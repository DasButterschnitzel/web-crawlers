// Skynet-grade HUD on a 2D canvas (composited inside the post pass so glitches
// tear through it). Every element is a pure function of time + data.
import { lastLE } from './model.js';
import { NB } from './audio.js';

const C = {
  cyan: '#00f0ff', cyanDim: 'rgba(0,240,255,0.35)', mag: '#ff2bd6', red: '#ff1e3c', amber: '#ffb000', white: '#e8f6ff',
  dim: 'rgba(160,220,255,0.55)', faint: 'rgba(0,240,255,0.12)', green: '#39ff88',
};
const CAT_COL = ['#2e7bff', '#ff2bd6', '#9fdcff', '#00f0ff', '#39ff88', '#5a5f7a', '#ffb000', '#7c4dff', '#c6ff00', '#333a55'];
const MONO = '"Share Tech Mono", monospace', HEAD = 'Orbitron, sans-serif', LAB = 'Rajdhani, sans-serif';

const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
const ease = x => { x = clamp01(x); return x * x * (3 - 2 * x); };
const hash = (a, b = 0) => { let x = (a * 374761393 + b * 668265263) | 0; x = Math.imul(x ^ (x >>> 13), 1274126177); return ((x ^ (x >>> 16)) >>> 0) / 4294967296; };
const pad = (n, w, c = '0') => String(n).padStart(w, c);
const fmtBytes = b => b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? (b / 1024).toFixed(1) + ' KB' : b + ' B';
const tc = t => { const m = Math.floor(t / 60), s = Math.floor(t % 60), f = Math.floor((t % 1) * 60); return `${pad(m, 2)}:${pad(s, 2)}:${pad(f, 2)}`; };
const GLYPHS = '01アイウエオカキクケコサシスセソタチツテトナニヌネノ#$%&@ABCDEF';

export class HUD {
  constructor(canvas) {
    this.cv = canvas; this.g = canvas.getContext('2d');
    this.resize(canvas.width, canvas.height);
  }
  resize(w, h) { this.W = w; this.H = h; this.k = w / 1920; }

  // ------------------------------------------------------------- primitives
  font(size, fam = MONO, weight = 400) { this.g.font = `${weight} ${Math.round(size * this.k)}px ${fam}`; }
  text(s, x, y, color = C.white, size = 18, fam = MONO, align = 'left', weight = 400, alpha = 1) {
    const g = this.g; this.font(size, fam, weight); g.textAlign = align; g.textBaseline = 'alphabetic';
    g.globalAlpha = alpha; g.fillStyle = color; g.fillText(s, x * this.k, y * this.k); g.globalAlpha = 1;
  }
  glowText(s, x, y, color, size, fam = HEAD, align = 'left', weight = 700, alpha = 1, blur = 18) {
    const g = this.g; g.save(); g.shadowColor = color; g.shadowBlur = blur * this.k; this.text(s, x, y, color, size, fam, align, weight, alpha); g.restore();
  }
  line(x0, y0, x1, y1, color = C.cyan, w = 1, alpha = 1) {
    const g = this.g, k = this.k; g.globalAlpha = alpha; g.strokeStyle = color; g.lineWidth = w * k;
    g.beginPath(); g.moveTo(x0 * k, y0 * k); g.lineTo(x1 * k, y1 * k); g.stroke(); g.globalAlpha = 1;
  }
  rect(x, y, w, h, color, alpha = 1) { const g = this.g, k = this.k; g.globalAlpha = alpha; g.fillStyle = color; g.fillRect(x * k, y * k, w * k, h * k); g.globalAlpha = 1; }
  srect(x, y, w, h, color, lw = 1, alpha = 1) { const g = this.g, k = this.k; g.globalAlpha = alpha; g.strokeStyle = color; g.lineWidth = lw * k; g.strokeRect(x * k, y * k, w * k, h * k); g.globalAlpha = 1; }
  brackets(x, y, w, h, s = 14, color = C.cyan, lw = 2, alpha = 1) {
    const L = (a, b, c, d) => this.line(a, b, c, d, color, lw, alpha);
    L(x, y, x + s, y); L(x, y, x, y + s); L(x + w, y, x + w - s, y); L(x + w, y, x + w, y + s);
    L(x, y + h, x + s, y + h); L(x, y + h, x, y + h - s); L(x + w, y + h, x + w - s, y + h); L(x + w, y + h, x + w, y + h - s);
  }
  panel(x, y, w, h, title, alpha = 1, color = C.cyan) {
    this.rect(x, y, w, h, 'rgba(2,8,18,0.55)', alpha);
    this.brackets(x, y, w, h, 12, color, 1.5, alpha);
    if (title) { this.rect(x, y - 22, Math.min(w, title.length * 10 + 26), 20, color, 0.14 * alpha); this.text(title, x + 8, y - 6, color, 14, LAB, 'left', 700, alpha); }
  }
  /** scramble-in text: characters resolve from noise */
  decode(s, prog, seed = 0) {
    if (prog >= 1) return s;
    const n = Math.floor(s.length * prog);
    let out = s.slice(0, n);
    for (let i = n; i < Math.min(s.length, n + 6); i++) out += s[i] === ' ' ? ' ' : GLYPHS[Math.floor(hash(i, seed + Math.floor(prog * 60)) * GLYPHS.length)];
    return out;
  }

