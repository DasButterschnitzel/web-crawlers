// The spider, live: a visible Chrome walks a real website. On every page the
// spider reads the real words (glitching them in its overlay, never changing
// the page), then walks to a real content link, the camera flies the link in
// 3D link space, and the next page loads — from the live site, politely.
//
//   node live.mjs https://www.example.org [--pages 20] [--dwell 25] [--dark] [--track song.mp3 | --no-audio]
//
// Polite by design: robots.txt is checked before every page (disallowed pages
// are skipped), one page per --dwell seconds (min 15), third-party requests
// are blocked (except images/fonts from --allow-hosts), consent dialogs are
// closed without consenting, and the walk stops at the first sign of server
// pushback (429/503, bounces to error pages).
//
// The minimap shows what the spider has seen so far: every visited page and
// every link it found, laid out live. With --crawl <crawl.json> (from
// crawler/crawl.mjs) the HUD also shows click depth from the full map.
// Stop: type "stop" + enter, ctrl-c, or close the window. --offline replays a
// local capture (--cache dir) without network, for testing.
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { launch, Cache, routeRequests, quietPage, contentLinks, sleep } from './lib/common.mjs';
import { parseRobots, robotsPolicy } from '../crawler/lib/robots.mjs';
import { ForceLayout3D } from '../viz3d/js/layout.js';
import { PALETTE } from '../viz3d/js/model.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const flag = n => process.argv.includes('--' + n);
const START0 = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
if (!START0) { console.log('usage: node live.mjs <url> [--pages 20] [--dwell 25] [--dark] [--track file | --no-audio] [--crawl crawl.json]'); process.exit(2); }
const START = new URL(START0).href;
const site = new URL(START).origin + '/';
const host = new URL(START).host;
const DWELL = Math.max(15, +arg('dwell', 25)), PAGES = Math.max(1, +arg('pages', 20));
const HOSTDIR = path.join(ROOT, 'video3d', 'build', 'live', host.replace(/[^\w.-]/g, '_'));
mkdirSync(HOSTDIR, { recursive: true });
const status = o => console.log('@status ' + JSON.stringify(o));     // machine-readable lines for the control panel

