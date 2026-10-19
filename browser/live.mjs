// The spider, live: a visible Chrome walks a real website. On every page the
// spider reads the real words (glitching them in its overlay, never changing
// the page), then walks to a real content link, the camera flies the link in
// 3D link space, and the next page loads — from the live site, politely.
//
//   node live.mjs https://www.example.org [--dwell 25] [--pages 20] [--no-audio] [--graph ../video3d/build/web-graph.json]
//
// --offline replays the local capture instead (no network at all), for testing.
// Measured per page (Navigation Timing + DOM): TTFB, bytes, DOM size, words,
// links. Third-party requests are blocked, consent dialogs are closed without
// consenting, and the walk stops at the first sign of server pushback.
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launch, Cache, routeRequests, quietPage, contentLinks, sleep } from './lib/common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const flag = n => process.argv.includes('--' + n);
const START = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'https://www.dreieich.de/';
const site = new URL(START).origin + '/';
const DWELL = Math.max(15, +arg('dwell', 25)), PAGES = +arg('pages', 20);
const BUILD = path.join(ROOT, 'video3d', 'build');
const mounts = { 'viz/': path.join(ROOT, 'viz3d'), 'inject/': path.join(HERE, 'inject'), 'build/': BUILD };
const graphFile = path.resolve(arg('graph', path.join(BUILD, 'web-graph.json')));
const graph = existsSync(graphFile) ? JSON.parse(readFileSync(graphFile, 'utf8')) : null;
const crawlFile = arg('crawl') || path.join(ROOT, 'runs', 'dreieich', 'crawl.json');
const crawl = existsSync(crawlFile) ? JSON.parse(readFileSync(crawlFile, 'utf8')) : null;
const nodeOf = new Map((crawl?.nodes || []).map((n, i) => [n.url, n]));
const audioMeta = existsSync(path.join(BUILD, 'audio.json')) ? JSON.parse(readFileSync(path.join(BUILD, 'audio.json'), 'utf8')) : null;
const PRIVATE = /\/mitarbeiter\/|HES:employee|\/personen\//i;
const graphIndex = new Map((graph?.urls || []).map((u, i) => [u, i]));

const { browser, ua } = await launch({ headless: flag('headless') });
const page = await browser.newPage();
for (const p of await browser.pages()) if (p !== page) await p.close();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
await page.setUserAgent(ua);
await page.setBypassCSP(true);
// pages are always fetched live; images, scripts and fonts come from the local cache when we have them
await routeRequests(page, { site, cache: new Cache(path.join(BUILD, 'webcache')), record: !flag('offline'), freshDocuments: !flag('offline'), mounts });
let pushback = 0;
if (flag('debug')) { page.on('framenavigated', f => console.log('    [nav]', f === page.mainFrame() ? 'main' : 'sub', f.url().slice(0, 90))); page.on('framedetached', f => console.log('    [detached]', f.url().slice(0, 90))); page.on('console', m => { if (m.type() === 'error') console.log('    [console]', m.text().slice(0, 120)); }); }
page.on('response', r => { if (r.url().startsWith(site) && (r.status() === 429 || r.status() === 503 || /error_path/.test(r.headers().location || ''))) pushback++; });

const sectionOf = u => new URL(u).pathname.split('/').filter(Boolean).slice(0, 2).join('/') || '/';
const log = [];
const visited = new Set();
let url = START, prev = null, t0 = Date.now(), words = 0;
console.log(`ArachNet live: ${START}  ·  ${DWELL}s per page  ·  close the window or ctrl-c to stop`);

