// ArachNet page overlay — runs inside the real website (injected as a module
// from the local helper server). Drives the spider (inject/spider.js), the HUD,
// the 3D layer and the page "infection" from one clock:
//   render mode: the harness calls __arach.frame(t) once per video frame
//   live mode:   its own requestAnimationFrame loop, live audio
const cfg = window.__arachCfg;
const B = cfg.base;
const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
const ease = x => { x = clamp01(x); return x * x * (3 - 2 * x); };

const [{ BakedAudio, LiveAudio }, { WebHUD }, { create3D }, THREE] = await Promise.all([
  import(B + 'viz/js/audio.js'), import(B + 'inject/webhud.js'), import(B + 'inject/overlay3d.js'), import(B + 'viz/node_modules/three/build/three.module.js'),
]);

// fonts (FontFace API: unaffected by the page's CSS)
const F = B + 'viz/node_modules/@fontsource/';
await Promise.all([
  ['Orbitron', 'orbitron/files/orbitron-latin-900-normal.woff2', '900'], ['Orbitron', 'orbitron/files/orbitron-latin-700-normal.woff2', '700'],
  ['Share Tech Mono', 'share-tech-mono/files/share-tech-mono-latin-400-normal.woff2', '400'],
  ['Rajdhani', 'rajdhani/files/rajdhani-latin-700-normal.woff2', '700'], ['Rajdhani', 'rajdhani/files/rajdhani-latin-600-normal.woff2', '600'],
].map(async ([fam, file, weight]) => { const f = new FontFace(fam, `url(${F + file})`, { weight }); await f.load(); document.fonts.add(f); }));

const graph = await (await fetch(B + 'build/web-graph.json')).json();
let audio;
if (cfg.mode === 'live' && !cfg.trackUrl) audio = new LiveAudio(new Audio());
else if (cfg.mode === 'live') {
  const el = new Audio(cfg.trackUrl);               // compressed (live.mjs turns big WAVs into Opus): a 90 MB file through request interception crashes the tab el.crossOrigin = 'anonymous'; el.loop = true;
  audio = new LiveAudio(el); window.__arachAudioEl = el;
  el.addEventListener('loadedmetadata', () => { el.currentTime = (cfg.audioOffset || 0) % (el.duration || 1e9); }, { once: true });
  audio.start().then(() => el.play()).catch(() => {});
} else audio = await BakedAudio.load(B + 'build/');

// ---------------------------------------------------------------- layers
const W = innerWidth, H = innerHeight;
const host = document.createElement('arachnet-hud');
host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; display: block; contain: strict;';
const shadow = host.attachShadow({ mode: 'closed' });
const c3 = document.createElement('canvas'), c2 = document.createElement('canvas');
for (const c of [c3, c2]) { c.style.cssText = 'position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; pointer-events: none;'; shadow.appendChild(c); }
c3.width = W; c3.height = H;
const hud = new WebHUD(c2); hud.resize(W, H);
const three = await create3D({ THREE, canvas: c3, graph, W, H });

// the page's look: a style element we steer with custom properties on <html>
const style = document.createElement('style');
style.textContent = `
  body { filter: var(--arach-filter, none) !important; transform: var(--arach-shift, none); transform-origin: 50% 0; }
  body img, body picture, body video, body iframe { filter: var(--arach-media, none) !important; }
  html[data-arach-neg] { background: var(--arach-bg) !important; }
  ::selection { background: #ff2bd6; color: #fff; }`;
document.head.appendChild(style);
const root = document.documentElement;
// dark sites: the takeover is a neon grade (a blend layer over the page), not a negative
const tint = document.createElement('arachnet-tint');
tint.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; display: block; opacity: 0; mix-blend-mode: color-dodge; background: radial-gradient(ellipse at 30% 20%, rgba(0,240,255,.55), transparent 60%), radial-gradient(ellipse at 75% 80%, rgba(255,43,214,.5), transparent 60%);';
if (cfg.seg.darkSite) document.documentElement.appendChild(tint);

