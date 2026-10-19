// Environment: neon grid floor with beat shockwaves, a spectrogram mountain
// ring on the horizon, the sky dome with the Eye, and drifting data dust.
import * as THREE from 'three';
import { NB } from './audio.js';
import { rng } from './layout.js';

const FOG = `
  uniform vec3 uFogColor; uniform float uFogDensity;
  vec3 applyFog(vec3 c, float dist) { float f = 1.0 - exp(-pow(uFogDensity * dist, 1.6)); return mix(c, uFogColor, clamp(f, 0.0, 1.0)); }
`;

export class Environment {
  constructor(scene, { fogColor = new THREE.Color('#03040c'), fogDensity = 0.0042 } = {}) {
    this.scene = scene;
    this.fog = { uFogColor: { value: fogColor }, uFogDensity: { value: fogDensity } };
    this.rings = new Float32Array(8).fill(-100);
    this.ringIdx = 0;
    this.buildFloor();
    this.buildTerrain();
    this.buildSky();
    this.buildDust();
    this.buildEye();
  }

  buildFloor() {
    const g = new THREE.PlaneGeometry(1400, 1400, 1, 1); g.rotateX(-Math.PI / 2);
    this.floorMat = new THREE.ShaderMaterial({
      uniforms: {
        ...this.fog, uTime: { value: 0 }, uBass: { value: 0 }, uBeat: { value: 0 }, uRings: { value: this.rings },
        uOrigin: { value: new THREE.Vector2() }, uColA: { value: new THREE.Color('#00e5ff') }, uColB: { value: new THREE.Color('#ff2bd6') },
        uScan: { value: 0 }, uCity: { value: 0 }, uAlert: { value: 0 },
      },
      vertexShader: `
        varying vec3 vW; varying float vDist;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vec4 mv = viewMatrix * w; vDist = -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        ${FOG}
        uniform float uTime, uBass, uBeat, uRings[8], uScan, uCity, uAlert; uniform vec2 uOrigin; uniform vec3 uColA, uColB;
        varying vec3 vW; varying float vDist;
        float grid(vec2 p, float s, float w) { vec2 q = p / s; vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q); return 1.0 - min(min(g.x, g.y) / w, 1.0); }
        void main() {
          vec2 p = vW.xz; float d = length(p - uOrigin);
          float fine = grid(p, 2.1, 0.9) * 0.22;
          float major = grid(p, 10.5, 1.3);
          float fade = exp(-length(p) * 0.0045);
          vec3 col = vec3(0.004, 0.006, 0.016);
          col += uColA * (fine + major * (0.35 + 0.9 * uBass)) * fade;
          float ring = 0.0;
          for (int i = 0; i < 8; i++) { float age = uTime - uRings[i]; if (age > 0.0 && age < 3.5) { float r = age * 70.0; ring += smoothstep(1.4, 0.0, abs(d - r)) * (1.0 - age / 3.5) * (0.4 + 0.6 * major + fine); } }
          col += uColB * ring * 0.55;
          // sweeping radar line
          float a = atan(p.y, p.x); float sweep = fract((a / 6.28318) - uTime * 0.07);
          col += uColA * smoothstep(0.985, 1.0, sweep) * 0.35 * fade * (major + fine);
          col += vec3(1.0, 0.05, 0.15) * uAlert * major * fade;
          gl_FragColor = vec4(applyFog(col, vDist), 1.0);
        }`,
    });
    this.floor = new THREE.Mesh(g, this.floorMat);
    this.floor.renderOrder = -2;
    this.scene.add(this.floor);
  }

