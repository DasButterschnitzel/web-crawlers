#!/usr/bin/env node
// ArachNet — the crawler the spider was missing.
//
// A polite, dependency-free site crawler (Node >= 20): robots.txt (RFC 9309),
// sitemap discovery, meta robots / X-Robots-Tag, adaptive throttling, redirect
// chains, timings, page-weight and SEO/a11y signals, and a full link graph.
// Every step is an event: written to events.ndjson and, with --live, streamed
// over SSE to the 3D visualiser (viz3d/) while the crawl is running.
//
//   node crawl.mjs https://www.example.org
//   node crawl.mjs https://www.example.org --live 8080 --max-pages 500
//   node crawl.mjs --replay runs/<run>/crawl.json --live 8080 --speed 4
import { EventEmitter } from 'node:events';
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync, createWriteStream, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize, makeScope, sectionOf, isBinaryUrl } from './lib/url.mjs';
import { parseRobots, robotsPolicy } from './lib/robots.mjs';
import { collectSitemaps } from './lib/sitemap.mjs';
import { extract, robotsFlags } from './lib/html.mjs';
import { serve } from './lib/live.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.0.0';

const HELP = `
ArachNet ${VERSION} — polite site crawler with a live 3D view

usage: node crawl.mjs <url> [options]
       node crawl.mjs --replay <crawl.json> --live <port> [--speed n]

  --max-pages <n>        fetch at most n URLs                         (5000)
  --max-depth <n>        maximum link depth from the seed            (50)
  --concurrency <n>      parallel requests                           (3)
  --delay <ms>           minimum gap between request starts          (250)
  --timeout <ms>         per request                                 (20000)
  --ua <string>          user agent
  --out <dir>            output directory              (runs/<host>-<stamp>)
  --include <regex>      only crawl URLs matching
  --exclude <regex>      skip URLs matching
  --subdomains           treat subdomains as in scope
  --no-sitemap           do not seed from sitemaps
  --no-files             do not HEAD-check linked files (pdf, images, ...)
  --ignore-robots-txt    ignore robots.txt            (only for sites you own)
  --follow-nofollow      follow links on nofollow pages (only for sites you own)
  --live <port>          serve viz3d/ and stream events at /events
  --audio <file>         soundtrack for the live view (served at /audio/)
  --quiet                less console output

  stop a running crawl cleanly: ctrl-c, or create a file named STOP in the output dir.
  The crawl also stops by itself when the server keeps pushing back (429/503,
  redirects to error pages); results so far are always written.
`;

function parseArgs(argv) {
  const o = {
    seed: null, maxPages: 5000, maxDepth: 50, concurrency: 3, delay: 250, timeout: 20000,
    ua: `ArachNet/${VERSION} (+https://github.com/DasButterschnitzel/web-crawlers)`,
    out: null, include: null, exclude: null, subdomains: false, sitemap: true, files: true,
    respectRobotsTxt: true, respectNofollow: true, live: null, replay: null, speed: 1, quiet: false,
  };
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i], v = () => a[++i];
    switch (k) {
      case '-h': case '--help': console.log(HELP); process.exit(0);
      case '--max-pages': o.maxPages = +v(); break;
      case '--max-depth': o.maxDepth = +v(); break;
      case '--concurrency': o.concurrency = Math.max(1, +v()); break;
      case '--delay': o.delay = Math.max(0, +v()); break;
      case '--timeout': o.timeout = +v(); break;
      case '--ua': o.ua = v(); break;
      case '--out': o.out = v(); break;
      case '--include': o.include = new RegExp(v()); break;
      case '--exclude': o.exclude = new RegExp(v()); break;
      case '--subdomains': o.subdomains = true; break;
      case '--no-sitemap': o.sitemap = false; break;
      case '--no-files': o.files = false; break;
      case '--ignore-robots-txt': o.respectRobotsTxt = false; break;
      case '--follow-nofollow': o.respectNofollow = false; break;
      case '--live': o.live = +v(); break;
      case '--replay': o.replay = v(); break;
      case '--speed': o.speed = +v(); break;
      case '--audio': o.audio = v(); break;
      case '--quiet': o.quiet = true; break;
      default:
        if (k.startsWith('-')) { console.error(`unknown option ${k}`); process.exit(2); }
        o.seed = k;
    }
  }
  return o;
}

