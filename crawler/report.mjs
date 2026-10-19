#!/usr/bin/env node
// Crawl report: crawl.json (+ events.json) -> one self-contained HTML file
// (inline SVG charts with hover, tables, light/dark), optionally a PDF.
//
//   node report.mjs ../runs/<run> [--pdf] [--lang de]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || '.');
const wantPdf = process.argv.includes('--pdf');
// gzip/raw ratio measured on the homepage when the run predates per-page gzip measurement
const SAMPLE_RATIO = +(process.argv[process.argv.indexOf('--gzip-ratio') + 1] || 0) || 35465 / 254108;
const crawl = JSON.parse(readFileSync(path.join(dir, 'crawl.json'), 'utf8'));
const events = existsSync(path.join(dir, 'events.json')) ? JSON.parse(readFileSync(path.join(dir, 'events.json'), 'utf8')) : [];

// ------------------------------------------------------------------ helpers
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf = n => (n ?? 0).toLocaleString('de-DE');
const pct = (a, b) => b ? (100 * a / b).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' %' : '–';
const kb = b => b == null ? '–' : b >= 1048576 ? (b / 1048576).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' MB' : (b / 1024).toLocaleString('de-DE', { maximumFractionDigits: 0 }) + ' KB';
const quant = (arr, q) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const rel = url => { try { const u = new URL(url); return decodeURIComponent(u.pathname + u.search); } catch { return url; } };
const link = url => `<a href="${esc(url)}">${esc(rel(url))}</a>`;
const countBy = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); m.set(k, (m.get(k) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]); };

