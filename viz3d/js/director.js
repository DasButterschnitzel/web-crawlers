// The director: turns (time, audio) into everything that changes over the
// piece — act, camera shot, effect levels, HUD layout, spider goals.
// Acts sit on the song's sections (detected by analyze_audio.py, snapped to
// downbeats); cuts land on downbeats; glitches and flashes follow onsets.
import { lastLE } from './model.js';

const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
const ease = x => { x = clamp01(x); return x * x * (3 - 2 * x); };
const easeIO = x => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const ramp = (t, a, b) => clamp01((t - a) / (b - a));
const win = (t, a, b, fi = 1, fo = 1) => clamp01((t - a) / fi) * clamp01((b - t) / fo);
const mix = (a, b, k) => a + (b - a) * k;
const v3 = (x, y, z) => [x, y, z];
const lerp3 = (a, b, k) => [mix(a[0], b[0], k), mix(a[1], b[1], k), mix(a[2], b[2], k)];
const hash = (a, b = 0) => { let x = (a * 374761393 + b * 668265263) | 0; x = Math.imul(x ^ (x >>> 13), 1274126177); return ((x ^ (x >>> 16)) >>> 0) / 4294967296; };

function catmull(pts, u) {
  const n = pts.length - 1, f = clamp01(u) * n, i = Math.min(n - 1, Math.floor(f)), t = f - i;
  const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n, i + 2)];
  const c = (a, b, c2, d) => 0.5 * ((2 * b) + (-a + c2) * t + (2 * a - 5 * b + 4 * c2 - d) * t * t + (-a + 3 * b - 3 * c2 + d) * t * t * t);
  return [c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1]), c(p0[2], p1[2], p2[2], p3[2])];
}

export class Director {
  constructor({ audio, duration, host }) {
    this.audio = audio; this.dur = duration; this.host = host;
    const db = audio.downbeats || [];
    const snap = t => db.length ? db[Math.max(0, lastLE(db, t + 0.05))] : t;
    const S = (audio.sections || []).map(s => s.start);
    const sec = i => S[i] ?? i * 24;
    // timeline (seconds), derived from the song's sections
    this.T = {
      boot: 0, lock: sec(1), crawl: snap(sec(1) + 21.6), infil2: sec(3), prolif: sec(6), ice: sec(9), city: sec(10),
      latency: sec(12), anomaly: sec(13), core: sec(14), coreDrop: sec(15), outro: sec(17), end: duration,
    };
    if (!(this.T.crawl > this.T.lock)) this.T.crawl = this.T.lock + 20;
    this.T.crawlEnd = this.T.city - 2.4;
    this.cuts = this.buildCuts(db);
  }

  setModel(model) {
    this.m = model;
    this.host ||= model.meta.host;
    this.hasIce = model.nodes.some(n => n.blocked);          // only a site that pushed back gets the firewall act
    this.rank = model.nodes.slice().filter(n => !n.blocked).sort((a, b) => (b.prn || 0) - (a.prn || 0)).slice(0, 10);
    // tour of the city: hubs of the biggest districts
    const bySec = new Map();
    for (const n of model.nodes) if (!n.blocked && (!bySec.has(n.section) || (n.prn || 0) > (bySec.get(n.section).prn || 0))) bySec.set(n.section, n);
    this.tour = [...bySec.values()].sort((a, b) => b.sec.count - a.sec.count).slice(0, 8);
    const ctr = model.sectionList.filter(s => s.centroid && s.count > 8).sort((a, b) => b.count - a.count);
    this.clusters = ctr.slice(0, 6);
  }

