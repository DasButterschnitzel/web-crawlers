// robots.txt (RFC 9309): groups per user-agent, longest-match Allow/Disallow
// with * and $ wildcards, Crawl-delay and Sitemap lines.

export function parseRobots(text = '') {
  const groups = [];
  const sitemaps = [];
  let cur = null, lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], delay: null }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === 'sitemap') { if (val) sitemaps.push(val); continue; }
    if (!cur) continue;
    if (key === 'allow' || key === 'disallow') {
      if (key === 'disallow' && !val) continue;      // "Disallow:" (empty) allows everything
      cur.rules.push({ allow: key === 'allow', path: val, re: patternToRe(val) });
    } else if (key === 'crawl-delay') {
      const d = parseFloat(val);
      if (Number.isFinite(d)) cur.delay = d;
    }
  }
  return { groups, sitemaps };
}

function patternToRe(p) {
  const anchored = p.endsWith('$');
  const body = (anchored ? p.slice(0, -1) : p).split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

/** Returns a policy { allowed(url), delay, matchedAgent } for our user agent. */
export function robotsPolicy(parsed, userAgent) {
  const token = userAgent.split(/[\/\s]/)[0].toLowerCase();
  const groups = parsed?.groups || [];
  let group = groups.find(g => g.agents.some(a => a !== '*' && token.includes(a)))
           || groups.find(g => g.agents.includes('*'));
  const rules = group?.rules || [];
  return {
    matchedAgent: group ? group.agents.join(',') : null,
    delay: group?.delay ?? null,
    allowed(url) {
      if (!rules.length) return true;
      let path;
      try { const u = new URL(url); path = u.pathname + u.search; } catch { return false; }
      let best = null;
      for (const r of rules) {
        if (!r.re.test(path)) continue;
        if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
      }
      return !best || best.allow;
    },
  };
}
