// The data city: every fetched page is a tower in its section's district.
// Height = content (words) + importance (PageRank); colour by section, by
// response time or by issues. Towers rise in waves, windows flicker with the
// hi-hats, roofs flash when a spider foot lands on them; parent->child links
// arc between the roofs as flowing light.
import * as THREE from 'three';
import { lastLE } from './model.js';

const smooth = x => { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); };

export class CityView {
  constructor(scene, model, { riseStart = 1e9 } = {}) {
    this.scene = scene; this.m = model;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.N = model.nodes.length;
    this.build();
    this.setRise(riseStart);
    this.buildArcs();
    this.buildIndex();
  }

  build() {
    const m = this.m, N = this.N;
    const geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, 0.5, 0);
    const ig = new THREE.InstancedBufferGeometry().copy(geo);
    this.aCol = new Float32Array(N * 3); this.aHeat = new Float32Array(N * 3); this.aData = new Float32Array(N * 4); this.aHit = new Float32Array(N).fill(-100); this.aRise = new Float32Array(N);
    const c = new THREE.Color(), h = new THREE.Color();
    const maxT = Math.max(...m.nodes.map(n => n.ttfb || 0), 1);
    m.nodes.forEach((n, i) => {
      c.set(n.sec.color); this.aCol.set([c.r, c.g, c.b], i * 3);
      // heat: response time (cyan fast -> magenta -> red slow)
      // same scale as the HUD legend: <100 ms cyan, ~300 ms blue, ~1 s magenta, >2 s red
      const ms = n.ttfb || 0;
      const stops = [[0, '#00f0ff'], [100, '#00f0ff'], [300, '#3d6dff'], [1000, '#ff2bd6'], [2000, '#ff1e3c']];
      let j = 0; while (j < stops.length - 2 && ms > stops[j + 1][0]) j++;
      const [a0, c0] = stops[j], [a1, c1] = stops[j + 1];
      h.set(c0).lerp(new THREE.Color(c1), Math.min(1, Math.max(0, (ms - a0) / (a1 - a0 || 1))));
      this.aHeat.set([h.r, h.g, h.b], i * 3);
      const issue = n.status >= 400 || n.blocked ? 1 : n.noalt > 0 ? 0.6 : 0;
      this.aData.set([n.ch, n.cw, issue, (i * 0.6180339) % 1], i * 4);
    });
    ig.setAttribute('aCol', new THREE.InstancedBufferAttribute(this.aCol, 3));
    ig.setAttribute('aHeat', new THREE.InstancedBufferAttribute(this.aHeat, 3));
    ig.setAttribute('aData', new THREE.InstancedBufferAttribute(this.aData, 4));
    ig.setAttribute('aHit', new THREE.InstancedBufferAttribute(this.aHit, 1).setUsage(THREE.DynamicDrawUsage));
    ig.setAttribute('aRise', new THREE.InstancedBufferAttribute(this.aRise, 1));
    const off = new Float32Array(N * 2);
    m.nodes.forEach((n, i) => off.set([n.cx, n.cz], i * 2));
    ig.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 2));
    ig.instanceCount = N;
    this.geo = ig;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uHeatMix: { value: 0 }, uIssue: { value: 0 }, uHat: { value: 0 }, uBass: { value: 0 }, uAlpha: { value: 1 },
        uFogColor: { value: new THREE.Color('#03040c') }, uFogDensity: { value: 0.0042 },
      },
      vertexShader: `
        uniform float uTime; attribute vec3 aCol, aHeat; attribute vec4 aData; attribute float aHit, aRise; attribute vec2 aOff;
        varying vec3 vCol, vHeat, vLocal; varying vec4 vData; varying float vHit, vDist, vH;
        void main(){
          float rise = smoothstep(0.0, 1.0, clamp((uTime - aRise) / 1.4, 0.0, 1.0));
          float hgt = max(0.02, aData.x * rise);
          vec3 p = vec3(position.x * aData.y, position.y * hgt, position.z * aData.y);
          vLocal = vec3(position.x, position.y * hgt, position.z); vH = hgt;
          vec4 w = modelMatrix * vec4(p + vec3(aOff.x, 0.0, aOff.y), 1.0);
          vec4 mv = viewMatrix * w; vDist = -mv.z;
          vCol = aCol; vHeat = aHeat; vData = aData; vHit = aHit;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uTime, uHeatMix, uIssue, uHat, uBass, uAlpha; uniform vec3 uFogColor; uniform float uFogDensity;
        varying vec3 vCol, vHeat, vLocal; varying vec4 vData; varying float vHit, vDist, vH;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        void main(){
          vec3 base = mix(vCol, vHeat, uHeatMix);
          vec3 issueCol = vData.z > 0.9 ? vec3(1.0, 0.08, 0.18) * (0.75 + 0.25 * sin(uTime * 8.0)) : vData.z > 0.5 ? vec3(1.0, 0.69, 0.0) : vec3(0.0, 0.94, 1.0) * 0.35;
          base = mix(base, issueCol, uIssue);
          // windows on the facades
          float onX = step(0.4995, abs(vLocal.x)), onZ = step(0.4995, abs(vLocal.z));
          float side = max(onX, onZ);
          vec2 wuv = vec2((vLocal.x + vLocal.z) * 4.0, vLocal.y * 2.2);
          vec2 cell = floor(wuv); vec2 f = fract(wuv);
          float win = step(0.2, f.x) * step(f.x, 0.8) * step(0.25, f.y) * step(f.y, 0.75);
          float lit = step(0.55 - uHat * 0.25, hash(cell + vData.w * 91.0 + floor(uTime * 1.5 + hash(cell) * 5.0) * 0.37));
          float top = step(0.999, vLocal.y / max(vH, 0.001));
          side *= 1.0 - top;
          float across = onX > 0.5 ? abs(vLocal.z) : abs(vLocal.x);
          float vEdge = smoothstep(0.44, 0.5, across) * side;                       // vertical neon edges
          float tEdge = smoothstep(vH - 0.1, vH, vLocal.y) * side;                  // roof line
          float rim = smoothstep(0.42, 0.5, max(abs(vLocal.x), abs(vLocal.z))) * top; // roof outline
          float flash = exp(-max(uTime - vHit, 0.0) * 3.0);
          vec3 c = vec3(0.006, 0.008, 0.016);
          c += base * win * lit * side * (0.16 + uBass * 0.22);
          c += base * (vEdge * 0.55 + tEdge * 0.9 + rim * 1.1);
          c += base * top * (0.06 + 0.12 * uBass) + vec3(1.0) * flash * (0.2 + top * 0.9 + rim);
          c += base * 0.1 * exp(-vLocal.y * 3.0) * side;  // ground glow
          float fog = 1.0 - exp(-pow(uFogDensity * vDist, 1.6));
          gl_FragColor = vec4(mix(c, uFogColor, clamp(fog, 0.0, 1.0)) * uAlpha, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(ig, this.mat);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
  }

  /** towers rise district by district, downtown first, starting at t0 */
  setRise(t0) {
    this.riseStart = t0;
    const m = this.m;
    m.nodes.forEach((n, i) => {
      const d = (n.sec.idx % 9) * 0.55 + Math.min(4, Math.hypot(n.cx, n.cz) * 0.035) + ((i * 0.618) % 1) * 0.8;
      this.aRise[i] = t0 + d;
    });
    this.geo.attributes.aRise.needsUpdate = true;
  }

  towerTop(i, t) {
    if (i >= this.N) return 0;
    const n = this.m.nodes[i];
    const k = smooth((t - this.aRise[i]) / 1.4);
    return Math.max(0.02, n.ch * k);
  }

  buildIndex() {
    // spatial hash of tower footprints for ground queries
    this.cell = 2.1;
    this.idx = new Map();
    this.m.nodes.forEach((n, i) => {
      const k = Math.floor(n.cx / this.cell) + ',' + Math.floor(n.cz / this.cell);
      if (!this.idx.has(k)) this.idx.set(k, []); this.idx.get(k).push(i);
    });
  }
  towerAt(x, z) {
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const b = this.idx.get((cx + dx) + ',' + (cz + dz)); if (!b) continue;
      for (const i of b) { const n = this.m.nodes[i], hw = n.cw / 2; if (Math.abs(x - n.cx) <= hw && Math.abs(z - n.cz) <= hw) return i; }
    }
    return -1;
  }
  ground(x, z, t) {
    if (t < this.riseStart || this.hidden) return 0;
    const i = this.towerAt(x, z);
    return i < 0 ? 0 : this.towerTop(i, t);
  }
  hit(i, t) { this.aHit[i] = t; this.geo.attributes.aHit.needsUpdate = true; }

  buildArcs() {
    const m = this.m, S = 22;
    // a readable subset: links out of the homepage are mostly navigation, keep only a few of those
    let rootKept = 0;
    const pairs = m.nodes.filter(n => n.parent >= 0 && n.parent !== n.i && !n.blocked)
      .filter(n => n.parent !== 0 || (rootKept++ < 36))
      .filter((n, k) => k < 900).map(n => [n.parent, n.i]);
    this.arcPairs = pairs;
    const A = pairs.length;
    this.arcPos = new Float32Array(A * S * 6); const u = new Float32Array(A * S * 2), col = new Float32Array(A * S * 6), seed = new Float32Array(A * S * 2);
    const c = new THREE.Color();
    pairs.forEach(([a, b], k) => {
      c.set(m.nodes[b].sec.color);
      for (let s = 0; s < S; s++) {
        const o = (k * S + s);
        u[o * 2] = s / S; u[o * 2 + 1] = (s + 1) / S;
        col.set([c.r, c.g, c.b, c.r, c.g, c.b], o * 6);
        seed[o * 2] = seed[o * 2 + 1] = (k * 0.618) % 1;
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.arcPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aU', new THREE.BufferAttribute(u, 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.arcMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uAlpha: { value: 0 } },
      vertexShader: `attribute float aU, aSeed; attribute vec3 aColor; varying float vU, vS; varying vec3 vC; void main(){ vU = aU; vS = aSeed; vC = aColor; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform float uTime, uAlpha; varying float vU, vS; varying vec3 vC; void main(){ float p = fract(vU - uTime * 0.45 - vS); float head = pow(p, 14.0); gl_FragColor = vec4(vC * uAlpha * (0.05 + head * 1.0), 1.0); }`,
    });
    this.arcs = new THREE.LineSegments(g, this.arcMat);
    this.arcs.frustumCulled = false;
    this.group.add(this.arcs);
    this.arcGeo = g; this.arcSegs = S; this.arcFrame = -1;
  }

  updateArcs(t) {
    const m = this.m, S = this.arcSegs, P = this.arcPos;
    this.arcPairs.forEach(([a, b], k) => {
      const A = m.nodes[a], B = m.nodes[b];
      const ya = this.towerTop(a, t), yb = this.towerTop(b, t);
      const d = Math.hypot(B.cx - A.cx, B.cz - A.cz);
      const apex = Math.max(ya, yb) + 3 + d * 0.32;
      for (let s = 0; s < S; s++) {
        const o = (k * S + s) * 6;
        for (let e = 0; e < 2; e++) {
          const u = (s + e) / S;
          const x = A.cx + (B.cx - A.cx) * u, z = A.cz + (B.cz - A.cz) * u;
          const y = (1 - u) * (1 - u) * ya + 2 * (1 - u) * u * apex + u * u * yb;
          P[o + e * 3] = x; P[o + e * 3 + 1] = y; P[o + e * 3 + 2] = z;
        }
      }
    });
    this.arcGeo.attributes.position.needsUpdate = true;
  }

  update(t, A, P) {
    const vis = (P.city ?? 0) > 0;
    this.group.visible = vis;
    this.hidden = !vis;
    if (!vis) return;
    const U = this.mat.uniforms;
    U.uTime.value = t; U.uHeatMix.value = P.heat ?? 0; U.uIssue.value = P.issues ?? 0; U.uHat.value = A.hat; U.uBass.value = A.bands[1] * 0.7 + A.kick * 0.4;
    U.uAlpha.value = P.city;
    if (P.arcs > 0) this.updateArcs(t);
    this.arcs.visible = (P.arcs ?? 0) > 0;
    this.arcMat.uniforms.uTime.value = t; this.arcMat.uniforms.uAlpha.value = (P.arcs ?? 0) * (0.7 + A.beat * 0.5);
  }
}
