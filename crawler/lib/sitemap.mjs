// sitemap.xml / sitemap index / .xml.gz. Regex extraction is enough for the
// sitemaps.org schema and avoids an XML dependency.
import { gunzipSync } from 'node:zlib';

const decode = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();

export function parseSitemap(xml) {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const tag = isIndex ? 'sitemap' : 'url';
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const get = k => { const r = block.match(new RegExp(`<${k}[^>]*>([\\s\\S]*?)</${k}>`, 'i')); return r ? decode(r[1]) : null; };
    const loc = get('loc');
    if (loc) out.push({ loc, lastmod: get('lastmod'), priority: get('priority'), changefreq: get('changefreq') });
  }
  return { isIndex, entries: out };
}

/** Fetch a sitemap tree (indexes are followed up to `maxDepth`). `get(url)` must return { status, buf }. */
export async function collectSitemaps(roots, get, { maxDepth = 3, maxFiles = 200, log = () => {} } = {}) {
  const seen = new Set(), urls = new Map(), files = [];
  const walk = async (url, depth) => {
    if (seen.has(url) || seen.size >= maxFiles || depth > maxDepth) return;
    seen.add(url);
    let res;
    try { res = await get(url); } catch (e) { files.push({ url, error: e.message }); return; }
    if (res.status !== 200) { files.push({ url, status: res.status }); return; }
    let buf = res.buf;
    if (buf[0] === 0x1f && buf[1] === 0x8b) { try { buf = gunzipSync(buf); } catch { /* not really gzip */ } }
    const xml = buf.toString('utf8');
    if (!/<(urlset|sitemapindex)[\s>]/i.test(xml)) { files.push({ url, status: res.status, note: 'not a sitemap' }); return; }
    const { isIndex, entries } = parseSitemap(xml);
    files.push({ url, status: 200, index: isIndex, entries: entries.length });
    log(`sitemap ${url} -> ${entries.length} ${isIndex ? 'sitemaps' : 'urls'}`);
    if (isIndex) for (const e of entries) await walk(e.loc, depth + 1);
    else for (const e of entries) if (!urls.has(e.loc)) urls.set(e.loc, e);
  };
  for (const r of roots) await walk(r, 0);
  return { files, urls };
}
