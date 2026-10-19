// The spider on the real website, as a music video. Pages come from the local
// capture (capture.mjs) — the site is never contacted. Each page runs on a
// virtual clock (rAF, timers, Date) so every frame is exact; the overlay
// (inject/) draws spider, HUD and 3D. 3D interludes are cut from the viz3d
// render. Everything is assembled on the song's sections and downbeats.
//
//   node render.mjs --still 30,80,150          PNG stills
//   node render.mjs --workers 3                all web segments -> out/web/*.mp4
//   node render.mjs --assemble                 web segments + viz3d interludes + music -> out/arachnet-web.mp4
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, Cache, routeRequests, quietPage, sleep } from './lib/common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const flag = n => process.argv.includes('--' + n);
const BUILD = path.join(ROOT, 'video3d', 'build');
const CACHE = path.resolve(arg('cache', path.join(BUILD, 'webcache')));
const RUN = path.resolve(arg('run', path.join(ROOT, 'runs', 'dreieich')));
const OUT = path.join(ROOT, 'video3d', 'out', 'web');
const MASTER3D = path.resolve(arg('master3d', path.join(ROOT, 'video3d', 'out', 'arachnet-dreieich.mp4')));
const FPS = +arg('fps', 60), W = 1920, H = 1080;
mkdirSync(OUT, { recursive: true });

const route = JSON.parse(readFileSync(path.join(CACHE, 'route.json'), 'utf8'));
const cache = new Cache(CACHE);
const audioMeta = JSON.parse(readFileSync(path.join(BUILD, 'audio.json'), 'utf8'));
const crawl = JSON.parse(readFileSync(path.join(RUN, 'crawl.json'), 'utf8'));
const graph = JSON.parse(readFileSync(path.join(BUILD, 'web-graph.json'), 'utf8'));
const site = new URL(route[0].url).origin + '/';
const mounts = { 'viz/': path.join(ROOT, 'viz3d'), 'inject/': path.join(HERE, 'inject'), 'build/': BUILD };

// ---------------------------------------------------------------- data per page
const byUrl = new Map(crawl.nodes.map(n => [n.url, n]));
const htmlNodes = crawl.nodes.filter(n => n.title !== undefined);
const prRank = new Map(htmlNodes.slice().sort((a, b) => b.pagerank - a.pagerank).map((n, i) => [n.url, i + 1]));
const wafUrl = Object.keys(cache.index).find(u => /\/error_path\/503/.test(u));
const blockedCount = crawl.nodes.filter(n => /error_path/.test(n.redirect || '')).length;
const secName = u => (new URL(u).pathname.split('/').filter(Boolean)[0] || 'root').toUpperCase();
const pathOf = u => { const x = new URL(u); return decodeURIComponent(x.pathname + x.search); };

function pageData(url, title) {
  const n = byUrl.get(url) || byUrl.get(url.replace(/\?.*$/, '')) || {};
  return {
    url, path: pathOf(url), title: n.title || title, status: n.status ?? 200, ttfb: n.ttfb, bytes: n.bytes, dom: n.domNodes, words: n.wordCount,
    links: n.linksInternal, depth: n.clickDepth, seq: (n.tagSeq || '').slice(0, 260), blocked: false,
    pr: prRank.get(n.url), inl: n.inlinks,
  };
}

// ---------------------------------------------------------------- the plan
// pages that list named staff stay out of the video (no people in a 'Skynet' piece)
const staffPage = url => { const h = cache.get(url); return h && /HES:employee/.test(h.body.toString('utf8')); };
const usable = route.map((r, i) => i).filter(i => cache.has(route[i].url) && !staffPage(route[i].url));

