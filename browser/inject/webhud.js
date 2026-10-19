// HUD for the spider-on-the-real-website view. The site stays the stage: panels
// live in the page margins (left: the words the spider reads, right: link space
// and telemetry, bottom: the page's real crawl data and the signal), the top
// shows the address being read. Pure function of (time, state).

const C = { cyan: '#00f0ff', mag: '#ff2bd6', red: '#ff1e3c', amber: '#ffb000', white: '#e8f6ff', dim: 'rgba(170,225,255,0.62)', panel: 'rgba(2,6,16,0.74)' };
const CAT_COL = ['#2e7bff', '#ff2bd6', '#9fdcff', '#00f0ff', '#39ff88', '#5a5f7a', '#ffb000', '#7c4dff', '#c6ff00', '#333a55'];
const MONO = '"Share Tech Mono", monospace', HEAD = 'Orbitron, sans-serif', LAB = 'Rajdhani, sans-serif';
const GLY = '01アイウエオカキクケコサシスセソ#$%&@ABCDEF';
const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
const hash = (a, b = 0) => { let x = (a * 374761393 + b * 668265263) | 0; x = Math.imul(x ^ (x >>> 13), 1274126177); return ((x ^ (x >>> 16)) >>> 0) / 4294967296; };
const pad = (n, w) => String(n).padStart(w, '0');
const kb = b => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(1) + ' KB';
const tc = t => `${pad(Math.floor(t / 60), 2)}:${pad(Math.floor(t % 60), 2)}:${pad(Math.floor((t % 1) * 60), 2)}`;

export class WebHUD {
  constructor(canvas) {
    this.cv = canvas; this.g = canvas.getContext('2d');
    this.words = [];                     // [text, t]
    this.noise = document.createElement('canvas'); this.noise.width = this.noise.height = 256;
    const ng = this.noise.getContext('2d'), id = ng.createImageData(256, 256);
    for (let i = 0; i < id.data.length; i += 4) { const v = hash(i, 7) * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
    ng.putImageData(id, 0, 0);
  }
  resize(w, h) { this.W = w; this.H = h; this.k = w / 1920; this.cv.width = w; this.cv.height = h; }
  word(text, t) { this.words.unshift([text, t]); if (this.words.length > 40) this.words.pop(); }

  font(size, fam = MONO, weight = 400) { this.g.font = `${weight} ${Math.round(size * this.k)}px ${fam}`; }
  text(s, x, y, color = C.white, size = 18, fam = MONO, align = 'left', weight = 400, alpha = 1, glow = 0) {
    const g = this.g; this.font(size, fam, weight); g.textAlign = align; g.globalAlpha = alpha; g.fillStyle = color;
    if (glow) { g.shadowColor = color; g.shadowBlur = glow * this.k; }
    g.fillText(s, x * this.k, y * this.k); g.shadowBlur = 0; g.globalAlpha = 1;
  }
  rect(x, y, w, h, color, alpha = 1) { const g = this.g, k = this.k; g.globalAlpha = alpha; g.fillStyle = color; g.fillRect(x * k, y * k, w * k, h * k); g.globalAlpha = 1; }
  line(x0, y0, x1, y1, color = C.cyan, w = 1, alpha = 1) { const g = this.g, k = this.k; g.globalAlpha = alpha; g.strokeStyle = color; g.lineWidth = w * k; g.beginPath(); g.moveTo(x0 * k, y0 * k); g.lineTo(x1 * k, y1 * k); g.stroke(); g.globalAlpha = 1; }
  brackets(x, y, w, h, s = 12, color = C.cyan, lw = 1.5, alpha = 1) {
    const L = (a, b, c, d) => this.line(a, b, c, d, color, lw, alpha);
    L(x, y, x + s, y); L(x, y, x, y + s); L(x + w, y, x + w - s, y); L(x + w, y, x + w, y + s);
    L(x, y + h, x + s, y + h); L(x, y + h, x, y + h - s); L(x + w, y + h, x + w - s, y + h); L(x + w, y + h, x + w, y + h - s);
  }
  panel(x, y, w, h, title, a, color = C.cyan) {
    this.rect(x, y, w, h, C.panel, a);
    this.brackets(x, y, w, h, 12, color, 1.5, a);
    if (title) { this.rect(x, y - 20, title.length * 9 + 22, 18, color, 0.22 * a); this.text(title, x + 8, y - 6, color, 13, LAB, 'left', 700, a); }
  }
  decode(s, p, seed = 0) {
    if (p >= 1) return s;
    const n = Math.floor(s.length * p); let out = s.slice(0, n);
    for (let i = n; i < Math.min(s.length, n + 5); i++) out += s[i] === ' ' ? ' ' : GLY[Math.floor(hash(i, seed + Math.floor(p * 50)) * GLY.length)];
    return out;
  }

  draw(S) {
    const g = this.g, { t, A } = S;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.W, this.H);
    const a = S.hud ?? 1;
    if (S.boot) this.boot(S);
    if (a > 0) {
      this.frame(S, a);
      if (S.page) this.pagePanel(S, a);
      this.signal(S, a);
      this.readStream(S, a);
      this.telemetry(S, a);
      if (S.lock) this.lockOn(S, a);
    }
    if (S.travel) this.travel(S);
    if (S.card) this.card(S, S.card);
    if (S.alert > 0.01) this.alert(S);
    if (S.summary) this.summary(S);
    this.post(S);
  }