// ---------------------------------------------------------------- spider
const seg = cfg.seg;
const sp = window.__arachSpider;
let wordsRead = cfg.wordsBefore || 0;
sp.onWord = (text, x, y, now) => { wordsRead++; hud.word(text, lastT); };
let started = false;
const startSpider = () => { if (started) return; started = true; sp.start({ autoRead: true, size: seg.spiderSize || 'XXL', density: 'wild', enter: seg.enter || { x: W * 0.5, y: H * 0.42 } }); if (seg.cruise) sp.tune({ cruise: seg.cruise }); document.documentElement.appendChild(host); };
if ((seg.spiderAt ?? -1e9) <= seg.t0) startSpider();
else document.documentElement.appendChild(host);

// find the real link element on this page (positions are re-read live every frame)
let linkEl = null;
if (seg.link) {
  let best = 1e9;
  for (const a of document.querySelectorAll('a[href]')) {
    let u; try { u = new URL(a.getAttribute('href'), location.href); u.hash = ''; } catch { continue; }
    if (u.href !== seg.link.href) continue;
    const r = a.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const d = Math.abs(r.left + scrollX - seg.link.x) + Math.abs(r.top + scrollY - seg.link.y);
    if (d < best) { best = d; linkEl = a; }
  }
}
let lured = false, arrivedAt = -1;