// ---------------------------------------------------------------------------
// min-heap ordered by (tier, depth, seq): link-discovered URLs before
// sitemap-only ones, shallow before deep, otherwise FIFO
class Frontier {
  constructor() { this.h = []; this.seq = 0; }
  get size() { return this.h.length; }
  key(e) { return e.tier * 1e9 + e.depth * 1e6 + e.seq; }
  push(e) {
    e.seq = this.seq++; e.k = this.key(e);
    const h = this.h; h.push(e);
    let i = h.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (h[p].k <= h[i].k) break; [h[p], h[i]] = [h[i], h[p]]; i = p; }
  }
  pop() {
    const h = this.h; if (!h.length) return null;
    const top = h[0], last = h.pop();
    if (h.length) {
      h[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < h.length && h[l].k < h[m].k) m = l;
        if (r < h.length && h[r].k < h[m].k) m = r;
        if (m === i) break; [h[m], h[i]] = [h[i], h[m]]; i = m;
      }
    }
    return top;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SEC_HEADERS = ['strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy'];
const KEEP_HEADERS = ['server', 'x-powered-by', 'cache-control', 'expires', 'etag', 'last-modified', 'content-encoding', 'vary', 'x-robots-tag', 'content-language', 'age', 'via', 'x-cache', ...SEC_HEADERS];

export class Crawler extends EventEmitter {
  constructor(opts) {
    super();
    this.o = opts;
    this.seed = normalize(opts.seed);
    if (!this.seed) throw new Error('invalid seed url');
    this.host = new URL(this.seed).hostname;
    this.inScope = makeScope(this.seed, { subdomains: opts.subdomains });
    this.nodes = [];            // id -> node
    this.byUrl = new Map();     // url -> node
    this.edges = [];            // [from, to, flags]
    this.edgeSet = new Set();
    this.external = new Map();  // domain -> count
    this.frontier = new Frontier();
    this.sitemapUrls = new Map();
    this.backlog = [];          // every event, for late SSE subscribers and events.ndjson
    this.fetched = 0;
    this.inflight = 0;
    this.gap = opts.delay;
    this.nextSlot = 0;
    this.errorsInRow = 0;
    this.recent = [];           // last responses: true = the server is pushing back
    this.t0 = performance.now();
    this.robots = { status: null, policy: robotsPolicy(null, opts.ua), sitemaps: [] };
  }

  now() { return Math.round(performance.now() - this.t0); }
  emitEv(type, data = {}) {
    const ev = { t: this.now(), type, ...data };
    this.backlog.push(ev);
    this.emit('event', ev);
    return ev;
  }
  log(...a) { if (!this.o.quiet) console.log(...a); }

  allowedByFilters(url) {
    if (this.o.include && !this.o.include.test(url)) return false;
    if (this.o.exclude && this.o.exclude.test(url)) return false;
    return true;
  }

  node(url, via, parent = null, depth = 0) {
    let n = this.byUrl.get(url);
    if (n) { if (n.parent == null && parent != null && n.id !== parent && n.via !== 'seed') n.parent = parent; return n; }
    n = { id: this.nodes.length, url, section: sectionOf(url), via, parent, depth, state: 'known', file: isBinaryUrl(url) };
    if (this.sitemapUrls.has(url)) { n.inSitemap = true; n.lastmod = this.sitemapUrls.get(url).lastmod || null; }
    this.nodes.push(n);
    this.byUrl.set(url, n);
    this.emitEv('node', { id: n.id, url, section: n.section, via, parent, depth, file: n.file || undefined });
    return n;
  }

  enqueue(n, tier, depth) {
    if (n.state === 'fetched' || n.state === 'fetching' || n.state === 'error') return;
    if (n.queued && n.queued.tier <= tier) return;     // already queued at least as urgently
    if (tier === 0 && depth > this.o.maxDepth) { if (n.state === 'known') n.state = 'too-deep'; return; }   // sitemap entries have no link depth
    if (!this.allowedByFilters(n.url)) { n.state = 'filtered'; return; }
    if (this.o.respectRobotsTxt && !this.robots.policy.allowed(n.url)) { n.state = 'robots-disallowed'; return; }
    if (n.file && !this.o.files) { n.state = 'file-skipped'; return; }
    if (n.queued) n.queued.stale = true;                 // promote: old heap entry becomes a no-op
    n.depth = Math.min(n.depth, depth);
    n.queued = { n, tier, depth: n.depth, stale: false };
    n.state = 'queued';
    this.frontier.push(n.queued);
  }

