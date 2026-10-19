// Post: bloom -> tone map -> "cyber" pass (HUD composite, chromatic aberration,
// block glitches, scanlines, grain, vignette, flashes). The HUD is composited
// inside the pass so glitches tear through the interface too.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const CyberShader = {
  uniforms: {
    tDiffuse: { value: null }, tHud: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1920, 1080) },
    uAberr: { value: 0.002 }, uGlitch: { value: 0 }, uScan: { value: 0.18 }, uGrain: { value: 0.06 }, uVignette: { value: 0.9 },
    uFlash: { value: 0 }, uFlashColor: { value: new THREE.Color(1, 1, 1) }, uFade: { value: 1 }, uTint: { value: new THREE.Color(1, 1, 1) },
    uHudAlpha: { value: 1 }, uSeed: { value: 0 }, uInvert: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse, tHud; uniform float uTime, uAberr, uGlitch, uScan, uGrain, uVignette, uFlash, uFade, uHudAlpha, uSeed, uInvert;
    uniform vec2 uRes; uniform vec3 uFlashColor, uTint; varying vec2 vUv;
    float h1(float x){ return fract(sin(x * 91.3458) * 47453.5453); }
    float h2(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    vec3 sceneAt(vec2 uv, vec2 off){
      vec3 c;
      c.r = texture2D(tDiffuse, uv + off).r;
      c.g = texture2D(tDiffuse, uv).g;
      c.b = texture2D(tDiffuse, uv - off).b;
      vec4 hr = texture2D(tHud, uv + off * 0.3); vec4 hg = texture2D(tHud, uv); vec4 hb = texture2D(tHud, uv - off * 0.3);
      vec3 hud = vec3(hr.r * hr.a, hg.g * hg.a, hb.b * hb.a);
      float ha = max(max(hr.a, hg.a), hb.a) * uHudAlpha;
      return c * (1.0 - ha * 0.8) + hud * uHudAlpha;
    }
    void main(){
      vec2 uv = vUv;
      float slot = floor(uTime * 24.0) + uSeed;
      // block displacement glitch
      if (uGlitch > 0.0) {
        float band = floor(uv.y * mix(8.0, 40.0, h1(slot)));
        float r = h2(vec2(band, slot));
        if (r < uGlitch * 0.55) uv.x += (h2(vec2(band * 1.7, slot)) - 0.5) * 0.18 * uGlitch;
        float blk = h2(floor(uv * vec2(16.0, 9.0)) + slot);
        if (uGlitch > 0.45 && blk < (uGlitch - 0.45) * 0.08) uv = fract(uv + vec2(h1(slot + 3.0), h1(slot + 7.0)) * 0.1);
      }
      vec2 d = uv - 0.5;
      vec2 off = d * (uAberr + uGlitch * 0.012) * (1.0 + dot(d, d) * 2.0);
      vec3 c = sceneAt(uv, off);
      // scanlines + rolling bar
      float sl = 0.5 + 0.5 * sin(uv.y * uRes.y * 3.14159);
      c *= 1.0 - uScan * (1.0 - sl) * 0.6;
      c *= 1.0 + 0.05 * smoothstep(0.02, 0.0, abs(fract(uv.y - uTime * 0.08) - 0.5));
      // grain
      c += (h2(uv * uRes + fract(uTime) * 100.0) - 0.5) * uGrain;
      // vignette
      c *= mix(1.0, smoothstep(1.05, 0.25, length(d * vec2(1.0, 0.85))), uVignette);
      c *= uTint;
      c = mix(c, uFlashColor, uFlash);
      c = mix(c, 1.0 - c, uInvert);
      gl_FragColor = vec4(c * uFade, 1.0);
    }`,
};

export class Post {
  constructor(renderer, scene, camera, w, h) {
    this.r = renderer;
    this.composer = new EffectComposer(renderer);
    this.composer.setSize(w, h);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.8, 0.5, 0.3);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.cyber = new ShaderPass(CyberShader);
    this.cyber.uniforms.uRes.value.set(w, h);
    this.composer.addPass(this.cyber);
  }
  setHud(canvas) {
    this.hudTex = new THREE.CanvasTexture(canvas);
    this.hudTex.colorSpace = THREE.NoColorSpace;   // composited after OutputPass: values are already display-referred
    this.hudTex.minFilter = THREE.LinearFilter; this.hudTex.generateMipmaps = false;
    this.cyber.uniforms.tHud.value = this.hudTex;
  }
  render(P) {
    const U = this.cyber.uniforms;
    for (const k of ['uTime', 'uAberr', 'uGlitch', 'uScan', 'uGrain', 'uVignette', 'uFlash', 'uFade', 'uHudAlpha', 'uSeed', 'uInvert']) if (P[k] !== undefined) U[k].value = P[k];
    if (P.flashColor) U.uFlashColor.value.set(P.flashColor);
    if (P.tint) U.uTint.value.setRGB(...P.tint);
    this.bloom.strength = P.bloom ?? 1.1;
    this.bloom.radius = P.bloomRadius ?? 0.55;
    this.bloom.threshold = P.bloomThreshold ?? 0.3;
    if (this.hudTex) this.hudTex.needsUpdate = true;
    this.composer.render();
  }
}
