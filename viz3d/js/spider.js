// The crawler, in 3D: eight legs with coxa + two-bone IK (knees high), an
// alternating tetrapod gait whose feet plant on whatever the ground is (grid
// floor or the roofs of the data city), a dark armoured body with a hex
// abdomen and eight red eyes. Deterministic: step(dt) with a fixed dt.
import * as THREE from 'three';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const angLerp = (a, b, t) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * t; };

// [hip angle (deg from forward), foot rest angle, rest radius, femur, tibia]
const LEG_DEF = [
  [36, 28, 5.6, 3.1, 3.9],
  [70, 68, 5.1, 2.9, 3.5],
  [108, 112, 5.0, 2.9, 3.4],
  [142, 154, 5.5, 3.0, 3.8],
];

export class Spider {
  constructor(scene, { scale = 1, color = '#00e5ff', accent = '#ff1e3c' } = {}) {
    this.scene = scene;
    this.S = scale;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.pos = V(0, 0, 0); this.vel = V(); this.heading = 0; this.headingVel = 0;
    this.bodyY = 1.7; this.pitch = 0; this.roll = 0;
    this.spinneret = V();
    this.eyes = V();
    this.onPlant = null;
    this.gaitPhase = 0;
    this.color = new THREE.Color(color); this.accent = new THREE.Color(accent);
    this.buildBody();
    this.buildLegs();
    this.placed = false;
  }