// ------------------------------------------------------------------ data
const N = crawl.nodes;
const fetched = N.filter(n => n.state === 'fetched' || n.state === 'error');
const isBlocked = n => n.status === 503 || /error[_-]?path/.test(n.redirect || '');
const firewallPages = fetched.filter(n => /\/error_path\//.test(n.url));
const real = fetched.filter(n => !/\/error_path\//.test(n.url));
const blocked = real.filter(isBlocked);
const ok = real.filter(n => !isBlocked(n));
const html = ok.filter(n => n.title !== undefined);
const files = ok.filter(n => n.method === 'HEAD');
const redirects = ok.filter(n => n.status >= 300 && n.status < 400);
const broken = ok.filter(n => n.status >= 400);
const st = crawl.stats;
const host = crawl.host;
const started = new Date(crawl.startedAt);
const dateDe = started.toLocaleString('de-DE', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Berlin' });

const ttfbHtml = html.map(n => n.ttfb);
const sizes = html.map(n => n.bytes);
const slow = html.slice().sort((a, b) => b.ttfb - a.ttfb).slice(0, 12);
const heavy = html.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 10);

// SEO
const noTitle = html.filter(n => !n.title);
const titleGroups = countBy(html.filter(n => n.title), n => n.title).filter(([, c]) => c > 1);
const dupTitlePages = titleGroups.reduce((s, [, c]) => s + c, 0);
const longTitle = html.filter(n => n.title && n.title.length > 65);
const noDesc = html.filter(n => !n.metaDescription);
const descGroups = countBy(html.filter(n => n.metaDescription), n => n.metaDescription).filter(([, c]) => c > 1);
const dupDescPages = descGroups.reduce((s, [, c]) => s + c, 0);
const noH1 = html.filter(n => !n.h1Count);
const multiH1 = html.filter(n => n.h1Count > 1);
const noCanon = html.filter(n => !n.canonical);
const canonElse = html.filter(n => n.canonical && n.canonical !== n.url);
const noindex = html.filter(n => n.robots?.noindex);
const langs = countBy(html, n => n.lang || '(fehlt)');
const noViewport = html.filter(n => !n.viewport);
const ld = countBy(html.flatMap(n => n.jsonLd || []), x => x);
const ogPages = html.filter(n => n.og).length;
// accessibility
const imgTotal = html.reduce((s, n) => s + (n.images || 0), 0);
const imgNoAlt = html.reduce((s, n) => s + (n.imagesNoAlt || 0), 0);
const imgEmptyAlt = html.reduce((s, n) => s + (n.imagesEmptyAlt || 0), 0);
const pagesNoAlt = html.filter(n => n.imagesNoAlt > 0);
const templ = html.filter(n => n.templateLinks > 0);
// tech
const hdr = (n, h) => n.headers?.[h];
const secHeaders = ['strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy'];
const secCover = secHeaders.map(h => [h, html.filter(n => hdr(n, h)).length]);
const enc = countBy(html, n => hdr(n, 'content-encoding') || '(keine)');
const cache = countBy(html, n => hdr(n, 'cache-control') || '(fehlt)');
const servers = countBy(html, n => [hdr(n, 'server'), hdr(n, 'x-powered-by')].filter(Boolean).join(' / ') || '(keine Angabe)');
const domAvg = avg(html.map(n => n.domNodes || 0)), domMax = Math.max(...html.map(n => n.domNodes || 0));
const scriptsAvg = avg(html.map(n => n.scripts || 0));
const wordsAvg = avg(html.map(n => n.wordCount || 0));
// structure
const depthDist = countBy(html.filter(n => n.clickDepth >= 0), n => n.clickDepth).sort((a, b) => a[0] - b[0]);
const unreachable = html.filter(n => n.clickDepth < 0).length;
const prTop = html.slice().sort((a, b) => b.pagerank - a.pagerank).slice(0, 12);
const sections = countBy(html, n => n.section);
const smSet = new Set(N.filter(n => n.inSitemap).map(n => n.url));
const htmlInSm = html.filter(n => n.inSitemap).length;
const htmlNotInSm = html.filter(n => !n.inSitemap);
const smNotFetched = N.filter(n => n.inSitemap && n.state !== 'fetched').length;
const orphans = html.filter(n => n.inSitemap && n.inlinks === 0);
const ext = crawl.external.slice(0, 15);
// who links to broken pages
const byId = new Map(N.map(n => [n.id, n]));
const linkersOf = id => crawl.edges.filter(e => e[1] === id).map(e => byId.get(e[0])).filter(Boolean);
// timeline (requests per 30 s, ok vs blocked)
const pageEv = events.filter(e => e.type === 'page');
const evBlocked = e => e.status === 503 || /error[_-]?path/.test(e.redirect || '');
const firstBlock = pageEv.find(evBlocked);
const reqsBeforeBlock = firstBlock ? pageEv.indexOf(firstBlock) : pageEv.length;
const BUCKET = 30000;
const buckets = [];
for (const e of pageEv) { const b = Math.floor(e.t / BUCKET); buckets[b] ??= [0, 0]; buckets[b][evBlocked(e) ? 1 : 0]++; }
for (let i = 0; i < buckets.length; i++) buckets[i] ??= [0, 0];
const ratePre = firstBlock ? reqsBeforeBlock / (firstBlock.t / 1000) : 0;

// ------------------------------------------------------------------ charts (inline SVG)
// single series -> no legend; >= 2 series -> legend; thin bars, rounded data end, hairline grid
function hbar(rows, { unit = '', w = 640, fmt = nf, color = 'var(--series-1)', label = r => r[0] } = {}) {
  const bh = 18, gap = 10, lw = 210, top = 4, vw = w - lw - 70;
  const mx = Math.max(...rows.map(r => r[1]), 1);
  const h = top + rows.length * (bh + gap);
  let s = `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Balkendiagramm">`;
  rows.forEach((r, i) => {
    const y = top + i * (bh + gap), bw = Math.max(2, vw * r[1] / mx);
    s += `<g class="mark" data-tip="${esc(label(r))}: ${esc(fmt(r[1]))}${unit}">`
      + `<rect class="hit" x="0" y="${y - gap / 2}" width="${w}" height="${bh + gap}" fill="transparent"/>`
      + `<text x="${lw - 10}" y="${y + bh * 0.72}" text-anchor="end" class="lab">${esc(String(label(r)).slice(0, 30))}</text>`
      + `<path d="M${lw},${y} h${bw - 4} a4,4 0 0 1 4,4 v${bh - 8} a4,4 0 0 1 -4,4 h${-(bw - 4)} z" fill="${r[2] || color}"/>`
      + `<text x="${lw + bw + 8}" y="${y + bh * 0.72}" class="val">${esc(fmt(r[1]))}${unit}</text></g>`;
  });
  return s + '</svg>';
}

function columns(series, cats, { w = 680, h = 230, stacked = false, xlab = '', tipCat = c => c, yfmt = nf, every = 1 } = {}) {
  const L = 44, B = 34, T = 10, R = 8, pw = w - L - R, ph = h - T - B;
  const totals = cats.map((_, i) => stacked ? series.reduce((s, se) => s + se.data[i], 0) : Math.max(...series.map(se => se.data[i])));
  const raw = Math.max(...totals, 1);
  const step = Math.pow(10, Math.floor(Math.log10(raw))) * (raw / Math.pow(10, Math.floor(Math.log10(raw))) > 5 ? 2 : raw / Math.pow(10, Math.floor(Math.log10(raw))) > 2 ? 1 : 0.5);
  const mx = Math.ceil(raw / step) * step;
  const band = pw / cats.length, bw = Math.min(24, band - 2);
  let s = `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Säulendiagramm">`;
  for (let v = 0; v <= mx + 1e-9; v += step) {
    const y = T + ph - ph * v / mx;
    s += `<line x1="${L}" x2="${w - R}" y1="${y}" y2="${y}" class="grid"/><text x="${L - 6}" y="${y + 4}" text-anchor="end" class="tick">${yfmt(v)}</text>`;
  }
  cats.forEach((c, i) => {
    const x = L + i * band + (band - bw) / 2;
    let base = T + ph;
    const parts = series.map(se => `${se.name}: ${nf(se.data[i])}`).join(' · ');
    s += `<g class="mark" data-tip="${esc(tipCat(c))} — ${esc(parts)}"><rect class="hit" x="${L + i * band}" y="${T}" width="${band}" height="${ph}" fill="transparent"/>`;
    const segs = series.map(se => se.data[i]).map((v, k) => [v, k]).filter(([v]) => v > 0);
    segs.forEach(([v, k], j) => {
      const hh = ph * v / mx, y = base - hh;
      const topSeg = j === segs.length - 1;
      const r = Math.min(4, hh / 2, bw / 2);
      const gapH = j > 0 ? 2 : 0;                // 2px surface gap between stacked segments
      const yy = y, hh2 = Math.max(0.5, hh - gapH);
      s += topSeg
        ? `<path d="M${x},${yy + hh2} v${-(hh2 - r)} a${r},${r} 0 0 1 ${r},${-r} h${bw - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${hh2 - r} z" fill="${series[k].color}"/>`
        : `<rect x="${x}" y="${yy}" width="${bw}" height="${hh2}" fill="${series[k].color}"/>`;
      base = y;
    });
    s += '</g>';
    if (i % every === 0) s += `<text x="${L + i * band + band / 2}" y="${h - B + 16}" text-anchor="middle" class="tick">${esc(c)}</text>`;
  });
  s += `<line x1="${L}" x2="${w - R}" y1="${T + ph}" y2="${T + ph}" class="axis"/>`;
  if (xlab) s += `<text x="${L + pw / 2}" y="${h - 4}" text-anchor="middle" class="tick">${esc(xlab)}</text>`;
  return s + '</svg>';
}

const legend = items => `<div class="legend">${items.map(([n, c]) => `<span><i style="background:${c}"></i>${esc(n)}</span>`).join('')}</div>`;
const table = (head, rows, cls = '') => `<div class="tw"><table class="${cls}"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const details = (summary, inner) => `<details class="tv"><summary>${summary}</summary>${inner}</details>`;

// TTFB histogram
const tb = [[0, 50], [50, 100], [100, 150], [150, 200], [200, 300], [300, 500], [500, 1000], [1000, 2000], [2000, 1e9]];
const tbLab = ['<50', '50–100', '100–150', '150–200', '200–300', '300–500', '0,5–1 s', '1–2 s', '>2 s'];
const tbData = tb.map(([a, b]) => ttfbHtml.filter(v => v >= a && v < b).length);
// size histogram
// size bins that fit this site: 7 even steps between the 5th and 95th percentile
const kbs = sizes.map(b => b / 1024), lo = Math.floor(quant(kbs, .05) / 10) * 10, hi = Math.ceil(quant(kbs, .95) / 10) * 10;
const stepKb = Math.max(5, Math.ceil((hi - lo) / 5 / 5) * 5);
const sb = [[0, lo]]; for (let a = lo; a < hi; a += stepKb) sb.push([a, a + stepKb]); sb.push([sb[sb.length - 1][1], 1e9]);
const sbLab = sb.map(([a, b], i) => i === 0 ? `<${a}` : b >= 1e9 ? `>${a}` : `${a}–${b}`);
const sbData = sb.map(([a, b]) => sizes.filter(v => v / 1024 >= a && v / 1024 < b).length);

const statusRows = countBy(real, n => isBlocked(n) ? 'WAF-Bounce (303 → 503)' : String(n.status)).map(([k, c]) => [k, c,
  k.startsWith('WAF') ? 'var(--critical)' : k.startsWith('2') ? 'var(--good)' : k.startsWith('3') ? 'var(--warning)' : 'var(--serious)']);

// ------------------------------------------------------------------ findings
const findings = [];
const F = (sev, title, text) => findings.push({ sev, title, text });
if (blocked.length) F('kritisch', 'Web Application Firewall blockt den Crawler',
  `Nach ${nf(reqsBeforeBlock)} Anfragen (≈ ${ratePre.toLocaleString('de-DE', { maximumFractionDigits: 1 })} Anfragen/s) leitete der Server jede weitere Anfrage per <code>303</code> auf <code>/error_path/503.html</code> um (${nf(blocked.length)} Bounces). Das schützt die Seite, betrifft aber auch legitime Audit- und Monitoring-Tools. Für Audits eine Allowlist (User-Agent/IP) einrichten oder mit ≤ 1 Anfrage/s crawlen.`);
if (crawl.robots.status !== 200) F('hoch', 'Keine robots.txt',
  `<code>/robots.txt</code> liefert die HTML-404-Seite (Status ${crawl.robots.status}). Damit fehlen Crawl-Regeln und der <code>Sitemap:</code>-Hinweis. Die 404-Vorlage enthält zwar <code>meta robots="noai, noindex, nofollow, noarchive, GPTBot: noindex, …"</code>, das wirkt aber nur auf die Fehlerseite selbst und steuert keine Bots. Eine echte robots.txt (Sitemap-Zeile, ggf. Regeln für KI-Crawler) anlegen.`);
if (broken.length) F('hoch', `${broken.length} defekte interne Ziele (4xx/5xx)`, `Diese URLs werden intern verlinkt, liefern aber Fehler – siehe Tabelle „Defekte Ziele“ mit den verlinkenden Seiten.`);
if (noDesc.length) F('mittel', `${nf(noDesc.length)} Seiten ohne Meta-Description (${pct(noDesc.length, html.length)})`, 'Suchmaschinen erzeugen dann eigene Snippets; für Kernseiten individuelle Beschreibungen hinterlegen.');
if (dupTitlePages) F('mittel', `${nf(dupTitlePages)} Seiten teilen sich ${nf(titleGroups.length)} Titel`, 'Doppelte <code>&lt;title&gt;</code> erschweren die Unterscheidung in Suchergebnissen und Browser-Tabs.');
if (imgNoAlt) F('mittel', `${nf(imgNoAlt)} Bilder ohne alt-Attribut auf ${nf(pagesNoAlt.length)} Seiten`, 'Für Screenreader (BITV 2.0 / WCAG 1.1.1) fehlt jede Textalternative. Dekorative Bilder mit <code>alt=""</code> kennzeichnen, inhaltliche beschreiben.');
if (noH1.length || multiH1.length) F('niedrig', `Überschriftenstruktur: ${nf(noH1.length)} Seiten ohne H1, ${nf(multiH1.length)} mit mehreren H1`, 'Eine H1 pro Seite verbessert Orientierung für Screenreader und Suchmaschinen.');
if (templ.length) F('niedrig', `Unaufgelöste Template-Links auf ${nf(templ.length)} Seiten`, 'Im ausgelieferten HTML stehen Links wie <code>href="{{ item.self.webUrl }}"</code> (clientseitiges Templating). Crawler ohne JavaScript sehen dort tote Links.');
if (htmlNotInSm.length) F('niedrig', `${nf(htmlNotInSm.length)} erreichbare Seiten fehlen in der Sitemap`, `Die Sitemap listet ${nf(st.sitemapUrls)} URLs; ${nf(htmlNotInSm.length)} per Link gefundene HTML-Seiten sind dort nicht enthalten.`);
const uncompressed = html.filter(n => !hdr(n, 'content-encoding'));
if (uncompressed.length > html.length * 0.5) {
  const sum = uncompressed.reduce((s, n) => s + (n.bytes || 0), 0);
  const measured = uncompressed.filter(n => n.gzipBytes);
  const ratio = measured.length ? measured.reduce((s, n) => s + n.gzipBytes, 0) / measured.reduce((s, n) => s + n.bytes, 0) : SAMPLE_RATIO;
  F('hoch', 'HTML wird unkomprimiert ausgeliefert',
    `Keine der ${nf(html.length)} Seiten kam mit <code>Content-Encoding</code>, obwohl der Crawler <code>gzip, br</code> anbot (auch CSS ist betroffen). Die Startseite wiegt ${kb(N[0].bytes)}; mit gzip wären es etwa ${kb(N[0].bytes * ratio)} (−${Math.round((1 - ratio) * 100)} %). Hochgerechnet auf alle analysierten Seiten: ${kb(sum)} statt ≈ ${kb(sum * ratio)}${measured.length ? '' : ' (Verhältnis aus einer Stichprobe der Startseite)'}. Kompression (mod_deflate/mod_brotli) für text/html, text/css und JavaScript aktivieren – das ist der größte einzelne Performance-Hebel.`);
}
if (crawl.robots.status === 200) F('info', 'robots.txt vorhanden', `${crawl.robots.groups?.length || 0} Regelgruppe(n), Sitemap-Verweis ${crawl.robots.sitemaps?.length ? 'gesetzt' : 'fehlt'}${crawl.robots.contentSignals?.length ? `; Content-Signals für KI: <code>${esc(crawl.robots.contentSignals.join('; '))}</code>` : ''}.`);
const noindexArchive = noindex.filter(n => /pressearchiv|archiv/i.test(n.url));
if (noindex.length) F('info', `noindex auf ${nf(noindex.length)} Seiten`,
  `${noindexArchive.length ? `${nf(noindexArchive.length)} davon liegen in Archivbereichen (vermutlich gewollt). Die übrigen ` : 'Alle '}${nf(noindex.length - noindexArchive.length)} prüfen, ob sie bewusst aus Suchmaschinen ausgeschlossen sind – siehe Tabelle im Abschnitt SEO.`);
if (imgTotal && !imgNoAlt) F('info', `Alle ${nf(imgTotal)} Bilder haben ein alt-Attribut`, `${nf(imgEmptyAlt)} davon sind mit <code>alt=""</code> als dekorativ markiert – stichprobenartig prüfen, ob darunter inhaltliche Bilder sind.`);
const permMissing = secCover.find(([h]) => h === 'permissions-policy')[1] === 0;
F('info', 'Sicherheits-Header gut aufgestellt', `HSTS, CSP, X-Frame-Options, X-Content-Type-Options und Referrer-Policy sind gesetzt${permMissing ? '; nur <code>Permissions-Policy</code> fehlt' : ''}.`);

const sevOrder = { kritisch: 0, hoch: 1, mittel: 2, niedrig: 3, info: 4 };
findings.sort((a, b) => sevOrder[a.sev] - sevOrder[b.sev]);

// ------------------------------------------------------------------ page
const kpi = (label, value, sub = '') => `<div class="kpi"><div class="kl">${label}</div><div class="kv">${value}</div>${sub ? `<div class="ks">${sub}</div>` : ''}</div>`;
const sevIcon = { kritisch: '⛔', hoch: '▲', mittel: '◆', niedrig: '●', info: 'ℹ' };

const page = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Crawl-Report ${esc(host)}</title>
<style>
:root {
  color-scheme: light;
  --bg: #f6f7f9; --surface: #ffffff; --surface-2: #eef1f5; --ink: #0d1117; --ink-2: #4a5160; --ink-3: #7b8394; --line: #dde2ea;
  --accent: #0a84a8; --accent-2: #c2187e;
  --series-1: #2a78d6; --series-2: #eb6834;
  --good: #1a8a4a; --warning: #c98500; --serious: #e34948; --critical: #b3123a;
  --hero-bg: #05070f; --hero-ink: #e8f6ff;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #07090f; --surface: #0e121b; --surface-2: #151b27; --ink: #e8edf5; --ink-2: #aab3c2; --ink-3: #7c8697; --line: #232b3a;
    --accent: #00d8ff; --accent-2: #ff3fc8;
    --series-1: #3987e5; --series-2: #d95926;
    --good: #2fb36a; --warning: #e0a000; --serious: #e66767; --critical: #ff4d6d;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #07090f; --surface: #0e121b; --surface-2: #151b27; --ink: #e8edf5; --ink-2: #aab3c2; --ink-3: #7c8697; --line: #232b3a;
  --accent: #00d8ff; --accent-2: #ff3fc8;
  --series-1: #3987e5; --series-2: #d95926;
  --good: #2fb36a; --warning: #e0a000; --serious: #e66767; --critical: #ff4d6d;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 "Segoe UI", system-ui, -apple-system, sans-serif; }
a { color: var(--accent); text-decoration: none; word-break: break-all; }
a:hover { text-decoration: underline; }
code { font: 13px "Cascadia Code", Consolas, monospace; background: var(--surface-2); padding: 1px 5px; border-radius: 4px; word-break: break-all; }
.hero { background: var(--hero-bg); color: var(--hero-ink); padding: 48px 16px 40px; position: relative; overflow: hidden; }
.hero::before { content: ""; position: absolute; inset: 0; background:
  linear-gradient(transparent 0 calc(100% - 1px), rgba(0,240,255,.08) 0) 0 0 / 100% 28px,
  linear-gradient(90deg, transparent 0 calc(100% - 1px), rgba(0,240,255,.08) 0) 0 0 / 28px 100%; mask-image: linear-gradient(transparent, #000 60%); }
.wrap { max-width: 1080px; margin: 0 auto; position: relative; }
.eyebrow { font: 600 12px/1 Consolas, monospace; letter-spacing: .2em; color: #00f0ff; text-transform: uppercase; }
.hero h1 { font-size: clamp(28px, 5vw, 46px); margin: 12px 0 6px; letter-spacing: -.01em; }
.hero h1 span { color: #ff2bd6; }
.hero p { color: #9fb3c8; margin: 0; max-width: 760px; }
.meta { display: flex; flex-wrap: wrap; gap: 8px 22px; margin-top: 18px; font: 13px Consolas, monospace; color: #7fa7bf; }
main { padding: 0 16px 60px; }
section { margin-top: 36px; }
h2 { font-size: 22px; margin: 0 0 12px; display: flex; align-items: center; gap: 10px; }
h2::before { content: ""; width: 4px; height: 22px; background: var(--accent); border-radius: 2px; }
h3 { font-size: 16px; margin: 22px 0 8px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 18px; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 460px), 1fr)); gap: 16px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: -26px; position: relative; }
.kpi { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
.kl { font-size: 13px; color: var(--ink-2); }
.kv { font-size: 26px; font-weight: 650; margin-top: 2px; font-variant-numeric: proportional-nums; }
.ks { font-size: 12px; color: var(--ink-3); margin-top: 2px; }
.finding { display: grid; grid-template-columns: 96px 1fr; gap: 14px; padding: 14px 0; border-top: 1px solid var(--line); }
.finding:first-child { border-top: 0; }
.sev { font: 600 12px/1.2 Consolas, monospace; text-transform: uppercase; letter-spacing: .06em; padding: 5px 8px; border-radius: 6px; align-self: start; text-align: center; border: 1px solid; }
.sev.kritisch { color: var(--critical); border-color: var(--critical); }
.sev.hoch { color: var(--serious); border-color: var(--serious); }
.sev.mittel { color: var(--warning); border-color: var(--warning); }
.sev.niedrig { color: var(--ink-2); border-color: var(--line); }
.sev.info { color: var(--good); border-color: var(--good); }
.finding b { display: block; margin-bottom: 2px; }
.finding p { margin: 0; color: var(--ink-2); }
.chart { width: 100%; height: auto; display: block; }
.chart .lab, .chart .val, .chart .tick { font: 12px "Segoe UI", system-ui, sans-serif; fill: var(--ink-2); }
.chart .val { fill: var(--ink); font-weight: 600; }
.chart .grid { stroke: var(--line); stroke-width: 1; }
.chart .axis { stroke: var(--ink-3); stroke-width: 1; }
.chart .mark:hover path, .chart .mark:hover rect:not(.hit) { filter: brightness(1.15); }
.legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px; color: var(--ink-2); margin: 4px 0 8px; }
.legend i { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.cap { font-size: 13px; color: var(--ink-3); margin: 6px 0 0; }
.tw { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
th { text-align: left; font-weight: 600; color: var(--ink-2); border-bottom: 1px solid var(--line); padding: 7px 8px; white-space: nowrap; }
td { border-bottom: 1px solid var(--line); padding: 7px 8px; vertical-align: top; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
details.tv { margin-top: 10px; }
details.tv summary { cursor: pointer; color: var(--accent); font-size: 13px; }
.two { columns: 2 320px; column-gap: 28px; }
.two li { break-inside: avoid; }
ul { padding-left: 20px; } li { margin: 4px 0; }
#tip { position: fixed; pointer-events: none; background: var(--ink); color: var(--bg); font-size: 12.5px; padding: 6px 9px; border-radius: 6px; opacity: 0; transition: opacity .1s; z-index: 9; max-width: 340px; }
footer { color: var(--ink-3); font-size: 12.5px; margin-top: 40px; border-top: 1px solid var(--line); padding-top: 14px; }
.theme { position: absolute; right: 0; top: 0; background: transparent; border: 1px solid #2a3a4a; color: #9fb3c8; border-radius: 8px; padding: 6px 10px; font-size: 12px; cursor: pointer; }
@media print {
  body { background: #fff; color: #000; }
  .theme, details.tv summary { display: none; }
  details.tv { display: block; } details.tv > * { display: block; }
  .card, .kpi { break-inside: avoid; }
  section { break-inside: auto; }
  .hero { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
</style>
</head>
<body>
<header class="hero"><div class="wrap">
  <button class="theme" id="theme" type="button">Hell/Dunkel</button>
  <div class="eyebrow">ArachNet Crawl-Report · /[•]\\</div>
  <h1>${esc(host)} <span>//</span> technischer Website-Audit</h1>
  <p>Automatischer Crawl mit ArachNet ${esc(crawl.generator.split(' ')[1] || '')} (Fork von cyohei9907/web-crawlers): Erreichbarkeit, Performance, Struktur, SEO-Grundlagen, Barrierefreiheit und Sicherheits-Header${blocked.length ? ' – plus was passiert, wenn ein Crawler auf die Firewall trifft' : ''}.</p>
  <div class="meta"><span>Start: ${esc(dateDe)}</span><span>Dauer: ${(st.duration / 60000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} min</span><span>User-Agent: ${esc(crawl.ua)}</span></div>
</div></header>

<main><div class="wrap">
<div class="kpis">
  ${kpi('Analysierte HTML-Seiten', nf(html.length), `von ${nf(real.length)} Anfragen`)}
  ${kpi('Interne Links', nf(st.edges), `${nf(Math.round(avg(html.map(n => n.linksInternal || 0))))} pro Seite`)}
  ${kpi('Median TTFB', nf(quant(ttfbHtml, .5)) + ' ms', `p90 ${nf(quant(ttfbHtml, .9))} ms`)}
  ${kpi('Ø Seitengröße', kb(avg(sizes)), `HTML, unkomprimiert`)}
  ${blocked.length ? kpi('WAF-Bounces', nf(blocked.length), `ab Anfrage ${nf(reqsBeforeBlock + 1)}`) : kpi('Abweisungen', '0', 'kein 429/503, keine Sperre')}
  ${kpi('Externe Domains', nf(st.externalDomains), 'verlinkt')}
</div>

<section>
  <h2>Kernbefunde</h2>
  <div class="card">${findings.map(f => `<div class="finding"><div class="sev ${f.sev}">${sevIcon[f.sev]} ${f.sev}</div><div><b>${f.title}</b><p>${f.text}</p></div></div>`).join('')}</div>
</section>

<section>
  <h2>Crawl-Verlauf${blocked.length ? ' und Firewall' : ''}</h2>
  <div class="card">
    ${blocked.length ? legend([['Erfolgreiche Antworten', 'var(--series-1)'], ['WAF-Bounce (Umleitung auf Fehlerseite)', 'var(--critical)']]) : ''}
    ${columns([{ name: 'OK', data: buckets.map(b => b[0]), color: 'var(--series-1)' }, { name: 'WAF', data: buckets.map(b => b[1]), color: 'var(--critical)' }],
      buckets.map((_, i) => `${(i * BUCKET / 60000).toLocaleString('de-DE')}′`), { stacked: true, xlab: 'Minute seit Crawl-Start (30-s-Intervalle)', tipCat: c => `ab ${c}`, every: 2 })}
    <p class="cap">Anfragen pro 30 Sekunden. Der Crawler lief mit ${crawl.options.concurrency} parallelen Verbindungen und mindestens ${crawl.options.delay} ms Abstand (≈ ${(1000 / crawl.options.delay).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Anfragen/s). ${firstBlock ? `Ab Minute ${(firstBlock.t / 60000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} antwortete der Server nur noch mit Umleitungen auf eine Fehlerseite; der Crawl wurde daraufhin beendet. Der Crawler erkennt solche Gegenwehr inzwischen selbst und stoppt nach 5 von 20 Abweisungen.` : 'Der Server hat keine einzige Anfrage abgewiesen.'}</p>
    ${details('Tabellenansicht', table(['Intervall', '<span class="n">OK</span>', '<span class="n">WAF</span>'], buckets.map((b, i) => [`${(i * 30)}–${(i + 1) * 30} s`, `<span class="n">${b[0]}</span>`, `<span class="n">${b[1]}</span>`])))}
  </div>
</section>

<section>
  <h2>Antworten und Abdeckung</h2>
  <div class="grid2">
    <div class="card"><h3 style="margin-top:0">HTTP-Status aller Anfragen</h3>${hbar(statusRows)}<p class="cap">Dateien (PDF u. a.) wurden nur per HEAD geprüft (${nf(files.length)} Stück).</p></div>
    <div class="card"><h3 style="margin-top:0">Analysierte Seiten nach Bereich</h3>${hbar(sections.slice(0, 9))}<p class="cap">Erstes Pfadsegment der URL.${blocked.length ? ' Einige Bereiche sind unterrepräsentiert, weil die Firewall vor Erreichen dieser Sitemap-Einträge blockte.' : ''}</p></div>
  </div>
  <div class="card" style="margin-top:16px">
    <ul class="two">
      <li>Sitemap: <b>${nf(st.sitemapUrls)}</b> URLs, davon ${nf(htmlInSm)} als HTML analysiert${smNotFetched ? `; ${nf(smNotFetched)} Sitemap-URLs wurden ${blocked.length ? 'wegen der Blockade ' : ''}nicht erreicht` : ''}.</li>
      <li><b>${nf(htmlNotInSm.length)}</b> analysierte Seiten stehen nicht in der Sitemap.</li>
      <li>Klicktiefe ab Startseite: ${depthDist.map(([d, c]) => `${d}: ${nf(c)}`).join(' · ')}${unreachable ? ` · nicht per Link erreichbar: ${nf(unreachable)}` : ''}.</li>
      <li>Sitemap-Seiten ohne eingehenden Link aus dem Crawl: <b>${nf(orphans.length)}</b>.</li>
      <li>Weiterleitungen${blocked.length ? ' (ohne WAF)' : ''}: ${countBy(redirects, n => n.status).map(([s, c]) => `${s} × ${c}`).join(', ') || 'keine'}.</li>
      ${firewallPages.length ? `<li>Firewall-eigene Fehlerseiten abgerufen: ${nf(firewallPages.length)} (im Report ausgeklammert).</li>` : ''}
    </ul>
  </div>
</section>

<section>
  <h2>Performance</h2>
  <div class="grid2">
    <div class="card"><h3 style="margin-top:0">Time to First Byte (HTML-Seiten)</h3>${columns([{ name: 'Seiten', data: tbData, color: 'var(--series-1)' }], tbLab, { xlab: 'Millisekunden', tipCat: c => c + ' ms' })}
      <p class="cap">Median ${nf(quant(ttfbHtml, .5))} ms, p90 ${nf(quant(ttfbHtml, .9))} ms, p99 ${nf(quant(ttfbHtml, .99))} ms, Maximum ${nf(Math.max(...ttfbHtml))} ms.</p></div>
    <div class="card"><h3 style="margin-top:0">HTML-Größe pro Seite</h3>${columns([{ name: 'Seiten', data: sbData, color: 'var(--series-1)' }], sbLab, { xlab: 'Kilobyte (unkomprimiert)', tipCat: c => c + ' KB' })}
      <p class="cap">Ø ${kb(avg(sizes))}, Maximum ${kb(Math.max(...sizes))}. Ø ${nf(Math.round(domAvg))} DOM-Elemente (max. ${nf(domMax)}), Ø ${scriptsAvg.toLocaleString('de-DE', { maximumFractionDigits: 1 })} &lt;script&gt;-Blöcke, Ø ${nf(Math.round(wordsAvg))} Wörter.</p></div>
  </div>
  <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Langsamste Seiten (TTFB)</h3>
    ${table(['Seite', '<span class="n">TTFB</span>', '<span class="n">Größe</span>'], slow.map(n => [link(n.url), `<span class="n">${nf(n.ttfb)} ms</span>`, `<span class="n">${kb(n.bytes)}</span>`]))}
    <p class="cap">Einzelne Ausreißer von mehreren Sekunden treten bei Übersichtsseiten mit vielen Teasern (Newsroom, Paginierung) auf; vermutlich serverseitiges Rendern ohne Cache. Kompression: ${enc.map(([k, c]) => `${esc(k)} ${pct(c, html.length)}`).join(', ')}. Cache-Control: ${cache.slice(0, 2).map(([k, c]) => `<code>${esc(k)}</code> (${pct(c, html.length)})`).join(', ')}.</p>
  </div>
</section>

<section>
  <h2>SEO-Grundlagen</h2>
  <div class="card">
    ${table(['Prüfpunkt', '<span class="n">Seiten</span>', '<span class="n">Anteil</span>'], [
      ['Titel fehlt', noTitle.length, pct(noTitle.length, html.length)],
      ['Titel doppelt vergeben', dupTitlePages, pct(dupTitlePages, html.length)],
      ['Titel länger als 65 Zeichen', longTitle.length, pct(longTitle.length, html.length)],
      ['Meta-Description fehlt', noDesc.length, pct(noDesc.length, html.length)],
      ['Meta-Description doppelt', dupDescPages, pct(dupDescPages, html.length)],
      ['Keine H1', noH1.length, pct(noH1.length, html.length)],
      ['Mehrere H1', multiH1.length, pct(multiH1.length, html.length)],
      ['Kein Canonical', noCanon.length, pct(noCanon.length, html.length)],
      ['Canonical zeigt auf andere URL', canonElse.length, pct(canonElse.length, html.length)],
      ['noindex gesetzt', noindex.length, pct(noindex.length, html.length)],
      ['Kein Viewport-Tag', noViewport.length, pct(noViewport.length, html.length)],
    ].map(([a, b, c]) => [a, `<span class="n">${nf(b)}</span>`, `<span class="n">${c}</span>`]))}
    <p class="cap">Sprache: ${langs.map(([k, c]) => `<code>${esc(k)}</code> × ${nf(c)}`).join(', ')}. Strukturierte Daten (JSON-LD): ${ld.slice(0, 8).map(([k, c]) => `${esc(k)} × ${nf(c)}`).join(', ') || 'keine'}. Open-Graph-Tags auf ${pct(ogPages, html.length)} der Seiten.</p>
    ${noindex.length - noindexArchive.length > 0 ? `<h3>noindex außerhalb des Pressearchivs</h3>${table(['Seite', 'Robots-Angabe'], noindex.filter(n => !/pressearchiv/.test(n.url)).slice(0, 15).map(n => [link(n.url), `<code>${esc((n.robots.raw || '').split(' | ')[0])}</code>`]))}` : ''}
    <h3>Häufigste doppelte Titel</h3>
    ${table(['Titel', '<span class="n">Seiten</span>'], titleGroups.slice(0, 8).map(([t, c]) => [esc(t), `<span class="n">${c}</span>`]))}
  </div>
</section>

<section>
  <h2>Barrierefreiheit (automatisch prüfbar)</h2>
  <div class="card">
    <ul>
      <li><b>${nf(imgTotal)}</b> Bilder im HTML, davon <b>${nf(imgNoAlt)}</b> ohne alt-Attribut (${pct(imgNoAlt, imgTotal)}) auf ${nf(pagesNoAlt.length)} Seiten und ${nf(imgEmptyAlt)} mit leerem alt (als dekorativ markiert).</li>
      <li>${nf(noH1.length + multiH1.length)} Seiten mit abweichender H1-Struktur.</li>
      <li>Sprache im &lt;html&gt;-Element deklariert: ${nf(html.filter(n => n.lang).length)} von ${nf(html.length)} Seiten.</li>
    </ul>
    ${pagesNoAlt.length ? `<h3>Seiten mit den meisten Bildern ohne alt</h3>${table(['Seite', '<span class="n">ohne alt</span>'], pagesNoAlt.sort((a, b) => b.imagesNoAlt - a.imagesNoAlt).slice(0, 8).map(n => [link(n.url), `<span class="n">${n.imagesNoAlt}</span>`]))}` : ''}
    <p class="cap">Ein Crawl ersetzt keinen BITV-Test: Kontraste, Tastaturbedienung und Formularbeschriftungen brauchen eine manuelle Prüfung.</p>
  </div>
</section>

<section>
  <h2>Sicherheit und Server</h2>
  <div class="card">
    ${table(['Header', '<span class="n">Abdeckung</span>', 'Wert (Startseite)'], secCover.map(([h, c]) => [`<code>${h}</code>`, `<span class="n">${pct(c, html.length)}</span>`, esc((N[0].headers?.[h] || '– fehlt –').slice(0, 120)) + ((N[0].headers?.[h] || '').length > 120 ? '…' : '')]))}
    <p class="cap">Server-Kennung: ${servers.slice(0, 2).map(([k, c]) => `<code>${esc(k)}</code> (${pct(c, html.length)})`).join(', ')}.</p>
  </div>
</section>

<section>
  <h2>Struktur und Verlinkung</h2>
  <div class="grid2">
    <div class="card"><h3 style="margin-top:0">Wichtigste Seiten (PageRank im internen Linkgraph)</h3>
      ${table(['Seite', '<span class="n">Links rein</span>'], prTop.map(n => [link(n.url), `<span class="n">${nf(n.inlinks)}</span>`]))}</div>
    <div class="card"><h3 style="margin-top:0">Meistverlinkte externe Domains</h3>
      ${hbar(ext.slice(0, 12).map(([d, c]) => [d, c]), { w: 560 })}</div>
  </div>
  ${broken.length ? `<div class="card" style="margin-top:16px"><h3 style="margin-top:0">Defekte Ziele</h3>
    ${table(['Ziel', '<span class="n">Status</span>', 'verlinkt von (Auszug)'], broken.map(n => [link(n.url), `<span class="n">${n.status}</span>`, linkersOf(n.id).slice(0, 3).map(l => link(l.url)).join('<br>') || '–']))}</div>` : ''}
  ${redirects.length ? `<div class="card" style="margin-top:16px"><h3 style="margin-top:0">Weiterleitungen</h3>
    ${table(['Von', '<span class="n">Status</span>', 'Nach'], redirects.slice(0, 20).map(n => [n.url.includes('://' + host + '/') ? link(n.url) : esc(n.url), `<span class="n">${n.status}</span>`, n.redirect ? (n.redirect.includes(host) ? link(n.redirect) : esc(n.redirect)) : '–']))}</div>` : ''}
</section>

<section>
  <h2>Empfehlungen</h2>
  <div class="card"><ol>
    ${[
      uncompressed.length > html.length * 0.5 && '<li><b>Kompression aktivieren</b> (gzip/Brotli für HTML, CSS, JS): spart rund 85 % der übertragenen HTML-Daten.</li>',
      crawl.robots.status !== 200 && `<li><b>robots.txt anlegen</b> mit <code>Sitemap: https://${esc(host)}/sitemap.xml</code> und – falls gewünscht – expliziten Regeln für KI-Crawler.</li>`,
      blocked.length && '<li><b>WAF-Regeln dokumentieren</b>: Schwelle und Sperrdauer kennen, Allowlist für eigene Audit-/Monitoring-Tools pflegen; ein klares <code>429 Too Many Requests</code> mit <code>Retry-After</code> hilft höflichen Crawlern mehr als eine Umleitung auf eine Fehlerseite.</li>',
      noDesc.length > html.length * 0.1 && '<li><b>Meta-Descriptions</b> für die wichtigsten und meistverlinkten Seiten pflegen.</li>',
      dupTitlePages > html.length * 0.05 && '<li><b>Doppelte Titel auflösen</b> (Versionen, Paginierung, Archiv).</li>',
      imgNoAlt && '<li><b>Alt-Texte</b> für inhaltliche Bilder ergänzen, dekorative Bilder mit <code>alt=""</code> markieren.</li>',
      htmlNotInSm.length > 10 && `<li><b>Sitemap vervollständigen</b>: ${nf(htmlNotInSm.length)} erreichbare Seiten fehlen darin.</li>`,
      templ.length && '<li><b>Template-Links</b> serverseitig rendern oder nicht als <code>href</code> ausliefern.</li>',
      broken.length && `<li><b>${nf(broken.length)} defekte Ziele</b> reparieren oder umleiten (Tabelle oben).</li>`,
      quant(ttfbHtml, .99) > 1500 && `<li><b>Langsame Ausreißer</b> cachen; der Median liegt bei ~${nf(quant(ttfbHtml, .5))} ms TTFB.</li>`,
    ].filter(Boolean).join('\n    ') || '<li>Keine dringenden Maßnahmen – die Seite ist technisch in sehr gutem Zustand.</li>'}
  </ol></div>
</section>

<section>
  <h2>Methodik</h2>
  <div class="card"><ul>
    <li>Crawler: ArachNet (Node.js, ohne Abhängigkeiten) im Fork <a href="https://github.com/DasButterschnitzel/web-crawlers">DasButterschnitzel/web-crawlers</a>; robots.txt (RFC 9309), Sitemap-Seeding, Meta-Robots/X-Robots-Tag, adaptive Drosselung, Redirect-Ketten.</li>
    <li>Einstellungen: ${crawl.options.concurrency} parallele Verbindungen, mindestens ${crawl.options.delay} ms Abstand zwischen Anfragen, max. ${nf(crawl.options.maxPages)} Abrufe, Dateien nur per HEAD.</li>
    <li>Analysiert wird das ausgelieferte HTML ohne JavaScript-Ausführung. Inhalte werden nicht gespeichert, nur Metriken (Titel, Längen, Zählwerte, Header).</li>
    <li>${blocked.length ? `Einschränkung: Wegen der Firewall-Sperre ist die Abdeckung unvollständig (${nf(html.length)} von mindestens ${nf(N.length)} bekannten URLs analysiert).` : `Abdeckung: ${nf(html.length)} HTML-Seiten von ${nf(N.length)} bekannten URLs analysiert, ohne Abweisung durch den Server.`}</li>
  </ul></div>
</section>

<footer>Erstellt ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })} mit ArachNet · Rohdaten: <code>crawl.json</code>, <code>events.ndjson</code></footer>
</div></main>
<div id="tip" role="tooltip"></div>
<script>
(() => {
  const tip = document.getElementById('tip');
  document.addEventListener('pointermove', e => {
    const m = e.target.closest && e.target.closest('.mark');
    if (!m) { tip.style.opacity = 0; return; }
    tip.textContent = m.dataset.tip; tip.style.opacity = 1;
    const x = Math.min(innerWidth - tip.offsetWidth - 8, e.clientX + 14), y = e.clientY + 16;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  });
  const btn = document.getElementById('theme');
  let saved = null; try { saved = localStorage.getItem('arachnet-theme'); } catch {}
  if (saved) document.documentElement.dataset.theme = saved;
  btn.addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('arachnet-theme', document.documentElement.dataset.theme); } catch {}
  });
})();
</script>
</body>
</html>`;

const out = path.join(dir, 'report.html');
writeFileSync(out, page);
console.log(`  report -> ${out}`);

if (wantPdf) {
  const chrome = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const pdf = path.join(dir, 'report.pdf');
  const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${pdf}`, 'file:///' + out.replace(/\\/g, '/')], { stdio: 'inherit' });
  console.log(r.status === 0 ? `  pdf    -> ${pdf}` : '  pdf failed');
}
