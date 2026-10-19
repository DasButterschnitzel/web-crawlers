// CrawlModel: the crawl as the visualiser sees it — fetched pages become
// nodes with an appearance time, links between fetched pages become edges.
// Built either from a recorded run (crawl.json + events.json, mapped onto the
// video timeline and quantised to the music) or incrementally from live events.
import { ForceLayout3D, cityLayout, rng } from './layout.js';

export const PALETTE = ['#00f0ff', '#ff2bd6', '#7c4dff', '#39ff88', '#ffb000', '#ff3355', '#2e7bff', '#c6ff00', '#ff6a00', '#00ffc8', '#ff77aa', '#9d7bff'];
export const STATUS_COLOR = s => s >= 500 || !s ? '#ff1e3c' : s >= 400 ? '#ff3355' : s >= 300 ? '#ffb000' : '#00f0ff';

const shortPath = url => { try { const u = new URL(url); return decodeURIComponent(u.pathname + u.search); } catch { return url; } };

export class CrawlModel {
  constructor() {
    this.nodes = []; this.edges = []; this.byCrawlId = new Map();
    this.sections = new Map(); this.sectionList = [];
    this.layout = new ForceLayout3D({ seed: 1337 });
    this.meta = { host: '', seed: '' };
    this.inDeg = [];
  }

  sectionInfo(name) {
    let s = this.sections.get(name);
    if (!s) {
      s = { name, count: 0, color: PALETTE[this.sections.size % PALETTE.length], idx: this.sections.size, firstT: Infinity, sum: [0, 0, 0] };
      this.sections.set(name, s); this.sectionList.push(s);
    }
    return s;
  }

  addNode(cn, page, t) {
    const sec = this.sectionInfo(cn.section || '?');
    const parentCid = cn.parent ?? null;
    const parent = parentCid != null && this.byCrawlId.has(parentCid) ? this.byCrawlId.get(parentCid) : (this.nodes.length ? 0 : -1);
    const n = {
      i: this.nodes.length, cid: cn.id, url: cn.url, path: shortPath(cn.url), section: sec.name, sec,
      title: (page.title || cn.title || '').replace(/\s*\|\s*Stadt Dreieich\s*$/i, '').trim(),
      status: page.status ?? cn.status, ttfb: page.ttfb ?? cn.ttfb ?? 0, ms: page.ms ?? cn.ms ?? 0, bytes: page.bytes ?? cn.bytes ?? 0,
      ctype: page.ctype ?? cn.ctype, words: page.words ?? cn.wordCount ?? 0, dom: page.dom ?? cn.domNodes ?? 0,
      links: page.links ?? cn.linksInternal ?? 0, ext: page.ext ?? cn.linksExternal ?? 0, imgs: page.imgs ?? cn.images ?? 0,
      noalt: page.noalt ?? cn.imagesNoAlt ?? 0, seq: page.seq || (cn.tagSeq || '').slice(0, 240), redirect: page.redirect || cn.redirect || null,
      pr: cn.pagerank ?? 0, inl: cn.inlinks ?? 0, depth: cn.clickDepth ?? cn.depth ?? 0, parent, t, file: !!cn.file,
      out: (page.edges || []).length,
    };
    n.blocked = n.status === 503 || /error[_-]?path/.test(n.redirect || '');
    sec.count++; sec.firstT = Math.min(sec.firstT, t);
    this.nodes.push(n); this.byCrawlId.set(cn.id, n.i); this.inDeg.push(0);
    n.li = this.layout.addNode(sec.name, parent, 0);
    if (parent >= 0) this.layout.addSpring(parent, n.i, 0.035, 2.6);
    return n;
  }

  addEdge(a, b, t, kind = 0) {
    this.inDeg[b]++;
    const e = { a, b, t, kind };
    this.edges.push(e);
    return e;
  }

