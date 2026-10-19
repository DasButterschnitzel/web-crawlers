// Shared 3D layouts (no three.js dependency: runs in the browser for live
// crawls and in Node to precompute deterministic layouts for video renders).
//
//  * ForceLayout3D: incremental force-directed graph. Sections (first path
//    segment) get anchor points on a Fibonacci sphere so the site forms
//    galaxies; PageRank hubs sink towards the core; links are springs and
//    repulsion is grid-hashed (O(n)).
//  * cityLayout: squarified treemap of sections -> districts, one tower per page.

export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fibonacciSphere(n, r) {
  const out = [], g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i + 0.5) / n * 2, rad = Math.sqrt(1 - y * y), th = g * i;
    out.push([Math.cos(th) * rad * r, y * r * 0.62, Math.sin(th) * rad * r]);   // flattened: reads better on a 16:9 screen
  }
  return out;
}

export class ForceLayout3D {
  constructor({ seed = 7, anchorRadius = 46, cell = 7 } = {}) {
    this.R = rng(seed);
    this.anchorRadius = anchorRadius;
    this.cell = cell;
    this.cap = 0; this.n = 0;
    this.grow(1024);
    this.springs = [];          // [a, b, k, len]
    this.sectionAnchor = new Map();
    this.sectionOrder = [];
    this.adjCount = [];
  }
  grow(cap) {
    const f = (old, c) => { const a = new Float32Array(c); if (old) a.set(old); return a; };
    this.x = f(this.x, cap * 3); this.v = f(this.v, cap * 3); this.anchor = f(this.anchor, cap * 3);
    this.hub = f(this.hub, cap); this.pinned = f(this.pinned, cap);
    this.cap = cap;
  }
  /** Sections must be declared (largest first) so anchors are stable. */
  setSections(names) {
    this.sectionOrder = names.slice();
    const pts = fibonacciSphere(Math.max(names.length, 1), this.anchorRadius);
    // largest sections take the most "equatorial" slots for a wide composition
    const idx = pts.map((p, i) => i).sort((a, b) => Math.abs(pts[a][1]) - Math.abs(pts[b][1]));
    names.forEach((n, i) => this.sectionAnchor.set(n, pts[idx[i % pts.length]]));
  }
  ensureSection(name) {
    if (this.sectionAnchor.has(name)) return;
    const k = this.sectionAnchor.size;
    const p = fibonacciSphere(k + 1, this.anchorRadius)[k];
    this.sectionAnchor.set(name, p);
  }
  addNode(section, parent = -1, hub = 0) {
    if (this.n >= this.cap) this.grow(this.cap * 2);
    const i = this.n++;
    this.ensureSection(section);
    const a = section === '/' ? [0, 0, 0] : this.sectionAnchor.get(section);
    this.anchor.set(a, i * 3);
    const j = () => (this.R() - 0.5) * 4;
    if (parent >= 0 && parent < i) this.x.set([this.x[parent * 3] + j(), this.x[parent * 3 + 1] + j(), this.x[parent * 3 + 2] + j()], i * 3);
    else this.x.set([a[0] * 0.3 + j(), a[1] * 0.3 + j(), a[2] * 0.3 + j()], i * 3);
    this.hub[i] = hub;
    this.pinned[i] = section === '/' && i === 0 ? 1 : 0;
    return i;
  }
  setHub(i, h) { this.hub[i] = h; }
  addSpring(a, b, k = 0.02, len = 3) { this.springs.push([a, b, k, len]); }

  step(iter = 1, { alpha = 1 } = {}) {
    const n = this.n, x = this.x, v = this.v, A = this.anchor, cell = this.cell, cut2 = cell * cell;
    for (let it = 0; it < iter; it++) {
      // repulsion via spatial hash
      const grid = new Map();
      const key = (cx, cy, cz) => (cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791);
      for (let i = 0; i < n; i++) {
        const k = key(Math.floor(x[i * 3] / cell), Math.floor(x[i * 3 + 1] / cell), Math.floor(x[i * 3 + 2] / cell));
        let b = grid.get(k); if (!b) grid.set(k, b = []); b.push(i);
      }
      for (let i = 0; i < n; i++) {
        const xi = x[i * 3], yi = x[i * 3 + 1], zi = x[i * 3 + 2];
        const cx = Math.floor(xi / cell), cy = Math.floor(yi / cell), cz = Math.floor(zi / cell);
        let fx = 0, fy = 0, fz = 0;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          const b = grid.get(key(cx + dx, cy + dy, cz + dz)); if (!b) continue;
          for (const j of b) {
            if (j === i) continue;
            const ex = xi - x[j * 3], ey = yi - x[j * 3 + 1], ez = zi - x[j * 3 + 2];
            let d2 = ex * ex + ey * ey + ez * ez;
            if (d2 > cut2) continue;
            if (d2 < 0.01) d2 = 0.01;
            const f = 2.2 / d2 * (1 - d2 / cut2);
            fx += ex * f; fy += ey * f; fz += ez * f;
          }
        }
        // anchor pull (hubs drift to the core)
        const h = this.hub[i], ax = A[i * 3] * (1 - h), ay = A[i * 3 + 1] * (1 - h), az = A[i * 3 + 2] * (1 - h);
        const ka = 0.012 + 0.03 * h;
        fx += (ax - xi) * ka; fy += (ay - yi) * ka; fz += (az - zi) * ka;
        v[i * 3] = (v[i * 3] + fx * alpha) * 0.82; v[i * 3 + 1] = (v[i * 3 + 1] + fy * alpha) * 0.82; v[i * 3 + 2] = (v[i * 3 + 2] + fz * alpha) * 0.82;
      }
      for (const [a, b, k, len] of this.springs) {
        if (a >= n || b >= n) continue;
        const ex = x[b * 3] - x[a * 3], ey = x[b * 3 + 1] - x[a * 3 + 1], ez = x[b * 3 + 2] - x[a * 3 + 2];
        const d = Math.sqrt(ex * ex + ey * ey + ez * ez) + 1e-6, f = (d - len) * k * alpha / d;
        v[a * 3] += ex * f; v[a * 3 + 1] += ey * f; v[a * 3 + 2] += ez * f;
        v[b * 3] -= ex * f; v[b * 3 + 1] -= ey * f; v[b * 3 + 2] -= ez * f;
      }
      for (let i = 0; i < n; i++) {
        if (this.pinned[i]) { v[i * 3] = v[i * 3 + 1] = v[i * 3 + 2] = 0; continue; }
        // clamp speed for stability
        const s = Math.hypot(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
        const m = s > 3 ? 3 / s : 1;
        x[i * 3] += v[i * 3] * m; x[i * 3 + 1] += v[i * 3 + 1] * m; x[i * 3 + 2] += v[i * 3 + 2] * m;
      }
    }
  }
  pos(i) { return [this.x[i * 3], this.x[i * 3 + 1], this.x[i * 3 + 2]]; }
}

