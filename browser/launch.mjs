// ArachNet control panel: a local page to fire the live spider at a website.
//
//   node launch.mjs            -> http://127.0.0.1:7777  (opens your browser)
//
// The panel checks robots.txt first, can map the site with the polite crawler
// (and build the audit report) before going live, then starts live.mjs in a
// visible Chrome window. Log and status stream back into the panel; STOP ends
// the crawl / walk cleanly. One run at a time, bound to localhost only.
import { createServer } from 'node:http';
import { spawn, exec } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRobots, robotsPolicy } from '../crawler/lib/robots.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = +(process.env.ARACHNET_PORT || 7777);
const UA = 'ArachNet/1.0 (+https://github.com/DasButterschnitzel/web-crawlers)';

const clients = new Set();
const backlog = [];
const send = ev => { backlog.push(ev); if (backlog.length > 400) backlog.shift(); const s = `data: ${JSON.stringify(ev)}\n\n`; for (const c of clients) c.write(s); };
const say = (text, level = 'info') => send({ type: 'log', text, level, t: Date.now() });

let job = null;   // { host, phase, child, crawlDir, report, stopping }

function runChild(cmd, args, onLine) {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buf = '';
  const feed = d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (line.trim()) onLine(line); } };
  child.stdout.on('data', feed); child.stderr.on('data', feed);
  return child;
}
const done = child => new Promise(res => child.on('exit', code => res(code)));

