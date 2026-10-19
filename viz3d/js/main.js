// ArachNet viz3d — entry point.
//   ?mode=render  deterministic: window.__ready, window.__frame(f) (used by video3d/render3d.mjs)
//   ?mode=replay  recorded run + baked audio, real time in the browser (press space)
//   ?mode=live    live SSE feed from `node crawler/crawl.mjs <url> --live <port>`
// Params: run=<dir with crawl.json/events.json>, audio=<dir with audio.json/.bin/track.wav>
import * as THREE from 'three';
import { BakedAudio, LiveAudio } from './audio.js';
import { CrawlModel, lastLE } from './model.js';
import { Environment } from './env.js';
import { GraphView } from './graph.js';
import { CityView } from './city.js';
import { Spider } from './spider.js';
import { HUD } from './hud.js';
import { Post } from './post.js';
import { Director } from './director.js';

const Q = new URLSearchParams(location.search);
const MODE = Q.get('mode') || 'replay';
const RUN = Q.get('run') || 'run/';
const AUDIO = Q.get('audio') || 'audio/';
const W = +(Q.get('w') || (MODE === 'render' ? 1920 : innerWidth));
const H = +(Q.get('h') || (MODE === 'render' ? 1080 : innerHeight));
const FPS = +(Q.get('fps') || 60);

async function loadFonts() {
  const fams = ['900 40px Orbitron', '700 40px Orbitron', '400 20px "Share Tech Mono"', '700 20px Rajdhani', '600 20px Rajdhani'];
  await Promise.all(fams.map(f => document.fonts.load(f)));
  await document.fonts.ready;
}

function neonEnvironment(renderer) {
  // a tiny emissive "room" for metallic reflections on the spider
  const s = new THREE.Scene();
  const box = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20), new THREE.MeshBasicMaterial({ color: '#010208', side: THREE.BackSide }));
  s.add(box);
  const panel = (c, x, y, z, w, h, ry = 0, rx = 0) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide })); m.position.set(x, y, z); m.rotation.set(rx, ry, 0); s.add(m); };
  panel(new THREE.Color(0, 2.2, 2.6), -9, 3, 0, 4, 14, Math.PI / 2);
  panel(new THREE.Color(2.4, 0.2, 2.0), 9, 2, 2, 3, 10, -Math.PI / 2);
  panel(new THREE.Color(2.5, 0.1, 0.2), 0, 9.5, 0, 6, 1.5, 0, Math.PI / 2);
  panel(new THREE.Color(0.4, 0.6, 1.2), 0, 1, -9, 12, 2);
  const pm = new THREE.PMREMGenerator(renderer);
  const env = pm.fromScene(s, 0.02).texture;
  pm.dispose();
  return env;
}

