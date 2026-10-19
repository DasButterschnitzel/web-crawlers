// Audio features with one interface for two sources:
//   BakedAudio  - per-frame records from video3d/analyze_audio.py (deterministic renders)
//   LiveAudio   - WebAudio AnalyserNode on an <audio> element (live crawls / replays)
// Both fill the same `frame` object every update.

export const NB = 64;
const EDGES = (() => { const e = []; for (let i = 0; i <= NB; i++) e.push(30 * Math.pow(16000 / 30, i / NB)); return e; })();

function makeFrame() {
  return {
    spec: new Float32Array(NB), bands: new Float32Array(7), wave: new Float32Array(64),
    rms: 0, flux: 0, kick: 0, snare: 0, hat: 0, energy: 0,
    beat: 0, beatIndex: -1, sinceBeat: 9, beatPhase: 0, downbeatIndex: -1, sinceDownbeat: 9, bar: 0, section: 0, sinceOnset: 9,
  };
}

const lastLE = (arr, t) => {           // index of last element <= t (binary search), -1 if none
  let lo = 0, hi = arr.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
};

export class BakedAudio {
  static async load(base) {
    const meta = await (await fetch(base + 'audio.json')).json();
    const bin = new Uint8Array(await (await fetch(base + 'audio.bin')).arrayBuffer());
    return new BakedAudio(meta, bin);
  }
  constructor(meta, bin) {
    this.meta = meta; this.bin = bin; this.fps = meta.fps; this.frames = meta.frames; this.stride = meta.stride;
    this.bpm = meta.bpm; this.beats = meta.beats; this.downbeats = meta.downbeats;
    this.onsetT = meta.onsets.map(o => o[0]);
    this.sections = meta.sections;
    this.sectionStarts = meta.sections.map(s => s.start);
    this.frame = makeFrame();
    this.duration = meta.duration;
  }
  rec(f) { f = Math.max(0, Math.min(this.frames - 1, f | 0)); return f * this.stride; }
  /** spectrum row of an arbitrary time into `out` (for history textures) */
  specAt(t, out, offset = 0) {
    const o = this.rec(Math.round(t * this.fps));
    for (let i = 0; i < NB; i++) out[offset + i] = this.bin[o + i];
  }
  update(t) {
    const F = this.frame, L = this.meta.layout, b = this.bin, o = this.rec(Math.round(t * this.fps));
    for (let i = 0; i < NB; i++) F.spec[i] = b[o + i] / 255;
    for (let i = 0; i < 7; i++) F.bands[i] = b[o + L.bands[0] + i] / 255;
    F.rms = b[o + L.rms] / 255; F.flux = b[o + L.flux] / 255; F.kick = b[o + L.kick] / 255;
    F.snare = b[o + L.snare] / 255; F.hat = b[o + L.hat] / 255;
    for (let i = 0; i < 64; i++) F.wave[i] = (b[o + L.wave[0] + i] - 128) / 127;
    const sec = Math.max(0, Math.min(this.meta.energy.length - 1, t | 0));
    F.energy = this.meta.energy[sec];
    const bi = lastLE(this.beats, t);
    F.beatIndex = bi; F.sinceBeat = bi >= 0 ? t - this.beats[bi] : 9;
    const period = 60 / this.bpm;
    F.beatPhase = Math.min(1, F.sinceBeat / period);
    F.beat = Math.exp(-F.sinceBeat * 7);
    const di = lastLE(this.downbeats, t);
    F.downbeatIndex = di; F.sinceDownbeat = di >= 0 ? t - this.downbeats[di] : 9; F.bar = di;
    F.section = Math.max(0, lastLE(this.sectionStarts, t));
    const oi = lastLE(this.onsetT, t);
    F.sinceOnset = oi >= 0 ? t - this.onsetT[oi] : 9;
    return F;
  }
}