  buildBody() {
    const S = this.S;
    this.body = new THREE.Group();
    this.root.add(this.body);
    const metal = new THREE.MeshStandardMaterial({ color: '#0b0f1c', metalness: 0.92, roughness: 0.32, emissive: '#02040a' });
    this.metal = metal;
    // cephalothorax
    const ceph = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), metal);
    ceph.scale.set(1.1 * S, 0.62 * S, 1.3 * S);
    this.body.add(ceph);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.02, 1), 1), new THREE.LineBasicMaterial({ color: this.color, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    edges.scale.copy(ceph.scale);
    this.body.add(edges);
    this.cephEdges = edges;
    // abdomen with hex armour shader
    this.abdMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uBass: { value: 0 }, uKick: { value: 0 }, uCol: { value: this.color.clone() }, uAcc: { value: this.accent.clone() }, uAlert: { value: 0 } },
      vertexShader: `varying vec3 vN, vP, vV; void main(){ vP = position; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        uniform float uTime, uBass, uKick, uAlert; uniform vec3 uCol, uAcc; varying vec3 vN, vP, vV;
        float hex(vec2 p){ p.x *= 1.1547; p.y += mod(floor(p.x), 2.0) * 0.5; p = abs(fract(p) - 0.5); return abs(max(p.x * 1.5 + p.y, p.y * 2.0) - 1.0); }
        void main(){
          float fr = pow(1.0 - max(dot(vN, vV), 0.0), 2.5);
          vec2 uv = vec2(atan(vP.z, vP.x) * 2.2, vP.y * 4.0);
          float h = smoothstep(0.08, 0.0, hex(uv * 1.6));
          float wave = 0.5 + 0.5 * sin(vP.z * 6.0 - uTime * 4.0);
          vec3 base = vec3(0.012, 0.016, 0.03);
          vec3 c = base + uCol * h * (0.18 + 0.9 * uBass * wave) + uCol * fr * 0.45;
          // hourglass glyph on top
          vec2 q = vec2(vP.x, vP.z + 0.15);
          float glass = step(abs(q.x), 0.04 + abs(q.y) * 0.32) * step(abs(q.y), 0.3) * step(0.72, vP.y);
          c += uAcc * glass * (0.9 + 2.5 * uKick + 2.0 * uAlert);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    const abd = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), this.abdMat);
    abd.scale.set(0.95 * S, 0.8 * S, 1.4 * S);
    abd.position.set(0, 0.5 * S, -2.15 * S);
    abd.rotation.x = -0.25;
    this.body.add(abd);
    this.abdomen = abd;
    // eyes: two big, six small, Skynet red
    this.eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 0.12, 0.2), toneMapped: false });
    const eyeGeo = new THREE.SphereGeometry(1, 16, 12);
    const eyeDef = [[0.22, 0.32, 1.02, 0.17], [-0.22, 0.32, 1.02, 0.17], [0.5, 0.3, 0.88, 0.1], [-0.5, 0.3, 0.88, 0.1], [0.36, 0.45, 0.78, 0.08], [-0.36, 0.45, 0.78, 0.08], [0.12, 0.5, 0.86, 0.07], [-0.12, 0.5, 0.86, 0.07]];
    for (const [x, y, z, r] of eyeDef) { const e = new THREE.Mesh(eyeGeo, this.eyeMat); e.position.set(x * S, y * S, z * S); e.scale.setScalar(r * S); this.body.add(e); }
    // chelicerae
    const fang = new THREE.ConeGeometry(0.1 * S, 0.55 * S, 8);
    for (const sx of [-1, 1]) { const f = new THREE.Mesh(fang, metal); f.position.set(0.16 * sx * S, -0.18 * S, 1.15 * S); f.rotation.x = Math.PI * 0.62; this.body.add(f); }
  }

  buildLegs() {
    const S = this.S;
    this.legs = [];
    const segGeo = new THREE.CylinderGeometry(1, 0.7, 1, 8, 1); segGeo.translate(0, 0.5, 0);
    const jointGeo = new THREE.SphereGeometry(1, 10, 8);
    this.jointMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 1.4, 1.8), toneMapped: false });
    this.legMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPulse: { value: 0 }, uCol: { value: this.color.clone() } },
      vertexShader: `varying vec3 vN, vV; varying float vY; void main(){ vY = position.y; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform float uTime, uPulse; uniform vec3 uCol; varying vec3 vN, vV; varying float vY;
        void main(){ float fr = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
          float stripe = smoothstep(0.9, 1.0, fract(vY * 5.0 - uTime * 2.5));
          vec3 c = vec3(0.012, 0.016, 0.03) + uCol * fr * 1.1 + uCol * stripe * (0.35 + 1.2 * uPulse);
          gl_FragColor = vec4(c, 1.0); }`,
    });
    const order = [];
    for (const side of [1, -1]) LEG_DEF.forEach(([hipA, restA, rr, fem, tib], k) => {
      const ha = THREE.MathUtils.degToRad(hipA), ra = THREE.MathUtils.degToRad(restA + (k === 0 ? 0 : 0));
      const L = {
        side, k,
        hip: V(Math.sin(ha) * 0.85 * side * S, 0.05 * S, Math.cos(ha) * 0.95 * S),
        rest: V(Math.sin(ra) * rr * side * S, 0, Math.cos(ra) * rr * S),
        coxa: 0.45 * S, femur: fem * S, tibia: tib * S,
        foot: V(), from: V(), to: V(), stepping: false, stepT: 0, stepDur: 0.2,
        group: (k + (side > 0 ? 0 : 1)) % 2,
        segs: [], joints: [],
        P: [V(), V(), V(), V()],   // hip, coxa end, knee, foot (world)
      };
      for (let s = 0; s < 3; s++) {
        const m = new THREE.Mesh(segGeo, this.legMat);
        m.userData.r = [0.17, 0.14, 0.09][s] * S;
        this.root.add(m); L.segs.push(m);
      }
      for (let s = 0; s < 3; s++) {
        const j = new THREE.Mesh(jointGeo, this.jointMat);
        j.scale.setScalar([0.14, 0.12, 0.07][s] * S);
        this.root.add(j); L.joints.push(j);
      }
      this.legs.push(L); order.push(L);
    });
    // glowing leg lines
    const g = new THREE.BufferGeometry();
    this.linePos = new Float32Array(this.legs.length * 3 * 6);
    g.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.lineMat = new THREE.LineBasicMaterial({ color: this.color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    this.lines = new THREE.LineSegments(g, this.lineMat);
    this.lines.frustumCulled = false;
    this.root.add(this.lines);
  }

  // body frame helpers
  toWorld(local, out = V()) {
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    out.set(this.pos.x + local.x * c + local.z * s, this.bodyY + local.y, this.pos.z - local.x * s + local.z * c);
    return out;
  }
  restWorld(L, lead, ground, out = V()) {
    this.toWorld(L.rest, out);
    out.x += this.vel.x * lead; out.z += this.vel.z * lead;
    out.y = ground(out.x, out.z);
    return out;
  }

  place(x, z, heading, ground) {
    this.pos.set(x, 0, z); this.heading = heading; this.vel.set(0, 0, 0);
    for (const L of this.legs) { this.restWorld(L, 0, ground, L.foot); L.stepping = false; }
    this.bodyY = this.avgFootY() + 1.7 * this.S;
    this.placed = true;
  }
  avgFootY() { let s = 0; for (const L of this.legs) s += L.foot.y; return s / this.legs.length; }

  /**
   * target: {x, z} or null; ground(x, z) -> y; A: audio frame; opts.speed
   */
  step(dt, t, target, ground, A, opts = {}) {
    if (!this.placed) this.place(0, 0, 0, ground);
    const S = this.S;
    const maxSpeed = (opts.speed ?? 9) * S;
    // steering
    const want = V();
    if (target) {
      const dx = target.x - this.pos.x, dz = target.z - this.pos.z, d = Math.hypot(dx, dz);
      const arrive = 5 * S;
      if (d > 0.3) want.set(dx / d, 0, dz / d).multiplyScalar(maxSpeed * clamp(d / arrive, 0, 1));
    }
    const acc = 1 - Math.exp(-3.2 * dt);
    this.vel.lerp(want, acc);
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (sp > 0.4 * S) {
      const h = Math.atan2(this.vel.x, this.vel.z);
      this.heading = angLerp(this.heading, h, 1 - Math.exp(-2.6 * dt));
    } else if (opts.face != null) this.heading = angLerp(this.heading, opts.face, 1 - Math.exp(-1.5 * dt));
    this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;

    // gait
    const lead = 0.28, thresh = 0.9 * S, urgent = 2.0 * S;
    const stepping = [0, 0];
    for (const L of this.legs) if (L.stepping) stepping[L.group]++;
    const tmp = V();
    // most displaced legs first
    const cand = this.legs.filter(L => !L.stepping).map(L => { this.restWorld(L, lead, ground, tmp); return [L, tmp.distanceTo(L.foot), tmp.clone()]; }).sort((a, b) => b[1] - a[1]);
    for (const [L, d, tgt] of cand) {
      const other = stepping[1 - L.group] > 0;
      if ((d > thresh && !other) || d > urgent) {
        L.stepping = true; L.stepT = 0;
        L.stepDur = clamp(0.24 - sp / S * 0.012, 0.11, 0.24);
        L.from.copy(L.foot); L.to.copy(tgt);
        stepping[L.group]++;
      }
    }
    for (const L of this.legs) {
      if (!L.stepping) continue;
      L.stepT += dt / L.stepDur;
      // re-aim towards the moving rest spot while in the air
      this.restWorld(L, lead, ground, tmp); L.to.lerp(tmp, 0.25);
      const u = clamp(L.stepT, 0, 1), e = u * u * (3 - 2 * u);
      L.foot.lerpVectors(L.from, L.to, e);
      L.foot.y += Math.sin(u * Math.PI) * (0.9 * S + Math.abs(L.to.y - L.from.y) * 0.5);
      if (L.stepT >= 1) {
        L.stepping = false; L.foot.copy(L.to);
        if (this.onPlant) this.onPlant(L.foot, L, t);
      }
    }
    // body height / tilt follow the feet
    let front = 0, back = 0, left = 0, right = 0;
    for (const L of this.legs) { if (L.k < 2) front += L.foot.y; else back += L.foot.y; if (L.side > 0) left += L.foot.y; else right += L.foot.y; }
    const targetY = this.avgFootY() + (1.75 + 0.12 * Math.sin(t * 2.1)) * S + (A ? A.kick * 0.18 * S : 0);
    this.bodyY += (targetY - this.bodyY) * (1 - Math.exp(-8 * dt));
    this.pitch += (clamp((back - front) / 4 / (4 * S), -0.4, 0.4) - this.pitch) * (1 - Math.exp(-6 * dt));
    this.roll += (clamp((right - left) / 4 / (6 * S), -0.3, 0.3) - this.roll) * (1 - Math.exp(-6 * dt));
    this.gaitPhase += sp * dt;
  }

  ik(L) {
    const [H, C, K, F] = L.P;
    this.toWorld(L.hip, H);
    // coxa: short horizontal stub towards the foot
    const dir = V(F.copy(L.foot).x - H.x, 0, L.foot.z - H.z).normalize();
    C.copy(H).addScaledVector(dir, L.coxa); C.y += 0.12 * this.S;
    F.copy(L.foot);
    const d0 = V().subVectors(F, C);
    let d = d0.length();
    const a = L.femur, b = L.tibia;
    d = clamp(d, Math.abs(a - b) + 0.01, a + b - 0.01);
    const fwd = d0.normalize();
    const up = V(0, 1, 0).addScaledVector(fwd, -fwd.y).normalize();
    const x = (a * a - b * b + d * d) / (2 * d), h = Math.sqrt(Math.max(0, a * a - x * x));
    K.copy(C).addScaledVector(fwd, x).addScaledVector(up, h);
    // if the foot is out of reach, pull it in along the line
    if (V().subVectors(L.foot, C).length() > a + b) F.copy(C).addScaledVector(fwd, d);
  }

  updateMeshes(t, A, P = {}) {
    const S = this.S;
    this.body.position.set(this.pos.x, this.bodyY, this.pos.z);
    this.body.rotation.set(this.pitch, this.heading, this.roll, 'YXZ');
    const tmp = V(), Y = V(0, 1, 0), q = new THREE.Quaternion();
    let li = 0;
    for (const L of this.legs) {
      this.ik(L);
      const P4 = L.P;
      for (let s = 0; s < 3; s++) {
        const a = P4[s], b = P4[s + 1], m = L.segs[s];
        tmp.subVectors(b, a); const len = tmp.length();
        m.position.copy(a);
        q.setFromUnitVectors(Y, tmp.normalize());
        m.quaternion.copy(q);
        m.scale.set(m.userData.r, len, m.userData.r);
        L.joints[s].position.copy(b);
        this.linePos.set([a.x, a.y, a.z, b.x, b.y, b.z], li); li += 6;
      }
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    // world anchors used by others
    this.body.updateMatrixWorld();
    this.spinneret.set(0, 0.2 * S, -4.0 * S).applyMatrix4(this.body.matrixWorld);
    this.eyes.set(0, 0.35 * S, 1.1 * S).applyMatrix4(this.body.matrixWorld);
    // audio + alert driven materials
    const alert = P.alert || 0;
    this.abdMat.uniforms.uTime.value = t;
    this.abdMat.uniforms.uBass.value = A ? A.bands[1] * 0.9 + A.kick * 0.4 : 0;
    this.abdMat.uniforms.uKick.value = A ? A.kick : 0;
    this.abdMat.uniforms.uAlert.value = alert;
    const glow = 1 + (A ? A.beat * 0.8 : 0);
    this.eyeMat.color.setRGB(3.0 * glow + alert * 2, 0.08, 0.15);
    this.jointMat.color.setRGB(0.15 + alert * 2, 1.2 * glow * (1 - alert * 0.7), 1.7 * glow * (1 - alert * 0.7));
    this.lineMat.opacity = 0.55 + 0.45 * (A ? A.bands[3] : 0);
    this.legMat.uniforms.uTime.value = t; this.legMat.uniforms.uPulse.value = A ? A.kick : 0;
    this.legMat.uniforms.uCol.value.copy(this.color).lerp(this.accent, alert);
    this.lineMat.color.copy(this.color).lerp(this.accent, alert);
    this.cephEdges.material.opacity = 0.35 + 0.4 * (A ? A.hat : 0);
    this.root.visible = P.spider !== 0;
    const sv = P.spiderReveal ?? 1;
    this.root.traverse(o => { if (o.material && o.material.transparent !== undefined && o !== this.root) o.visible = sv > 0.02; });
  }
}