async function boot() {
  await loadFonts();
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: MODE === 'render', alpha: false });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, MODE !== 'render');
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.getElementById('stage').appendChild(renderer.domElement);
  if (MODE === 'render') { renderer.domElement.style.width = W + 'px'; renderer.domElement.style.height = H + 'px'; }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#020309');
  scene.fog = new THREE.FogExp2('#03040c', 0.004);
  scene.environment = neonEnvironment(renderer);
  scene.add(new THREE.HemisphereLight('#3050ff', '#ff2bd6', 0.25));
  const key = new THREE.DirectionalLight('#9fe8ff', 1.2); key.position.set(-30, 50, 20); scene.add(key);
  const rim = new THREE.DirectionalLight('#ff2bd6', 1.4); rim.position.set(40, 20, -40); scene.add(rim);

  const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 4000);
  const hudCanvas = document.createElement('canvas'); hudCanvas.width = W; hudCanvas.height = H;
  const hud = new HUD(hudCanvas);
  const post = new Post(renderer, scene, camera, W, H);
  post.setHud(hudCanvas);

  if (MODE === 'live') return (await import('./live.js')).startLive({ THREE, renderer, scene, camera, hud, post, W, H, RUN, AUDIO });

  // ---------------------------------------------------------------- recorded
  const audio = await BakedAudio.load(AUDIO);
  const [crawl, events] = await Promise.all([fetch(RUN + 'crawl.json').then(r => r.json()), fetch(RUN + 'events.json').then(r => r.json())]);
  const duration = +(Q.get('duration') || audio.duration);
  const director = new Director({ audio, duration, host: crawl.host });
  const T = director.T;
  const model = CrawlModel.fromRecorded(crawl, events, { start: T.crawl, ice: T.ice, end: T.crawlEnd, bpm: audio.bpm, grid0: audio.beats[0] || 0 });
  model.meta.rootHeaders = crawl.nodes[0]?.headers || {};
  director.setModel(model);

  const env = new Environment(scene);
  const graph = new GraphView(scene, model, { maxNodes: model.nodes.length + 8, maxEdges: model.edges.length + 8 });
  graph.sync();
  const city = new CityView(scene, model, { riseStart: T.city + 2.2 });
  const spider = new Spider(scene, { scale: 1.5 });
  const ground = (x, z) => city.ground(x, z, simT);
  spider.onPlant = (foot, L, t) => {
    if (t < T.city || t > T.core) return;
    const i = city.towerAt(foot.x, foot.z);
    if (i >= 0) { city.hit(i, t); graph.hit(i, t); }
  };

  // real-crawl rates for the HUD
  const realT = model.nodes.map(n => n.realT);
  const realRate = k => { if (k < 0) return 0; const t1 = realT[k], i0 = lastLE(realT, t1 - 10); return (k - i0) / 10; };
  const rateSpark = k => { const out = []; if (k < 0) return [0, 0]; const t1 = realT[k]; for (let s = 39; s >= 0; s--) { const te = t1 - s * 3, a = lastLE(realT, te - 10), b = lastLE(realT, te); out.push(Math.min(1, (b - a) / 10 / 6)); } return out; };

  const st = model.meta.stats || {};
  const hh = model.meta.rootHeaders;
  const srv = [hh.server, hh['strict-transport-security'] && 'HSTS', hh['content-security-policy'] && 'CSP', hh['x-frame-options'] && 'XFO'].filter(Boolean).join(' · ');
  const L = T.lock;
  const targetRows = [
    ['HOST', crawl.host.toUpperCase(), '#e8f6ff', L + 1.0],
    ['SERVER', srv.toUpperCase() || 'UNKNOWN', '#e8f6ff', L + 2.2],
    ['ROBOTS.TXT', `${crawl.robots.status} → ${crawl.robots.groups?.length ? crawl.robots.groups.length + ' GROUPS' : 'NO RULES'}`, '#ffb000', L + 3.4],
    ['SITEMAP', `${st.sitemapUrls} URLS`, '#00f0ff', L + 4.6],
    ['GOVERNOR', `${crawl.options.concurrency} THREADS · ${crawl.options.delay} MS GATE`, '#e8f6ff', L + 5.8],
    ['LAUNCH', (crawl.startedAt || '').replace('T', ' ').slice(0, 19) + ' UTC', '#9fdcff', L + 7.0],
  ];
  const red = '#ff1e3c', cy = '#00f0ff', dm = '#7fb8cc';
  const TRACK = (Q.get('track') || audio.meta.title || (audio.meta.source || '').replace(/\.wav$/i, '')).toUpperCase();
  const bootLines = [
    [0.0, 'ARACHNET BIOS 1.0.0  ·  FORK OF CYOHEI9907/WEB-CRAWLERS', dm],
    [0.7, 'MEMORY TEST ........................................ 65536 MB OK', dm],
    [1.4, 'LOADING KERNEL arachnet.ko ......................... OK', cy],
    [2.1, 'MOUNTING SILK FILESYSTEM ........................... OK', cy],
    [2.8, 'LEG ACTUATORS 1-8 .................................. CALIBRATED', cy],
    [3.5, 'OPTICAL ARRAY  ·  8 EYES ........................... ONLINE', red],
    [4.2, 'ROBOTS.TXT COMPLIANCE MODULE ....................... ARMED', cy],
    [4.9, `POLITENESS GOVERNOR  ·  ${crawl.options.concurrency} THREADS  ·  ${crawl.options.delay} MS GATE`, cy],
    [5.6, `RECORDED SESSION  ·  ${(st.fetched || 0)} REQUESTS  ·  ${(st.duration / 1000 / 60).toFixed(1)} MIN`, cy],
    [6.3, `AUDIO LINK  ·  "${TRACK}"  ·  ${audio.bpm.toFixed(0)} BPM`, '#ff2bd6'],
    [7.0, `TARGET VECTOR  ·  ${crawl.seed}`, '#e8f6ff'],
    [7.8, 'AWAKENING', red],
  ];
  const okN = model.nodes.filter(n => !n.blocked).length;
  const blkN = model.nodes.length - okN;
  const summaryRows = [
    ['PAGES MAPPED', okN.toLocaleString('en-US'), cy],
    ['LINKS TRACED', (st.edges || 0).toLocaleString('en-US'), cy],
    ['DATA INGESTED', (st.bytes / 1048576).toFixed(1) + ' MB', '#e8f6ff'],
    ['MEDIAN TTFB', (st.ttfb?.p50 ?? 0) + ' MS', '#e8f6ff'],
    ['SECTORS', String(model.sectionList.filter(s => s.count > 0).length), '#e8f6ff'],
    ['EXTERNAL DOMAINS', String(st.externalDomains || 0), '#e8f6ff'],
    ['WAF BOUNCES', String(blkN), red],
  ];

  let simT = 0;
  const DT = 1 / 60;
  const ctx = {
    spider, graphCenter: [0, 40, 0],
    graphWorld: k => { const n = model.nodes[k]; return { x: n.gx, y: n.gy + 40, z: n.gz }; },
  };
  const advance = t => {
    while (simT < t - 1e-6) {
      const goal = director.spiderGoal(simT, ctx);
      audio.update(simT);
      spider.step(DT, simT, goal, ground, audio.frame, { speed: simT > T.city && simT < T.core ? 7 : 9 });
      simT += DT;
    }
  };
  const proj = new THREE.Vector3();
  const tmpV = new THREE.Vector3();
  const project = i => {
    graph.world(i, proj); proj.project(camera);
    if (proj.z > 1) return { behind: true };
    return { x: (proj.x * 0.5 + 0.5) * 1920, y: (-proj.y * 0.5 + 0.5) * 1080 };
  };

  function frameAt(t) {
    advance(t);
    const A = audio.update(t);
    const P = director.params(t, A);
    ctx.spiderPos = [spider.pos.x, spider.bodyY, spider.pos.z]; ctx.spiderHeading = spider.heading;
    const cam = director.camera(t, A, ctx);
    camera.position.set(...cam.pos); camera.up.set(Math.sin(cam.roll), Math.cos(cam.roll), 0); camera.lookAt(...cam.look);
    camera.fov = cam.fov; camera.aspect = W / H; camera.updateProjectionMatrix();
    // floor shockwaves: the last strong beats (stateless)
    env.resetRings();
    for (let b = Math.max(0, A.beatIndex - 7); b <= A.beatIndex; b++) if (b >= 0 && (b % 2 === 0 || t > T.prolif)) env.shockwave(audio.beats[b]);
    env.floorMat.uniforms.uOrigin.value.set(spider.pos.x, spider.pos.z);
    env.update(t, A, audio, P);
    graph.update(t, A, P, spider, P.city > 0 ? city : null);
    city.update(t, A, P);
    spider.updateMeshes(t, A, P);
    spider.root.scale.setScalar(1);
    spider.root.visible = P.spiderReveal > 0.01;
    const Hd = director.hud(t, A, ctx);
    Object.assign(Hd, { t, A, m: model, project, targetRows, bootLines, bootStart: 0.8, summaryRows, summaryStart: T.outro + 3.5,
      realRate, rateSpark, trackName: TRACK, spiderXZ: [spider.pos.x, spider.pos.z], downPhase: 0 });
    hud.draw(Hd);
    post.render({ uTime: t, uAberr: P.aberr, uGlitch: P.glitch, uScan: P.scan, uGrain: P.grain, uVignette: P.vignette, uFlash: P.flash, flashColor: P.flashColor,
      uFade: P.fade, uHudAlpha: P.hudAlpha, uSeed: P.seed, uInvert: P.invert, tint: P.tint, bloom: P.bloom, bloomRadius: P.bloomRadius });
  }

  window.__info = { frames: Math.round(duration * FPS), fps: FPS, duration, T, nodes: model.nodes.length, edges: model.edges.length };
  window.__frame = f => { frameAt(f / FPS); return true; };
  window.__seek = f => { advance(f / FPS); return true; };

  if (MODE === 'render') { window.__ready = true; return; }

  // replay: real time with the actual track
  const el = new Audio(AUDIO + 'track.wav'); el.preload = 'auto';
  let t0 = null, paused = true, start = +(Q.get('t') || 0);
  const ui = document.getElementById('ui');
  ui.textContent = 'CLICK / SPACE TO ENGAGE';
  const toggle = async () => {
    if (paused) { el.currentTime = start; await el.play(); paused = false; ui.textContent = ''; }
    else { el.pause(); paused = true; start = el.currentTime; ui.textContent = 'PAUSED'; }
  };
  addEventListener('keydown', e => { if (e.code === 'Space') toggle(); });
  addEventListener('click', toggle);
  if (start > 0) advance(start);
  const loop = () => {
    const t = paused ? start : el.currentTime;
    if (t < simT - 0.5) { simT = 0; spider.placed = false; }        // seek backwards: re-simulate
    frameAt(t);
    requestAnimationFrame(loop);
  };
  loop();
}

boot().catch(e => { console.error(e); document.getElementById('ui').textContent = 'ERROR: ' + e.message; window.__error = String(e.stack || e); });