  boot(S) {
    const { t } = S, B = S.bootLines || [];
    this.rect(0, 0, 1920, 1080, '#020309', S.boot);
    let y = 170;
    for (const [at, s, col] of B) {
      if (t < at) break;
      const p = clamp01((t - at) / Math.max(0.15, s.length * 0.012));
      this.text(s.slice(0, Math.floor(s.length * p)) + (p < 1 && Math.floor(t * 8) % 2 ? '█' : ''), 140, y, col || C.cyan, 22, MONO, 'left', 400, Math.min(1, S.boot * 1.5));
      y += 33;
    }
  }

  frame(S, a) {
    const { t, A } = S;
    this.brackets(22, 22, 1876, 1036, 40, C.cyan, 2, 0.7 * a);
    // top-left: unit
    this.rect(36, 30, 330, 64, C.panel, 0.55 * a);
    this.text('ARACHNET', 48, 72, C.cyan, 30, HEAD, 'left', 900, a, 16);
    this.text('/[•]\\', 252, 70, C.mag, 24, MONO, 'left', 400, a);
    this.text('SPIDER ON LIVE DOM  ·  BUILD 1.0', 50, 90, C.dim, 12, LAB, 'left', 600, a);
    // top-right: rec + timecode
    this.rect(1560, 30, 324, 64, C.panel, 0.55 * a);
    if (Math.floor(t * 2) % 2 === 0) { g2(this, 1582, 56, 7, C.red, a); }
    this.text('REC', 1596, 63, C.red, 18, HEAD, 'left', 700, a);
    this.text('T+' + tc(t), 1868, 63, C.white, 20, MONO, 'right', 400, a);
    this.text(`${(S.bpm || 100).toFixed(0)} BPM  ·  BAR ${pad(Math.max(0, (A.bar ?? 0) + 1), 3)}  ·  ${S.phase || ''}`, 1868, 86, C.dim, 12, MONO, 'right', 400, a);
    // address bar: what is being read right now
    if (S.page) {
      const p = S.page, age = t - S.pageT0;
      const url = (p.url || '').replace(/^https?:\/\//, '');
      const shown = this.decode(url, clamp01(age / 1.2), 3);
      this.font(15, MONO); const w = Math.min(980, this.g.measureText(shown).width / this.k + 150);
      const x = 960 - w / 2;
      this.rect(x, 36, w, 34, C.panel, 0.8 * a);
      this.brackets(x, 36, w, 34, 8, p.blocked ? C.red : C.cyan, 1.2, a);
      const st = p.blocked ? '503' : String(p.status ?? '—');
      this.rect(x + 8, 42, 48, 22, p.blocked ? C.red : p.status >= 300 ? C.amber : C.cyan, 0.9 * a);
      this.text(st, x + 32, 59, '#02060f', 15, HEAD, 'center', 900, a);
      this.text(shown.slice(0, 110), x + 66, 59, C.white, 15, MONO, 'left', 400, a);
    }
  }

  pagePanel(S, a) {
    const p = S.page, { t } = S, x = 36, y = 862, w = 560, h = 180;
    const pa = a * clamp01((t - S.pageT0 - 0.3) / 0.6);
    if (pa <= 0) return;
    this.panel(x, y, w, h, 'INTERCEPT  ·  NODE ' + pad(S.nodeNo || 0, 4), pa, p.blocked ? C.red : C.cyan);
    const title = (p.title || p.path || '').replace(/\s*\|\s*Stadt Dreieich\s*$/i, '').toUpperCase();
    this.text(this.decode(title.slice(0, 44), clamp01((t - S.pageT0) / 1.4), 11), x + 14, y + 30, p.blocked ? C.red : C.white, 19, LAB, 'left', 700, pa);
    const cells = p.blocked
      ? [['STATUS', '303→503'], ['WAF', 'ENGAGED'], ['BOUNCES', String(S.bounces || 618)], ['ACCESS', 'DENIED']]
      : [['TTFB', (p.ttfb ?? '—') + ' MS'], ['SIZE', p.bytes ? kb(p.bytes) : '—'], ['DOM', String(p.dom ?? '—')], ['WORDS', String(p.words ?? '—')], ['LINKS', String(p.links ?? '—')], ['DEPTH', String(p.depth ?? '—')]];
    cells.forEach(([k, v], i) => {
      const cx = x + 14 + (i % 3) * 182, cy = y + 60 + Math.floor(i / 3) * 40;
      this.text(k, cx, cy, C.dim, 12, LAB, 'left', 700, pa);
      this.text(v, cx, cy + 20, p.blocked ? C.red : C.cyan, 18, MONO, 'left', 400, pa, 8);
    });
    // DOM barcode: one bar per tag of this real page, coloured by tag type
    const seq = p.seq || '';
    if (seq) {
      const bw = (w - 28) / Math.max(160, seq.length);
      const reveal = clamp01((t - S.pageT0 - 0.5) / 1.5);
      for (let j = 0; j < seq.length && j / seq.length < reveal; j++) this.rect(x + 14 + j * bw, y + 150, Math.max(1, bw * 0.8), 18, CAT_COL[+seq[j]] || '#888', 0.9 * pa);
    }
  }

  signal(S, a) {
    const { A } = S, x = 1440, y = 900, w = 444, h = 130;
    this.panel(x, y, w, h, 'SIGNAL  ·  ' + (S.track || ''), a, C.mag);
    const n = A.spec.length, bw = (w - 16) / n;
    for (let i = 0; i < n; i++) { const v = A.spec[i]; this.rect(x + 8 + i * bw, y + h - 6 - v * (h - 30), bw - 1.5, v * (h - 30), i < 12 ? C.mag : i < 40 ? C.cyan : C.white, (0.35 + 0.65 * v) * a); }
    const g = this.g, k = this.k;
    g.globalAlpha = 0.9 * a; g.strokeStyle = C.white; g.lineWidth = 1.4 * k; g.beginPath();
    for (let i = 0; i < 64; i++) { const px = (x + 8 + i / 63 * (w - 16)) * k, py = (y + 40 + A.wave[i] * 26) * k; i ? g.lineTo(px, py) : g.moveTo(px, py); }
    g.stroke(); g.globalAlpha = 1;
    for (let i = 0; i < 4; i++) { const on = A.beatIndex >= 0 && (A.beatIndex % 4) === i; this.rect(x + w - 92 + i * 21, y + 10, 16, 5, on ? C.mag : 'rgba(0,240,255,0.35)', (on ? 0.4 + 0.6 * A.beat : 0.4) * a); }
  }

  readStream(S, a) {
    const { t } = S, x = 40, y = 170;
    this.text('READ STREAM', x, y, C.cyan, 14, LAB, 'left', 700, a);
    this.text(`${(S.wordsRead || 0).toLocaleString('en-US')} WORDS`, x, y + 20, C.dim, 12, MONO, 'left', 400, a);
    this.line(x, y + 28, x + 250, y + 28, C.cyan, 1, 0.35 * a);
    this.words.slice(0, 22).forEach(([w, wt], i) => {
      const age = t - wt;
      if (age < 0) return;
      const fresh = Math.exp(-age * 3);
      const col = i === 0 ? C.white : i % 5 === 0 ? C.mag : C.cyan;
      this.text(this.decode(w.slice(0, 22).toUpperCase(), clamp01(age / 0.25), i), x + fresh * 12, y + 54 + i * 26, col, 17 - Math.min(5, i * 0.25), MONO, 'left', 400, a * (1 - i * 0.04), fresh * 14);
    });
  }

  telemetry(S, a) {
    const x = 1560, y = 420, w = 324;
    const rows = S.telemetry || [];
    this.panel(x, y, w, 40 + rows.length * 34, 'TELEMETRY', a);
    rows.forEach(([k, v, col], i) => {
      this.text(k, x + 12, y + 30 + i * 34, C.dim, 12, LAB, 'left', 700, a);
      this.text(v, x + w - 12, y + 30 + i * 34, col || C.white, 18, MONO, 'right', 400, a, 6);
    });
    // minimap frame (the 3D layer renders inside it)
    const m = S.mini;
    if (m) { this.brackets(m.x, m.y, m.w, m.h, 12, C.cyan, 1.5, a); this.text('LINK SPACE  ·  ' + (S.miniLabel || ''), m.x + 6, m.y - 6, C.cyan, 13, LAB, 'left', 700, a); }
  }

  lockOn(S, a) {
    const L = S.lock, { t } = S;
    const x = L.x, y = L.y, w = Math.max(40, L.w), h = Math.max(18, L.h);
    const pulse = 0.5 + 0.5 * Math.sin(t * 12);
    const col = L.arrived ? C.mag : C.cyan;
    const pad2 = 10 + 6 * pulse;
    this.brackets(x - pad2, y - pad2, w + 2 * pad2, h + 2 * pad2, 12, col, 2.5, a);
    this.rect(x - 4, y - 4, w + 8, h + 8, col, (L.arrived ? 0.28 : 0.1) * a * (0.6 + 0.4 * pulse));
    const lx = Math.min(1500, x + w + 24), ly = Math.max(140, y - 18);
    this.line(x + w + pad2, y + h / 2, lx - 6, ly + 6, col, 1.2, a);
    this.rect(lx, ly - 18, 300, 46, C.panel, 0.85 * a);
    this.text(L.arrived ? 'LINK ACQUIRED' : 'LINK LOCK', lx + 10, ly, col, 15, HEAD, 'left', 900, a, 10);
    this.text('→ ' + (L.path || '').slice(0, 34), lx + 10, ly + 20, C.white, 13, MONO, 'left', 400, a);
  }

  travel(S) {
    const T = S.travel, a = T.a;
    if (a <= 0) return;
    this.text('TRAVERSING LINK', 960, 470, C.cyan, 34, HEAD, 'center', 900, a, 24);
    this.text((T.from || '') + '   ⟶   ' + (T.to || ''), 960, 512, C.white, 18, MONO, 'center', 400, a);
    this.text(`EDGE ${T.edge || ''}`, 960, 540, C.dim, 14, MONO, 'center', 400, a);
  }

  card(S, c) {
    const { t } = S, age = t - c.t0, dur = c.t1 - c.t0;
    const a = clamp01(age / 0.2) * clamp01((dur - age) / 0.5);
    if (a <= 0) return;
    const y = c.y ?? 300;
    const s = this.decode(c.title, clamp01(age / 0.6), 5);
    this.rect(0, y - 92, 1920, 150, 'rgba(2,6,16,0.55)', a * 0.9);
    if (c.kicker) this.text(c.kicker, 960, y - 52, C.mag, 20, LAB, 'center', 700, a);
    const jit = age < 0.35 ? (hash(Math.floor(t * 30)) - 0.5) * 24 : 0;
    this.text(s, 960 - 4 + jit, y, 'rgba(255,43,214,0.8)', c.size || 76, HEAD, 'center', 900, a);
    this.text(s, 960 + 4 - jit, y, 'rgba(0,240,255,0.8)', c.size || 76, HEAD, 'center', 900, a);
    this.text(s, 960, y, C.white, c.size || 76, HEAD, 'center', 900, a, 26);
    if (c.sub) this.text(this.decode(c.sub, clamp01((age - 0.2) / 0.8), 9), 960, y + 40, C.cyan, 20, MONO, 'center', 400, a);
  }

  alert(S) {
    const a = S.alert, t = S.t, blink = 0.8 + 0.2 * Math.sign(Math.sin(t * 9));
    this.rect(560, 120, 800, 62, 'rgba(40,0,6,0.85)', a);
    this.brackets(560, 120, 800, 62, 14, C.red, 2, a * blink);
    this.text(S.alertText || '⚠ COUNTERMEASURES DETECTED', 960, 162, C.red, 28, HEAD, 'center', 900, a * blink, 22);
    if (S.alertSub) this.text(S.alertSub, 960, 206, C.red, 15, MONO, 'center', 400, a);
  }

  summary(S) {
    const sm = S.summary, a = sm.a, rows = sm.rows;
    const x = 610, y = 250, w = 700, h = 100 + rows.length * 44;
    this.rect(x, y, w, h, 'rgba(2,6,16,0.82)', a);
    this.brackets(x, y, w, h, 18, C.cyan, 2, a);
    this.text('MISSION REPORT', 960, y + 54, C.cyan, 34, HEAD, 'center', 900, a, 18);
    rows.forEach(([k, v, col], i) => {
      const p = clamp01((S.t - sm.t0 - i * 0.3) / 0.6);
      this.text(k, x + 40, y + 110 + i * 44, C.dim, 18, LAB, 'left', 700, a * p);
      this.text(this.decode(v, p, i), x + w - 40, y + 110 + i * 44, col || C.white, 22, MONO, 'right', 400, a * p);
    });
  }

  // scanlines, grain, vignette: drawn last so they sit on top of everything
  post(S) {
    const g = this.g, W = this.W, H = this.H;
    g.globalAlpha = 0.07;
    g.fillStyle = '#000';
    for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1);
    g.globalAlpha = 0.045 + (S.grain || 0);
    const ox = Math.floor(hash(Math.floor(S.t * 60), 1) * 256), oy = Math.floor(hash(Math.floor(S.t * 60), 2) * 256);
    g.globalCompositeOperation = 'overlay';
    for (let x = -ox; x < W; x += 256) for (let y = -oy; y < H; y += 256) g.drawImage(this.noise, x, y);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    const vg = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, `rgba(0,0,0,${0.55 + (S.vignette || 0)})`);
    g.fillStyle = vg; g.fillRect(0, 0, W, H);
    if (S.flash > 0) { g.globalAlpha = S.flash; g.fillStyle = S.flashColor || '#fff'; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
    if (S.fadeBlack > 0) { g.globalAlpha = S.fadeBlack; g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
  }
}

function g2(h, x, y, r, col, a) { const g = h.g, k = h.k; g.globalAlpha = a; g.fillStyle = col; g.beginPath(); g.arc(x * k, y * k, r * k, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; }