function makePlan() {
  const S = audioMeta.sections.map(s => s.start), sec = i => S[i];
  const bar = 240 / audioMeta.bpm;
  const segs = [];
  let ui = 0;
  const web = (t0, t1, o = {}) => segs.push({ kind: 'page', t0, t1, ri: o.ri ?? usable[Math.min(usable.length - 1, ui++)], ...o });
  const v3d = (t0, t1) => segs.push({ kind: '3d', t0, t1 });
  // boot + homepage
  web(0, sec(3), { boot: [12.5, sec(1)], spiderAt: 15.6, hudFrom: sec(1) - 0.6, card: { t0: sec(1) + 0.2, t1: sec(1) + 4.6, kicker: 'PHASE 01  ·  TARGET LOCK', title: new URL(site).host.toUpperCase(), sub: 'SPIDER RELEASED ON LIVE DOM' } });
  let t = sec(3);
  for (let i = 0; i < 4; i++, t += 8 * bar) web(t, t + 8 * bar);
  for (let i = 0; i < 8; i++, t += 4 * bar) web(t, t + 4 * bar, { flicker: true });
  web(t, t + 4 * bar, { alertRamp: true }); t += 4 * bar;
  segs.push({ kind: 'waf', t0: t, t1: t + 4 * bar }); t += 4 * bar;
  v3d(t, sec(11)); t = sec(11);
  for (const b of [8, 8, 8, 4, 4, 2]) { web(t, t + b * bar); t += b * bar; }
  for (let i = 0; i < 5; i++, t += 2 * bar) web(t, t + 2 * bar, { montage: true });
  v3d(t, sec(16)); t = sec(16);
  web(t, sec(17), { ri: 0, finale: true }); t = sec(17);
  v3d(t, audioMeta.duration);

  // decorate: pages, links, traversals, look
  const phase = t => t < sec(1) ? 'BOOT' : t < 40 ? 'PHASE 01 // TARGET LOCK' : t < sec(6) ? 'PHASE 02 // INFILTRATION' : t < sec(9) ? 'PHASE 03 // PROLIFERATION'
    : t < sec(11) ? 'PHASE 04 // COUNTERMEASURES' : t < sec(14) ? 'PHASE 05 // DEEP CRAWL' : t < sec(15) ? 'PHASE 06 // OVERDRIVE' : 'PHASE 07 // RETURN TO ROOT';
  const wafNode = graph.nodes.findIndex(n => graph.palette[n[3]] === '#ff1e3c');
  segs.forEach((s, k) => {
    if (s.kind === '3d') return;
    const next = segs[k + 1];
    s.phase = phase(s.t0 + 0.01);
    s.enter = { x: 960, y: 470 };
    const len = s.t1 - s.t0;
    s.readMax = len > 30 ? 2800 : len > 15 ? 2300 : 1500;
    if (len > 30) s.cruise = 115;
    if (s.kind === 'waf') {
      s.url = wafUrl;
      s.page = { url: wafUrl, path: '/error_path/503.html', title: '503 · SERVICE UNAVAILABLE', status: 503, blocked: true, seq: '' };
      s.routeIdx = Math.min(route.length - 1, segs[k - 1].ri + 1);
      s.alert = 1; s.alertText = '⚠ COUNTERMEASURES DETECTED'; s.alertSub = `WAF BOUNCE 303 → /error_path/503.html  ·  ${blockedCount} REQUESTS DENIED`;
      s.theme = [[s.t0, 1, 0.85], [s.t1, 1, 1]];
      s.card = { t0: s.t0 + 0.3, t1: s.t0 + 3.2, kicker: 'PHASE 04', title: 'ACCESS DENIED', sub: 'THE SITE FIGHTS BACK', y: 560 };
      s.telemetry = [['ROUTE', 'BLOCKED', '#ff1e3c'], ['WAF BOUNCES', String(blockedCount), '#ff1e3c'], ['AFTER', '≈ 900 REQ / 4.5 MIN'], ['RATE', '≈ 3.4 REQ/S'], ['DECISION', 'WITHDRAW', '#ffb000']];
      s.flashes = [[s.t0, 0.8]]; s.miniLabel = 'FIREWALL';
      s.spiderSize = 'XL';
      return;
    }
    const r = route[s.ri % route.length];
    s.url = r.url;
    s.page = pageData(r.url, r.title);
    s.routeIdx = s.ri;
    s.nodeNo = s.ri + 1;
    s.miniLabel = `NODE ${s.ri + 1} / ${route.length}`;
    s.telemetry = [
      ['ROUTE', `${s.ri + 1} / ${route.length}`], ['SITE NODES', crawl.stats.nodes.toLocaleString('en-US')],
      ['PAGERANK', s.page.pr ? `#${s.page.pr} / ${htmlNodes.length}` : '—', '#ff2bd6'], ['INLINKS', String(s.page.inl ?? '—')],
      ['CLICK DEPTH', String(s.page.depth ?? '—')], ['LINKS TRACED', crawl.stats.edges.toLocaleString('en-US')],
    ];
    // walk to the link that really leads to the next page, then traverse it in 3D
    const walk = next && next.kind !== '3d' && !next.montage && !s.montage && (next.kind === 'waf' || (next.kind === 'page' && next.ri === s.ri + 1 && r.next && r.next.href === route[next.ri]?.url && r.next.jumpFrom == null));
    if (walk && r.next) {
      s.link = { ...r.next, path: pathOf(r.next.href) };
      s.lureAt = s.t1 - 1.2 - Math.min(6, (s.t1 - s.t0) * 0.45);
      const toNode = next.kind === 'waf' ? wafNode : graph.route[next.ri];
      s.travelOut = { t0: s.t1 - 1.2, t1: s.t1 + 1.2, fromNode: graph.route[s.ri], toNode, fromPath: s.page.path, toPath: next.kind === 'waf' ? '/error_path/503.html' : pathOf(route[next.ri].url), edge: `${graph.route[s.ri]} → ${toNode}` };
      next.travelIn = s.travelOut;
    } else if (walk && next.kind === 'waf') {
      s.travelOut = { t0: s.t1 - 1.2, t1: s.t1 + 1.2, fromNode: graph.route[s.ri], toNode: wafNode, fromPath: s.page.path, toPath: '/error_path/503.html', edge: 'BLOCKED' };
      next.travelIn = s.travelOut;
    }
    if (!s.travelIn && s.t0 > 1) s.flashes = [[s.t0, s.montage ? 0.5 : 0.7]];
    if (s.t1 - s.t0 >= 9 && !s.card) s.card = { t0: s.t0 + (s.travelIn ? 1.0 : 0.3), t1: s.t0 + (s.travelIn ? 3.8 : 3.1), kicker: `NODE ${String(s.nodeNo).padStart(3, '0')}  //  ${secName(r.url)}`, title: (s.page.title || '').replace(/\s*\|\s*Stadt Dreieich\s*$/i, '').toUpperCase().slice(0, 34), sub: s.page.path.slice(0, 80) };
    // the page's look over the piece: original -> negative flashes -> negative -> red
    const inv = s.t0 < sec(8) ? 0 : 1;
    s.theme = [[s.t0, s.montage ? (s.ri % 2) : inv, 0]];
    if (s.alertRamp) { s.theme = [[s.t0, 1, 0], [s.t1, 1, 0.6]]; s.alert = 0.8; s.alertText = '⚠ ANOMALOUS RESPONSES'; s.alertSub = 'REDIRECT STORM  ·  303 SEE OTHER  ·  RATE GOVERNOR ENGAGED'; }
    if (s.montage) s.flicker = true;
    if (s.finale) { s.theme = [[s.t0, 1, 0]]; s.final = 1; s.card = { t0: s.t0 + 0.3, t1: s.t0 + 4.2, kicker: 'PHASE 07', title: 'RETURN TO ROOT', sub: `${route.length} PAGES WALKED  ·  ${crawl.stats.nodes.toLocaleString('en-US')} NODES MAPPED` }; s.fade = [[s.t1 - 1.2, 0], [s.t1, 1]]; }
    if (s.boot) s.fade = [[0, 1], [0.6, 0]];
  });
  return segs;
}