function themeAt(t) {
  // keyframes [[t, inv, red]]: inv = how far the page has turned negative, red = firewall tint
  const K = seg.theme || [[0, 0, 0]];
  let i = 0; while (i < K.length - 1 && K[i + 1][0] <= t) i++;
  const a = K[i], b = K[Math.min(K.length - 1, i + 1)];
  const u = b[0] > a[0] ? ease((t - a[0]) / (b[0] - a[0])) : 1;
  return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

const keyAt = (K, t) => { let i = 0; while (i < K.length - 1 && K[i + 1][0] <= t) i++; const a = K[i], b = K[Math.min(K.length - 1, i + 1)]; return b[0] > a[0] ? a[1] + (b[1] - a[1]) * ease((t - a[0]) / (b[0] - a[0])) : a[1]; };
let lastT = seg.t0;
function frame(t, A) {
  lastT = t;
  // consent dialogs can open late (page timers): close them, consenting to nothing — a modal makes the page inert to the spider's hit tests
  for (const d of document.querySelectorAll('dialog[open]')) { try { d.close(); } catch {} }
  if (!started && t >= seg.spiderAt) startSpider();
  sp.audio(A);
  // stop reading downwards once deep enough: the spider roams the visible band instead
  if (started && seg.readMax && sp.pos.py > seg.readMax && sp.options.autoRead) sp.set({ autoRead: false });
  // walk to the link, then hold it
  if (linkEl && !lured && t >= seg.lureAt) {
    lured = true;
    const r = linkEl.getBoundingClientRect();
    sp.lure(r.left + scrollX + Math.min(r.width, 160) * 0.5, r.top + scrollY + r.height * 0.5, () => { arrivedAt = t; });
  }
  // page infection + beat glitches
  let [inv, red] = themeAt(t);
  if (!seg.darkSite && seg.flicker && A.sinceDownbeat < 0.09 && (A.downbeatIndex % 2 === 0)) inv = 1 - inv;
  const hit = A.sinceOnset < 0.06 && A.flux > 0.7;
  const filt = [];
  if (seg.darkSite) {
    // a dark page stays dark: saturate + shift its accents, glow through the blend layer, flash negative on hits
    if (inv > 0.01) filt.push(`saturate(${(1 + 1.6 * inv).toFixed(2)})`, `hue-rotate(${(-25 * inv).toFixed(1)}deg)`, `contrast(${(1 + 0.18 * inv).toFixed(2)})`, `brightness(${(1 + 0.15 * inv).toFixed(2)})`);
    tint.style.opacity = (inv * (0.38 + 0.3 * A.bands[1] + 0.25 * A.kick)).toFixed(3);
    if (seg.flicker && A.sinceDownbeat < 0.07 && A.downbeatIndex % 2 === 0) filt.push('invert(1)', 'hue-rotate(180deg)');
    inv = 0;
  }
  if (inv > 0.01) filt.push(`invert(${inv.toFixed(3)})`, `hue-rotate(${(inv * 180).toFixed(1)}deg)`, `saturate(${(1 + 0.7 * inv).toFixed(2)})`, `contrast(${(1 + 0.12 * inv).toFixed(2)})`);
  if (red > 0.01) filt.push(`sepia(${red.toFixed(2)})`, `hue-rotate(${(-40 * red).toFixed(1)}deg)`, `saturate(${(1 + 3 * red).toFixed(2)})`);
  if (hit) filt.push(`hue-rotate(${(A.flux * 60).toFixed(0)}deg)`);
  root.style.setProperty('--arach-filter', filt.length ? filt.join(' ') : 'none');
  // the page background often sits on <html>, outside the filtered <body>: darken it with the negative
  if (inv > 0.5 || red > 0.3) { root.setAttribute('data-arach-neg', ''); root.style.setProperty('--arach-bg', red > 0.3 ? '#1a0207' : '#04060c'); }
  else root.removeAttribute('data-arach-neg');
  root.style.setProperty('--arach-media', inv > 0.01 ? `invert(${inv.toFixed(3)}) hue-rotate(${(inv * 180).toFixed(1)}deg)` : 'none');
  root.style.setProperty('--arach-shift', hit ? `translateX(${((A.flux - 0.7) * 40 * (A.beatIndex % 2 ? 1 : -1)).toFixed(1)}px) skewX(${(A.flux * 2).toFixed(2)}deg)` : 'none');
  sp.noCover(inv > 0.35);

  // traversal in / out
  let travel = null, travelHud = null;
  for (const T of [seg.travelIn, seg.travelOut]) {
    if (T && t >= T.t0 && t < T.t1) {
      const u = (t - T.t0) / (T.t1 - T.t0);
      travel = { from: T.fromNode, to: T.toNode, u };
      travelHud = { a: Math.min(1, Math.min(u, 1 - u) * 5), from: T.fromPath, to: T.toPath, edge: T.edge };
    }
  }
  const miniA = seg.mini === false ? 0 : clamp01((t - seg.t0) / 0.8) * (travel ? 0 : 1);
  const mini = { x: 1560, y: 128, w: 324, h: 250 };
  three.render({ t, A, routeIdx: seg.routeIdx, mini, miniA, travel, final: seg.final || 0 });

  // HUD
  let lock = null;
  if (linkEl && lured && !(seg.travelOut && t >= seg.travelOut.t0 + 0.6)) {
    const r = linkEl.getBoundingClientRect();
    lock = { x: r.left, y: r.top, w: r.width, h: r.height, arrived: arrivedAt >= 0 || (seg.travelOut && t >= seg.travelOut.t0), path: seg.link.path };
  }
  const kPx = 1920 / W;
  if (lock) { lock.x *= kPx; lock.y *= kPx; lock.w *= kPx; lock.h *= kPx; }
  const cardIn = seg.card && t >= seg.card.t0 && t < seg.card.t1 ? seg.card : null;
  hud.draw({
    t, A, bpm: audio.bpm, phase: seg.phase, track: cfg.track, hud: seg.hud ?? clamp01((t - (seg.hudFrom ?? -1)) / 1.2),
    page: seg.page, pageT0: seg.t0, nodeNo: seg.nodeNo, bounces: cfg.bounces, wordsRead, telemetry: seg.telemetry, mini, miniLabel: seg.miniLabel,
    lock, travel: travelHud, card: cardIn, alert: seg.alert ? clamp01((t - seg.t0) / 0.5) * seg.alert : 0, alertText: seg.alertText, alertSub: seg.alertSub,
    boot: seg.boot ? 1 - ease((t - seg.boot[0]) / (seg.boot[1] - seg.boot[0])) : 0, bootLines: cfg.bootLines,
    summary: seg.summaryRows && t >= seg.summaryAt ? { a: clamp01((t - seg.summaryAt) / 0.8), rows: seg.summaryRows, t0: seg.summaryAt } : null,
    flash: seg.flashes ? Math.max(0, ...seg.flashes.map(([at, amt]) => t >= at && t < at + 0.6 ? amt * Math.exp(-(t - at) * 7) : 0)) : 0,
    fadeBlack: seg.fade ? keyAt(seg.fade, t) : 0, grain: (seg.alert || 0) * 0.04, vignette: red * 0.2,
  });
}

window.__arach = {
  ready: true,
  frame(t) { frame(t, audio.update(t)); return sp.pos; },
  get spider() { return sp.pos; },
};
if (cfg.mode === 'live') {
  const t0 = performance.now() / 1000 - seg.t0;
  const loop = () => { const t = performance.now() / 1000 - t0; frame(t, audio.update(t)); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}
