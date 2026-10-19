// Live mode: watch a crawl while it happens. The crawler streams its events
// over SSE (/events); the graph grows, the force layout settles continuously,
// the spider fires silk at every page it fetches, the HUD counts along.
//
//   node crawler/crawl.mjs https://example.org --live 8080 [--audio track.wav]
//   -> open http://127.0.0.1:8080/?mode=live
//
// Keys: C toggles the data city, H the HUD, F fullscreen, M mutes. Drop an
// audio file onto the page to drive the visuals with it.
import { CrawlModel, lastLE } from './model.js';
import { LiveAudio } from './audio.js';
import { Environment } from './env.js';
import { GraphView } from './graph.js';
import { CityView } from './city.js';
import { Spider } from './spider.js';
import { Director } from './director.js';

const SHOTS = ['graphOrbitWide', 'chase', 'graphOrbit', 'lowHero', 'flyCluster', 'topDown'];
const CITY_SHOTS = ['cityOrbit', 'cityChase', 'cityTop', 'cityOrbit'];

export async function startLive({ THREE, renderer, scene, camera, hud, post, W, H, AUDIO }) {
  const Q = new URLSearchParams(location.search);
  const ui = document.getElementById('ui');
  const model = new CrawlModel();
  const env = new Environment(scene);
  const graph = new GraphView(scene, model, { maxNodes: 8000, maxEdges: 30000 });
  const spider = new Spider(scene, { scale: 1.5 });
  let city = null, cityOn = false, cityT = -1e9, hudOn = true;

  // audio: a track from ?track=, a dropped file, or silence
  const el = new Audio(); el.crossOrigin = 'anonymous'; el.loop = true;
  const audio = new LiveAudio(el);
  const track = Q.get('track');
  if (track) el.src = AUDIO + track;
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) { el.src = URL.createObjectURL(f); audio.start().then(() => el.play()); } });
  const engage = () => { audio.start().then(() => el.src && el.play()).catch(() => {}); ui.textContent = ''; };
  addEventListener('click', engage, { once: true });
  ui.textContent = 'CLICK TO ENGAGE  ·  DROP AN AUDIO FILE  ·  C = DATA CITY';

  // director: reuse the recorded-mode camera rig, with a live shot list
  const dir = new Director({ audio: { downbeats: [], sections: [], bpm: 100 }, duration: 1e9 });
  Object.assign(dir.T, { lock: -1, crawl: -1, ice: 1e9, city: 1e9, core: 1e9, coreDrop: 1e9, outro: 1e9, prolif: -1 });
  dir.m = model; dir.rank = []; dir.tour = []; dir.clusters = [];
  dir.shotAt = t => {
    const len = 12, k = Math.floor(t / len), list = cityOn ? CITY_SHOTS : SHOTS;
    let type = list[k % list.length];
    if (type === 'flyCluster' && dir.clusters.length < 2) type = 'graphOrbit';
    return { t0: k * len, t1: (k + 1) * len, type, seed: k };
  };

  const t0 = performance.now() / 1000;
  const now = () => performance.now() / 1000 - t0;
  const es = new EventSource('/events');
  // events that arrive in the first burst are history (joining a running crawl):
  // they get no spawn animation and are laid out in one go
  let dirty = false, lastMsg = 0, backlog = 0, settled = false;
  es.onmessage = m => {
    const ev = JSON.parse(m.data), tn = now();
    const inBurst = !settled && tn - lastMsg < 0.3;
    lastMsg = tn;
    const n = model.ingest(ev, inBurst ? tn - 30 : tn);
    if (n) { dirty = true; if (inBurst) { backlog++; model.nodeTimes[n.i] = tn - 30; } }
    if (ev.type === 'start') ui.textContent = 'LINK ESTABLISHED  ·  ' + ev.host.toUpperCase();
  };
  es.onerror = () => { ui.textContent = 'FEED LOST  ·  RETRYING'; };

  addEventListener('keydown', e => {
    if (e.code === 'KeyC' && model.nodes.length > 4) {
      cityOn = !cityOn; cityT = now();
      if (cityOn) {
        model.syncLayout(); model.buildCity();
        if (city) scene.remove(city.group);
        city = new CityView(scene, model, { riseStart: cityT + 1.5 });
        graph.syncedNodes = 0; graph.syncedEdges = 0; graph.sync();
      }
    }
    if (e.code === 'KeyH') hudOn = !hudOn;
    if (e.code === 'KeyF') document.documentElement.requestFullscreen?.();
    if (e.code === 'KeyM') el.muted = !el.muted;
  });

  const ground = (x, z) => (cityOn && city ? city.ground(x, z, now()) : 0);
  spider.onPlant = (foot, L, t) => { if (cityOn && city) { const i = city.towerAt(foot.x, foot.z); if (i >= 0 && i < city.N) { city.hit(i, t); graph.hit(i, t); } } };
  const proj = new THREE.Vector3();
  const project = i => { graph.world(i, proj); proj.project(camera); return proj.z > 1 ? { behind: true } : { x: (proj.x * 0.5 + 0.5) * 1920, y: (-proj.y * 0.5 + 0.5) * 1080 }; };
  const realRate = k => { if (k < 0) return 0; const rt = model.nodes.map(n => n.realT); const i0 = lastLE(rt, rt[k] - 10); return (k - i0) / 10; };

  let last = now(), lastSync = 0;
  const frame = () => {
    const t = now(), dt = Math.min(0.05, t - last); last = t;
    if (!settled && t - lastMsg > 0.6 && model.nodes.length) {
      settled = true;
      if (backlog > 20) { model.layout.step(Math.min(400, 40 + backlog / 3)); model.syncLayout(); graph.syncedNodes = 0; graph.syncedEdges = 0; dirty = true; }
      for (let i = 0; i < model.edgeTimes.length; i++) if (model.edgeTimes[i] > t - 1 && i < backlog * 50) model.edgeTimes[i] = Math.min(model.edgeTimes[i], t - 30);
    }
    if (dirty) { graph.sync(); dirty = false; }
    model.layout.step(2, { alpha: 0.5 });
    if (t - lastSync > 0.5) {
      model.syncLayout(); lastSync = t;
      dir.clusters = model.sectionList.filter(s => s.centroid && s.count > 6).sort((a, b) => b.count - a.count).slice(0, 6);
    } else for (const n of model.nodes) { const p = model.layout.pos(n.li); n.gx = p[0]; n.gy = p[1]; n.gz = p[2]; }

    const A = audio.update(t);
    const blockedRecently = model.meta.stats ? 0 : model.meta.blocked ? 1 : model.meta.throttle && t - model.meta.throttle.t < 8 ? 0.6 : 0;
    const morph = cityOn ? Math.min(1, (t - cityT) / 5) : Math.max(0, 1 - (t - cityT) / 3);
    const P = {
      nodeAlpha: 1 - 0.9 * morph, edgeAlpha: 0.07 + 0.04 * A.bands[3], edgeFlow: 0.2 + 0.6 * A.bands[5], packets: 0.8, threads: cityOn ? 0 : 1, cores: 1,
      morph, city: cityOn || morph > 0 ? Math.max(morph, 0.01) : 0, arcs: cityOn ? Math.min(1, (t - cityT - 6) / 4) : 0, heat: 0, issues: 0,
      graphOffset: [0, 40, 0], graphSpin: 0, nodeScale: 1 - 0.55 * morph, terrain: 1, eye: 1, alert: blockedRecently, spider: 1, spiderReveal: 1,
    };
    // spider: chase the newest page (floor projection)
    const k = model.nodes.length - 1;
    let goal = null;
    if (k >= 0) {
      const n = model.nodes[k];
      goal = cityOn && n.cx != null ? { x: n.cx, z: n.cz } : { x: Math.max(-42, Math.min(42, n.gx)), z: Math.max(-42, Math.min(42, n.gz)) };
    }
    spider.step(dt, t, goal, ground, A, { speed: 9 });

    const ctx = { spider, spiderPos: [spider.pos.x, spider.bodyY, spider.pos.z], spiderHeading: spider.heading, graphCenter: [0, 40, 0] };
    const cam = dir.camera(t, A, ctx);
    camera.position.set(...cam.pos); camera.up.set(Math.sin(cam.roll), Math.cos(cam.roll), 0); camera.lookAt(...cam.look);
    camera.fov = cam.fov; camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();

    env.resetRings(); if (A.sinceBeat < 3.5) env.shockwave(t - A.sinceBeat);
    env.floorMat.uniforms.uOrigin.value.set(spider.pos.x, spider.pos.z);
    env.update(t, A, audio, P);
    graph.update(t, A, P, spider, cityOn && city ? city : null);
    if (city) city.update(t, A, P);
    spider.updateMeshes(t, A, P);

    const meta = model.meta, opt = meta.options || {};
    const Hd = {
      t, A, m: model, project, bpm: audio.bpm || 100, phase: cityOn ? 'LIVE // DATA CITY' : 'LIVE // CRAWLING ' + (meta.host || '').toUpperCase(),
      show: hudOn ? { frame: 1, target: 1, stats: 1, log: 1, spectrum: 1, sections: 1, radar: 1, reticle: cityOn ? 0 : 1, hex: 0.8 } : {},
      targetRows: [
        ['HOST', (meta.host || '…').toUpperCase(), '#e8f6ff', 0],
        ['ROBOTS.TXT', meta.robots ? `${meta.robots.status} · ${meta.robots.groups} GROUPS` : '…', '#ffb000', 0],
        ['SITEMAP', meta.sitemap ? `${meta.sitemap.urls} URLS` : '…', '#00f0ff', 0],
        ['GOVERNOR', opt.concurrency ? `${opt.concurrency} THREADS · ${opt.delay} MS GATE` : '…', '#e8f6ff', 0],
        ['STATUS', meta.blocked ? 'HALTED · SERVER PUSHBACK' : meta.stats ? 'COMPLETE' : 'CRAWLING', meta.blocked ? '#ff1e3c' : '#39ff88', 0],
      ],
      realRate, trackName: track ? track.replace(/\.\w+$/, '').toUpperCase() : 'LIVE INPUT', spiderXZ: [spider.pos.x, spider.pos.z],
      radarScale: cityOn ? 60 : 75, radarCity: cityOn,
      alert: blockedRecently ? 0.9 : 0, alertText: meta.blocked ? '⚠ SERVER PUSHBACK — CRAWL HALTED' : '⚠ THROTTLING', alertSub: meta.blocked ? meta.blocked.reason : `GAP ${meta.throttle?.gap ?? ''} MS`,
    };
    hud.draw(Hd);
    post.render({ uTime: t, uAberr: 0.0006 + 0.003 * A.kick, uGlitch: A.sinceOnset < 0.06 && A.flux > 0.8 ? 0.3 : 0, uScan: 0.2, uGrain: 0.045, uVignette: 0.95,
      uFlash: 0, uFade: 1, uHudAlpha: 1, uSeed: Math.floor(t * 7), uInvert: 0, tint: [1 + blockedRecently * 0.15, 1 - blockedRecently * 0.3, 1 - blockedRecently * 0.25],
      bloom: 0.55 + 0.4 * A.bands[1] + 0.4 * A.kick, bloomRadius: 0.5 });
    requestAnimationFrame(frame);
  };
  addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); post.composer.setSize(innerWidth, innerHeight); });
  frame();
}
