// Polite capture: walk a chain of real pages through visible content links,
// store every same-site response in a local cache and write the route, so the
// spider video can be rendered offline (deterministic, zero load on the site).
//
//   node capture.mjs https://www.example.org --pages 30 --delay 20000 \
//        --crawl ../runs/<run>/crawl.json --out ../video3d/build/webcache
//
// Third-party requests are blocked. The consent dialog is closed without
// consenting. The capture stops at the first sign of server pushback.
import path from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { launch, Cache, routeRequests, quietPage, contentLinks, sleep } from './lib/common.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const SEED = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'https://www.dreieich.de/';
const PAGES = +arg('pages', 30), DELAY = +arg('delay', 20000), SCROLL = +arg('scroll', 4200);
const OUT = path.resolve(arg('out', '../video3d/build/webcache'));
const site = new URL(SEED).origin + '/';
const crawl = arg('crawl') && existsSync(arg('crawl')) ? JSON.parse(readFileSync(arg('crawl'), 'utf8')) : null;
const known = new Map((crawl?.nodes || []).filter(n => n.title !== undefined).map(n => [n.url, n]));
// content out-degree: links to pages that are not global navigation (prefer pages you can walk on from)
const contentOut = new Map();
if (crawl) {
  const indeg = new Map();
  for (const [, b] of crawl.edges) indeg.set(b, (indeg.get(b) || 0) + 1);
  const navCut = Math.max(25, known.size * 0.12);
  for (const [a, b] of crawl.edges) if ((indeg.get(b) || 0) < navCut) contentOut.set(a, (contentOut.get(a) || 0) + 1);
}
const pool = [];   // every candidate seen so far, for backtracking out of dead ends
const extra = (arg('extra') || '').split(',').filter(Boolean);
const allowHosts = (arg('allow-hosts') || '').split(',').filter(Boolean);
// steer the walk: --prefer <regex> gets a bonus; --jump-gap n jumps when an earlier page offers a link n points better
const PREFER = arg('prefer') ? new RegExp(arg('prefer')) : null;
const JUMP_GAP = +arg('jump-gap', 1e9), VARIETY = +arg('variety', 1.1);
// --path a,b,c (paths or URLs): a curated route; each step walks a visible link when one exists, else it is a jump
const PATH = arg('path') ? arg('path').split(',').filter(Boolean).map(p => new URL(p, SEED).href) : null;     // e.g. the firewall's error page, fetched once at the end

const cache = new Cache(OUT);
const { browser, ua } = await launch({ headless: true });
const page = await browser.newPage();
await page.setUserAgent(ua);
if (process.argv.includes('--dark')) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await routeRequests(page, { site, cache, record: true, allowHosts });
let pushback = 0;
page.on('response', r => { if (r.url().startsWith(site) && (r.status() === 429 || r.status() === 503 || /error_path/.test(r.headers().location || ''))) pushback++; });

const sectionOf = u => new URL(u).pathname.split('/').filter(Boolean).slice(0, 2).join('/') || '/';
// people's personal pages (staff directory) stay out of the route
const PRIVATE = /\/mitarbeiter\/|HES:employee|\/personen\/|ionas4-edit-id|timestamp=/i;
const seenSections = new Map();
const route = [];
const visited = new Set();
let url = SEED, prevSec = [];
console.log(`capture ${SEED}: up to ${PAGES} pages, ${DELAY / 1000}s apart -> ${OUT}`);