// squarified treemap (Bruls et al.) of weights into rect {x, y, w, h}
export function treemap(items, rect) {
  const out = [];
  const total = items.reduce((s, it) => s + it.weight, 0) || 1;
  const scale = rect.w * rect.h / total;
  const list = items.map(it => ({ ...it, area: it.weight * scale })).sort((a, b) => b.area - a.area);
  let r = { ...rect };
  const worst = (row, side) => {
    const s = row.reduce((a, b) => a + b.area, 0);
    let mx = 0, mn = Infinity;
    for (const it of row) { mx = Math.max(mx, it.area); mn = Math.min(mn, it.area); }
    return Math.max(side * side * mx / (s * s), (s * s) / (side * side * mn));
  };
  const layoutRow = row => {
    const s = row.reduce((a, b) => a + b.area, 0);
    if (r.w >= r.h) {
      const w = s / r.h; let y = r.y;
      for (const it of row) { const h = it.area / w; out.push({ ...it, rect: { x: r.x, y, w, h } }); y += h; }
      r = { x: r.x + w, y: r.y, w: r.w - w, h: r.h };
    } else {
      const h = s / r.w; let x = r.x;
      for (const it of row) { const w = it.area / h; out.push({ ...it, rect: { x, y: r.y, w, h } }); x += w; }
      r = { x: r.x, y: r.y + h, w: r.w, h: r.h - h };
    }
  };
  let row = [];
  for (const it of list) {
    const side = Math.min(r.w, r.h);
    if (!row.length || worst([...row, it], side) <= worst(row, side)) row.push(it);
    else { layoutRow(row); row = [it]; }
  }
  if (row.length) layoutRow(row);
  return out;
}

/**
 * pages: [{ id, section, pr }] -> Map id -> { x, z, w } and districts [{ name, rect }]
 * One tower per page on a regular grid inside its district; the highest
 * PageRank pages take the district's centre ("downtown").
 */
export function cityLayout(pages, { cell = 2, street = 4 } = {}) {
  const bySec = new Map();
  for (const p of pages) { if (!bySec.has(p.section)) bySec.set(p.section, []); bySec.get(p.section).push(p); }
  const items = [...bySec].map(([name, list]) => ({ name, list, weight: list.length * 1.35 + 6 }));
  const area = items.reduce((s, it) => s + it.weight, 0) * cell * cell;
  const W = Math.sqrt(area) * 1.08;
  const tm = treemap(items, { x: -W / 2, y: -W / 2, w: W, h: W });
  const pos = new Map();
  const districts = [];
  for (const d of tm) {
    const r = { x: d.rect.x + street / 2, y: d.rect.y + street / 2, w: Math.max(cell, d.rect.w - street), h: Math.max(cell, d.rect.h - street) };
    districts.push({ name: d.name, rect: r, count: d.list.length });
    const cols = Math.max(1, Math.floor(r.w / cell)), rows = Math.max(1, Math.floor(r.h / cell));
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const cells = [];
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      const x = r.x + (i + 0.5) * (r.w / cols), y = r.y + (j + 0.5) * (r.h / rows);
      cells.push({ x, y, d: Math.hypot((x - cx) / r.w, (y - cy) / r.h) });
    }
    cells.sort((a, b) => a.d - b.d);
    const list = d.list.slice().sort((a, b) => b.pr - a.pr);
    const fw = Math.min(r.w / cols, r.h / rows) * 0.72;
    list.forEach((p, k) => {
      const c = cells[k % cells.length];
      const stack = Math.floor(k / cells.length);            // overflow (rare) stacks a little off-grid
      pos.set(p.id, { x: c.x + stack * 0.35, z: c.y + stack * 0.35, w: fw });
    });
  }
  return { pos, districts, size: W };
}
