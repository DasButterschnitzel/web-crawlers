// Tiny static server + Server-Sent-Events stream, so the 3D visualiser can
// watch a crawl as it happens (or a recorded one being replayed).
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.bin': 'application/octet-stream',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.ndjson': 'application/x-ndjson',
};

/**
 * mounts: { '/': dir, '/run/': dir2, ... } (longest prefix wins)
 * feed:   object with .backlog (array of events) and .on('event', fn)
 */
export function serve({ port = 8080, host = '127.0.0.1', mounts, feed, snapshot, onClient, log = console.log }) {
  const prefixes = Object.keys(mounts).sort((a, b) => b.length - a.length);
  const clients = new Set();
  if (feed) feed.on('event', ev => {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of clients) res.write(line);
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
      res.write(': arachnet live feed\n\n');
      for (const ev of feed?.backlog || []) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      clients.add(res);
      if (onClient) onClient(clients.size);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/crawl.json' && snapshot) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
      res.end(JSON.stringify(snapshot()));
      return;
    }
    const pre = prefixes.find(p => url.pathname.startsWith(p));
    if (!pre) { res.writeHead(404); res.end('not found'); return; }
    const root = path.resolve(mounts[pre]);
    let rel = decodeURIComponent(url.pathname.slice(pre.length));
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, rel);
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    const size = statSync(file).size;
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    // range support so <audio> can seek in long tracks
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      const start = range[1] ? +range[1] : 0, end = range[2] ? Math.min(+range[2], size - 1) : size - 1;
      res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' });
    createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(port, host, () => {
    log(`  live view -> http://${host}:${server.address().port}/?mode=live${feed?.trackParam || ''}`);
    resolve(server);
  }));
}