export class LiveAudio {
  constructor(el) {
    this.el = el;
    this.frame = makeFrame();
    this.bpm = 100; this.beats = []; this.downbeats = [];
    this.sections = [{ start: 0, end: 1e9, energy: .5 }];
    this.hist = [];       // spectrum history for the terrain (most recent first)
    this.min = new Float32Array(NB).fill(-90); this.max = new Float32Array(NB).fill(-30);
    this.prev = new Float32Array(NB);
    this.lastBeat = -9; this.beatCount = 0; this.intervals = [];
    this.env = 0; this.kickAvg = 0;
  }
  start() {
    if (this.ctx) return this.ctx.resume();
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaElementSource(this.el);
    this.an = this.ctx.createAnalyser();
    this.an.fftSize = 4096; this.an.smoothingTimeConstant = 0.55;
    src.connect(this.an); this.an.connect(this.ctx.destination);
    this.fbuf = new Float32Array(this.an.frequencyBinCount);
    this.tbuf = new Float32Array(this.an.fftSize);
    const sr = this.ctx.sampleRate, hz = i => i * sr / this.an.fftSize;
    this.map = [];
    for (let b = 0; b < NB; b++) {
      const lo = EDGES[b], hi = EDGES[b + 1], bins = [];
      for (let i = 1; i < this.fbuf.length; i++) { const f = hz(i); if (f >= lo && f < hi) bins.push(i); }
      if (!bins.length) bins.push(Math.max(1, Math.round(Math.sqrt(lo * hi) * this.an.fftSize / sr)));
      this.map.push(bins);
    }
    const BR = [[20, 60], [60, 250], [250, 500], [500, 2000], [2000, 4000], [4000, 8000], [8000, 16000]];
    this.bmap = BR.map(([lo, hi]) => { const r = []; for (let i = 1; i < this.fbuf.length; i++) { const f = hz(i); if (f >= lo && f < hi) r.push(i); } return r; });
    return this.ctx.resume();
  }
  specAt(_t, out, offset = 0, k = 0) {
    const row = this.hist[k] || this.hist[this.hist.length - 1];
    for (let i = 0; i < NB; i++) out[offset + i] = row ? row[i] * 255 : 0;
  }
  update(t) {
    const F = this.frame;
    if (!this.an) return F;
    this.an.getFloatFrequencyData(this.fbuf);
    this.an.getFloatTimeDomainData(this.tbuf);
    let flux = 0, kick = 0, snare = 0, hat = 0;
    for (let b = 0; b < NB; b++) {
      let p = 0; for (const i of this.map[b]) p += Math.pow(10, this.fbuf[i] / 10);
      const db = 10 * Math.log10(p / this.map[b].length + 1e-12);
      this.min[b] = Math.min(this.min[b] + 0.02, db); this.max[b] = Math.max(this.max[b] - 0.01, db);
      const v = Math.max(0, Math.min(1, (db - this.min[b]) / (this.max[b] - this.min[b] + 1e-6))) ** 1.25;
      const d = Math.max(0, db - this.prev[b]); this.prev[b] = db;
      flux += d; if (b < 14) kick += d; else if (b < 48) snare += d; else hat += d;
      F.spec[b] = Math.max(v, F.spec[b] * 0.86);
    }
    this.hist.unshift(Float32Array.from(F.spec)); if (this.hist.length > 160) this.hist.pop();
    for (let j = 0; j < 7; j++) {
      let p = 0; for (const i of this.bmap[j]) p += Math.pow(10, this.fbuf[i] / 10);
      const v = Math.max(0, Math.min(1, (10 * Math.log10(p + 1e-12) + 70) / 60));
      F.bands[j] = Math.max(v, F.bands[j] * 0.9);
    }
    let s = 0; for (let i = 0; i < this.tbuf.length; i++) s += this.tbuf[i] * this.tbuf[i];
    F.rms = Math.min(1, Math.sqrt(s / this.tbuf.length) * 4);
    for (let i = 0; i < 64; i++) F.wave[i] = this.tbuf[Math.floor(i * this.tbuf.length / 64)] * 2;
    const n = v => Math.max(0, Math.min(1, v));
    F.flux = n(flux / NB / 3); F.snare = Math.max(n(snare / 34 / 3), F.snare * 0.8); F.hat = Math.max(n(hat / 16 / 3), F.hat * 0.7);
    const k = kick / 14;
    this.kickAvg = this.kickAvg * 0.97 + k * 0.03;
    F.kick = Math.max(n(k / (this.kickAvg * 3 + 0.5)), F.kick * 0.8);
    this.env = this.env * 0.995 + F.rms * 0.005; F.energy = Math.min(1, this.env * 2);
    // naive beat tracker: strong low-end onset, at least 70% of the running interval apart
    const iv = this.intervals.length ? this.intervals.slice().sort((a, b) => a - b)[this.intervals.length >> 1] : 0.6;
    if (F.kick > 0.55 && t - this.lastBeat > iv * 0.7) {
      if (this.lastBeat > 0 && t - this.lastBeat < 1.5) { this.intervals.push(t - this.lastBeat); if (this.intervals.length > 16) this.intervals.shift(); }
      this.lastBeat = t; this.beatCount++;
      if (this.beatCount % 4 === 1) this.lastDown = t;
      this.bpm = 60 / iv;
    }
    F.sinceBeat = t - this.lastBeat; F.beat = Math.exp(-F.sinceBeat * 7); F.beatIndex = this.beatCount;
    F.beatPhase = Math.min(1, F.sinceBeat / iv);
    F.sinceDownbeat = t - (this.lastDown ?? -9); F.downbeatIndex = this.beatCount >> 2; F.bar = F.downbeatIndex;
    F.sinceOnset = F.flux > 0.5 ? 0 : F.sinceOnset + 1 / 60;
    return F;
  }
}