async function checkSite(raw) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); } catch { return { ok: false, error: 'Das ist keine gültige URL.' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'Nur http(s)-Adressen.' };
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)) return { ok: false, error: 'Lokale Adressen sind nicht vorgesehen.' };
  const origin = u.origin + '/';
  let status = null, txt = '', err = null;
  try {
    const r = await fetch(origin + 'robots.txt', { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
    status = r.status;
    if (r.ok && !/html/i.test(r.headers.get('content-type') || '')) txt = await r.text();
  } catch (e) { err = e.message; }
  const parsed = parseRobots(txt);
  const pol = robotsPolicy(parsed, UA);
  return {
    ok: true, url: u.href, host: u.host, robots: { status, error: err, groups: parsed.groups.length, sitemaps: parsed.sitemaps, contentSignals: parsed.contentSignals, crawlDelay: pol.delay },
    allowed: pol.allowed(u.href), allowedRoot: pol.allowed(origin),
  };
}

async function fire(o) {
  if (job) return { ok: false, error: 'Es läuft schon ein Einsatz. Erst STOP.' };
  const chk = await checkSite(o.url);
  if (!chk.ok) return chk;
  if (!chk.allowed) return { ok: false, error: `robots.txt von ${chk.host} verbietet Crawlern diese Adresse.` };
  const pages = Math.max(1, Math.min(60, +o.pages || 15)), dwell = Math.max(15, Math.min(120, +o.dwell || 25));
  job = { host: chk.host, phase: 'starting', stopping: false };
  send({ type: 'state', state: 'starting', host: chk.host });
  say(`TARGET ${chk.url}  ·  robots.txt ${chk.robots.status ?? '—'}${chk.robots.contentSignals.length ? '  ·  Content-Signal: ' + chk.robots.contentSignals.join('; ') : ''}`);
  (async () => {
    let crawlJson = null;
    try {
      if (o.map) {
        // 1) map the site politely (the crawler stops by itself on pushback; STOP file ends it early)
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        job.crawlDir = path.join(ROOT, 'runs', `${chk.host}-${stamp}`);
        job.phase = 'mapping'; send({ type: 'state', state: 'mapping', host: chk.host });
        say(`MAPPING  ·  up to ${o.mapPages || 300} pages, 2 connections, 600 ms gate`);
        const c = runChild(process.execPath, ['crawler/crawl.mjs', chk.url, '--max-pages', String(Math.min(2000, +o.mapPages || 300)), '--concurrency', '2', '--delay', '600', '--out', job.crawlDir], line => {
          const m = line.match(/^\s*\[\s*(\d+)\|q\s*(\d+)\]\s+(\S+)\s+(\d+|-)ms\s+(\d+)KB\s+(.*)$/);
          if (m) send({ type: 'map', n: +m[1], queue: +m[2], status: m[3], ms: m[4], path: m[6] });
          else say(line.trim(), /!!|error/i.test(line) ? 'warn' : 'info');
        });
        job.child = c;
        await done(c);
        crawlJson = path.join(job.crawlDir, 'crawl.json');
        if (existsSync(crawlJson)) {
          say('REPORT  ·  building audit report');
          await done(runChild(process.execPath, ['crawler/report.mjs', job.crawlDir], l => say(l.trim())));
          if (existsSync(path.join(job.crawlDir, 'report.html'))) { job.report = path.join(job.crawlDir, 'report.html'); send({ type: 'report', href: '/report/' + encodeURIComponent(path.basename(job.crawlDir)) }); }
        } else crawlJson = null;
      }
      if (job.stopping) throw new Error('stopped');
      // 2) go live
      job.phase = 'live'; send({ type: 'state', state: 'live', host: chk.host });
      const args = ['browser/live.mjs', chk.url, '--pages', String(pages), '--dwell', String(dwell)];
      if (o.dark) args.push('--dark');
      if (!o.audio) args.push('--no-audio'); else if (o.track && existsSync(o.track)) args.push('--track', o.track);
      if (crawlJson) args.push('--crawl', crawlJson);
      if (o.allowHosts) args.push('--allow-hosts', String(o.allowHosts).replace(/\s+/g, ''));
      say(`LIVE  ·  ${pages} pages  ·  ${dwell} s per page${o.dark ? '  ·  dark mode' : ''}${o.audio ? '' : '  ·  no audio'}`);
      const c = runChild(process.execPath, args, line => {
        if (line.startsWith('@status ')) { try { send({ type: 'status', ...JSON.parse(line.slice(8)) }); } catch {} return; }
        say(line.trim(), /!!|^\s*!/.test(line) ? 'warn' : 'info');
      });
      job.child = c;
      await done(c);
    } catch (e) { if (e.message !== 'stopped') say('ERROR ' + e.message, 'warn'); }
    say('MISSION ENDED'); send({ type: 'state', state: 'idle' });
    job = null;
  })();
  return { ok: true };
}

function stopJob() {
  if (!job) return { ok: false, error: 'Nichts aktiv.' };
  job.stopping = true;
  say('STOP requested');
  if (job.phase === 'mapping' && job.crawlDir) { mkdirSync(job.crawlDir, { recursive: true }); writeFileSync(path.join(job.crawlDir, 'STOP'), ''); }
  if (job.phase === 'live' && job.child) { try { job.child.stdin.write('stop\n'); } catch {} setTimeout(() => { try { job?.child?.kill(); } catch {} }, 60000); }
  return { ok: true };
}

const body = req => new Promise(res => { let s = ''; req.on('data', d => (s += d)); req.on('end', () => { try { res(JSON.parse(s || '{}')); } catch { res({}); } }); });
const json = (res, o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  // the panel only talks to pages it served itself
  if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://127.0.0.1:${PORT}` && req.headers.origin !== `http://localhost:${PORT}`) return json(res, { ok: false, error: 'origin' }, 403);
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(readFileSync(path.join(HERE, 'panel', 'index.html')));
  }
  if (u.pathname.startsWith('/fonts/')) {        // panel fonts, from the visualiser's local copies
    const base = path.join(ROOT, 'viz3d', 'node_modules', '@fontsource');
    const f = path.resolve(base, decodeURIComponent(u.pathname.slice(7)));
    if (!f.startsWith(base) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=86400' });
    return createReadStream(f).pipe(res);
  }
  if (u.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    for (const ev of backlog) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'state', state: job ? job.phase : 'idle', host: job?.host })}\n\n`);
    clients.add(res); req.on('close', () => clients.delete(res));
    return;
  }
  if (u.pathname === '/api/check') return json(res, await checkSite(u.searchParams.get('url') || ''));
  if (u.pathname === '/api/fire' && req.method === 'POST') return json(res, await fire(await body(req)));
  if (u.pathname === '/api/stop' && req.method === 'POST') return json(res, stopJob());
  if (u.pathname.startsWith('/report/')) {
    const dir = path.join(ROOT, 'runs', decodeURIComponent(u.pathname.slice(8)).replace(/[\\/]/g, ''));
    const f = path.join(dir, 'report.html');
    if (!existsSync(f)) { res.writeHead(404); return res.end('no report'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return createReadStream(f).pipe(res);
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`ArachNet control panel -> ${url}  (ctrl-c to quit)`);
  if (!process.argv.includes('--no-open')) exec(process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`);
});
process.on('SIGINT', () => { if (job) stopJob(); setTimeout(() => process.exit(0), 1500); });