  /** cut list: shot boundaries on downbeats (every 4 or 8 bars), each with a shot type */
  buildCuts(db) {
    const T = this.T, out = [];
    const add = (t0, t1, type, extra = {}) => out.push({ t0, t1, type, ...extra });
    const bars = (t0, t1, every, types) => {
      let k = 0;
      for (let t = t0; t < t1 - 0.5; k++) {
        const nx = Math.min(t1, t + every * 2.4);
        add(t, nx, types[k % types.length], { seed: k + Math.round(t) });
        t = nx;
      }
    };
    add(0, T.lock, 'bootPush');
    bars(T.lock, T.crawl, 4, ['heroOrbit', 'craneReveal']);
    bars(T.crawl, T.infil2, 4, ['lowHero', 'graphOrbitWide', 'chase', 'graphOrbit']);
    bars(T.infil2, T.prolif, 4, ['graphOrbit', 'chase', 'flyCluster', 'lowHero', 'graphOrbitWide', 'topDown']);
    bars(T.prolif, T.ice, 4, ['flyCluster', 'graphOrbitWide', 'chase', 'flyCluster', 'lowHero', 'graphOrbit', 'topDown']);
    bars(T.ice, T.city, 2, ['iceShake', 'chase', 'graphOrbitWide', 'iceShake', 'lowHero', 'graphOrbit']);
    bars(T.city, T.core, 4, ['cityRise', 'cityChase', 'cityOrbit', 'cityStreet', 'cityTop', 'cityChase', 'cityOrbit', 'cityStreet']);
    bars(T.core, T.outro, 4, ['coreDive', 'graphOrbit', 'coreDive', 'graphOrbitWide', 'flyCluster', 'coreDive']);
    add(T.outro, T.end, 'outroPull');
    return out;
  }