const plan = makePlan();
writeFileSync(path.join(OUT, 'plan.json'), JSON.stringify(plan, null, 1));

const S0 = audioMeta.sections.map(s => s.start);
const bootLines = [
  [0.8, 'ARACHNET BIOS 1.0.0  ·  FORK OF CYOHEI9907/WEB-CRAWLERS', '#7fb8cc'],
  [1.5, 'LOADING SPIDER  ·  extension/src/spider.js  ·  LIVE DOM MODE', '#00f0ff'],
  [2.2, 'LEG ACTUATORS 1-8 + PALPS ....................... CALIBRATED', '#00f0ff'],
  [2.9, 'WORD GRIP  ·  caretRangeFromPoint + Intl.Segmenter ..... OK', '#00f0ff'],
  [3.6, 'OPTICAL ARRAY  ·  8 EYES ......................... ONLINE', '#ff1e3c'],
  [4.3, 'PAGE INTEGRITY  ·  OVERLAY ONLY, DOM UNTOUCHED ....... OK', '#00f0ff'],
  [5.0, `ROBOTS.TXT ${crawl.robots.status}  ·  SITEMAP ${crawl.stats.sitemapUrls} URLS  ·  GOVERNOR ${crawl.options.concurrency}×${crawl.options.delay} MS`, '#00f0ff'],
  [5.7, `CRAWL MAP  ·  ${crawl.stats.nodes} NODES  ·  ${crawl.stats.edges} LINKS  ·  ${route.length} PAGES ON ROUTE`, '#00f0ff'],
  [6.4, `AUDIO LINK  ·  "${(audioMeta.title || '').toUpperCase()}"  ·  ${audioMeta.bpm.toFixed(0)} BPM`, '#ff2bd6'],
  [7.1, `TARGET VECTOR  ·  ${site}`, '#e8f6ff'],
  [8.0, 'RELEASING THE SPIDER', '#ff1e3c'],
];