  // ------------------------------------------------------------------ draw
  draw(H) {
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.W, this.H);
    const { t, A, m } = H, show = H.show || {};
    const k = m.nodeTimes ? lastLE(m.nodeTimes, t) : m.nodes.length - 1;
    this.cur = k;
    if (show.boot) this.boot(H);
    if (show.frame) this.frame(H, show.frame);
    if (show.target) this.target(H, show.target);
    if (show.stats) this.stats(H, k, show.stats);
    if (show.log) this.log(H, k, show.log);
    if (show.spectrum) this.spectrum(H, show.spectrum);
    if (show.sections) this.sections(H, k, show.sections);
    if (show.radar) this.radar(H, k, show.radar);
    if (show.reticle && k >= 0) this.reticle(H, H.focus ?? k, show.reticle);
    if (show.hex) this.hex(H, show.hex);
    if (show.ranking) this.ranking(H, show.ranking);
    if (show.legend) this.legend(H, show.legend);
    if (H.alert > 0.01) this.alert(H);
    if (H.card) this.card(H, H.card);
    if (show.summary) this.summary(H, show.summary);
  }

  boot(H) {
    const { t } = H, B = H.bootLines || [];
    const t0 = H.bootStart ?? 0.6;
    let y = 150;
    const a = H.show.boot;
    for (let i = 0; i < B.length; i++) {
      const [at, s, col] = B[i];
      if (t < t0 + at) break;
      const p = clamp01((t - t0 - at) / Math.max(0.15, s.length * 0.012));
      const txt = s.slice(0, Math.floor(s.length * p));
      this.text(txt + (p < 1 && Math.floor(t * 8) % 2 ? '█' : ''), 120, y, col || C.cyan, 21, MONO, 'left', 400, a);
      y += 31;
      if (y > 1000) break;
    }
  }

  frame(H, a) {
    const { t, A } = H;
    const W = 1920, Hh = 1080, m = 28;
    this.brackets(m, m, W - 2 * m, Hh - 2 * m, 46, C.cyan, 2, 0.75 * a);
    // top bar
    this.glowText('ARACHNET', 74, 86, C.cyan, 34, HEAD, 'left', 900, a, 22);
    this.text('/[•]\\', 312, 84, C.mag, 28, MONO, 'left', 400, a);
    this.text('AUTONOMOUS CRAWL UNIT  ·  SKYNET-CLASS  ·  BUILD 1.0.0', 76, 112, C.dim, 15, LAB, 'left', 600, a);
    // ticks along the top
    for (let i = 0; i < 60; i++) { const x = 480 + i * 16, hgt = i % 5 ? 6 : 14; this.line(x, 52, x, 52 + hgt, C.cyan, 1, 0.35 * a); }
    const lvl = A.rms;
    this.rect(480, 72, 944 * lvl, 3, C.cyan, 0.6 * a);
    // right: rec + timecode
    const rec = Math.floor(t * 2) % 2 === 0;
    this.g.save(); this.g.globalAlpha = a; this.g.fillStyle = C.red; this.g.beginPath(); this.g.arc(1640 * this.k, 76 * this.k, 8 * this.k, 0, Math.PI * 2); if (rec) this.g.fill(); this.g.restore();
    this.text('REC', 1656, 83, C.red, 20, HEAD, 'left', 700, a);
    this.text('T+' + tc(t), 1848, 84, C.white, 22, MONO, 'right', 400, a);
    this.text(`FRAME ${pad(Math.round(t * 60), 6)}  ·  ${H.bpm.toFixed(1)} BPM  ·  BAR ${pad(Math.max(0, A.bar + 1), 3)}`, 1848, 110, C.dim, 15, MONO, 'right', 400, a);
    // phase label bottom centre
    if (H.phase) this.text(H.phase, 960, 1046, C.cyan, 16, LAB, 'center', 700, 0.85 * a);
    // beat squares
    for (let i = 0; i < 4; i++) {
      const on = H.A.beatIndex >= 0 && ((H.A.beatIndex - (H.downPhase ?? 0)) % 4 + 4) % 4 === i;
      this.rect(1688 + i * 22, 98 - 0, 16, 6, on ? C.mag : C.cyanDim, (on ? 0.4 + 0.6 * A.beat : 0.4) * a);
    }
  }

  target(H, a) {
    const meta = H.m.meta, x = 76, y = 170;
    this.panel(x, y, 430, 196, 'TARGET ACQUISITION', a);
    const rows = H.targetRows || [];
    rows.forEach(([k, v, col, at], i) => {
      const p = clamp01((H.t - (at ?? -10)) / 0.9);
      if (p <= 0) return;
      this.text(k, x + 16, y + 34 + i * 30, C.dim, 15, LAB, 'left', 700, a);
      this.text(this.decode(v, p, i * 17), x + 130, y + 34 + i * 30, col || C.white, 18, MONO, 'left', 400, a);
    });
  }

  stats(H, k, a) {
    const { m, t } = H, x = 1494, y = 170, w = 350;
    this.panel(x, y, w, 392, 'TELEMETRY', a);
    const cum = k >= 0 ? m.cum[k] : { bytes: 0, err: 0, red: 0, ttfbAvg: 0, links: 0, blocked: 0 };
    const nodes = k + 1;
    const rate = H.realRate ? H.realRate(k) : 0;
    const rows = [
      ['NODES MAPPED', nodes.toLocaleString('en-US'), C.cyan],
      ['LINKS TRACED', (cum.links || 0).toLocaleString('en-US'), C.cyan],
      ['DATA INGESTED', fmtBytes(cum.bytes), C.white],
      ['THROUGHPUT', rate.toFixed(1) + ' REQ/S', C.white],
      ['AVG TTFB', Math.round(cum.ttfbAvg) + ' MS', C.white],
      ['ANOMALIES', String(cum.err + (cum.blocked || 0)), cum.err + (cum.blocked || 0) ? C.red : C.dim],
      ['ICE BOUNCES', String(cum.blocked || 0), cum.blocked ? C.red : C.dim],
    ];
    rows.forEach(([lab, val, col], i) => {
      const yy = y + 40 + i * 52;
      this.text(lab, x + 16, yy - 8, C.dim, 14, LAB, 'left', 700, a);
      this.glowText(val, x + w - 16, yy + 14, col, 26, MONO, 'right', 400, a, 10);
      this.line(x + 16, yy + 22, x + w - 16, yy + 22, C.cyan, 1, 0.12 * a);
    });
    // sparkline of real request rate
    if (H.rateSpark) {
      const sp = H.rateSpark(k), n = sp.length;
      const g = this.g, kk = this.k; g.save(); g.globalAlpha = 0.8 * a; g.strokeStyle = C.mag; g.lineWidth = 1.5 * kk; g.beginPath();
      sp.forEach((v, i) => { const px = (x + 16 + i / (n - 1) * (w - 32)) * kk, py = (y + 380 - v * 22) * kk; i ? g.lineTo(px, py) : g.moveTo(px, py); });
      g.stroke(); g.restore();
    }
  }

  log(H, k, a) {
    const { m, t } = H, x = 76, y = 812, w = 860, rows = 7;
    this.panel(x, y, w, 220, 'INTERCEPT LOG', a);
    for (let r = 0; r < rows; r++) {
      const i = k - r;
      if (i < 0) break;
      const n = m.nodes[i];
      const age = t - n.t;
      const blocked = n.blocked;
      const status = blocked ? '303' : String(n.status);
      const col = blocked || n.status >= 400 ? C.red : n.status >= 300 ? C.amber : r === 0 ? C.white : C.cyan;
      const size = n.file ? 'HEAD' : fmtBytes(n.bytes || 0);
      const line = `${pad(Math.floor(n.realT / 60), 2)}:${(n.realT % 60).toFixed(3).padStart(6, '0')}  ${status}  ${pad(n.ms, 5, ' ')}ms  ${size.padStart(9, ' ')}  ${blocked ? '⟶ ICE  ' : ''}${n.path}`;
      const p = r === 0 ? clamp01(age / 0.25) : 1;
      const s = line.slice(0, Math.floor(Math.min(line.length, 92) * p)) + (line.length > 92 && p >= 1 ? '…' : '');
      this.text(s, x + 16, y + 200 - r * 27, col, 16, MONO, 'left', 400, a * (1 - r * 0.09));
    }
  }

  spectrum(H, a) {
    const { A } = H, x = 1294, y = 862, w = 550, h = 150;
    this.panel(x, y, w, h + 20, 'SIGNAL  ·  ' + (H.trackName || 'AUDIO'), a, C.mag);
    const bw = w / NB;
    for (let i = 0; i < NB; i++) {
      const v = A.spec[i];
      const col = i < 12 ? C.mag : i < 40 ? C.cyan : C.white;
      this.rect(x + 4 + i * bw, y + h + 6 - v * h * 0.85, bw - 2, v * h * 0.85, col, (0.35 + 0.65 * v) * a);
    }
    // oscilloscope
    const g = this.g, kk = this.k;
    g.save(); g.globalAlpha = 0.9 * a; g.strokeStyle = C.white; g.lineWidth = 1.5 * kk; g.beginPath();
    for (let i = 0; i < 64; i++) { const px = (x + 8 + i / 63 * (w - 16)) * kk, py = (y + 50 + A.wave[i] * 34) * kk; i ? g.lineTo(px, py) : g.moveTo(px, py); }
    g.stroke(); g.restore();
    const names = ['SUB', 'BASS', 'LOW', 'MID', 'HI', 'PRES', 'AIR'];
    names.forEach((nm, i) => this.text(nm + ' ' + pad(Math.round(A.bands[i] * 99), 2), x + 10 + i * 77, y + 20, C.dim, 12, MONO, 'left', 400, a));
  }

  sections(H, k, a) {
    const { m } = H, x = 1494, y = 600, w = 350;
    const counts = new Map();
    for (let i = 0; i <= k; i++) { const s = m.nodes[i].sec; counts.set(s, (counts.get(s) || 0) + 1); }
    const list = [...counts].sort((p, q) => q[1] - p[1]).slice(0, 7);
    this.panel(x, y, w, 224, 'SECTORS', a);
    const mx = Math.max(1, ...list.map(l => l[1]));
    list.forEach(([s, c], i) => {
      const yy = y + 30 + i * 28;
      this.text(s.name.toUpperCase().slice(0, 20), x + 14, yy, C.white, 14, LAB, 'left', 700, a);
      this.rect(x + 170, yy - 11, (w - 230) * c / mx, 10, s.color, 0.85 * a);
      this.text(String(c), x + w - 14, yy, s.color, 15, MONO, 'right', 400, a);
    });
  }

  radar(H, k, a) {
    const { m, t } = H, cx = 290, cy = 560, R = 150;
    const g = this.g, kk = this.k;
    g.save(); g.globalAlpha = a;
    g.strokeStyle = C.cyanDim; g.lineWidth = 1 * kk;
    for (const r of [R, R * 0.66, R * 0.33]) { g.beginPath(); g.arc(cx * kk, cy * kk, r * kk, 0, Math.PI * 2); g.stroke(); }
    this.line(cx - R, cy, cx + R, cy, C.cyan, 1, 0.25 * a); this.line(cx, cy - R, cx, cy + R, C.cyan, 1, 0.25 * a);
    // sweep
    const sw = t * 1.6;
    const grd = g.createConicGradient(sw, cx * kk, cy * kk);
    grd.addColorStop(0, 'rgba(0,240,255,0.35)'); grd.addColorStop(0.12, 'rgba(0,240,255,0)'); grd.addColorStop(1, 'rgba(0,240,255,0)');
    g.fillStyle = grd; g.beginPath(); g.arc(cx * kk, cy * kk, R * kk, 0, Math.PI * 2); g.fill();
    // nodes (top-down view of the graph or the city)
    const scale = R / (H.radarScale || 70);
    const city = H.radarCity;
    for (let i = 0; i <= k; i += 1) {
      const n = m.nodes[i];
      const px = city ? n.cx : n.gx, pz = city ? n.cz : n.gz;
      const dx = px * scale, dy = pz * scale;
      if (dx * dx + dy * dy > R * R) continue;
      const ang = Math.atan2(dy, dx), d = ((sw - ang) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      const b = 0.25 + 0.75 * Math.exp(-d * 1.5);
      g.fillStyle = n.blocked || n.status >= 400 ? C.red : n.sec.color; g.globalAlpha = a * b;
      g.fillRect((cx + dx) * kk - 1, (cy + dy) * kk - 1, 2.4 * kk, 2.4 * kk);
    }
    g.globalAlpha = a;
    if (H.spiderXZ) { const [sx, sz] = H.spiderXZ; g.fillStyle = C.red; g.beginPath(); g.arc((cx + sx * scale) * kk, (cy + sz * scale) * kk, 4 * kk, 0, Math.PI * 2); g.fill(); }
    g.restore();
    this.text('TOPOLOGY', cx - R, cy - R - 12, C.cyan, 14, LAB, 'left', 700, a);
    this.text(city ? 'CITY GRID' : 'LINK SPACE', cx + R, cy - R - 12, C.dim, 13, MONO, 'right', 400, a);
  }

  reticle(H, i, a) {
    const { m, t } = H, n = m.nodes[i];
    if (!n || !H.project) return;
    const p = H.project(i);
    if (!p || p.behind) return;
    const age = t - n.t;
    const x = p.x, y = p.y;
    const s = 46 + 30 * Math.exp(-age * 4);
    const col = n.blocked || n.status >= 400 ? C.red : n.status >= 300 ? C.amber : C.cyan;
    const g = this.g, kk = this.k;
    g.save(); g.translate(x * kk, y * kk); g.rotate(t * 0.8); g.translate(-x * kk, -y * kk);
    this.brackets(x - s / 2, y - s / 2, s, s, 12, col, 2, a);
    g.restore();
    this.line(x - s, y, x - s * 0.6, y, col, 1, a); this.line(x + s * 0.6, y, x + s, y, col, 1, a);
    this.line(x, y - s, x, y - s * 0.6, col, 1, a); this.line(x, y + s * 0.6, x, y + s, col, 1, a);
    // leader + data card
    const right = x < 1100;
    const lx = right ? x + 70 : x - 70, ly = y - 70;
    const bx = right ? lx + 10 : lx - 430, by = ly - 96;
    if (by < 140 || by > 760 || bx < 520 || bx + 420 > 1480) return;
    this.line(x + (right ? s / 2 : -s / 2), y - s / 2, lx, ly, col, 1, a);
    this.line(lx, ly, right ? lx + 10 : lx - 10, ly, col, 1, a);
    const pa = clamp01(age / 0.35);
    this.rect(bx, by, 420, 128, 'rgba(2,8,18,0.72)', a * pa);
    this.srect(bx, by, 420, 128, col, 1, 0.6 * a * pa);
    const title = n.blocked ? 'ACCESS DENIED — WAF' : (n.title || n.path).slice(0, 34);
    this.text(this.decode(title.toUpperCase(), clamp01(age / 0.5), i), bx + 12, by + 26, col, 17, LAB, 'left', 700, a * pa);
    this.text(n.path.slice(0, 46), bx + 12, by + 48, C.dim, 13, MONO, 'left', 400, a * pa);
    this.text(`${n.blocked ? '303→503' : n.status}  ${n.ms}MS  ${fmtBytes(n.bytes || 0)}  DOM ${n.dom || 0}  W ${n.words || 0}`, bx + 12, by + 70, C.white, 14, MONO, 'left', 400, a * pa);
    // DOM barcode: one bar per tag, coloured by tag category
    const seq = n.seq || '';
    const bw = 396 / Math.max(120, seq.length);
    for (let j = 0; j < seq.length; j++) {
      const c = +seq[j];
      if (c === 5 && j < 40) continue;
      this.rect(bx + 12 + j * bw, by + 84, Math.max(1, bw * 0.8), 30, CAT_COL[c] || '#888', a * pa * (j / seq.length < clamp01(age / 0.6) ? 0.9 : 0));
    }
  }

  hex(H, a) {
    const { t } = H;
    const cols = [[22, 0], [1886, 1]];
    for (const [x, side] of cols) {
      for (let r = 0; r < 34; r++) {
        const row = Math.floor(t * 12) + r;
        const v = Math.floor(hash(row, side * 99) * 0xffff).toString(16).toUpperCase().padStart(4, '0');
        this.text(v, x, 160 + r * 26, r % 7 === 0 ? C.mag : C.cyan, 12, MONO, 'left', 400, a * (0.15 + 0.35 * hash(row, 3)));
      }
    }
  }

  ranking(H, a) {
    const { m } = H, x = 76, y = 420;
    const top = H.rankList || [];
    this.panel(x, y, 520, 40 + top.length * 30, 'PRIORITY TARGETS  ·  PAGERANK', a, C.mag);
    top.forEach((n, i) => {
      const p = clamp01((H.t - (H.rankStart || 0) - i * 0.25) / 0.6);
      if (p <= 0) return;
      this.text(pad(i + 1, 2), x + 14, y + 32 + i * 30, C.mag, 16, MONO, 'left', 400, a * p);
      this.text(this.decode((n.title || n.path).slice(0, 40).toUpperCase(), p, i), x + 52, y + 32 + i * 30, C.white, 16, LAB, 'left', 700, a * p);
      this.rect(x + 420, y + 21 + i * 30, 86 * (n.prn || 0) * p, 8, n.sec.color, a);
    });
  }

  legend(H, a) {
    const L = H.legendItems || [];
    const x = 960 - L.length * 95, y = 990;
    L.forEach(([lab, col], i) => { this.rect(x + i * 190, y - 10, 14, 10, col, a); this.text(lab, x + i * 190 + 22, y, C.white, 14, LAB, 'left', 700, a); });
    if (H.legendTitle) this.text(H.legendTitle, 960, y - 24, C.dim, 14, LAB, 'center', 700, a);
  }

  alert(H) {
    const a = H.alert, t = H.t;
    const blink = 0.8 + 0.2 * Math.sign(Math.sin(t * 9));
    this.rect(560, 150, 800, 64, 'rgba(40,0,6,0.8)', a);
    this.srect(560, 150, 800, 64, C.red, 2, a * blink);
    for (let i = 0; i < 26; i++) this.rect(560 + i * 31, 214, 18, 6, C.red, a * 0.6 * ((i + Math.floor(t * 10)) % 2));
    this.glowText(H.alertText || '⚠ COUNTERMEASURES DETECTED', 960, 194, C.red, 30, HEAD, 'center', 900, a * blink, 24);
    if (H.alertSub) this.text(H.alertSub, 960, 246, C.red, 16, MONO, 'center', 400, a);
  }

  card(H, c) {
    const { t } = H, age = t - c.t0, dur = c.t1 - c.t0;
    const a = clamp01(age / 0.25) * clamp01((dur - age) / 0.5);
    if (a <= 0) return;
    const jit = age < 0.4 ? (hash(Math.floor(t * 30)) - 0.5) * 30 : 0;
    const y = c.y ?? 540;
    if (c.kicker) this.text(c.kicker, 960, y - 64, C.mag, 22, LAB, 'center', 700, a);
    const s = this.decode(c.title, clamp01(age / 0.7), 5);
    // rgb split title
    this.glowText(s, 960 - 4 + jit, y, 'rgba(255,40,214,0.8)', c.size || 96, HEAD, 'center', 900, a * 0.8, 0);
    this.glowText(s, 960 + 4 - jit, y, 'rgba(0,240,255,0.8)', c.size || 96, HEAD, 'center', 900, a * 0.8, 0);
    this.glowText(s, 960, y, C.white, c.size || 96, HEAD, 'center', 900, a, 30);
    if (c.sub) this.text(this.decode(c.sub, clamp01((age - 0.3) / 0.8), 9), 960, y + 52, C.cyan, 22, MONO, 'center', 400, a);
  }

  summary(H, a) {
    const S = H.summaryRows || [];
    const x = 610, y = 300, w = 700;
    this.rect(x, y, w, 90 + S.length * 44, 'rgba(2,8,18,0.7)', a);
    this.brackets(x, y, w, 90 + S.length * 44, 18, C.cyan, 2, a);
    this.glowText('MISSION REPORT', 960, y + 52, C.cyan, 34, HEAD, 'center', 900, a, 18);
    S.forEach(([k, v, col], i) => {
      const p = clamp01((H.t - (H.summaryStart || 0) - i * 0.35) / 0.6);
      this.text(k, x + 40, y + 110 + i * 44, C.dim, 18, LAB, 'left', 700, a * p);
      this.text(this.decode(v, p, i * 7), x + w - 40, y + 110 + i * 44, col || C.white, 22, MONO, 'right', 400, a * p);
    });
  }
}