  // ring of mountains whose heights are the recent spectrum history: sound radiates outwards
  buildTerrain() {
    this.histRows = 160;
    this.hist = new Uint8Array(NB * this.histRows);
    this.histTex = new THREE.DataTexture(this.hist, NB, this.histRows, THREE.RedFormat, THREE.UnsignedByteType);
    this.histTex.magFilter = THREE.LinearFilter; this.histTex.minFilter = THREE.LinearFilter; this.histTex.needsUpdate = true;
    const g = new THREE.RingGeometry(190, 620, 192, 90); g.rotateX(-Math.PI / 2);
    this.terrainMat = new THREE.ShaderMaterial({
      uniforms: { ...this.fog, uHist: { value: this.histTex }, uTime: { value: 0 }, uAmp: { value: 70 }, uGlow: { value: 1 },
        uColA: { value: new THREE.Color('#ff2bd6') }, uColB: { value: new THREE.Color('#00e5ff') } },
      vertexShader: `
        uniform sampler2D uHist; uniform float uAmp; varying float vH; varying vec2 vUv2; varying float vDist;
        void main() {
          vec3 p = position; float r = length(p.xz); float a = atan(p.z, p.x);
          float v = clamp((r - 190.0) / 430.0, 0.0, 1.0);
          float u = abs(a) / 3.14159;                 // mirrored: bass on one side, highs opposite
          float h = texture2D(uHist, vec2(0.04 + u * 0.92, v)).r;
          float edge = smoothstep(0.0, 0.08, v) * (1.0 - smoothstep(0.75, 1.0, v));
          p.y = pow(h, 1.6) * uAmp * edge;
          vH = h * edge; vUv2 = vec2(a * 30.0, r * 0.11);
          vec4 mv = modelViewMatrix * vec4(p, 1.0); vDist = -mv.z; gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        ${FOG}
        uniform vec3 uColA, uColB; uniform float uGlow; varying float vH; varying vec2 vUv2; varying float vDist;
        void main() {
          vec2 g = abs(fract(vUv2) - 0.5) / fwidth(vUv2); float line = 1.0 - min(min(g.x, g.y), 1.0);
          vec3 c = mix(uColB * 0.6, uColA, smoothstep(0.15, 0.7, vH));
          c = mix(c, vec3(1.0, 0.75, 0.3), smoothstep(0.75, 1.0, vH));
          vec3 col = c * (line * (0.25 + 1.4 * vH) + vH * 0.12) * uGlow + vec3(0.01, 0.0, 0.02);
          gl_FragColor = vec4(applyFog(col, vDist * 0.55), 1.0);
        }`,
    });
    this.terrain = new THREE.Mesh(g, this.terrainMat);
    this.terrain.position.y = -0.5;
    this.scene.add(this.terrain);
  }

