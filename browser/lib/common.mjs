// Shared browser plumbing: launching Chrome, the response cache (record /
// replay), cookie-dialog handling and the "which link next" heuristics.
import puppeteer from 'puppeteer-core';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.bin': 'application/octet-stream', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.css': 'text/css' };

export const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

export async function launch({ headless = true, w = 1920, h = 1080, gpu = true } = {}) {
  const args = ['--hide-scrollbars', '--force-color-profile=srgb', '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
  if (gpu) args.push('--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11');
  if (!headless) args.push(`--window-size=${w},${h + 140}`, '--app=about:blank');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless, protocolTimeout: 600000, args, defaultViewport: { width: w, height: h, deviceScaleFactor: 1 } });
  const ua = (await browser.userAgent()).replace('HeadlessChrome', 'Chrome') + ' ArachNet/1.0 (+https://github.com/DasButterschnitzel/web-crawlers)';
  return { browser, ua };
}

// ------------------------------------------------------------------ cache
export class Cache {
  constructor(dir) {
    this.dir = dir; mkdirSync(path.join(dir, 'files'), { recursive: true });
    const idx = path.join(dir, 'index.json');
    this.index = existsSync(idx) ? JSON.parse(readFileSync(idx, 'utf8')) : {};
  }
  key(url) { return createHash('sha1').update(url).digest('hex'); }
  has(url) { return !!this.index[url]; }
  put(url, status, headers, buf) {
    const k = this.key(url);
    writeFileSync(path.join(this.dir, 'files', k), buf);
    this.index[url] = { k, status, type: headers['content-type'] || 'application/octet-stream', size: buf.length };
  }
  get(url) {
    const e = this.index[url];
    if (!e) return null;
    return { status: e.status, contentType: e.type, body: readFileSync(path.join(this.dir, 'files', e.k)) };
  }
  save() { writeFileSync(path.join(this.dir, 'index.json'), JSON.stringify(this.index, null, 0)); }
}

/**
 * Route requests: own site -> network (recording) or cache (replay);
 * our local injection server -> network; everything third-party -> blocked.
 */
export async function routeRequests(page, { site, cache, record, local, mounts, freshDocuments = false }) {
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    // our own overlay files, served under the site's origin (no CORS / CSP / local-network prompts)
    if (mounts && u.startsWith(site + '__arachnet/')) {
      const rel = decodeURIComponent(new URL(u).pathname.slice('/__arachnet/'.length));
      const pre = Object.keys(mounts).find(p => rel.startsWith(p));
      const file = pre && path.resolve(mounts[pre], rel.slice(pre.length));
      if (!file || !file.startsWith(path.resolve(mounts[pre])) || !existsSync(file)) return req.respond({ status: 404, body: '' });
      return req.respond({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: readFileSync(file), headers: { 'cache-control': 'no-store' } });
    }
    if (u.startsWith('data:') || u.startsWith('blob:')) return req.continue();
    if (local && u.startsWith(local)) return req.continue();
    const own = u.startsWith(site);
    if (!own) return req.abort('blockedbyclient');
    const hit = freshDocuments && req.resourceType() === 'document' ? null : cache.get(u);
    if (record && !hit) { page.__net = (page.__net || 0) + 1; return req.continue(); }   // already cached: never ask the site twice
    if (!hit) return req.respond({ status: 404, contentType: 'text/plain', body: '' });
    req.respond({ status: hit.status, contentType: hit.contentType, body: hit.body, headers: { 'access-control-allow-origin': '*' } });
  });
  if (record) page.on('response', async res => {
    const u = res.url(), req = res.request();
    if (!u.startsWith(site) || req.method() !== 'GET' || cache.has(u)) return;
    const st = res.status();
    if (st >= 300 && st < 400) return;
    try { cache.put(u, st, res.headers(), await res.buffer()); } catch { /* streamed / aborted */ }
  });
}

// close the consent dialog without consenting to anything, and keep it hidden
export const QUIET_CSS = `
  dialog.cookie-consent-form, .cookie-consent-form, #eyeAble_container_ID, .eyeAble_customToolOpenerClass { display: none !important; }
  html, body { overflow: visible !important; scroll-behavior: auto !important; }
  * { scroll-behavior: auto !important; }
`;
export async function quietPage(page) {
  await page.evaluate(css => {
    document.querySelectorAll('dialog[open]').forEach(d => { try { d.close(); } catch {} });
    const s = document.createElement('style'); s.dataset.arachnet = 'quiet'; s.textContent = css; document.head.appendChild(s);
    document.documentElement.style.overflow = ''; document.body.style.overflow = '';
  }, QUIET_CSS);
}

/** visible, in-site content links (not header/nav/footer), with document rects */
export async function contentLinks(page, site) {
  return page.evaluate(site => {
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      let u;
      try { u = new URL(a.getAttribute('href'), location.href); } catch { continue; }
      u.hash = '';
      const href = u.href;
      if (!href.startsWith(site) || /\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|ics|xml|rss|vcf|json)(\?|$)/i.test(u.pathname)) continue;
      if (a.closest('header, footer, [role=banner], [role=contentinfo], .breadcrumb, .main-navigation, .footer')) continue;
      const r = a.getBoundingClientRect();
      if (r.width < 24 || r.height < 8) continue;
      const cs = getComputedStyle(a);
      if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity < .2) continue;
      const text = (a.innerText || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      if (text.length < 3) continue;
      const key = href + '|' + Math.round(r.top + scrollY);
      if (seen.has(key)) continue; seen.add(key);
      out.push({ href, text: text.slice(0, 90), x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height });
    }
    return out;
  }, site);
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