// ---------------------------------------------------------------- soundtrack
let trackDir = null, trackFile = null, trackTitle = 'NO SIGNAL';
if (!flag('no-audio')) {
  let src = arg('track') ? path.resolve(arg('track')) : path.join(ROOT, 'video3d', 'build', 'track.ogg');
  if (existsSync(src)) {
    // big WAVs through request interception crash the tab: compress once
    if (/\.wav$/i.test(src) && statSync(src).size > 30e6) {
      const ogg = path.join(ROOT, 'video3d', 'build', 'tracks', path.basename(src).replace(/\.wav$/i, '.ogg'));
      mkdirSync(path.dirname(ogg), { recursive: true });
      if (!existsSync(ogg)) { console.log('  compressing soundtrack ...'); spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-c:a', 'libopus', '-b:a', '160k', ogg]); }
      if (existsSync(ogg)) src = ogg;
    }
    trackDir = path.dirname(src); trackFile = path.basename(src);
    const meta = path.join(ROOT, 'video3d', 'build', 'audio.json');
    trackTitle = !arg('track') && existsSync(meta) ? (JSON.parse(readFileSync(meta, 'utf8')).title || 'SIGNAL') : path.basename(src).replace(/\.\w+$/, '');
  }
}
const mounts = { 'viz/': path.join(ROOT, 'viz3d'), 'inject/': path.join(HERE, 'inject'), 'build/': HOSTDIR, ...(trackDir ? { 'audio/': trackDir } : {}) };

// ---------------------------------------------------------------- optional full map
const crawlFile = arg('crawl');
const crawl = crawlFile && existsSync(crawlFile) ? JSON.parse(readFileSync(crawlFile, 'utf8')) : null;
const nodeOf = new Map((crawl?.nodes || []).map(n => [n.url, n]));

// ---------------------------------------------------------------- robots.txt
const ua0 = `ArachNet/1.0 (+https://github.com/DasButterschnitzel/web-crawlers)`;
let policy = robotsPolicy(null, ua0), robotsInfo = 'not checked';
if (!flag('offline')) {
  try {
    const r = await fetch(site + 'robots.txt', { headers: { 'user-agent': ua0 }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    const txt = r.ok && !/html/i.test(r.headers.get('content-type') || '') ? await r.text() : '';
    const parsed = parseRobots(txt);
    policy = robotsPolicy(parsed, ua0);
    robotsInfo = `${r.status}${txt ? `, ${parsed.groups.length} group(s)` : ' (no rules)'}${parsed.contentSignals.length ? `, Content-Signal: ${parsed.contentSignals.join('; ')}` : ''}`;
  } catch (e) { robotsInfo = 'unreachable (' + e.message + ')'; }
}
console.log(`  robots.txt: ${robotsInfo}`);
if (!policy.allowed(START)) { console.log(`  !! robots.txt disallows ${START} for crawlers — not going there.`); status({ state: 'refused', reason: 'robots.txt' }); process.exit(3); }
const crawlDelay = policy.delay ? Math.max(DWELL, policy.delay) : DWELL;

// ---------------------------------------------------------------- what the spider has seen (minimap)
const L = new ForceLayout3D({ seed: 42, anchorRadius: 40 });
const gNodes = [], gIdx = new Map(), gEdges = [], gSec = new Map(), gIn = [];
const areaOf = u => new URL(u).pathname.split('/').filter(Boolean)[0] || '/';
function gNode(u, parent = -1) {
  if (gIdx.has(u)) return gIdx.get(u);
  const sec = areaOf(u);
  if (!gSec.has(sec)) gSec.set(sec, gSec.size);
  const i = L.addNode(sec, parent, gNodes.length ? 0 : 0.9);
  gNodes.push({ u, sec }); gIdx.set(u, i); gIn.push(0);
  if (parent >= 0) L.addSpring(parent, i, 0.03, 3);
  return i;
}
function gLink(a, b) { gEdges.push([a, b]); gIn[b]++; }
function writeGraph(route) {
  L.step(gNodes.length < 300 ? 120 : 60);
  const maxIn = Math.max(1, ...gIn);
  const palette = PALETTE.slice();
  const nodes = gNodes.map((n, i) => { const p = L.pos(i); return [+p[0].toFixed(2), +p[1].toFixed(2), +p[2].toFixed(2), gSec.get(n.sec) % palette.length, +(gIn[i] / maxIn).toFixed(3)]; });
  writeFileSync(path.join(HOSTDIR, 'web-graph.json'), JSON.stringify({ nodes, edges: gEdges.slice(-6000), palette, route, urls: gNodes.map(n => n.u) }));
}

// ---------------------------------------------------------------- browser
const headless = flag('headless');
const { browser, ua } = await launch({ headless, viewport: headless ? undefined : null });
const page = await browser.newPage();
for (const p of await browser.pages()) if (p !== page) await p.close();
if (headless) await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
await page.setUserAgent(ua);
await page.setBypassCSP(true);
if (flag('dark')) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
// pages are always fetched live; images, scripts and fonts are cached per host so a second visit costs the site less
await routeRequests(page, { site, cache: new Cache(arg('cache') || path.join(HOSTDIR, 'cache')), record: !flag('offline'), freshDocuments: !flag('offline'), mounts, allowHosts: (arg('allow-hosts') || '').split(',').filter(Boolean) });
let pushback = 0;
page.on('response', r => { if (r.url().startsWith(site) && (r.status() === 429 || r.status() === 503 || /error_path|captcha|blocked/.test(r.headers().location || ''))) pushback++; });

// stopping: "stop" on stdin (the control panel), ctrl-c, or the window closing
let stop = false;
createInterface({ input: process.stdin }).on('line', l => { if (/^\s*(stop|q|quit)\s*$/i.test(l)) { stop = true; console.log('  stopping after this page ...'); } });
process.on('SIGINT', () => { stop = true; });
browser.on('disconnected', () => { stop = true; });
const nap = async ms => { const end = Date.now() + ms; while (!stop && Date.now() < end) await sleep(Math.min(250, end - Date.now())); };

const PRIVATE = /\/mitarbeiter\/|HES:employee|\/personen\/|\/(login|logout|signin|signup|register|account|cart|checkout)\b/i;
const pathOf = u => decodeURIComponent(new URL(u).pathname);
const log = [], visited = new Set(), route = [];
let url = START, prev = null, words = 0;
const t0 = Date.now();
console.log(`ArachNet live: ${START}  ·  ${crawlDelay}s per page  ·  up to ${PAGES} pages  ·  soundtrack: ${trackTitle}`);
status({ state: 'running', host, pages: 0, of: PAGES });

for (let i = 0; i < PAGES && url && !stop; i++) {
  visited.add(url);
  const tNav = Date.now();
  let res;
  try { res = await page.goto(url, { waitUntil: 'load', timeout: 60000 }); }
  catch (e) { if (!stop) console.log('  ! ' + e.message); break; }
  if (pushback) { console.log('  !! server pushback (429/503 or error-page bounce) -> the spider withdraws'); status({ state: 'pushback' }); break; }
  if (page.url() !== url) { url = page.url(); visited.add(url); }
  if (!url.startsWith(site)) { console.log('  ! redirected off-site, stopping'); break; }
  await quietPage(page).catch(() => {});
  const data = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const CAT = { h1: 1, h2: 1, h3: 1, h4: 1, p: 2, span: 2, strong: 2, a: 3, img: 4, picture: 4, svg: 4, script: 5, style: 5, link: 5, meta: 5, form: 6, input: 6, button: 6, ul: 7, ol: 7, li: 7, table: 8, tr: 8, td: 8 };
    const all = document.getElementsByTagName('*');
    let seq = ''; for (let i = 0; i < Math.min(240, all.length); i++) seq += CAT[all[i].tagName.toLowerCase()] ?? 0;
    const text = document.body ? document.body.innerText : '';
    return { ttfb: Math.round(nav.responseStart - nav.startTime) || null, bytes: nav.decodedBodySize || null, dom: all.length,
      words: (text.match(/[\p{L}\p{N}]+/gu) || []).length, links: document.querySelectorAll('a[href]').length, title: document.title, seq };
  }).catch(() => ({}));

  // map what we see: this page, and every content link on it
  const me = gNode(url, prev ? prev.node : -1);
  route.push(me);
  const all = await contentLinks(page, site, { header: true }).catch(() => []);
  for (const l of all) { const j = gNode(l.href, me); if (j !== me) gLink(me, j); }
  // where next: visible, allowed by robots.txt, not visited, not private; prefer new areas and the middle of the page
  const links = all.filter(l => !visited.has(l.href) && !PRIVATE.test(l.href) && policy.allowed(l.href));
  const scored = links.map(l => ({ ...l, s: (l.y > 150 && l.y < 1600 ? 2 : 0) + (areaOf(l.href) !== areaOf(url) ? 1.2 : 0) + (route.some(r => gNodes[r].sec === areaOf(l.href)) ? 0 : 1) + ((l.href.length * 31 + i) % 7) / 10 })).sort((a, b) => b.s - a.s);
  const next = scored[0] || null;
  const nextNode = next ? gNode(next.href, me) : -1;
  writeGraph(route);

  const elapsed = (Date.now() - t0) / 1000;
  const title = (data.title || '').replace(/^(.+?)\s+[|–—-]\s+[^|–—]+$/, '$1');
  const seg = {
    kind: 'page', t0: 0, t1: crawlDelay, phase: `LIVE // ${host.toUpperCase()}`, routeIdx: route.length - 1, nodeNo: i + 1,
    page: { url, path: pathOf(url), title, status: res?.status(), ...data, depth: nodeOf.get(url)?.clickDepth ?? (route.length - 1), blocked: false },
    link: next && { ...next, path: pathOf(next.href) }, lureAt: crawlDelay - 8,
    travelIn: prev ? { t0: -1.2, t1: 1.2, fromNode: prev.node, toNode: me, fromPath: prev.path, toPath: pathOf(url), edge: `${prev.node} → ${me}` } : null,
    travelOut: next ? { t0: crawlDelay - 1.2, t1: crawlDelay + 1.2, fromNode: me, toNode: nextNode, fromPath: pathOf(url), toPath: pathOf(next.href), edge: `${me} → ${nextNode}` } : null,
    card: { t0: 0.6, t1: 3.4, kicker: `LIVE NODE ${String(i + 1).padStart(3, '0')}  //  ${areaOf(url).toUpperCase()}`, title: title.toUpperCase().slice(0, 34), sub: pathOf(url).slice(0, 80) },
    telemetry: [['PAGES WALKED', `${i + 1} / ${PAGES}`], ['TTFB', (data.ttfb ?? '—') + ' MS'], ['DOM NODES', String(data.dom ?? '—')], ['WORDS ON PAGE', String(data.words ?? '—')], ['LINKS SEEN', String(gEdges.length)], ['ELAPSED', `${Math.round(elapsed)} S`]],
    miniLabel: `${gNodes.length} NODES SEEN`, mini: true, enter: { x: 960, y: 470 }, readMax: 2300, theme: [[0, 0, 0]], darkSite: flag('dark'),
  };
  const cfg = { mode: 'live', base: site + '__arachnet/', track: trackFile ? trackTitle.toUpperCase() : 'NO SIGNAL', trackUrl: trackFile ? site + '__arachnet/audio/' + encodeURIComponent(trackFile) : null, bounces: 0, wordsBefore: words, audioOffset: elapsed, seg };
  try {
    await page.evaluate(c => { window.__arachCfg = c; }, cfg);
    await page.addScriptTag({ url: site + '__arachnet/inject/spider.js' });
    await page.addScriptTag({ url: site + '__arachnet/inject/overlay.js', type: 'module' });
  } catch (e) { console.log('  overlay: ' + e.message); }
  console.log(`  [${i + 1}] ${res?.status()} ${data.ttfb ?? '—'}ms ${Math.round((data.bytes || 0) / 1024)}KB  ${pathOf(url)}  -> ${next ? next.text.slice(0, 40) : '(end of the trail)'}`);
  status({ state: 'running', host, pages: i + 1, of: PAGES, url, ttfb: data.ttfb, nodes: gNodes.length, links: gEdges.length });
  log.push({ url, status: res?.status(), ...data, next: next?.href || null, at: new Date().toISOString() });
  if (arg('shots')) {
    mkdirSync(arg('shots'), { recursive: true });
    await nap(crawlDelay * 500 - (Date.now() - tNav));
    if (!stop) await page.screenshot({ path: path.join(arg('shots'), `live-${String(i + 1).padStart(2, '0')}.png`) }).catch(() => {});
  }
  await nap(crawlDelay * 1000 - (Date.now() - tNav));
  words += await page.evaluate(() => window.__arachSpider?.words || 0).catch(() => 0);
  prev = { node: me, path: pathOf(url) };
  url = next?.href;
}

mkdirSync(path.join(ROOT, 'runs'), { recursive: true });
const out = path.join(ROOT, 'runs', `live-${host}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
writeFileSync(out, JSON.stringify(log, null, 1));
console.log(`walked ${log.length} pages -> ${out}`);
status({ state: 'done', host, pages: log.length, of: PAGES, log: out });
if (!flag('keep-open')) await browser.close().catch(() => {});
process.exit(0);