for (let i = 0; i < PAGES && url; i++) {
  const t0 = Date.now();
  page.__net = 0;
  visited.add(url);
  let res;
  try { res = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }); }
  catch (e) { console.log(`  ! ${url}: ${e.message}`); break; }
  if (pushback) { console.log('  !! server pushback -> stopping capture'); break; }
  if (page.url() !== url) { url = page.url(); visited.add(url); }   // redirects: keep the final URL (that is what the cache holds)
  await quietPage(page);
  // scroll down once so lazy images below the fold load, then back up
  const docH = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < Math.min(docH, SCROLL); y += 700) { await page.evaluate(y => scrollTo(0, y), y); await sleep(250); }
  await page.evaluate(() => scrollTo(0, 0));
  await sleep(1200);
  const links = await contentLinks(page, site, { header: process.argv.includes('--header-links') });
  const title = await page.title();
  // choose where the spider goes next: a visible content link to a page the crawler knows
  const sec = sectionOf(url);
  const area = u => new URL(u).pathname.split('/').filter(Boolean)[0] || '/';     // top-level area, for variety
  seenSections.set(area(url), (seenSections.get(area(url)) || 0) + 1);
  const scored = links.filter(l => !visited.has(l.href) && !PRIVATE.test(l.href)).map(l => {
    let s = 0;
    const k = known.get(l.href);
    if (k) { s += 3 + Math.min(2, (k.wordCount || 0) / 400); const co = contentOut.get(k.id) || 0; s += co ? Math.min(3, co / 3) : -2; }
    if (l.y > 220 && l.y < 1700) s += 2; else if (l.y > 3000) s -= 3;
    if (!prevSec.includes(sectionOf(l.href))) s += 1.5;
    const seen = seenSections.get(area(l.href)) || 0;
    s += seen ? -VARIETY * seen : 2.5;
    if (PREFER && PREFER.test(l.href)) s += 4;
    if (/[?&]paged|page=/.test(l.href)) s -= 4;
    if (l.text.length > 60) s -= 0.5;
    s += ((i * 7919 + l.href.length * 31) % 100) / 400;   // stable tie-break
    return { ...l, s };
  }).sort((a, b) => b.s - a.s);
  for (const c of scored.slice(1)) pool.push({ ...c, from: i });
  pool.sort((a, b) => b.s - a.s);
  while (pool.length && visited.has(pool[0].href)) pool.shift();
  let next = scored[0] && scored[0].s > 0 ? scored[0] : null, jump = null;
  if (PATH) {
    const want = PATH[i + 1];
    const hit = want && links.filter(l => l.href === want).sort((a, b) => Math.abs(a.y - 600) - Math.abs(b.y - 600))[0];
    next = want ? (hit || { href: want, text: want, x: 0, y: 0, w: 0, h: 0, s: 0 }) : null;
  }
  if (!PATH && next && pool.length && pool[0].s - next.s > JUMP_GAP) next = null;     // stuck in a corridor: jump to a clearly better open link
  if (!next && !PATH) {      // dead end: jump back to the best open link of an earlier page
    pool.sort((a, b) => b.s - a.s);
    while (pool.length && visited.has(pool[0].href)) pool.shift();
    if (pool.length) { next = pool.shift(); jump = next.from; }
  }
  if (PATH && next && !next.w) jump = -1;            // curated step without a visible link: cut
  route.push({ url, title, status: res?.status(), docH, links, net: page.__net, next: next && { href: next.href, text: next.text, x: next.x, y: next.y, w: next.w, h: next.h, jumpFrom: jump } });
  cache.save();
  writeFileSync(path.join(OUT, 'route.json'), JSON.stringify(route, null, 1));
  console.log(`  [${i + 1}] ${res?.status()} ${url.replace(site, '/')}  (${links.length} links, ${page.__net} net) -> ${next ? (jump != null ? '[jump] ' : '') + next.text.slice(0, 40) : '—'}  ·  cache ${Object.keys(cache.index).length}`);
  prevSec = [sec, ...prevSec].slice(0, 2);
  url = next?.href;
  const wait = page.__net ? DELAY - (Date.now() - t0) : 0;     // nothing fetched from the site: no need to wait
  if (url && wait > 0) await sleep(wait);
}

for (const u of extra) {
  try { const r = await page.goto(u, { waitUntil: 'networkidle2', timeout: 60000 }); console.log(`  extra ${r?.status()} ${u}`); await sleep(1500); }
  catch (e) { console.log(`  extra failed ${u}: ${e.message}`); }
}
cache.save();
await browser.close();
console.log(`done: ${route.length} pages, ${Object.keys(cache.index).length} cached responses`);
