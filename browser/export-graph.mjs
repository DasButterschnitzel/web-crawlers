// Precompute the 3D link-space layout for the page overlay (minimap + traversals):
// node positions from the same force layout the 3D visualiser uses, a readable
// subset of links, and the captured route mapped onto graph nodes.
//   node export-graph.mjs ../runs/<run> ../video3d/build/webcache/route.json ../video3d/build/web-graph.json
import { readFileSync, writeFileSync } from 'node:fs';
import { CrawlModel } from '../viz3d/js/model.js';
const [run, routeFile, out] = process.argv.slice(2);
const crawl = JSON.parse(readFileSync(run + '/crawl.json', 'utf8'));
const events = JSON.parse(readFileSync(run + '/events.json', 'utf8'));
const m = CrawlModel.fromRecorded(crawl, events, { start: 0, ice: 100, end: 120, bpm: 100, grid0: 0 });
const palette = [...new Set(m.nodes.map(n => n.blocked ? '#ff1e3c' : n.sec.color))];
const nodes = m.nodes.map(n => [+n.gx.toFixed(2), +n.gy.toFixed(2), +n.gz.toFixed(2), palette.indexOf(n.blocked ? '#ff1e3c' : n.sec.color), +(n.prn || 0).toFixed(3)]);
const idx = new Map(m.nodes.map(n => [n.url, n.i]));
const strip = u => u.replace(/\?.*$/, '');
const byPath = new Map(m.nodes.map(n => [strip(n.url), n.i]));
const edges = m.edges.filter((e, k) => (e.kind & 1) || k % 3 === 0).slice(0, 5000).map(e => [e.a, e.b]);
const route = JSON.parse(readFileSync(routeFile, 'utf8')).map(p => idx.get(p.url) ?? byPath.get(strip(p.url)) ?? -1);
writeFileSync(out, JSON.stringify({ nodes, edges, palette, route, urls: m.nodes.map(n => n.url) }));
console.log(`graph: ${nodes.length} nodes, ${edges.length} edges, route ${route.filter(i => i >= 0).length}/${route.length} mapped -> ${out}`);