  // politeness: one shared gate per host, adaptive on 429/503
  async gate() {
    for (;;) {
      const now = performance.now();
      if (now >= this.nextSlot) { this.nextSlot = now + this.gap; return; }
      await sleep(this.nextSlot - now);
    }
  }
  slowDown(retryAfterSec) {
    this.gap = Math.min(10000, Math.max(this.gap * 2, 500));
    if (retryAfterSec) this.nextSlot = Math.max(this.nextSlot, performance.now() + retryAfterSec * 1000);
    this.emitEv('throttle', { gap: Math.round(this.gap) });
  }
  speedUp() { if (this.gap > this.o.delay) this.gap = Math.max(this.o.delay, this.gap * 0.9); }

  // a server that keeps answering 429/503 or bouncing us to an error page wants
  // us gone: stop cleanly instead of hammering it at a slower pace
  pushback(isBlock, why) {
    this.recent.push(isBlock); if (this.recent.length > 20) this.recent.shift();
    const n = this.recent.filter(Boolean).length;
    if (isBlock && n >= 5 && !this.aborted) {
      this.aborted = true; this.blocked = why;
      this.emitEv('blocked', { reason: why, recent: n });
      this.log(`  !! server pushback (${why}, ${n}/20 recent responses) -> stopping the crawl`);
    }
  }

