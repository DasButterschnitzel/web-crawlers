// The 3D layer on top of the real page: a rotating minimap of the site's link
// graph (route so far lit, current page pulsing) and full-screen link
// traversals between pages. Stateless: everything is a function of time, so
// a traversal that starts on one page continues seamlessly on the next.
export async function create3D({ THREE, canvas, graph, W, H }) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;              // backdrop + scene are drawn as two passes
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(50, W / H, 0.1, 3000);

  const N = graph.nodes.length;
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N);
  const c = new THREE.Color();
  graph.nodes.forEach((n, i) => {
    pos.set([n[0], n[1], n[2]], i * 3);
    c.set(graph.palette[n[3]] || '#00f0ff'); col.set([c.r, c.g, c.b], i * 3);
    size[i] = 0.8 + 2.2 * Math.sqrt(n[4] || 0);
  });
  const lit = new Float32Array(N);            // 1 = on the route already
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  pg.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  pg.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  pg.setAttribute('aLit', new THREE.BufferAttribute(lit, 1));
  const pmat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uScale: { value: 1 }, uBeat: { value: 0 }, uDim: { value: 0.45 } },
    vertexShader: `uniform float uScale, uBeat, uDim; attribute vec3 aColor; attribute float aSize, aLit; varying vec3 vC; varying float vA;
      void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); float s = aSize * (1.0 + aLit * (0.8 + uBeat));
        gl_PointSize = min(40.0, s * uScale * 260.0 / max(1.0, -mv.z)); vC = mix(aColor, vec3(1.0), aLit * 0.4); vA = mix(uDim, 1.0, aLit); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying vec3 vC; varying float vA; void main(){ float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
      gl_FragColor = vec4(vC * (smoothstep(0.5, 0.0, d) * 0.5 + smoothstep(0.15, 0.0, d)) * vA, 1.0); }`,
  });
  scene.add(new THREE.Points(pg, pmat));

  const E = graph.edges.length, ep = new Float32Array(E * 6), ec = new Float32Array(E * 6);
  graph.edges.forEach(([a, b], i) => {
    ep.set([pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2], pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]], i * 6);
    c.set(graph.palette[graph.nodes[b][3]] || '#00f0ff'); ec.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
  });
  const eg = new THREE.BufferGeometry();
  eg.setAttribute('position', new THREE.BufferAttribute(ep, 3)); eg.setAttribute('color', new THREE.BufferAttribute(ec, 3));
  const emat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false });
  scene.add(new THREE.LineSegments(eg, emat));

  // the route: a bright polyline through the visited pages
  const R = graph.route.length;
  const rp = new Float32Array(Math.max(1, R - 1) * 6);
  const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
  const rmat = new THREE.LineBasicMaterial({ color: '#ff2bd6', transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
  const routeLine = new THREE.LineSegments(rg, rmat); scene.add(routeLine);
  const P = i => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);

  // current-node marker: two rings that face the camera
  const ring = new THREE.Mesh(new THREE.RingGeometry(1, 1.25, 48), new THREE.MeshBasicMaterial({ color: '#ff2bd6', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  const ring2 = new THREE.Mesh(new THREE.RingGeometry(1.6, 1.7, 6), new THREE.MeshBasicMaterial({ color: '#00f0ff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  scene.add(ring, ring2);

  // a backdrop quad for full-screen traversals (fades the page out)
  const bgScene = new THREE.Scene(), bgCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const bgMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: { uA: { value: 0 }, uT: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `uniform float uA, uT; varying vec2 vUv; void main(){ vec2 p = vUv - 0.5; float r = length(p);
      vec3 c = mix(vec3(0.01, 0.02, 0.06), vec3(0.0), r); float grid = step(0.98, fract(vUv.y * 60.0 + uT)) * 0.05;
      gl_FragColor = vec4(c + vec3(0.0, grid, grid), uA); }` });
  bgScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat));

  const center = new THREE.Vector3();
  for (let i = 0; i < N; i++) center.add(P(i)); center.multiplyScalar(1 / Math.max(1, N));
  let extent = 1; for (let i = 0; i < N; i++) extent = Math.max(extent, P(i).distanceTo(center));   // small live graphs get a closer minimap camera
  const ease = x => { x = Math.min(1, Math.max(0, x)); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };

  function setRoute(k) {
    lit.fill(0);
    for (let i = 0; i <= k && i < R; i++) if (graph.route[i] >= 0) lit[graph.route[i]] = 1;
    pg.attributes.aLit.needsUpdate = true;
    let n = 0;
    for (let i = 0; i < Math.min(k, R - 1); i++) {
      const a = graph.route[i], b = graph.route[i + 1];
      if (a < 0 || b < 0) continue;
      rp.set([...P(a).toArray(), ...P(b).toArray()], n * 6); n++;
    }
    rg.setDrawRange(0, n * 2); rg.attributes.position.needsUpdate = true;
  }

  /**
   * S = { t, A, routeIdx, mini: {x,y,w,h} | null, travel: { from, to, u } | null, final: 0..1 }
   */
  function render(S) {
    const { t, A } = S;
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, W, H);
    renderer.clear();
    setRoute(S.routeIdx);
    pmat.uniforms.uBeat.value = A.beat * 0.6 + A.kick * 0.4;
    const cur = graph.route[Math.max(0, Math.min(R - 1, S.routeIdx))];
    const curP = cur >= 0 ? P(cur) : center.clone();

    const T = S.travel;
    if (T && T.u > 0 && T.u < 1) {
      // full-screen flight along the link: pull back from A, arc over, dive into B
      const u = T.u, a = T.from >= 0 ? P(T.from) : center, b = T.to >= 0 ? P(T.to) : center;
      const fade = Math.min(1, Math.min(u, 1 - u) * 5);
      bgMat.uniforms.uA.value = 0.92 * fade; bgMat.uniforms.uT.value = t;
      renderer.render(bgScene, bgCam);
      const k = ease(u), mid = a.clone().lerp(b, 0.5);
      const lift = a.distanceTo(b) * 0.6 + 30;
      const away = new THREE.Vector3(Math.sin(t * 0.3), 0.5, Math.cos(t * 0.3)).normalize();
      const p0 = a.clone().addScaledVector(away, 6), p2 = b.clone().addScaledVector(away, 2.5), p1 = mid.clone().addScaledVector(away, lift);
      const q = (1 - k) * (1 - k), w = 2 * (1 - k) * k, z = k * k;
      cam.position.set(q * p0.x + w * p1.x + z * p2.x, q * p0.y + w * p1.y + z * p2.y, q * p0.z + w * p1.z + z * p2.z);
      cam.up.set(0, 1, 0); cam.lookAt(a.clone().lerp(b, Math.min(1, k * 1.2)));
      cam.fov = 55 + 25 * Math.sin(u * Math.PI); cam.aspect = W / H; cam.updateProjectionMatrix();
      pmat.uniforms.uScale.value = 1.6; pmat.uniforms.uDim.value = 0.55 * fade; emat.opacity = 0.16 * fade; rmat.opacity = fade;
      ring.position.copy(b); ring2.position.copy(b); ring.lookAt(cam.position); ring2.lookAt(cam.position);
      ring.scale.setScalar(2 + A.kick); ring2.scale.setScalar(2.4); ring2.rotation.z = t;
      ring.material.opacity = ring2.material.opacity = fade;
      renderer.clearDepth();
      renderer.render(scene, cam);
      return;
    }
    const m = S.mini;
    if (!m || S.miniA <= 0) return;
    renderer.setScissorTest(true);
    const sx = m.x / 1920 * W, sy = H - (m.y + m.h) / 1080 * H, sw = m.w / 1920 * W, sh = m.h / 1080 * H;
    renderer.setScissor(sx, sy, sw, sh); renderer.setViewport(sx, sy, sw, sh);
    bgMat.uniforms.uA.value = 0.7 * S.miniA; renderer.render(bgScene, bgCam);
    const ang = t * 0.12, r = Math.min(125, Math.max(22, extent * 2.3)) * (1 - 0.25 * (S.final || 0));
    const focus = center.clone().lerp(curP, 0.55);
    cam.position.set(focus.x + Math.cos(ang) * r, focus.y + r * 0.3, focus.z + Math.sin(ang) * r);
    cam.up.set(0, 1, 0); cam.lookAt(focus); cam.fov = 45; cam.aspect = sw / sh; cam.updateProjectionMatrix();
    pmat.uniforms.uScale.value = 0.75; pmat.uniforms.uDim.value = 0.4 * S.miniA; emat.opacity = 0.07 * S.miniA; rmat.opacity = S.miniA;
    ring.position.copy(curP); ring2.position.copy(curP); ring.lookAt(cam.position); ring2.lookAt(cam.position);
    ring.scale.setScalar(4 + 3 * A.beat); ring2.scale.setScalar(5); ring2.rotation.z = t * 2;
    ring.material.opacity = ring2.material.opacity = S.miniA;
    renderer.clearDepth();
    renderer.render(scene, cam);
    renderer.setScissorTest(false);
  }
  return { render, renderer };
}
