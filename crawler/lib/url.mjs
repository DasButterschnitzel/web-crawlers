// URL normalisation and scoping. A crawler is only as good as its dedupe:
// two spellings of the same page must collapse to one node.

const SKIP_SCHEMES = /^(javascript|mailto|tel|data|blob|about|file|ftp|whatsapp|sms|callto|skype):/i;
const TEMPLATE = /\{\{|\}\}|%7B%7B|%7D%7D|\$\{/i;            // {{ item.url }} etc. from client-side templates
const TRACKING = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_[a-z]+|_hsenc|_hsmi|yclid|igshid)$/i;

export const BINARY_EXT = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|zip|rar|7z|gz|tgz|tar|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp3|mp4|m4a|wav|ogg|webm|mov|avi|mkv|woff2?|ttf|otf|eot|exe|msi|dmg|apk|ics|vcf|xml|rss|json|csv|txt)$/i;

/** Resolve `href` against `base` and canonicalise it. Returns null for anything not crawlable. */
export function normalize(href, base) {
  if (href == null) return null;
  href = String(href).trim();
  if (!href || href[0] === '#' || SKIP_SCHEMES.test(href) || TEMPLATE.test(href)) return null;
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.username = ''; u.password = '';
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
  // drop tracking parameters, keep the rest in their original order (order can matter to the server)
  if (u.search) {
    const kept = [...u.searchParams].filter(([k]) => !TRACKING.test(k));
    u.search = kept.length ? '?' + kept.map(([k, v]) => v === '' ? encodeURIComponent(k) : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
  }
  // collapse duplicate slashes in the path (not in the scheme)
  u.pathname = u.pathname.replace(/\/{2,}/g, '/');
  return u.href;
}

const bare = h => h.replace(/^www\./, '');

/** Scope test: same host (www-insensitive), optionally any subdomain. */
export function makeScope(seed, { subdomains = false } = {}) {
  const root = bare(new URL(seed).hostname);
  return url => {
    let h;
    try { h = bare(new URL(url).hostname); } catch { return false; }
    return h === root || (subdomains && h.endsWith('.' + root));
  };
}

/** First path segment, used as "section" / district of the site. */
export function sectionOf(url) {
  try {
    const p = new URL(url).pathname.split('/').filter(Boolean);
    if (!p.length) return '/';
    const s = decodeURIComponent(p[0]);
    return BINARY_EXT.test(s) ? '[files]' : s.toLowerCase();
  } catch { return '?'; }
}

export const isBinaryUrl = url => {
  try { return BINARY_EXT.test(new URL(url).pathname); } catch { return false; }
};