  async request(url, method = 'GET') {
    await this.gate();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error('timeout')), this.o.timeout);
    const t0 = performance.now();
    try {
      const res = await fetch(url, {
        method, redirect: 'manual', signal: ctl.signal,
        headers: { 'user-agent': this.o.ua, accept: method === 'HEAD' ? '*/*' : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'accept-language': 'de,en;q=0.8' },
      });
      const ttfb = performance.now() - t0;
      let buf = Buffer.alloc(0);
      if (method !== 'HEAD') buf = Buffer.from(await res.arrayBuffer());
      const ms = performance.now() - t0;
      return { res, buf, ttfb, ms };
    } finally { clearTimeout(timer); }
  }

  async bootstrap() {
    const origin = new URL(this.seed).origin;
    this.emitEv('start', { seed: this.seed, host: this.host, ua: this.o.ua, version: VERSION, options: {
      maxPages: this.o.maxPages, concurrency: this.o.concurrency, delay: this.o.delay,
      respectRobotsTxt: this.o.respectRobotsTxt, respectNofollow: this.o.respectNofollow } });
    this.log(`ArachNet ${VERSION}  target ${this.seed}`);

    // robots.txt
    let robotsText = '';
    try {
      const { res, buf, ms } = await this.request(origin + '/robots.txt');
      this.robots.status = res.status;
      const ct = res.headers.get('content-type') || '';
      if (res.status === 200 && !/html/i.test(ct)) robotsText = buf.toString('utf8');
      this.robots.ms = Math.round(ms);
    } catch (e) { this.robots.status = 'error'; this.robots.error = e.message; }
    const parsed = parseRobots(robotsText);
    this.robots.policy = robotsPolicy(parsed, this.o.ua);
    this.robots.sitemaps = parsed.sitemaps;
    this.robots.contentSignals = parsed.contentSignals;
    this.robots.groups = parsed.groups.map(g => ({ agents: g.agents, rules: g.rules.map(r => (r.allow ? 'Allow: ' : 'Disallow: ') + r.path), delay: g.delay }));
    if (this.robots.policy.delay && this.o.respectRobotsTxt) this.gap = this.o.delay = Math.max(this.o.delay, this.robots.policy.delay * 1000);
    this.emitEv('robots', { status: this.robots.status, groups: this.robots.groups.length, sitemaps: parsed.sitemaps, crawlDelay: this.robots.policy.delay });
    this.log(`  robots.txt: ${this.robots.status}${robotsText ? `, ${parsed.groups.length} groups` : ' (no rules -> everything allowed)'}`);

    // sitemaps
    if (this.o.sitemap) {
      const roots = parsed.sitemaps.length ? parsed.sitemaps : [origin + '/sitemap.xml'];
      const sm = await collectSitemaps(roots, async u => {
        const { res, buf } = await this.request(u);
        return { status: res.status, buf };
      }, { log: s => this.log('  ' + s) });
      for (const [loc, e] of sm.urls) {
        const u = normalize(loc);
        if (u && this.inScope(u)) this.sitemapUrls.set(u, e);
      }
      this.sitemapFiles = sm.files;
      this.emitEv('sitemap', { files: sm.files.length, urls: this.sitemapUrls.size });
    }

    const root = this.node(this.seed, 'seed', null, 0);
    this.enqueue(root, 0, 0);
    for (const u of this.sitemapUrls.keys()) this.enqueue(this.node(u, 'sitemap', null, 99), 1, 99);
  }

  async run() {
    await this.bootstrap();
    const workers = Array.from({ length: this.o.concurrency }, (_, i) => this.worker(i));
    await Promise.all(workers);
    return this.finish();
  }

  async worker(wid) {
    for (;;) {
      if (this.fetched >= this.o.maxPages || this.aborted) return;
      const e = this.frontier.pop();
      if (!e) {
        if (this.inflight === 0) return;               // nothing left anywhere
        await sleep(50); continue;                      // others may still discover work
      }
      if (e.stale || e.n.state !== 'queued') continue;
      this.fetched++; this.inflight++;
      try { await this.visit(e.n, wid); }
      catch (err) { this.log(`  ! ${e.n.url}: ${err.message}`); }
      finally { this.inflight--; }
    }
  }

  async visit(n, wid, attempt = 0) {
    n.state = 'fetching';
    const head = n.file;
    this.emitEv('fetch', { id: n.id, w: wid, method: head ? 'HEAD' : 'GET' });
    let r;
    try {
      r = await this.request(n.url, head ? 'HEAD' : 'GET');
      if (head && (r.res.status === 405 || r.res.status === 501)) r = await this.request(n.url, 'GET');
    } catch (err) {
      if (attempt < 2) { await sleep(800 * (attempt + 1)); return this.visit(n, wid, attempt + 1); }
      n.state = 'error'; n.error = String(err.message || err);
      if (++this.errorsInRow > 25) { this.aborted = true; this.log('  too many consecutive errors, aborting'); }
      this.emitEv('page', { id: n.id, status: 0, error: n.error });
      return;
    }
    this.errorsInRow = 0;
    const { res, buf, ttfb, ms } = r;
    const status = res.status;
    const loc = res.headers.get('location') || '';
    const errorBounce = status >= 300 && status < 400 && /error[_-]?path|\/error\b|captcha|blocked|denied|\b(429|503)\b/i.test(loc);
    this.pushback(status === 429 || status === 503 || errorBounce, errorBounce ? 'redirect to ' + loc.split('?')[0] : 'HTTP ' + status);
    if ((status === 429 || status === 503) && attempt < 3 && !this.aborted) {
      this.slowDown(+res.headers.get('retry-after') || 0);
      return this.visit(n, wid, attempt + 1);
    }
    if (!errorBounce) this.speedUp();

    const headers = {};
    for (const h of KEEP_HEADERS) { const v = res.headers.get(h); if (v != null) headers[h] = v.slice(0, 300); }
    Object.assign(n, {
      state: 'fetched', status, ttfb: Math.round(ttfb), ms: Math.round(ms), t: this.now(),
      ctype: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || null,
      bytes: head ? (+res.headers.get('content-length') || null) : buf.length,
      transfer: +res.headers.get('content-length') || null, headers, method: head ? 'HEAD' : 'GET',
    });

    const out = { id: n.id, status, ttfb: n.ttfb, ms: n.ms, bytes: n.bytes, ctype: n.ctype, w: wid, gap: Math.round(this.gap) };

    // redirects: record the hop and treat the target as a discovered link
    if (status >= 300 && status < 400 && res.headers.get('location')) {
      const to = normalize(res.headers.get('location'), n.url);
      n.redirect = to;
      if (to && !errorBounce) {
        if (this.inScope(to)) {
          const t = this.node(to, 'redirect', n.id, n.depth);
          this.link(n.id, t.id, 4);
          this.enqueue(t, 0, n.depth);
          out.edges = [[t.id, 4]];
        } else this.tallyExternal(to);
      }
      out.redirect = to;
      this.emitEv('page', out);
      this.progress(n);
      return;
    }

    const isHtml = !head && /html/.test(n.ctype || '') && status < 400;
    if (isHtml) this.analyse(n, buf, res, out);
    this.emitEv('page', out);
    this.progress(n);
  }

  analyse(n, buf, res, out) {
    const ct = res.headers.get('content-type') || '';
    let charset = (/charset=([\w-]+)/i.exec(ct) || [])[1];
    if (!charset) charset = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString('latin1')) || [])[1];
    let html;
    try { html = new TextDecoder(charset || 'utf-8').decode(buf); } catch { html = buf.toString('utf8'); }
    const x = extract(html);
    const base = x.base ? normalize(x.base, n.url) || n.url : n.url;
    const flags = robotsFlags(x.metaRobots, res.headers.get('x-robots-tag'));
    const nofollowPage = flags.nofollow && this.o.respectNofollow;

    let internal = 0, externalCount = 0, nofollowSkipped = 0;
    const edgesOut = [];
    const seenHere = new Set();
    for (const l of x.links) {
      const u = normalize(l.href, base);
      if (!u) continue;
      if (!this.inScope(u)) { externalCount++; this.tallyExternal(u); continue; }
      internal++;
      if (seenHere.has(u) || u === n.url) continue;
      seenHere.add(u);
      const relNofollow = /\bnofollow\b/.test(l.rel);
      const t = this.node(u, 'link', n.id, n.depth + 1);
      const fl = relNofollow ? 1 : 0;
      if (this.link(n.id, t.id, fl)) edgesOut.push([t.id, fl]);
      // follow policy: nofollow (page or link) means we only fetch what the
      // site operator published in its sitemap anyway
      const follow = !(nofollowPage || (relNofollow && this.o.respectNofollow)) || this.sitemapUrls.has(u);
      if (follow) this.enqueue(t, 0, n.depth + 1);
      else { nofollowSkipped++; if (t.state === 'known') t.state = 'not-followed'; }
    }

    const imgs = x.images.filter(i => i.src);
    Object.assign(n, {
      title: x.title, titleCount: x.titleCount, metaDescription: x.metaDescription, robots: flags, canonical: x.canonical ? normalize(x.canonical, base) : null,
      lang: x.lang, charset: x.charset || charset || null, viewport: x.viewport, h1: x.h1.slice(0, 5), h1Count: x.h1.length, hCount: x.hCount,
      headings: x.headings, wordCount: x.wordCount, textChars: x.textChars, linksInternal: internal, linksExternal: externalCount,
      linksUnique: seenHere.size, nofollowSkipped, templateLinks: x.templateLinks, images: imgs.length,
      imagesNoAlt: imgs.filter(i => i.alt == null).length, imagesEmptyAlt: imgs.filter(i => i.alt === '').length, imagesLazy: imgs.filter(i => i.lazy).length,
      scripts: x.scripts, scriptsExternal: x.scriptsExternal, stylesheets: x.stylesheets, inlineStyleBlocks: x.inlineStyleBlocks,
      iframes: x.iframes, forms: x.forms, inputs: x.inputs, jsonLd: x.jsonLd, og: Object.keys(x.og).length ? x.og : null, hreflang: x.hreflang,
      domNodes: x.domNodes, domDepth: x.domDepthMax, catCount: x.catCount, tagSeq: x.tagSeq.join(''),
      // what this page would weigh with gzip (only meaningful when the server sent it uncompressed)
      gzipBytes: res.headers.get('content-encoding') ? null : gzipSync(buf, { level: 6 }).length,
    });
    Object.assign(out, {
      title: x.title ? x.title.slice(0, 140) : null, words: x.wordCount, dom: x.domNodes, links: internal, ext: externalCount,
      imgs: imgs.length, noalt: n.imagesNoAlt, robots: flags.raw ? [flags.noindex && 'noindex', flags.nofollow && 'nofollow', flags.noai && 'noai'].filter(Boolean).join(',') : undefined,
      seq: n.tagSeq.slice(0, 240), edges: edgesOut,
    });
  }

  link(a, b, flags) {
    const k = a + '>' + b;
    if (this.edgeSet.has(k)) return false;
    this.edgeSet.add(k);
    this.edges.push([a, b, flags]);
    return true;
  }
  tallyExternal(u) {
    try { const h = new URL(u).hostname; this.external.set(h, (this.external.get(h) || 0) + 1); } catch {}
  }
  progress(n) {
    this.done = (this.done || 0) + 1;
    if (this.o.quiet) return;
    const s = String(n.status ?? 'ERR').padStart(3);
    process.stdout.write(`  [${String(this.done).padStart(4)}|q${String(this.frontier.size).padStart(4)}] ${s} ${String(n.ms ?? '-').padStart(5)}ms ${String(Math.round((n.bytes || 0) / 1024)).padStart(5)}KB  ${n.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 90)}\n`);
  }

  // ---- derived metrics once the crawl is over ----
  finish() {
    const N = this.nodes.length;
    const inl = new Array(N).fill(0), adj = Array.from({ length: N }, () => []);
    for (const [a, b] of this.edges) { inl[b]++; adj[a].push(b); }
    // click depth: BFS over the real link graph from the seed
    const depth = new Array(N).fill(-1); depth[0] = 0;
    const q = [0];
    for (let i = 0; i < q.length; i++) for (const b of adj[q[i]]) if (depth[b] < 0) { depth[b] = depth[q[i]] + 1; q.push(b); }
    // PageRank (damping .85), dangling mass spread evenly
    let pr = new Array(N).fill(1 / N);
    for (let it = 0; it < 40; it++) {
      const nx = new Array(N).fill(0.15 / N);
      let dangling = 0;
      for (let a = 0; a < N; a++) {
        if (!adj[a].length) { dangling += pr[a]; continue; }
        const share = 0.85 * pr[a] / adj[a].length;
        for (const b of adj[a]) nx[b] += share;
      }
      for (let i = 0; i < N; i++) nx[i] += 0.85 * dangling / N;
      pr = nx;
    }
    const maxPr = Math.max(...pr);
    this.nodes.forEach((n, i) => { n.inlinks = inl[i]; n.clickDepth = depth[i]; n.pagerank = +(pr[i] / maxPr).toFixed(5); delete n.queued; });
    const stats = this.stats();
    this.emitEv('done', { stats });
    this.log(`\n  done: ${stats.fetched} fetched, ${stats.nodes} nodes, ${stats.edges} links, ${(stats.bytes / 1048576).toFixed(1)} MB in ${(stats.duration / 1000).toFixed(1)} s`);
    return this.snapshot();
  }

  stats() {
    const f = this.nodes.filter(n => n.state === 'fetched' || n.state === 'error');
    const html = f.filter(n => n.title !== undefined);
    const byStatus = {};
    for (const n of f) byStatus[n.status ?? 0] = (byStatus[n.status ?? 0] || 0) + 1;
    const ttfbs = f.filter(n => n.ttfb != null && n.method === 'GET').map(n => n.ttfb).sort((a, b) => a - b);
    const pct = p => ttfbs.length ? ttfbs[Math.min(ttfbs.length - 1, Math.floor(p * ttfbs.length))] : null;
    return {
      nodes: this.nodes.length, edges: this.edges.length, fetched: f.length, html: html.length,
      bytes: f.reduce((s, n) => s + (n.method === 'GET' ? n.bytes || 0 : 0), 0), byStatus,
      ttfb: { p50: pct(.5), p90: pct(.9), p99: pct(.99), max: ttfbs[ttfbs.length - 1] ?? null },
      duration: this.now(), externalDomains: this.external.size, sitemapUrls: this.sitemapUrls.size,
      notFollowed: this.nodes.filter(n => n.state === 'not-followed').length,
      queuedLeft: this.nodes.filter(n => n.state === 'queued').length, stoppedBy: this.blocked || (this.aborted ? 'user' : null),
    };
  }

  snapshot() {
    return {
      generator: `ArachNet ${VERSION}`, seed: this.seed, host: this.host, ua: this.o.ua, startedAt: this.startedAt,
      options: { maxPages: this.o.maxPages, maxDepth: this.o.maxDepth, concurrency: this.o.concurrency, delay: this.o.delay,
        respectRobotsTxt: this.o.respectRobotsTxt, respectNofollow: this.o.respectNofollow, sitemap: this.o.sitemap, files: this.o.files },
      robots: { status: this.robots.status, groups: this.robots.groups, sitemaps: this.robots.sitemaps, contentSignals: this.robots.contentSignals, crawlDelay: this.robots.policy.delay },
      sitemapFiles: this.sitemapFiles || [], stats: this.stats(),
      external: [...this.external].sort((a, b) => b[1] - a[1]),
      nodes: this.nodes, edges: this.edges,
    };
  }
}