  buildSky() {
    const g = new THREE.SphereGeometry(1500, 48, 24);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { uTime: { value: 0 }, uPulse: { value: 0 }, uTint: { value: new THREE.Color('#ff1e3c') } },
      vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform float uTime, uPulse; uniform vec3 uTint; varying vec3 vP;
        float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,45.164))) * 43758.5453); }
        void main(){
          float y = vP.y;
          vec3 c = mix(vec3(0.012,0.004,0.03), vec3(0.0,0.0,0.004), smoothstep(-0.05, 0.6, y));
          c += uTint * 0.10 * exp(-abs(y) * 9.0) * (0.7 + 0.6 * uPulse);       // red haze on the horizon
          vec3 q = floor(vP * 420.0); float s = h(q); float tw = step(0.9975, s) * (0.4 + 0.6 * sin(uTime * 2.0 + s * 50.0));
          c += vec3(0.7,0.85,1.0) * tw * smoothstep(0.02, 0.3, y);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.skyMat = mat;
    this.sky = new THREE.Mesh(g, mat);
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);
  }

  buildDust() {
    const R = rng(4242), N = 5000;
    const pos = new Float32Array(N * 3), seed = new Float32Array(N);
    for (let i = 0; i < N; i++) { pos[i * 3] = (R() - 0.5) * 420; pos[i * 3 + 1] = R() * 140; pos[i * 3 + 2] = (R() - 0.5) * 420; seed[i] = R(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.dustMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uAir: { value: 0 }, uScale: { value: 1 } },
      vertexShader: `
        uniform float uTime, uAir, uScale; attribute float aSeed; varying float vA;
        void main(){
          vec3 p = position;
          p.y = mod(p.y + uTime * (0.6 + aSeed * 1.6), 140.0);
          p.x += sin(uTime * 0.2 + aSeed * 40.0) * 3.0; p.z += cos(uTime * 0.17 + aSeed * 30.0) * 3.0;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = min(6.0, (0.5 + 1.1 * aSeed) * uScale * (36.0 / -mv.z) * (1.0 + uAir));
          vA = (0.05 + 0.3 * uAir) * (0.3 + 0.7 * aSeed) * smoothstep(400.0, 40.0, -mv.z) * smoothstep(4.0, 20.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying float vA; void main(){ float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(vec3(0.55,0.85,1.0) * vA * smoothstep(0.5, 0.0, d), 1.0); }`,
    });
    this.dust = new THREE.Points(g, this.dustMat);
    this.dust.frustumCulled = false;
    this.scene.add(this.dust);
  }

  // the Eye: a giant segmented halo in the sky, red core — it is always watching
  buildEye() {
    const grp = new THREE.Group();
    const mk = (r, segs, gap, w, color, opacity) => {
      const pts = [];
      for (let i = 0; i < segs; i++) {
        const a0 = i / segs * Math.PI * 2, a1 = (i + 1 - gap) / segs * Math.PI * 2;
        for (let k = 0; k < 6; k++) {
          const a = a0 + (a1 - a0) * k / 6, b = a0 + (a1 - a0) * (k + 1) / 6;
          pts.push(Math.cos(a) * r, Math.sin(a) * r, 0, Math.cos(b) * r, Math.sin(b) * r, 0);
        }
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
      const l = new THREE.LineSegments(g, m); grp.add(l); return l;
    };
    this.eyeRings = [mk(170, 64, 0.35, 1, '#ff1e3c', 0.55), mk(150, 12, 0.18, 1, '#ff2bd6', 0.5), mk(205, 120, 0.6, 1, '#00e5ff', 0.35), mk(120, 3, 0.08, 1, '#ff1e3c', 0.8)];
    const core = new THREE.Mesh(new THREE.CircleGeometry(38, 64), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uPulse: { value: 0 }, uOpen: { value: 1 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform float uPulse, uOpen; varying vec2 vUv; void main(){ vec2 p = vUv - 0.5; float d = length(p);
        float iris = smoothstep(0.5, 0.0, d) * 0.6; float pupil = smoothstep(0.16 * uOpen, 0.05 * uOpen, abs(p.x) + 0.02) * smoothstep(0.5, 0.2, d);
        vec3 c = vec3(1.0, 0.06, 0.1) * (iris * (0.6 + uPulse)) + vec3(1.0, 0.7, 0.4) * pupil * (0.5 + uPulse);
        gl_FragColor = vec4(c * uOpen, 1.0); }`,
    }));
    grp.add(core);
    this.eyeCore = core;
    grp.position.set(0, 210, -760);
    this.eye = grp;
    this.scene.add(grp);
  }

  shockwave(t) { this.rings[this.ringIdx++ % 8] = t; }
  resetRings() { this.rings.fill(-100); this.ringIdx = 0; }

  update(t, A, audio, P) {
    const F = A;
    this.floorMat.uniforms.uTime.value = t;
    this.floorMat.uniforms.uBass.value = F.bands[1] * 0.8 + F.kick * 0.4;
    this.floorMat.uniforms.uAlert.value = P.alert || 0;
    // spectrum history -> terrain (deterministic: rebuilt from the baked track each frame)
    for (let k = 0; k < this.histRows; k++) audio.specAt(t - k / 40, this.hist, k * NB, k);
    this.histTex.needsUpdate = true;
    this.terrainMat.uniforms.uAmp.value = 30 + 70 * (P.terrain ?? 1) * (0.5 + F.energy);
    this.terrainMat.uniforms.uGlow.value = 0.6 + F.bands[1] * 0.8;
    this.skyMat.uniforms.uTime.value = t; this.skyMat.uniforms.uPulse.value = F.kick;
    this.dustMat.uniforms.uTime.value = t; this.dustMat.uniforms.uAir.value = F.bands[6] * 0.8 + F.hat * 0.5;
    const rot = [0.05, -0.12, 0.02, 0.3];
    this.eyeRings.forEach((r, i) => { r.rotation.z = t * rot[i] + (i === 3 ? F.beat * 0.2 : 0); r.material.opacity = (0.25 + 0.5 * F.bands[i % 7]) * (P.eye ?? 1); });
    this.eyeCore.material.uniforms.uPulse.value = F.kick * 0.8 + F.beat * 0.3;
    this.eyeCore.material.uniforms.uOpen.value = P.eye ?? 1;
    this.eye.scale.setScalar(1 + F.beat * 0.02);
  }
}