  // ---------------------------------------------------------------------
  /** recorded run -> deterministic timeline. timing: { start, end, bpm, grid0 } */
  static fromRecorded(crawl, events, timing) {
    const m = new CrawlModel();
    m.meta = { host: crawl.host, seed: crawl.seed, stats: crawl.stats, robots: crawl.robots, ua: crawl.ua, startedAt: crawl.startedAt, external: crawl.external, sitemapFiles: crawl.sitemapFiles, options: crawl.options };
    const cnodes = crawl.nodes;
    // the firewall's own error pages are not part of the site
    const pages = events.filter(e => e.type === 'page' && e.status && !/\/error_path\//.test(cnodes[e.id]?.url || ''));
    const N = pages.length;
    // video time: concave warp (first pages get room to breathe), quantised to 16th notes
    const sixteenth = 60 / timing.bpm / 4;
    const warp = u => 0.42 * Math.pow(u, 0.5) + 0.58 * u;
    m.realDuration = (pages[N - 1]?.t || 1) / 1000;
    // pages until the firewall kicked in fill [start, ice]; the bounced rest storms through [ice, end]
    const blockedEv = p => p.status === 503 || /error[_-]?path/.test(p.redirect || '');
    let b0 = pages.findIndex(blockedEv);
    if (b0 < 0 || timing.ice == null) b0 = N;
    const times = pages.map((p, i) => {
      const tv = i < b0
        ? timing.start + ((timing.ice ?? timing.end) - timing.start) * warp(b0 > 1 ? i / (b0 - 1) : 0)
        : timing.ice + (timing.end - timing.ice) * Math.pow((i - b0) / Math.max(1, N - 1 - b0), 0.8);
      return timing.grid0 + Math.round((tv - timing.grid0) / sixteenth) * sixteenth;
    });
    m.iceIndex = b0;
    // section order by size so anchors are stable and the biggest get the best spots
    const secCount = new Map();
    for (const p of pages) { const s = cnodes[p.id].section; secCount.set(s, (secCount.get(s) || 0) + 1); }
    const order = [...secCount].sort((a, b) => b[1] - a[1]).map(x => x[0]);
    m.layout.setSections(order.filter(s => s !== '/'));
    order.forEach(s => m.sectionInfo(s));

    const pending = [];
    pages.forEach((p, i) => { const n = m.addNode(cnodes[p.id], p, times[i]); n.realT = p.t / 1000; n.order = i; pending.push([n, p.edges || []]); });

    // edges between fetched pages; global navigation (linked from most pages) is not drawn
    const raw = [];
    for (const [n, edges] of pending) for (const [cid, fl] of edges) {
      const b = m.byCrawlId.get(cid); if (b == null || b === n.i) continue;
      raw.push([n.i, b, fl]);
    }
    const indeg = new Array(m.nodes.length).fill(0);
    for (const [, b] of raw) indeg[b]++;
    const navCut = Math.max(25, m.nodes.length * 0.12);
    const R = rng(99);
    const tree = new Set(m.nodes.map(n => n.parent + '>' + n.i));
    const keep = [];
    for (const [a, b, fl] of raw) {
      const isTree = tree.has(a + '>' + b);
      const nav = indeg[b] > navCut;
      if (isTree || (!nav && R() < 0.9) || (nav && R() < 0.012)) keep.push([a, b, fl, isTree, nav]);
    }
    const MAXE = 16000;
    const chosen = keep.length > MAXE ? keep.filter(e => e[3] || R() < MAXE / keep.length) : keep;
    for (const [a, b, fl, isTree, nav] of chosen) {
      const e = m.addEdge(a, b, Math.max(m.nodes[a].t, m.nodes[b].t), (isTree ? 1 : 0) | (nav ? 2 : 0) | (fl & 4 ? 4 : 0));
      if (!isTree && !nav) m.layout.addSpring(a, b, 0.006, 7);
    }
    m.navCut = navCut;
    // hubs sink to the core
    const maxPr = Math.max(...m.nodes.map(n => n.pr), 1e-9);
    m.nodes.forEach(n => { n.prn = n.pr / maxPr; m.layout.setHub(n.li, Math.min(0.7, 0.75 * Math.pow(n.prn, 0.7))); });
    m.layout.step(520);
    m.layout.step(120, { alpha: 0.4 });
    m.finalise();
    return m;
  }

  /** derived per-node render data (final positions, city, colours) */
  finalise() {
    const L = this.layout;
    for (const n of this.nodes) { const p = L.pos(n.li); n.gx = p[0]; n.gy = p[1]; n.gz = p[2]; }
    // centroid per section for labels
    for (const s of this.sectionList) s.sum = [0, 0, 0];
    for (const n of this.nodes) { const s = n.sec.sum; s[0] += n.gx; s[1] += n.gy; s[2] += n.gz; }
    for (const s of this.sectionList) if (s.count) s.centroid = s.sum.map(v => v / s.count);
    this.buildCity();
    // cumulative counters for the HUD (nodes are in appearance order)
    let bytes = 0, err = 0, red = 0, noalt = 0, words = 0, ttfbSum = 0, links = 0, blocked = 0;
    this.cum = this.nodes.map(n => {
      bytes += n.bytes || 0; links += n.out || 0; noalt += n.noalt || 0; words += n.words || 0; ttfbSum += n.ttfb || 0;
      if (n.blocked) blocked++; else if (n.status >= 400) err++; else if (n.status >= 300) red++;
      return { bytes, err, red, noalt, words, links, blocked, ttfbAvg: ttfbSum / (n.i + 1) };
    });
    this.edgesByT = this.edges.slice().sort((a, b) => a.t - b.t);
    this.edgeTimes = this.edgesByT.map(e => e.t);
    this.nodeTimes = this.nodes.map(n => n.t);
  }

  buildCity() {
    const pages = this.nodes.map(n => ({ id: n.i, section: n.section, pr: n.prn ?? n.pr ?? 0 }));
    const c = cityLayout(pages, { cell: 2.1, street: 4.5 });
    this.city = c;
    const maxW = Math.log1p(Math.max(...this.nodes.map(n => n.words || 0), 1));
    const maxB = Math.log1p(Math.max(...this.nodes.map(n => n.bytes || 0), 1));
    for (const n of this.nodes) {
      const p = c.pos.get(n.i);
      n.cx = p.x; n.cz = p.z; n.cw = p.w;
      const pr = Math.pow(n.prn ?? 0, 0.45);
      n.ch = n.file ? 0.6 + 1.2 * (Math.log1p(n.bytes || 0) / maxB) : 1.0 + 3.2 * (Math.log1p(n.words || 0) / maxW) + 9 * pr;
      if (n.status >= 400) n.ch = 0.5;
    }
  }

  // ---------------------------------------------------------------------
  // live ingestion (SSE). Times are wall-clock seconds of the visualiser.
  ingest(ev, t) {
    this.cnodes ??= new Map();
    this.waiting ??= new Map();
    this.nodeTimes ??= []; this.edgeTimes ??= []; this.edgesByT ??= this.edges; this.cum ??= [];
    switch (ev.type) {
      case 'start': this.meta.host = ev.host; this.meta.seed = ev.seed; this.meta.ua = ev.ua; this.meta.options = ev.options; break;
      case 'robots': this.meta.robots = ev; break;
      case 'sitemap': this.meta.sitemap = ev; break;
      case 'node': this.cnodes.set(ev.id, ev); break;
      case 'blocked': this.meta.blocked = { t, reason: ev.reason }; break;
      case 'throttle': this.meta.throttle = { t, gap: ev.gap }; break;
      case 'page': {
        if (!ev.status) return null;
        const cn = this.cnodes.get(ev.id) || { id: ev.id, url: '?', section: '?' };
        if (/\/error_path\//.test(cn.url)) return null;
        const n = this.addNode(cn, ev, t);
        n.realT = ev.t / 1000; n.prn = 0;
        const p = n.parent >= 0 ? this.nodes[n.parent] : null;
        n.gx = p ? p.gx : 0; n.gy = p ? p.gy : 0; n.gz = p ? p.gz : 0;
        this.nodeTimes.push(t);
        for (const [cid] of ev.edges || []) {
          const b = this.byCrawlId.get(cid);
          if (b == null) { if (!this.waiting.has(cid)) this.waiting.set(cid, []); this.waiting.get(cid).push(n.i); }
          else if (b !== n.i) this.liveEdge(n.i, b, t);
        }
        for (const a of this.waiting.get(cn.id) || []) this.liveEdge(a, n.i, t);
        this.waiting.delete(cn.id);
        const prev = this.cum[this.cum.length - 1] || { bytes: 0, err: 0, red: 0, noalt: 0, words: 0, links: 0, blocked: 0, ttfbAvg: 0 };
        const k = this.cum.length;
        this.cum.push({
          bytes: prev.bytes + (n.bytes || 0), links: prev.links + (n.out || 0), noalt: prev.noalt + (n.noalt || 0), words: prev.words + (n.words || 0),
          blocked: prev.blocked + (n.blocked ? 1 : 0), err: prev.err + (!n.blocked && n.status >= 400 ? 1 : 0), red: prev.red + (!n.blocked && n.status >= 300 && n.status < 400 ? 1 : 0),
          ttfbAvg: (prev.ttfbAvg * k + (n.ttfb || 0)) / (k + 1),
        });
        return n;
      }
      case 'done': this.meta.stats = ev.stats; break;
    }
    return null;
  }
  liveEdge(a, b, t, max = 30000) {
    if (this.edges.length >= max || this.inDeg[b] > Math.max(20, this.nodes.length * 0.15)) { this.inDeg[b]++; return; }
    this.addEdge(a, b, t, this.nodes[b].parent === a ? 1 : 0);
    this.edgeTimes.push(t);
    if (this.nodes[b].parent !== a) this.layout.addSpring(a, b, 0.006, 7);
  }
  /** copy live layout positions into the nodes and refresh centroids */
  syncLayout() {
    const L = this.layout;
    for (const n of this.nodes) { const p = L.pos(n.li); n.gx = p[0]; n.gy = p[1]; n.gz = p[2]; }
    for (const s of this.sectionList) s.sum = [0, 0, 0];
    for (const n of this.nodes) { const s = n.sec.sum; s[0] += n.gx; s[1] += n.gy; s[2] += n.gz; }
    for (const s of this.sectionList) if (s.count) s.centroid = s.sum.map(v => v / s.count);
    const maxIn = Math.max(1, ...this.inDeg);
    this.nodes.forEach((n, i) => { n.prn = this.inDeg[i] / maxIn; n.inl = this.inDeg[i]; });
  }
}

export function lastLE(arr, t) {
  let lo = 0, hi = arr.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}
