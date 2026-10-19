// The link graph: glowing page nodes, draw-on link beams, data packets racing
// along links, silk threads from the spider to every page it fetches, wire
// cores for hub pages and section labels. Everything is a function of time,
// so a frame can be rendered in any order.
import * as THREE from 'three';
import { rng } from './layout.js';
import { lastLE } from './model.js';

const easeOutBack = x => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
const smooth = x => { x = clamp01(x); return x * x * (3 - 2 * x); };

export class GraphView {
  constructor(scene, model, { maxNodes = 4096, maxEdges = 20000 } = {}) {
    this.scene = scene; this.m = model;
    this.maxNodes = maxNodes; this.maxEdges = maxEdges;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.pos = new Float32Array(maxNodes * 3);          // current animated positions
    this.buildNodes(); this.buildEdges(); this.buildPackets(); this.buildThreads(); this.buildCores();
    this.labels = new Map();
  }

  buildNodes() {
    const N = this.maxNodes, g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.nColor = new Float32Array(N * 3); this.nSize = new Float32Array(N); this.nT = new Float32Array(N).fill(1e9); this.nFlag = new Float32Array(N); this.nHit = new Float32Array(N).fill(-100);
    g.setAttribute('aColor', new THREE.BufferAttribute(this.nColor, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.nSize, 1));
    g.setAttribute('aT', new THREE.BufferAttribute(this.nT, 1));
    g.setAttribute('aFlag', new THREE.BufferAttribute(this.nFlag, 1));
    g.setAttribute('aHit', new THREE.BufferAttribute(this.nHit, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.nodeMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uScale: { value: 1 }, uBeat: { value: 0 }, uHeat: { value: 0 }, uAlpha: { value: 1 }, uPx: { value: 1 } },
      vertexShader: `
        uniform float uTime, uScale, uBeat, uHeat, uAlpha, uPx; attribute vec3 aColor; attribute float aSize, aT, aFlag, aHit;
        varying vec3 vC; varying float vA, vFlash, vErr;
        void main(){
          float age = uTime - aT;
          float on = smoothstep(0.0, 0.08, age);
          float flash = exp(-max(age, 0.0) * 3.5) * on + exp(-max(uTime - aHit, 0.0) * 4.0) * 0.8;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float s = aSize * (1.0 + 1.4 * flash + 0.25 * uBeat);
          float dist = max(1.0, -mv.z);
          gl_PointSize = min(46.0 * uPx, s * uScale * uPx * 300.0 / dist);
          vC = aColor; vA = on * uAlpha * smoothstep(3.0, 22.0, dist); vFlash = flash; vErr = aFlag;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vC; varying float vA, vFlash, vErr;
        void main(){
          vec2 p = gl_PointCoord - 0.5; float d = length(p);
          if (d > 0.5) discard;
          float core = smoothstep(0.14, 0.0, d);
          float halo = smoothstep(0.5, 0.0, d) * 0.08;
          float ring = smoothstep(0.035, 0.0, abs(d - 0.36)) * 0.3;
          vec3 c = vC * (halo + ring) + mix(vC, vec3(1.0), 0.45) * core * 1.05 + vec3(1.0) * vFlash * smoothstep(0.45, 0.05, d) * 0.9;
          gl_FragColor = vec4(c * vA, 1.0);
        }`,
    });
    this.nodes = new THREE.Points(g, this.nodeMat);
    this.nodes.frustumCulled = false;
    this.group.add(this.nodes);
    this.nodeGeo = g;
  }

  buildEdges() {
    const E = this.maxEdges, g = new THREE.BufferGeometry();
    this.ePos = new Float32Array(E * 6); this.eCol = new Float32Array(E * 6); this.eT = new Float32Array(E * 2).fill(1e9); this.eEnd = new Float32Array(E * 2);
    for (let i = 0; i < E; i++) this.eEnd[i * 2 + 1] = 1;
    g.setAttribute('position', new THREE.BufferAttribute(this.ePos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.eCol, 3));
    g.setAttribute('aT', new THREE.BufferAttribute(this.eT, 1));
    g.setAttribute('aEnd', new THREE.BufferAttribute(this.eEnd, 1));
    g.setDrawRange(0, 0);
    this.edgeMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uAlpha: { value: 0.16 }, uBeat: { value: 0 }, uFlow: { value: 0 }, uMorph: { value: 0 } },
      vertexShader: `
        uniform float uTime; attribute vec3 aColor; attribute float aT, aEnd; varying vec3 vC; varying float vAge, vEnd, vDist;
        void main(){ vC = aColor; vAge = uTime - aT; vEnd = aEnd; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        uniform float uAlpha, uBeat, uFlow, uTime, uMorph; varying vec3 vC; varying float vAge, vEnd, vDist;
        void main(){
          if (vAge < 0.0) discard;
          float fresh = exp(-vAge * 2.2);
          float a = uAlpha * (0.6 + 0.4 * uBeat) + fresh * 0.55;
          float flow = uFlow * pow(0.5 + 0.5 * sin(vEnd * 18.0 - uTime * 9.0), 8.0) * 0.6;
          float fade = smoothstep(420.0, 60.0, vDist);
          gl_FragColor = vec4(mix(vC, vec3(1.0), fresh * 0.5) * (a + flow) * fade * (1.0 - uMorph), 1.0);
        }`,
    });
    this.edges = new THREE.LineSegments(g, this.edgeMat);
    this.edges.frustumCulled = false;
    this.group.add(this.edges);
    this.edgeGeo = g;
  }

  buildPackets() {
    const P = this.nPackets = 3200, g = new THREE.BufferGeometry();
    this.pPos = new Float32Array(P * 3); this.pA = new Float32Array(P);
    g.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aA', new THREE.BufferAttribute(this.pA, 1).setUsage(THREE.DynamicDrawUsage));
    const R = rng(777);
    this.pSeed = Array.from({ length: P }, () => [R(), 0.25 + R() * 0.9, R()]);
    this.packetMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: 1 }, uPx: { value: 1 }, uColor: { value: new THREE.Color('#bff8ff') } },
      vertexShader: `uniform float uScale, uPx; attribute float aA; varying float vA; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = min(14.0 * uPx, 1.3 * uScale * uPx * 300.0 / max(1.0, -mv.z) * (0.6 + aA)); vA = aA * smoothstep(3.0, 18.0, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uColor; varying float vA; void main(){ float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; gl_FragColor = vec4(uColor * vA * smoothstep(0.5, 0.0, d) * 0.75, 1.0); }`,
    });
    this.packets = new THREE.Points(g, this.packetMat);
    this.packets.frustumCulled = false;
    this.group.add(this.packets);
    this.packetGeo = g;
  }

  buildThreads() {
    const T = this.maxThreads = 48, S = this.threadSegs = 28, g = new THREE.BufferGeometry();
    this.tPos = new Float32Array(T * S * 6); this.tA = new Float32Array(T * S * 2); this.tU = new Float32Array(T * S * 2); this.tCol = new Float32Array(T * S * 6);
    g.setAttribute('position', new THREE.BufferAttribute(this.tPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aA', new THREE.BufferAttribute(this.tA, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aU', new THREE.BufferAttribute(this.tU, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.tCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.threadMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `attribute float aA, aU; attribute vec3 aColor; varying float vA, vU; varying vec3 vC; void main(){ vA = aA; vU = aU; vC = aColor; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform float uTime; varying float vA, vU; varying vec3 vC; void main(){ float dash = 0.55 + 0.45 * step(0.5, fract(vU * 24.0 - uTime * 6.0)); gl_FragColor = vec4(mix(vC, vec3(1.0), 0.3) * vA * dash * 1.2, 1.0); }`,
    });
    this.threads = new THREE.LineSegments(g, this.threadMat);
    this.threads.frustumCulled = false;
    this.group.add(this.threads);
    this.threadGeo = g;
  }

  // rotating wireframe polyhedra around the top hubs
  buildCores() {
    const K = this.nCores = 22;
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const wire = new THREE.WireframeGeometry(geo);
    this.coreMeshes = [];
    for (let i = 0; i < K; i++) {
      const m = new THREE.LineSegments(wire, new THREE.LineBasicMaterial({ color: '#00e5ff', transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.visible = false; this.group.add(m); this.coreMeshes.push(m);
    }
  }

  /** (re)upload static per-node / per-edge attributes; call after the model changed */
  sync() {
    const m = this.m, c = new THREE.Color();
    const n = Math.min(m.nodes.length, this.maxNodes);
    for (let i = this.syncedNodes || 0; i < n; i++) {
      const nd = m.nodes[i];
      c.set(nd.blocked || nd.status >= 400 ? '#ff1e3c' : nd.status >= 300 ? '#ffb000' : nd.sec.color);
      this.nColor.set([c.r, c.g, c.b], i * 3);
      this.nSize[i] = nd.file ? 0.5 : 0.7 + 2.1 * Math.pow(nd.prn || 0, 0.5);
      this.nT[i] = nd.t;
      this.nFlag[i] = nd.blocked || nd.status >= 400 ? 1 : 0;
    }
    this.syncedNodes = n;
    ['aColor', 'aSize', 'aT', 'aFlag'].forEach(a => (this.nodeGeo.attributes[a].needsUpdate = true));
    this.nodeGeo.setDrawRange(0, n);
    const E = Math.min(m.edges.length, this.maxEdges);
    for (let i = this.syncedEdges || 0; i < E; i++) {
      const e = m.edges[i], A = m.nodes[e.a], B = m.nodes[e.b];
      c.set(e.kind & 2 ? '#3a4a7a' : B.sec.color);
      const k = e.kind & 1 ? 1.0 : 0.65;
      this.eCol.set([c.r * k, c.g * k, c.b * k, c.r * k, c.g * k, c.b * k], i * 6);
      this.eT[i * 2] = this.eT[i * 2 + 1] = e.t;
    }
    this.syncedEdges = E;
    ['aColor', 'aT'].forEach(a => (this.edgeGeo.attributes[a].needsUpdate = true));
    this.edgeGeo.setDrawRange(0, E * 2);
    // hub cores: highest PageRank
    this.coreIdx = m.nodes.slice(0, n).sort((a, b) => (b.prn || 0) - (a.prn || 0)).slice(0, this.nCores).map(nd => nd.i);
  }

  /** animated position of node i at time t (graph space), honouring the morph target */
  nodePos(i, t, out, morph = 0, cityTopY = null) {
    const m = this.m, nd = m.nodes[i];
    const age = t - nd.t;
    let x = nd.gx, y = nd.gy, z = nd.gz;
    if (age < 1.1) {
      const p = nd.parent >= 0 && nd.parent !== i ? m.nodes[nd.parent] : null;
      const k = age <= 0 ? 0 : easeOutBack(clamp01(age / 1.1));
      const sx = p ? p.gx : 0, sy = p ? p.gy : 0, sz = p ? p.gz : 0;
      x = sx + (x - sx) * k; y = sy + (y - sy) * k; z = sz + (z - sz) * k;
    }
    if (morph > 0 && nd.cx != null) {
      // staggered per district: towers' tops are where the nodes land
      const mm = smooth((morph - (nd.sec.idx % 7) * 0.035) / 0.75);
      const ty = cityTopY ? cityTopY(i) : nd.ch;
      x += (nd.cx - x) * mm; y += (ty + 0.6 - y) * mm; z += (nd.cz - z) * mm;
    }
    out[0] = x; out[1] = y; out[2] = z;
    return out;
  }

  update(t, A, P, spider, city) {
    const m = this.m, n = this.syncedNodes || 0;
    const off = P.graphOffset || [0, 0, 0], morph = P.morph || 0;
    this.group.position.set(off[0] * (1 - morph), off[1] * (1 - morph), off[2] * (1 - morph));
    this.group.rotation.y = (P.graphSpin || 0) * (1 - morph);
    const tmp = [0, 0, 0];
    const topY = city ? i => city.towerTop(i, t) : null;
    for (let i = 0; i < n; i++) {
      this.nodePos(i, t, tmp, morph, topY);
      this.pos[i * 3] = tmp[0]; this.pos[i * 3 + 1] = tmp[1]; this.pos[i * 3 + 2] = tmp[2];
    }
    this.nodeGeo.attributes.position.needsUpdate = true;
    const U = this.nodeMat.uniforms;
    U.uTime.value = t; U.uBeat.value = A.beat * 0.6 + A.kick * 0.5; U.uAlpha.value = P.nodeAlpha ?? 1; U.uPx.value = P.px || 1;
    U.uScale.value = P.nodeScale ?? 1;

    // edges: endpoints follow nodes; the far end draws on over 0.45 s
    const E = this.syncedEdges, ep = this.ePos, pos = this.pos;
    for (let i = 0; i < E; i++) {
      const e = m.edges[i], a = e.a * 3, b = e.b * 3;
      const age = t - e.t;
      if (age < 0) continue;
      const k = age < 0.45 ? smooth(age / 0.45) : 1;
      ep[i * 6] = pos[a]; ep[i * 6 + 1] = pos[a + 1]; ep[i * 6 + 2] = pos[a + 2];
      ep[i * 6 + 3] = pos[a] + (pos[b] - pos[a]) * k; ep[i * 6 + 4] = pos[a + 1] + (pos[b + 1] - pos[a + 1]) * k; ep[i * 6 + 5] = pos[a + 2] + (pos[b + 2] - pos[a + 2]) * k;
    }
    this.edgeGeo.attributes.position.needsUpdate = true;
    const EU = this.edgeMat.uniforms;
    EU.uTime.value = t; EU.uBeat.value = A.beat; EU.uAlpha.value = P.edgeAlpha ?? 0.16; EU.uFlow.value = P.edgeFlow ?? 0.3; EU.uMorph.value = Math.min(1, morph * 1.6);

    // packets ride on links that already exist
    const live = m.edgeTimes ? lastLE(m.edgeTimes, t) + 1 : (E || 0);
    const PA = this.pA, PP = this.pPos, pk = Math.round(this.nPackets * clamp01(P.packets ?? 1));
    for (let i = 0; i < this.nPackets; i++) {
      if (i >= pk || live < 1) { PA[i] = 0; continue; }
      const [s0, sp, ph] = this.pSeed[i];
      const cyc = t * sp + ph, c = Math.floor(cyc), u = cyc - c;
      const h = Math.abs(Math.sin((i + 1) * 12.9898 + c * 78.233) * 43758.5453) % 1;
      const e = m.edgesByT ? m.edgesByT[Math.floor(h * live)] : m.edges[Math.floor(h * live)];
      const a = e.a * 3, b = e.b * 3, rev = s0 > 0.5;
      const uu = rev ? 1 - u : u;
      PP[i * 3] = pos[a] + (pos[b] - pos[a]) * uu; PP[i * 3 + 1] = pos[a + 1] + (pos[b + 1] - pos[a + 1]) * uu; PP[i * 3 + 2] = pos[a + 2] + (pos[b + 2] - pos[a + 2]) * uu;
      PA[i] = Math.sin(u * Math.PI) * (0.5 + A.hat * 0.8) * Math.max(0, 1 - morph * 1.6);
    }
    this.packetGeo.attributes.position.needsUpdate = true; this.packetGeo.attributes.aA.needsUpdate = true;
    this.packetMat.uniforms.uPx.value = P.px || 1;

    this.updateThreads(t, A, P, spider);
    this.updateCores(t, A, P);
  }

  // silk: spinneret -> page, shot ~0.3 s before the page lands, then decays
  updateThreads(t, A, P, spider) {
    const m = this.m, S = this.threadSegs, TP = this.tPos, TA = this.tA, TU = this.tU, TC = this.tCol;
    TA.fill(0);
    if (!spider || !(P.threads ?? 1) || !m.nodeTimes) { this.threadGeo.attributes.aA.needsUpdate = true; return; }
    const lo = lastLE(m.nodeTimes, t - 0.9) + 1, hi = lastLE(m.nodeTimes, t + 0.32);
    const src = spider.spinneret, c = new THREE.Color(), wv = new THREE.Vector3();
    this.group.updateMatrixWorld();
    let k = 0;
    for (let i = Math.max(lo, hi - this.maxThreads + 1); i <= hi && k < this.maxThreads; i++, k++) {
      if (i < 0) continue;
      const nd = m.nodes[i], age = t - nd.t;                 // negative while the thread is travelling
      const reach = clamp01((age + 0.32) / 0.32), fade = age > 0 ? Math.exp(-age * 4) : 1;
      this.world(i, wv);
      const tx = wv.x, ty = wv.y, tz = wv.z;
      const sx = src.x, sy = src.y, sz = src.z;
      const mx = (sx + tx) / 2, my = (sy + ty) / 2 + 6 + Math.hypot(tx - sx, tz - sz) * 0.08, mz = (sz + tz) / 2;
      c.set(nd.blocked || nd.status >= 400 ? '#ff1e3c' : nd.status >= 300 ? '#ffb000' : nd.sec.color);
      for (let s = 0; s < S; s++) {
        const u0 = s / S * reach, u1 = (s + 1) / S * reach;
        const q = (u, o) => { const a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, d = u * u; o[0] = a * sx + b * mx + d * tx; o[1] = a * sy + b * my + d * ty; o[2] = a * sz + b * mz + d * tz; return o; };
        const p0 = q(u0, [0, 0, 0]), p1 = q(u1, [0, 0, 0]);
        const o = (k * S + s) * 6;
        TP.set(p0, o); TP.set(p1, o + 3);
        const al = fade * (0.35 + 0.65 * (s / S)) * (P.threads ?? 1);
        TA[(k * S + s) * 2] = al; TA[(k * S + s) * 2 + 1] = al;
        TU[(k * S + s) * 2] = u0; TU[(k * S + s) * 2 + 1] = u1;
        TC.set([c.r, c.g, c.b, c.r, c.g, c.b], o);
      }
    }
    ['position', 'aA', 'aU', 'aColor'].forEach(a => (this.threadGeo.attributes[a].needsUpdate = true));
    this.threadMat.uniforms.uTime.value = t;
  }

  updateCores(t, A, P) {
    const show = P.cores ?? 1;
    this.coreMeshes.forEach((mesh, k) => {
      const i = this.coreIdx?.[k];
      if (i == null || this.m.nodes[i].t > t || show <= 0) { mesh.visible = false; return; }
      const nd = this.m.nodes[i];
      mesh.visible = true;
      mesh.position.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
      const s = (0.9 + 2.4 * Math.pow(nd.prn || 0, 0.5)) * (1 + A.kick * 0.25) * smooth((t - nd.t) / 0.8);
      mesh.scale.setScalar(s);
      mesh.rotation.set(t * 0.3 + k, t * 0.45 + k * 2, 0);
      mesh.material.color.set(nd.sec.color);
      mesh.material.opacity = 0.32 * show * (1 - (P.morph || 0));
    });
  }

  hit(i, t) { if (i < this.maxNodes) { this.nHit[i] = t; this.nodeGeo.attributes.aHit.needsUpdate = true; } }

  /** world-space position of node i (includes group offset / spin) */
  world(i, out = new THREE.Vector3()) {
    out.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
    return out.applyMatrix4(this.group.matrixWorld);
  }
}