// ---------------------------------------------------------------- page runtime
function clock(seed) {
  let s = seed >>> 0;
  Math.random = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let vt = 0, rid = 0, tid = 0, timers = [];
  const rafs = new Map(), base = 1792400000000;
  performance.now = () => vt;
  Date.now = () => base + vt;
  window.requestAnimationFrame = cb => (rafs.set(++rid, cb), rid);
  window.cancelAnimationFrame = id => rafs.delete(id);
  window.setTimeout = (fn, ms = 0, ...a) => { const id = ++tid; timers.push({ id, at: vt + Math.max(0, +ms || 0), fn, a }); return id; };
  window.setInterval = (fn, ms = 0, ...a) => { const id = ++tid; timers.push({ id, at: vt + Math.max(1, +ms || 1), fn, a, every: Math.max(1, +ms || 1) }); return id; };
  window.clearTimeout = window.clearInterval = id => { timers = timers.filter(t => t.id !== id); };
  window.__tick = ms => {
    vt += ms;
    for (let guard = 0; guard < 50; guard++) {
      const due = timers.filter(t => t.at <= vt);
      if (!due.length) break;
      timers = timers.filter(t => t.at > vt || t.every);
      for (const t of due) { if (t.every) t.at += t.every; try { typeof t.fn === 'function' ? t.fn(...t.a) : null; } catch (e) { console.error(e); } }
    }
    const cbs = [...rafs.values()]; rafs.clear();
    for (const cb of cbs) { try { cb(vt); } catch (e) { console.error(e); } }
  };
}

async function openSegment(browser, ua, seg, k) {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await page.setUserAgent(ua);
  await page.setBypassCSP(true);
  page.on('pageerror', e => { if (!/eyeAble|matomo/i.test(e.message)) console.error(`  [seg ${k} page error]`, e.message.slice(0, 200)); });
  page.on('console', m => { if (m.type() === 'error' && /arach|overlay|spider|three/i.test(m.text())) console.error(`  [seg ${k}]`, m.text().slice(0, 200)); });
  await routeRequests(page, { site, cache, record: false, mounts });
  await page.evaluateOnNewDocument(clock, 1000 + k * 7919);
  await page.goto(seg.url, { waitUntil: 'load', timeout: 90000 });
  await page.evaluate(() => { for (let i = 0; i < 90; i++) window.__tick(1000 / 60); });
  await quietPage(page);
  const cfg = {
    mode: 'render', base: site + '__arachnet/', track: (audioMeta.title || '').toUpperCase(), bounces: blockedCount, bootLines,
    wordsBefore: Math.round(plan.filter(p => p.kind !== '3d' && p.t1 <= seg.t0).reduce((s, p) => s + (p.t1 - p.t0), 0) * 11),
    seg,
  };
  await page.evaluate(c => { window.__arachCfg = c; window.addEventListener('error', e => { window.__arachErr = String(e.message); }); }, cfg);
  await page.addScriptTag({ url: site + '__arachnet/inject/spider.js' });
  await page.addScriptTag({ url: site + '__arachnet/inject/overlay.js', type: 'module' });
  for (let i = 0; i < 600; i++) {
    const st = await page.evaluate(() => [!!(window.__arach && window.__arach.ready), window.__arachErr || null]);
    if (st[0]) break;
    if (st[1]) throw new Error('overlay: ' + st[1]);
    await sleep(100);
  }
  return page;
}

const shot = page => page.screenshot({ type: 'jpeg', quality: 92, optimizeForSpeed: true });

// ---------------------------------------------------------------- stills
if (arg('still')) {
  const { browser, ua } = await launch();
  mkdirSync(path.join(OUT, 'stills'), { recursive: true });
  for (const t of arg('still').split(',').map(Number)) {
    const k = plan.findIndex(s => t >= s.t0 && t < s.t1);
    const seg = plan[k];
    if (!seg || seg.kind === '3d') { console.log(`  t=${t}: 3d interlude, skipped`); continue; }
    const t0 = Date.now();
    const page = await openSegment(browser, ua, seg, k);
    const f0 = Math.round(seg.t0 * FPS), f1 = Math.round(t * FPS);
    for (let f = f0; f <= f1; f++) await page.evaluate((t, dt) => { window.__tick(dt); return window.__arach.frame(t); }, f / FPS, 1000 / FPS);
    writeFileSync(path.join(OUT, 'stills', `w${String(t).padStart(6, '0')}.png`), await page.screenshot({ type: 'png' }));
    if (flag('debug')) console.log(JSON.stringify(await page.evaluate(() => {
      const probe = [[700, 600], [960, 700], [1100, 800]].map(([x, y]) => { const cr = document.caretRangeFromPoint(x, y); const el = document.elementFromPoint(x, y); return [x, y, cr && cr.startContainer.nodeName, el && el.tagName]; });
      return { stats: window.__arachSpider.stats(), probe, scrollY, filter: getComputedStyle(document.body).filter, varF: document.documentElement.style.getPropertyValue('--arach-filter'), styles: [...document.querySelectorAll('style')].filter(s => s.textContent.includes('arach-filter')).length };
    })));
    console.log(`  t=${t}s (segment ${k}, ${seg.url.replace(site, '/')}) ${Date.now() - t0} ms`);
    await page.close();
  }
  await browser.close();
  process.exit(0);
}

