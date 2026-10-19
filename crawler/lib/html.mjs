// Fast, dependency-free HTML extraction: one tokenizer pass over the markup,
// collecting what a site audit and the visualiser need. It does not build a
// DOM; it tracks just enough state (open <a>, <title>, headings, depth).

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '', zwnj: '', zwj: '',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß',
  eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', ccedil: 'ç', ntilde: 'ñ', oslash: 'ø', aring: 'å',
  ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', sbquo: '‚', euro: '€', copy: '©', reg: '®', trade: '™', middot: '·',
  deg: '°', sect: '§', para: '¶', times: '×', bull: '•', frac12: '½', sup2: '²', sup3: '³', micro: 'µ',
};
export const decodeEntities = s => s.indexOf('&') < 0 ? s : s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, e) => {
  if (e[0] === '#') {
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try { return String.fromCodePoint(cp); } catch { return m; }
  }
  return ENT[e] ?? ENT[e.toLowerCase()] ?? m;
});

const ATTR = /([^\s=\/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
function attrs(s) {
  const o = {};
  if (!s) return o;
  ATTR.lastIndex = 0;
  let m;
  while ((m = ATTR.exec(s))) {
    const k = m[1].toLowerCase();
    if (!(k in o)) o[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return o;
}

// tag -> category, used for the "DOM barcode" of every page in the visualiser
const CAT = {};
const cat = (n, tags) => tags.split(' ').forEach(t => (CAT[t] = n));
cat(0, 'html body div section article main header footer nav aside figure figcaption details summary dialog');
cat(1, 'h1 h2 h3 h4 h5 h6 hgroup');
cat(2, 'p span strong em b i u small label blockquote q cite code pre mark abbr time address br hr sup sub');
cat(3, 'a');
cat(4, 'img picture svg video audio source iframe canvas embed object track');
cat(5, 'script style link meta noscript template base title head');
cat(6, 'form input button select textarea option fieldset legend output');
cat(7, 'ul ol li dl dt dd menu');
cat(8, 'table tr td th thead tbody tfoot caption colgroup col');
export const CATEGORIES = ['structure', 'heading', 'text', 'link', 'media', 'meta/script', 'form', 'list', 'table', 'other'];

const WORD = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
const squash = s => s.replace(/\s+/g, ' ').trim();

function jsonLdTypes(block, out) {
  let data;
  try { data = JSON.parse(block); } catch { return; }
  const visit = n => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(visit);
    const t = n['@type'];
    if (t) (Array.isArray(t) ? t : [t]).forEach(x => out.add(String(x)));
    if (n['@graph']) visit(n['@graph']);
  };
  visit(data);
}

export function extract(html) {
  const r = {
    title: null, titleCount: 0, metaDescription: null, metaRobots: null, canonical: null, lang: null, charset: null,
    viewport: false, base: null, og: {}, hreflang: [], h1: [], headings: [], hCount: [0, 0, 0, 0, 0, 0],
    links: [], images: [], scripts: 0, scriptsExternal: 0, stylesheets: 0, inlineStyleBlocks: 0, iframes: 0,
    forms: 0, inputs: 0, jsonLd: [], wordCount: 0, textChars: 0, domNodes: 0, domDepthMax: 0,
    tagSeq: [], catCount: new Array(CATEGORIES.length).fill(0), templateLinks: 0,
  };

  const ld = new Set();
  html = html.replace(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi, (m, body) => {
    jsonLdTypes(body, ld);
    return '<script></script>';
  });
  html = html.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|textarea)\b([^>]*)>[\s\S]*?<\/\1\s*>/gi, '<$1$2></$1>');

  const TOK = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|</g;
  let depth = 0, inBody = false, inTitle = false, titleBuf = '', heading = null, anchor = null;
  const body = [];
  let m;
  while ((m = TOK.exec(html))) {
    if (m[4] !== undefined || m[2] === undefined) {               // text
      const raw = m[4] ?? '<';
      if (!raw.trim()) continue;
      const t = decodeEntities(raw);
      if (inTitle) titleBuf += t;
      if (heading) heading.text += t;
      if (anchor) anchor.text += t;
      if (inBody) body.push(t);
      continue;
    }
    const close = m[1] === '/', name = m[2].toLowerCase(), rest = m[3];
    if (close) {
      if (!VOID.has(name)) depth = Math.max(0, depth - 1);
      if (name === 'title' && inTitle) { inTitle = false; if (r.title == null) r.title = squash(titleBuf); }
      else if (heading && name === heading.tag) {
        const text = squash(heading.text);
        if (heading.level === 1) r.h1.push(text);
        if (r.headings.length < 40) r.headings.push([heading.level, text.slice(0, 160)]);
        heading = null;
      } else if (name === 'a' && anchor) { anchor.text = squash(anchor.text).slice(0, 120); anchor = null; }
      continue;
    }
    const selfClose = /\/\s*$/.test(rest);
    r.domNodes++;
    const c = CAT[name] ?? 9;
    r.catCount[c]++;
    if (r.tagSeq.length < 720) r.tagSeq.push(c);
    if (!VOID.has(name) && !selfClose) { depth++; if (depth > r.domDepthMax) r.domDepthMax = depth; }

    switch (name) {
      case 'html': { const a = attrs(rest); r.lang = a.lang || a['xml:lang'] || null; break; }
      case 'body': inBody = true; break;
      case 'title': if (!inBody) { r.titleCount++; inTitle = true; titleBuf = ''; } break;
      case 'base': { const a = attrs(rest); if (a.href && !r.base) r.base = a.href; break; }
      case 'meta': {
        const a = attrs(rest);
        const key = (a.name || a.property || a['http-equiv'] || '').toLowerCase();
        if (a.charset) r.charset = a.charset.toLowerCase();
        if (key === 'description' && r.metaDescription == null) r.metaDescription = squash(a.content || '');
        else if (key === 'robots') r.metaRobots = (r.metaRobots ? r.metaRobots + ', ' : '') + (a.content || '');
        else if (key === 'viewport') r.viewport = true;
        else if (key.startsWith('og:')) r.og[key.slice(3)] = a.content || '';
        else if (key === 'content-type') { const cs = (a.content || '').match(/charset=([\w-]+)/i); if (cs) r.charset = cs[1].toLowerCase(); }
        break;
      }
      case 'link': {
        const a = attrs(rest), rel = (a.rel || '').toLowerCase();
        if (rel.split(/\s+/).includes('canonical')) r.canonical = a.href || null;
        else if (rel.includes('stylesheet')) r.stylesheets++;
        else if (rel.includes('alternate') && a.hreflang) r.hreflang.push([a.hreflang, a.href]);
        break;
      }
      case 'script': r.scripts++; if (/\ssrc\s*=/i.test(rest)) r.scriptsExternal++; break;
      case 'style': r.inlineStyleBlocks++; break;
      case 'iframe': r.iframes++; break;
      case 'form': r.forms++; break;
      case 'input': case 'select': case 'textarea': r.inputs++; break;
      case 'img': {
        const a = attrs(rest);
        r.images.push({ src: a.src || a['data-src'] || (a.srcset || '').split(/[\s,]/)[0] || null, alt: 'alt' in a ? a.alt : null, lazy: a.loading === 'lazy' });
        break;
      }
      case 'a': {
        const a = attrs(rest);
        if (a.href == null) break;
        if (/\{\{|%7B%7B/.test(a.href)) { r.templateLinks++; break; }
        anchor = { href: a.href, text: '', rel: (a.rel || '').toLowerCase(), target: a.target || null };
        r.links.push(anchor);
        if (selfClose) anchor = null;
        break;
      }
      default:
        if (/^h[1-6]$/.test(name)) { const level = +name[1]; r.hCount[level - 1]++; heading = { tag: name, level, text: '' }; }
    }
  }
  if (inTitle && r.title == null) r.title = squash(titleBuf);
  for (const l of r.links) if (typeof l.text === 'string') l.text = squash(l.text).slice(0, 120);

  const text = squash(body.join(' '));
  r.textChars = text.length;
  r.wordCount = (text.match(WORD) || []).length;
  r.jsonLd = [...ld];
  return r;
}

/** Parse the robots directives of a meta tag or X-Robots-Tag header into flags. */
export function robotsFlags(...values) {
  const s = values.filter(Boolean).join(',').toLowerCase();
  // "GPTBot: noindex" style entries are bot-specific and only apply to that bot; keep only the generic directives
  const generic = s.split(',').map(x => x.trim()).filter(x => x && !x.includes(':'));
  const has = d => generic.includes(d) || (d !== 'none' && generic.includes('none') && (d === 'noindex' || d === 'nofollow'));
  return { raw: values.filter(Boolean).join(' | ') || null, noindex: has('noindex'), nofollow: has('nofollow'), noarchive: has('noarchive'), noai: has('noai') || has('noimageai') };
}