  shotAt(t) { let lo = 0, hi = this.cuts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.cuts[m].t0 <= t) lo = m; else hi = m - 1; } return this.cuts[lo]; }

  /** where the spider wants to go */
  spiderGoal(t, ctx) {
    const T = this.T, m = this.m;
    if (t < T.lock + 6) return null;
    if (t < T.crawl) { const a = (t - T.lock) * 0.25; return { x: Math.cos(a) * 10, z: Math.sin(a) * 10 }; }
    if (t < T.city) {
      if (this.hasIce && t > T.ice + 12) return { x: 0, z: 0 };            // withdrawal
      const k = lastLE(m.nodeTimes, t + 0.3);
      if (k < 0) return { x: 0, z: 0 };
      const p = ctx.graphWorld(k);
      const r = Math.hypot(p.x, p.z), lim = 42;
      return r > lim ? { x: p.x / r * lim, z: p.z / r * lim } : { x: p.x, z: p.z };
    }
    if (t < T.core) {
      const seg = 7.2, i = Math.floor((t - T.city - 4) / seg);
      if (i < 0) return { x: 0, z: 0 };
      const n = this.tour[i % this.tour.length];
      return { x: n.cx, z: n.cz };
    }
    return { x: 0, z: 0 };
  }

  camera(t, A, ctx) {
    const T = this.T, sh = this.shotAt(t), u = (t - sh.t0) / (sh.t1 - sh.t0), sp = ctx.spider;
    const s = ctx.spiderPos, hd = ctx.spiderHeading;
    const G = ctx.graphCenter;          // world centre of the graph
    let pos, look, fov = 50, roll = 0;
    const R = hash(sh.seed || 1, 7), dir = R > 0.5 ? 1 : -1;
    switch (sh.type) {
      case 'bootPush': {
        const k = easeIO(u);
        pos = v3(Math.sin(t * 0.05) * 4, mix(7, 4.2, k), mix(46, 24, k)); look = v3(0, mix(3.5, 2.6, k), 0); fov = mix(34, 40, k); break;
      }
      case 'heroOrbit': {
        const a = R * 6 + u * 0.9 * dir; pos = v3(s[0] + Math.sin(a) * 24, 5.5, s[2] + Math.cos(a) * 24); look = v3(s[0], 2.6, s[2]); fov = 42; break;
      }
      case 'craneReveal': {
        const k = easeIO(u); const a = R * 6 + u * 0.4;
        pos = v3(s[0] + Math.sin(a) * mix(22, 44, k), mix(3.0, 26, k), s[2] + Math.cos(a) * mix(22, 44, k));
        look = lerp3(v3(s[0], 2.2, s[2]), v3(0, 60, -120), ease(ramp(u, 0.3, 1))); fov = mix(40, 55, k); break;
      }
      case 'lowHero': {
        const a = hd + Math.PI * 0.75 * dir + u * 0.35 * dir;
        pos = v3(s[0] + Math.sin(a) * 19, 1.4, s[2] + Math.cos(a) * 19);
        look = v3(mix(s[0], G[0], 0.35), mix(3, G[1] * 0.75, ease(u)), mix(s[2], G[2], 0.35)); fov = 58; roll = 0.04 * dir; break;
      }
      case 'graphOrbit': case 'graphOrbitWide': {
        const wide = sh.type === 'graphOrbitWide';
        const a = R * 6.28 + (t - sh.t0) * 0.045 * dir;
        const r = wide ? 150 : 98, h = wide ? 62 : 22;
        pos = v3(G[0] + Math.cos(a) * r, G[1] + h - 18 + Math.sin(t * 0.1) * 6, G[2] + Math.sin(a) * r);
        look = v3(G[0], G[1] - (wide ? 8 : 4), G[2]); fov = wide ? 52 : 50; break;
      }
      case 'chase': {
        const back = 22, a = hd + Math.PI + 0.5 * dir;
        pos = v3(s[0] + Math.sin(a) * back, 8, s[2] + Math.cos(a) * back);
        look = v3(s[0] + Math.sin(hd) * 8, 4 + 8 * ease(u), s[2] + Math.cos(hd) * 8); fov = 55; break;
      }
      case 'flyCluster': {
        const cl = this.clusters, pts = [];
        const off = Math.floor(R * cl.length);
        for (let i = 0; i < 4; i++) { const c = cl[(off + i) % cl.length].centroid; pts.push(v3(c[0] * 1.35 + G[0], c[1] + G[1] + 8, c[2] * 1.35 + G[2])); }
        pos = catmull(pts, easeIO(u) * 0.999);
        const ahead = catmull(pts, Math.min(1, easeIO(u) + 0.12));
        look = lerp3(ahead, G, 0.45); fov = 62; roll = Math.sin(t * 0.4) * 0.06; break;
      }
      case 'topDown': {
        const a = t * 0.06 * dir; pos = v3(G[0] + Math.cos(a) * 8, G[1] + 150, G[2] + Math.sin(a) * 8); look = G; fov = 50; break;
      }
      case 'iceShake': {
        const a = R * 6 + u * 0.6; pos = v3(G[0] + Math.cos(a) * 70, G[1] - 10, G[2] + Math.sin(a) * 70); look = v3(G[0], G[1], G[2]); fov = 64; roll = Math.sin(t * 3) * 0.05; break;
      }
      case 'cityRise': {
        const k = easeIO(u); const a = 0.6 + u * 0.5;
        pos = v3(Math.cos(a) * mix(150, 95, k), mix(140, 40, k), Math.sin(a) * mix(150, 95, k)); look = v3(0, mix(30, 0, k), 0); fov = 52; break;
      }
      case 'cityOrbit': {
        const a = R * 6.28 + (t - sh.t0) * 0.06 * dir; pos = v3(Math.cos(a) * 85, 38 + Math.sin(t * 0.2) * 6, Math.sin(a) * 85); look = v3(0, 2, 0); fov = 50; break;
      }
      case 'cityChase': {
        const back = 24, a = hd + Math.PI + 0.6 * dir;
        pos = v3(s[0] + Math.sin(a) * back, 16, s[2] + Math.cos(a) * back);
        look = v3(s[0] + Math.sin(hd) * 6, 4, s[2] + Math.cos(hd) * 6); fov = 56; break;
      }
      case 'cityStreet': {
        // skim between the towers at roof height
        const a = R * 6.28, d = mix(-70, 70, u);
        const ox = Math.cos(a), oz = Math.sin(a);
        pos = v3(ox * d - oz * 6, 19 + 3 * Math.sin(u * 3), oz * d + ox * 6);
        look = v3(ox * (d + 40), 4, oz * (d + 40)); fov = 62; roll = 0.04 * dir; break;
      }
      case 'cityTop': {
        const a = t * 0.05; pos = v3(Math.cos(a) * 6, 125, Math.sin(a) * 6); look = v3(0, 0, 0); fov = 55; break;
      }
      case 'coreDive': {
        const k = easeIO(u); const a = R * 6.28 + u * 1.2 * dir;
        const r = mix(130, 18, k);
        pos = v3(G[0] + Math.cos(a) * r, G[1] + mix(30, 2, k), G[2] + Math.sin(a) * r); look = G; fov = mix(48, 75, k); roll = k * 0.12 * dir; break;
      }
      case 'outroPull': {
        const k = easeIO(u); const a = 0.4 + u * 0.6;
        pos = v3(G[0] + Math.cos(a) * mix(70, 260, k), mix(G[1], 140, k), G[2] + Math.sin(a) * mix(70, 260, k));
        look = lerp3(G, v3(0, 170, -700), ease(ramp(u, 0.35, 0.9))); fov = mix(50, 40, k); break;
      }
      default: pos = v3(0, 20, 60); look = v3(0, 10, 0);
    }
    // shake on kicks (more during the firewall storm)
    const shake = (0.12 + (this.hasIce && t > T.ice && t < T.city ? 0.5 : 0) + (t > T.coreDrop && t < T.outro ? 0.3 : 0)) * A.kick;
    const j = Math.floor(t * 30);
    pos = [pos[0] + (hash(j, 1) - 0.5) * shake, pos[1] + (hash(j, 2) - 0.5) * shake, pos[2] + (hash(j, 3) - 0.5) * shake];
    return { pos, look, fov, roll, cut: sh };
  }

  /** all per-frame parameters */
  params(t, A) {
    const T = this.T, sh = this.shotAt(t);
    const sinceCut = t - sh.t0;
    const ice = this.hasIce ? win(t, T.ice, T.city, 1.2, 2.0) : 0;
    const city = ease(ramp(t, T.city, T.city + 3)) * (1 - ease(ramp(t, T.core - 1.5, T.core + 1.5)));
    const morph = ease(ramp(t, T.city - 0.5, T.city + 6)) * (1 - ease(ramp(t, T.core - 3, T.core + 2.5)));
    const drop = t > T.coreDrop && t < T.outro;
    const onsetGlitch = A.sinceOnset < 0.08 && A.flux > 0.75 ? 0.35 : 0;
    const P = {
      // scene
      nodeAlpha: ease(ramp(t, T.crawl - 1, T.crawl)) * (1 - 0.4 * ease(ramp(t, T.outro + 20, T.end))) * (1 - 0.93 * ease(ramp(t, T.city + 3, T.city + 7)) * (1 - ease(ramp(t, T.core - 3, T.core)))),
      edgeAlpha: 0.06 + 0.04 * A.bands[3] + (drop ? 0.05 : 0),
      edgeFlow: 0.2 + 0.6 * A.bands[5] + (t > T.core ? 0.5 : 0),
      packets: ramp(t, T.crawl + 5, T.crawl + 20) * (t > T.core ? 1 : 0.75),
      threads: t > T.crawl - 1 && t < T.city ? 1 : 0,
      cores: ease(ramp(t, T.prolif - 10, T.prolif)),
      morph, city, arcs: ease(ramp(t, T.city + 8, T.city + 14)) * city,
      heat: win(t, T.latency, T.anomaly, 1.5, 1.5),
      issues: ease(ramp(t, T.anomaly, T.anomaly + 2)) * (1 - ease(ramp(t, T.core - 2, T.core))),
      graphOffset: [0, 40, 0], graphSpin: t > T.core ? (t - T.core) * 0.05 : 0,
      nodeScale: (1 + (drop ? 0.25 * A.kick : 0)) * (1 - 0.55 * city),
      terrain: 0.4 + 0.6 * ease(ramp(t, T.lock, T.crawl)) + (drop ? 0.5 : 0),
      eye: ease(ramp(t, 8, 14)) * (1 - 0.3 * city),
      alert: ice,
      spider: 1, spiderReveal: ease(ramp(t, 12.5, 16)),
      floorPulse: true,
      // post
      bloom: 0.55 + 0.4 * A.bands[1] + 0.4 * A.kick + (drop ? 0.3 : 0) + ice * 0.25,
      bloomRadius: 0.5 + 0.2 * A.bands[6],
      aberr: 0.0006 + 0.003 * A.kick + ice * 0.004 + (drop ? 0.003 : 0),
      glitch: Math.max(Math.exp(-sinceCut * 9) * 0.9 * (sh.t0 > 1 ? 1 : 0), onsetGlitch, ice * 0.25 * A.kick, t < 1.2 ? 0.6 * (1 - t / 1.2) : 0),
      scan: 0.2, grain: 0.045 + ice * 0.04, vignette: 0.95,
      flash: 0, fade: ease(ramp(t, 0.15, 1.8)) * (1 - ease(ramp(t, T.end - 3.5, T.end - 0.3))),
      hudAlpha: 1, invert: 0, tint: [1 + ice * 0.15, 1 - ice * 0.3, 1 - ice * 0.25],
      seed: Math.floor(t * 7),
    };
    // flashes at act changes (one decaying white pulse, red at the firewall)
    for (const [at, col, amt] of [[T.lock, '#ffffff', 0.4], [T.crawl, '#bff8ff', 0.7], [T.prolif, '#ffffff', 0.5], [T.ice, this.hasIce ? '#ff1e3c' : '#bff8ff', this.hasIce ? 0.8 : 0.5], [T.city, '#ffffff', 0.7], [T.core, '#ffffff', 0.6], [T.coreDrop, '#ff2bd6', 0.7], [T.outro, '#ffffff', 0.5]]) {
      const d = t - at;
      if (d >= 0 && d < 0.8) { P.flash = Math.max(P.flash, amt * Math.exp(-d * 6)); P.flashColor = col; }
    }
    if (drop && A.sinceDownbeat < 0.1) P.invert = A.sinceDownbeat < 0.05 && (A.downbeatIndex % 4 === 0) ? 1 : 0;
    return P;
  }

  hud(t, A, ctx) {
    const T = this.T, m = this.m, meta = m.meta;
    const fadeIn = (a, d = 0.8) => ease(ramp(t, a, a + d));
    const city = t >= T.city && t < T.core;
    const H = {
      show: {
        boot: t < T.lock + 1 ? 1 - ease(ramp(t, T.lock - 1.5, T.lock + 0.5)) : 0,
        frame: fadeIn(T.lock - 0.5),
        target: fadeIn(T.lock + 0.5) * (1 - ease(ramp(t, T.outro - 1, T.outro))),
        stats: fadeIn(T.crawl - 2) * (1 - ease(ramp(t, T.outro - 1, T.outro))),
        log: fadeIn(T.crawl) * (1 - ease(ramp(t, T.outro - 1, T.outro))),
        spectrum: fadeIn(T.lock + 2),
        sections: fadeIn(T.prolif - 4) * (1 - ease(ramp(t, T.outro - 1, T.outro))),
        radar: fadeIn(T.crawl + 4) * (t > T.core && t < T.outro ? 0 : 1) * (1 - ease(ramp(t, T.outro - 1, T.outro))),
        reticle: t > T.crawl && t < T.city - 1 ? 1 : 0,
        hex: fadeIn(T.lock) * 0.9,
        ranking: t > T.core + 1 && t < T.outro - 0.5 ? fadeIn(T.core + 1) : 0,
        legend: (t > T.latency && t < T.core) ? fadeIn(T.latency) * (1 - ease(ramp(t, T.core - 1, T.core))) : 0,
        summary: t > T.outro + 3 ? fadeIn(T.outro + 3) * (1 - ease(ramp(t, T.end - 11, T.end - 9.5))) : 0,
      },
      alert: this.hasIce ? win(t, T.ice + 0.5, T.city - 1, 0.4, 0.8) : 0,
      alertText: t < T.ice + 16 ? '⚠ COUNTERMEASURES DETECTED' : '⚠ WITHDRAWAL PROTOCOL',
      alertSub: t < T.ice + 16 ? 'WAF BOUNCE 303 → /error_path/503.html  ·  ICE ENGAGED' : 'POLITENESS DIRECTIVE  ·  CRAWL HALTED  ·  DATA SECURED',
      phase: this.phaseName(t),
      bpm: this.audio.bpm || 100,
      radarScale: city ? 60 : 75, radarCity: city,
      rankList: this.rank, rankStart: T.core + 1,
      legendTitle: t < T.anomaly ? 'LATENCY SCAN — TIME TO FIRST BYTE' : 'ANOMALY SCAN',
      legendItems: t < T.anomaly ? [['< 100 MS', '#00f0ff'], ['~ 300 MS', '#3d6dff'], ['~ 1 S', '#ff2bd6'], ['> 2 S', '#ff1e3c']] : [['WAF BLOCKED / ERROR', '#ff1e3c'], ['IMAGES W/O ALT', '#ffb000'], ['NOMINAL', '#00f0ff']],
      card: this.cardAt(t),
    };
    return H;
  }

  phaseName(t) {
    const T = this.T;
    if (t < T.lock) return 'SYSTEM BOOT';
    if (t < T.crawl) return 'PHASE 01 // TARGET LOCK';
    if (t < T.prolif) return 'PHASE 02 // INFILTRATION';
    if (t < T.ice) return 'PHASE 03 // PROLIFERATION';
    if (t < T.city) return this.hasIce ? 'PHASE 04 // COUNTERMEASURES' : 'PHASE 04 // DEEP SCAN';
    if (t < T.latency) return 'PHASE 05 // DATA CITY';
    if (t < T.anomaly) return 'PHASE 05 // LATENCY SCAN';
    if (t < T.core) return 'PHASE 05 // ANOMALY SCAN';
    if (t < T.outro) return 'PHASE 06 // NEURAL CORE';
    return 'PHASE 07 // ASSIMILATION COMPLETE';
  }

  cardAt(t) {
    const T = this.T, s = this.m.meta.stats || {}, n = this.m.nodes.length;
    const okN = this.m.nodes.filter(x => !x.blocked).length;
    const cards = [
      { t0: 9.0, t1: T.lock - 0.3, title: 'ARACHNET', kicker: 'AUTONOMOUS CRAWL UNIT', sub: 'NEURAL WEB INTERFACE // ONLINE', size: 120 },
      { t0: T.lock + 0.2, t1: T.lock + 5, title: 'TARGET LOCK', kicker: 'PHASE 01', sub: (this.host || '').toUpperCase() },
      { t0: T.crawl, t1: T.crawl + 4.8, title: 'INFILTRATION', kicker: 'PHASE 02', sub: 'CRAWL SEQUENCE ENGAGED' },
      { t0: T.prolif, t1: T.prolif + 4.8, title: 'PROLIFERATION', kicker: 'PHASE 03', sub: `${okN} PAGES · ${(s.edges || 0).toLocaleString('en-US')} LINKS` },
      this.hasIce ? { t0: T.ice, t1: T.ice + 3.6, title: 'COUNTERMEASURES', kicker: 'PHASE 04', sub: 'WEB APPLICATION FIREWALL ENGAGED', y: 560 }
        : { t0: T.ice, t1: T.ice + 3.6, title: 'DEEP SCAN', kicker: 'PHASE 04', sub: 'NO COUNTERMEASURES  ·  ROBOTS: WELCOME', y: 560 },
      { t0: T.city + 0.3, t1: T.city + 5, title: 'DATA CITY', kicker: 'PHASE 05', sub: 'ONE TOWER PER PAGE · HEIGHT = CONTENT + PAGERANK' },
      { t0: T.latency, t1: T.latency + 3.6, title: 'LATENCY SCAN', kicker: 'PHASE 05.2', size: 72 },
      { t0: T.anomaly, t1: T.anomaly + 3.6, title: 'ANOMALY SCAN', kicker: 'PHASE 05.3', size: 72 },
      { t0: T.core, t1: T.core + 4.8, title: 'NEURAL CORE', kicker: 'PHASE 06', sub: 'PAGERANK CONVERGENCE' },
      { t0: T.outro, t1: T.outro + 3.2, title: 'ASSIMILATED', kicker: 'PHASE 07', sub: `${(this.host || '').toUpperCase()} // FULLY MAPPED` },
      { t0: T.end - 9, t1: T.end - 1.2, title: '/[•]\\', kicker: 'ARACHNET  ·  GITHUB.COM/DASBUTTERSCHNITZEL/WEB-CRAWLERS', sub: 'MUSIC: EIGHT-LEGGED CLOCK', size: 110, y: 560 },
    ];
    return cards.find(c => t >= c.t0 && t < c.t1) || null;
  }
}