// ---------------------------------------------------------------- video segments
const run = (cmd, args) => new Promise((res, rej) => { const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] }); p.on('exit', c => c === 0 ? res() : rej(new Error(`${cmd} exited ${c}`))); });
const ENC = ['-c:v', 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', '21', '-b:v', '0', '-maxrate', '30M', '-bufsize', '60M', '-spatial-aq', '1', '-temporal-aq', '1', '-profile:v', 'high', '-g', '120', '-bf', '3', '-pix_fmt', 'yuv420p', '-r', String(FPS)];
const partFile = k => path.join(OUT, `seg-${String(k).padStart(2, '0')}.mp4`);

if (!flag('assemble')) {
  const only = arg('segments') ? arg('segments').split(',').map(Number) : null;
  const todo = plan.map((s, k) => [s, k]).filter(([s, k]) => s.kind !== '3d' && (!only || only.includes(k)) && (flag('force') || !existsSync(partFile(k))));
  const WORKERS = +arg('workers', 3);
  let done = 0; const total = todo.reduce((n, [s]) => n + Math.round(s.t1 * FPS) - Math.round(s.t0 * FPS), 0);
  const t0 = Date.now();
  console.log(`  ${todo.length} web segments, ${total} frames, ${WORKERS} workers`);
  const queue = todo.slice().sort((a, b) => (b[0].t1 - b[0].t0) - (a[0].t1 - a[0].t0));
  async function worker() {
    const { browser, ua } = await launch();
    for (;;) {
      const job = queue.shift(); if (!job) break;
      const [seg, k] = job;
      const page = await openSegment(browser, ua, seg, k);
      const tmp = partFile(k) + '.tmp.mp4';
      const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', ...ENC, tmp], { stdio: ['pipe', 'inherit', 'inherit'] });
      const ffDone = new Promise((res, rej) => ff.on('exit', c => c === 0 ? res() : rej(new Error('ffmpeg ' + c))));
      for (let f = Math.round(seg.t0 * FPS); f < Math.round(seg.t1 * FPS); f++) {
        await page.evaluate((t, dt) => { window.__tick(dt); return window.__arach.frame(t); }, f / FPS, 1000 / FPS);
        const buf = await shot(page);
        if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
        if (++done % 120 === 0) { const el = (Date.now() - t0) / 1000; process.stdout.write(`\r  ${done}/${total} frames  ${(done / el).toFixed(1)} fps  eta ${Math.round((total - done) / (done / el))} s   `); }
      }
      ff.stdin.end(); await ffDone;
      rmSync(partFile(k), { force: true });
      await import('node:fs').then(fs => fs.renameSync(tmp, partFile(k)));
      await page.close();
    }
    await browser.close();
  }
  await Promise.all(Array.from({ length: WORKERS }, worker));
  console.log(`\n  web segments done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

if (flag('assemble') || flag('all')) {
  const list = [];
  for (const [k, s] of plan.entries()) {
    if (s.kind === '3d') {
      const f = partFile(k);
      if (!existsSync(f) || flag('force')) await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', s.t0.toFixed(4), '-i', MASTER3D, '-t', (s.t1 - s.t0).toFixed(4), '-an', ...ENC, f]);
      list.push(f);
    } else list.push(partFile(k));
  }
  const missing = list.filter(f => !existsSync(f));
  if (missing.length) { console.log('  missing segments:', missing.map(f => path.basename(f)).join(', ')); process.exit(1); }
  writeFileSync(path.join(OUT, 'concat.txt'), list.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
  const silent = path.join(OUT, 'web-silent.mp4');
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(OUT, 'concat.txt'), '-c', 'copy', silent]);
  const final = path.resolve(arg('final', path.join(ROOT, 'video3d', 'out', 'arachnet-web.mp4')));
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', silent, '-i', path.join(BUILD, 'track.wav'), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', '-shortest', '-movflags', '+faststart', final]);
  console.log(`  -> ${final}`);
}