for (let i = 0; i < PAGES && url; i++) {
  visited.add(url);
  const tNav = Date.now();
  let res;
  try { res = await page.goto(url, { waitUntil: 'load', timeout: 60000 }); } catch (e) { console.log('  !', e.message, (e.stack || '').split('\n').slice(1, 4).join(' | ')); break; }
  if (pushback) { console.log('  !! server pushback -> the spider withdraws'); break; }
  await quietPage(page);
  // what this page really is (measured now, in this browser)
  const data = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const CAT = { h1: 1, h2: 1, h3: 1, h4: 1, p: 2, span: 2, strong: 2, a: 3, img: 4, picture: 4, svg: 4, script: 5, style: 5, link: 5, meta: 5, form: 6, input: 6, button: 6, ul: 7, ol: 7, li: 7, table: 8, tr: 8, td: 8 };
    const all = document.getElementsByTagName('*');
    let seq = ''; for (let i = 0; i < Math.min(240, all.length); i++) seq += CAT[all[i].tagName.toLowerCase()] ?? 0;
    const text = document.body ? document.body.innerText : '';
    return { ttfb: Math.round(nav.responseStart - nav.startTime) || null, bytes: nav.decodedBodySize || null, dom: all.length,
      words: (text.match(/[\p{L}\p{N}]+/gu) || []).length, links: document.querySelectorAll('a[href]').length, title: document.title, seq };
  });
  const links = (await contentLinks(page, site)).filter(l => !visited.has(l.href) && !PRIVATE.test(l.href));
  const scored = links.map(l => ({ ...l, s: (l.y > 200 && l.y < 1800 ? 2 : 0) + (sectionOf(l.href) !== sectionOf(url) ? 1 : 0) + (nodeOf.has(l.href) ? 1 : 0) + ((l.href.length * 31 + i) % 7) / 10 })).sort((a, b) => b.s - a.s);
  const next = scored[0] || null;
  const gi = u => graphIndex.get(u) ?? -1;
  const elapsed = (Date.now() - t0) / 1000;
  const seg = {
    kind: 'page', t0: 0, t1: DWELL, phase: `LIVE // ${new URL(site).host.toUpperCase()}`, routeIdx: 0, nodeNo: i + 1,
    page: { url, path: decodeURIComponent(new URL(url).pathname), status: res?.status(), ...data, depth: nodeOf.get(url)?.clickDepth, blocked: false },
    link: next && { ...next, path: decodeURIComponent(new URL(next.href).pathname) }, lureAt: DWELL - 8,
    travelIn: prev ? { t0: -1.2, t1: 1.2, fromNode: prev.node, toNode: gi(url), fromPath: prev.path, toPath: decodeURIComponent(new URL(url).pathname), edge: 'LIVE' } : null,
    travelOut: next ? { t0: DWELL - 1.2, t1: DWELL + 1.2, fromNode: gi(url), toNode: gi(next.href), fromPath: decodeURIComponent(new URL(url).pathname), toPath: decodeURIComponent(new URL(next.href).pathname), edge: 'LIVE' } : null,
    card: { t0: 0.6, t1: 3.4, kicker: `LIVE NODE ${String(i + 1).padStart(3, '0')}`, title: (data.title || '').replace(/\s*\|.*$/, '').toUpperCase().slice(0, 34), sub: decodeURIComponent(new URL(url).pathname).slice(0, 80) },
    telemetry: [['PAGES WALKED', String(i + 1)], ['TTFB', (data.ttfb ?? '—') + ' MS'], ['DOM NODES', String(data.dom)], ['WORDS ON PAGE', String(data.words)], ['LINKS', String(data.links)], ['ELAPSED', `${Math.round(elapsed)} S`]],
    miniLabel: 'LIVE', mini: !!graph, enter: { x: 960, y: 470 }, readMax: 2300, theme: [[0, 0, 0]],
  };
  await page.evaluate(c => { window.__arachCfg = c; }, { mode: 'live', base: site + '__arachnet/', track: audioMeta && !flag('no-audio') ? (audioMeta.title || '').toUpperCase() : 'NO SIGNAL', bounces: 0, wordsBefore: words, audioOffset: elapsed, seg });
  await page.addScriptTag({ url: site + '__arachnet/inject/spider.js' });
  await page.addScriptTag({ url: site + '__arachnet/inject/overlay.js', type: 'module' }).catch(e => console.log('  overlay:', e.message));
  if (!flag('no-audio')) await page.evaluate(off => { const el = window.__arachAudioEl; if (el) { el.currentTime = off % (el.duration || 1e9); } }, elapsed).catch(() => {});
  console.log(`  [${i + 1}] ${res?.status()} ${data.ttfb}ms ${Math.round((data.bytes || 0) / 1024)}KB  ${url.replace(site, '/')}  -> ${next ? next.text.slice(0, 40) : '(end)'}`);
  log.push({ url, status: res?.status(), ...data, next: next?.href || null, at: new Date().toISOString() });
  const wait = DWELL * 1000 - (Date.now() - tNav);
  if (wait > 0) await sleep(wait);
  words = await page.evaluate(() => window.__arachSpider?.words || 0).catch(() => words) + words;
  prev = { node: gi(url), path: decodeURIComponent(new URL(url).pathname) };
  url = next?.href;
}
mkdirSync(path.join(ROOT, 'runs'), { recursive: true });
const out = path.join(ROOT, 'runs', `live-${new URL(site).host}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
writeFileSync(out, JSON.stringify(log, null, 1));
console.log(`walked ${log.length} pages -> ${out}`);
if (!flag('keep-open')) await browser.close();