// ---------------------------------------------------------------------------
// replay a recorded crawl as if it were live (for the visualiser)
class Replay extends EventEmitter {
  constructor(file, speed) {
    super();
    const data = JSON.parse(readFileSync(file, 'utf8'));
    this.events = JSON.parse(readFileSync(path.join(path.dirname(file), 'events.json'), 'utf8'));
    this.speed = speed; this.backlog = []; this.data = data;
  }
  async run() {
    const t0 = performance.now();
    for (const ev of this.events) {
      const wait = ev.t / this.speed - (performance.now() - t0);
      if (wait > 0) await sleep(wait);
      this.backlog.push(ev); this.emit('event', ev);
    }
  }
}

async function main() {
  const o = parseArgs(process.argv);
  const vizDir = path.resolve(HERE, '..', 'viz3d');
  if (o.replay) {
    const rp = new Replay(o.replay, o.speed);
    if (o.audio) rp.trackParam = '&track=' + encodeURIComponent(path.basename(o.audio));
    let started = false;
    await serve({ port: o.live || 8080, mounts: { '/': vizDir, '/run/': path.dirname(path.resolve(o.replay)), ...(o.audio ? { '/audio/': path.dirname(path.resolve(o.audio)) } : {}) },
      feed: rp, snapshot: () => rp.data,
      onClient: () => { if (started) return; started = true; console.log('  viewer connected -> replay starts'); rp.run().then(() => console.log('  replay finished')); } });
    console.log(`  replaying ${rp.events.length} events at ${o.speed}x as soon as a viewer connects`);
    return;
  }
  if (!o.seed) { console.log(HELP); process.exit(2); }

  const c = new Crawler(o);
  c.startedAt = new Date().toISOString();
  const stamp = c.startedAt.replace(/[:.]/g, '-').slice(0, 19);
  const out = path.resolve(o.out || path.join(HERE, '..', 'runs', `${c.host}-${stamp}`));
  mkdirSync(out, { recursive: true });
  const nd = createWriteStream(path.join(out, 'events.ndjson'));
  c.on('event', ev => nd.write(JSON.stringify(ev) + '\n'));

  if (o.audio) c.trackParam = '&track=' + encodeURIComponent(path.basename(o.audio));
  if (o.live) await serve({ port: o.live, mounts: { '/': vizDir, '/run/': out, ...(o.audio ? { '/audio/': path.dirname(path.resolve(o.audio)) } : {}) }, feed: c, snapshot: () => c.snapshot() });

  let stopping = false;
  process.on('SIGINT', () => { if (stopping) process.exit(1); stopping = true; console.log('\n  stopping after in-flight requests (ctrl-c again to kill)'); c.aborted = true; });

  const stopFile = path.join(out, 'STOP');
  const poll = setInterval(() => { if (existsSync(stopFile)) { c.log('  STOP file found -> stopping'); c.aborted = true; clearInterval(poll); } }, 1000);
  const result = await c.run();
  clearInterval(poll);
  writeFileSync(path.join(out, 'crawl.json'), JSON.stringify(result));
  writeFileSync(path.join(out, 'events.json'), JSON.stringify(c.backlog));
  nd.end();
  console.log(`  output -> ${out}`);
  if (o.live) console.log('  live server still running (ctrl-c to quit)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
