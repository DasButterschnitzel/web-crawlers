// Deterministic capture of viz3d (mode=render) into a video.
//
//   node render3d.mjs --run ../runs/<run>                 full length, 60 fps, 1920x1080
//   node render3d.mjs --run ../runs/<run> --workers 3     parallel chunks (GPU shared), concatenated
//   node render3d.mjs --run ../runs/<run> --still 45,130,300   PNG stills for checking
//   node render3d.mjs --run ../runs/<run> --from 40 --seconds 10   preview a range
//
// Each worker opens its own headless Chrome, re-simulates the spider from t=0
// to its first frame (cheap, no rendering) and pipes JPEG frames into ffmpeg.
// The audio (build/track.wav) is muxed at the end.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../crawler/lib/live.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; };
const flag = name => process.argv.includes('--' + name);

const RUN = path.resolve(arg('run', path.join(ROOT, 'runs', 'dreieich')));
const BUILD = path.join(HERE, 'build'), OUT = path.join(HERE, 'out');
const FPS = +arg('fps', 60), W = +arg('w', 1920), H = +arg('h', 1080);
const WORKERS = +arg('workers', 1);
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const QUALITY = +arg('jpeg', 92);
const NAME = arg('name', 'arachnet');
mkdirSync(OUT, { recursive: true });

const run = (cmd, args) => new Promise((res, rej) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  p.on('exit', c => c === 0 ? res() : rej(new Error(`${cmd} exited ${c}`)));
});

const server = await serve({ port: 0, mounts: { '/': path.join(ROOT, 'viz3d'), '/run/': RUN, '/build/': BUILD }, log: () => {} });
const PORT = server.address().port;
const URL0 = `http://127.0.0.1:${PORT}/?mode=render&run=/run/&audio=/build/&w=${W}&h=${H}&fps=${FPS}`;

async function openPage() {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, protocolTimeout: 600000,
    args: ['--hide-scrollbars', '--force-color-profile=srgb', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11',
      '--enable-gpu-rasterization', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('[page error]', e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.error('[page]', m.text()); });
  await page.goto(URL0, { waitUntil: 'load' });
  await page.waitForFunction('window.__ready || window.__error', { timeout: 300000, polling: 200 });
  const err = await page.evaluate('window.__error');
  if (err) throw new Error(err);
  const info = await page.evaluate('window.__info');
  const gl = await page.evaluate(() => { const c = document.querySelector('canvas'); const g = c.getContext('webgl2'); const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; });
  return { browser, page, info, gl };
}

async function shoot(page) {
  return page.screenshot({ type: 'jpeg', quality: QUALITY, optimizeForSpeed: true, captureBeyondViewport: false });
}

// ---------------------------------------------------------------- stills
if (arg('still')) {
  const { browser, page, info, gl } = await openPage();
  console.log(`  renderer: ${gl}  ·  ${info.nodes} nodes, ${info.edges} edges`);
  mkdirSync(path.join(OUT, 'stills'), { recursive: true });
  const times = arg('still').split(',').map(Number).sort((a, b) => a - b);
  for (const t of times) {
    const f = Math.round(t * FPS);
    const t0 = Date.now();
    await page.evaluate(f => window.__seek(f), f);
    await page.evaluate(f => window.__frame(f), f);
    const buf = await page.screenshot({ type: 'png' });
    const file = path.join(OUT, 'stills', `t${String(t).padStart(6, '0')}.png`);
    writeFileSync(file, buf);
    console.log(`  t=${t}s -> ${path.relative(HERE, file)} (${Date.now() - t0} ms)`);
  }
  await browser.close(); server.close();
  process.exit(0);
}

// ---------------------------------------------------------------- video
const probe = await openPage();
const info = probe.info;
console.log(`  renderer: ${probe.gl}`);
console.log(`  ${info.nodes} nodes, ${info.edges} edges, ${info.duration.toFixed(1)} s @ ${FPS} fps`);
await probe.browser.close();

const from = Math.round(+arg('from', 0) * FPS);
const total = Math.round((arg('seconds') ? +arg('seconds') : info.duration - +arg('from', 0)) * FPS);
const to = Math.min(info.frames, from + total);
const preview = from > 0 || to < info.frames;
const chunk = Math.ceil((to - from) / WORKERS);
const parts = [];
const t0 = Date.now();
let doneFrames = 0;

const encoder = arg('codec', 'h264_nvenc');
const encArgs = encoder === 'libx264'
  ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', '16']
  : ['-c:v', encoder, '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', arg('cq', '22'), '-b:v', '0', '-maxrate', arg('maxrate', '28M'), '-bufsize', '56M', '-spatial-aq', '1', '-temporal-aq', '1', '-rc-lookahead', '32', '-bf', '3', '-profile:v', 'high', '-g', '120'];

async function worker(w, f0, f1) {
  const { browser, page } = await openPage();
  const file = path.join(OUT, `part-${w}.mp4`);
  parts[w] = file;
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    ...encArgs, '-pix_fmt', 'yuv420p', '-r', String(FPS), file], { stdio: ['pipe', 'inherit', 'inherit'] });
  const ffDone = new Promise((res, rej) => ff.on('exit', c => c === 0 ? res() : rej(new Error('ffmpeg exited ' + c))));
  await page.evaluate(f => window.__seek(f), f0);
  for (let f = f0; f < f1; f++) {
    await page.evaluate(f => window.__frame(f), f);
    const buf = await shoot(page);
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    doneFrames++;
    if (doneFrames % 60 === 0) {
      const el = (Date.now() - t0) / 1000, fps = doneFrames / el;
      process.stdout.write(`\r  ${doneFrames}/${to - from} frames  ${fps.toFixed(1)} fps  eta ${Math.round((to - from - doneFrames) / fps)} s    `);
    }
  }
  ff.stdin.end();
  await ffDone;
  await browser.close();
}

const jobs = [];
for (let w = 0; w < WORKERS; w++) {
  const f0 = from + w * chunk, f1 = Math.min(to, f0 + chunk);
  if (f0 < f1) jobs.push(worker(w, f0, f1));
}
await Promise.all(jobs);
console.log(`\n  rendered ${to - from} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

// concat + mux audio
const list = path.join(OUT, 'parts.txt');
writeFileSync(list, parts.filter(Boolean).map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
const silent = path.join(OUT, preview ? 'preview-silent.mp4' : `${NAME}-silent.mp4`);
await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', silent]);
const track = path.join(BUILD, 'track.wav');
const final = path.join(OUT, preview ? 'preview.mp4' : `${NAME}.mp4`);
if (existsSync(track)) {
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', silent, '-ss', (from / FPS).toFixed(3), '-i', track,
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', '-shortest', '-movflags', '+faststart', final]);
  console.log(`  -> ${path.relative(HERE, final)}`);
} else console.log(`  -> ${path.relative(HERE, silent)} (no build/track.wav to mux)`);
for (const p of parts) if (p) rmSync(p, { force: true });
server.close();
