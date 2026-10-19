"""Bake a soundtrack into per-frame features for deterministic, audio-reactive rendering.

    python analyze_audio.py <track.wav> [--fps 60] [--out build]

Writes build/audio.bin (uint8 records, one per video frame) and build/audio.json
(layout, tempo, beats, downbeats, onsets, sections). The visualiser reads the
same structure in render mode that its WebAudio analyser produces live.

Record layout (STRIDE bytes per frame):
    spec[64]   log-frequency spectrum 30 Hz .. 16 kHz, 0..255
    bands[7]   sub, bass, lowmid, mid, highmid, presence, air
    rms, flux, kick, snare, hat
    wave[64]   oscilloscope samples, 128 = 0
"""
import argparse, json, os, sys
import numpy as np
from scipy.io import wavfile
from scipy.ndimage import uniform_filter1d, maximum_filter1d
from scipy.signal import find_peaks

NB = 64
BANDS = [(20, 60), (60, 250), (250, 500), (500, 2000), (2000, 4000), (4000, 8000), (8000, 16000)]
NWAVE = 64
STRIDE = NB + len(BANDS) + 5 + NWAVE


def norm01(x, lo=5, hi=99.5):
    a, b = np.percentile(x, lo), np.percentile(x, hi)
    return np.clip((x - a) / (b - a + 1e-9), 0, 1)


def release(x, k):
    """instant attack, exponential release along axis 0"""
    y = np.empty_like(x)
    y[0] = x[0]
    for i in range(1, len(x)):
        y[i] = np.maximum(x[i], y[i - 1] * k)
    return y


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('wav')
    ap.add_argument('--fps', type=int, default=60)
    ap.add_argument('--title', default=None)
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build'))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    sr, x = wavfile.read(a.wav)
    if x.dtype.kind == 'i':
        x = x.astype(np.float32) / np.iinfo(x.dtype).max
    x = x.astype(np.float32)
    mono = x.mean(axis=1) if x.ndim == 2 else x
    dur = len(mono) / sr
    fps = a.fps
    F = int(round(dur * fps))
    hop = sr / fps
    print(f'{a.wav}: {sr} Hz, {dur:.2f} s -> {F} frames @ {fps} fps')

    # ---- STFT (centred windows), chunked to keep memory flat ----
    nfft = 4096
    win = np.hanning(nfft).astype(np.float32)
    pad = np.pad(mono, (nfft // 2, nfft // 2 + int(hop) + 2))
    freqs = np.fft.rfftfreq(nfft, 1 / sr)
    edges = np.geomspace(30, 16000, NB + 1)
    bin_of = np.digitize(freqs, edges) - 1                     # band index per FFT bin (-1 / NB = outside)
    band_bins = [np.where(bin_of == b)[0] for b in range(NB)]
    # very low bands may contain no FFT bin: borrow the nearest one
    for b in range(NB):
        if len(band_bins[b]) == 0:
            c = np.sqrt(edges[b] * edges[b + 1])
            band_bins[b] = np.array([np.argmin(np.abs(freqs - c))])
    wide = [np.where((freqs >= lo) & (freqs < hi))[0] for lo, hi in BANDS]

    spec_db = np.zeros((F, NB), np.float32)
    wide_db = np.zeros((F, len(BANDS)), np.float32)
    kick_e = np.zeros(F, np.float32)
    starts = (np.arange(F) * hop).astype(np.int64)
    CH = 1024
    for c0 in range(0, F, CH):
        idx = starts[c0:c0 + CH]
        frames = np.stack([pad[s:s + nfft] for s in idx]) * win
        p = np.abs(np.fft.rfft(frames, axis=1)) ** 2
        for b in range(NB):
            spec_db[c0:c0 + CH, b] = 10 * np.log10(p[:, band_bins[b]].mean(axis=1) + 1e-12)
        for j, w in enumerate(wide):
            wide_db[c0:c0 + CH, j] = 10 * np.log10(p[:, w].sum(axis=1) + 1e-12)
        sys.stdout.write(f'\r  stft {min(F, c0 + CH)}/{F}')
    print()

    # ---- normalisation: per band (lively) blended with global (keeps dynamics) ----
    per = np.stack([norm01(spec_db[:, b], 3, 99.7) for b in range(NB)], 1)
    glob = norm01(spec_db, 10, 99.8)
    spec = np.clip(0.55 * per + 0.45 * glob, 0, 1) ** 1.25
    spec_vis = release(spec, 0.86)
    bands = np.stack([norm01(wide_db[:, j], 5, 99.5) for j in range(len(BANDS))], 1)
    bands_vis = release(bands, 0.9)

    # rms per frame window
    rms = np.array([np.sqrt(np.mean(mono[int(s):int(s + hop)] ** 2) + 1e-12) for s in starts])
    rms_db = 20 * np.log10(rms + 1e-9)
    rms_n = norm01(rms_db, 5, 99.7)

    # ---- onsets: spectral flux on the log spectrum ----
    d = np.diff(spec_db, axis=0, prepend=spec_db[:1])
    pos = np.maximum(d, 0)
    flux = pos.mean(axis=1)
    lowb = slice(0, int(NB * 0.22))                       # ~30..150 Hz
    midb = slice(int(NB * 0.3), int(NB * 0.75))
    hib = slice(int(NB * 0.82), NB)
    kick = pos[:, lowb].mean(axis=1)
    snare = pos[:, midb].mean(axis=1)
    hat = pos[:, hib].mean(axis=1)

    def onset_norm(v):
        v = v - uniform_filter1d(v, size=int(fps * 0.5))   # adaptive threshold
        v = np.maximum(v, 0)
        return np.clip(v / (np.percentile(v, 99.5) + 1e-9), 0, 1)

    flux_n, kick_n, snare_n, hat_n = map(onset_norm, (flux, kick, snare, hat))
    on_env = flux_n

    # ---- tempo: autocorrelation of the onset envelope ----
    env = on_env - on_env.mean()
    ac = np.correlate(env[:fps * 120], env[:fps * 120], 'full')[fps * 120 - 1:]
    lags = np.arange(len(ac))
    bpm_of = 60 * fps / np.maximum(lags, 1)
    ok = (bpm_of >= 70) & (bpm_of <= 180)
    weight = np.exp(-0.5 * (np.log2(bpm_of / 120) / 0.9) ** 2)   # mild prior around 120
    lag = int(lags[ok][np.argmax((ac * weight)[ok])])
    # refine with parabolic interpolation
    if 1 <= lag < len(ac) - 1:
        y0, y1, y2 = ac[lag - 1], ac[lag], ac[lag + 1]
        off = 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2 + 1e-12)
    else:
        off = 0
    period = lag + off
    bpm = 60 * fps / period
    print(f'  tempo ~ {bpm:.2f} BPM (period {period:.2f} frames)')

    # ---- beat tracking (dynamic programming, Ellis 2007) ----
    alpha = 400.0
    score = on_env.astype(np.float64).copy()
    back = np.full(F, -1)
    lo, hi = int(round(period * 0.5)), int(round(period * 2))
    prange = np.arange(-hi, -lo + 1)
    penalty = -alpha * np.log(-prange / period) ** 2
    for t in range(hi, F):
        cand = score[t + prange] + penalty
        k = int(np.argmax(cand))
        score[t] = on_env[t] + cand[k]
        back[t] = t + prange[k]
    t = int(np.argmax(score[-int(period * 2):])) + F - int(period * 2)
    beats = []
    while t >= 0:
        beats.append(t)
        t = back[t]
        if t < 0:
            break
    beats = np.array(sorted(beats))
    # extend the grid backwards into the intro if the DP stopped early
    while beats[0] - period > 0:
        beats = np.insert(beats, 0, int(round(beats[0] - period)))
    # downbeat phase: which beat of 4 carries the most low end
    phase = int(np.argmax([kick_n[beats[p::4]].mean() + 0.5 * rms_n[beats[p::4]].mean() for p in range(4)]))
    downbeats = beats[phase::4]

    # ---- sections: novelty on a self-similarity matrix of 1 s feature frames ----
    sec = int(dur)
    feat = np.stack([np.r_[spec[i * fps:(i + 1) * fps].mean(0), 2 * rms_n[i * fps:(i + 1) * fps].mean(),
                           2 * bands[i * fps:(i + 1) * fps].mean(0)] for i in range(sec)])
    feat = (feat - feat.mean(0)) / (feat.std(0) + 1e-9)
    feat /= np.linalg.norm(feat, axis=1, keepdims=True) + 1e-9
    S = feat @ feat.T
    K = 12
    g = np.outer(np.r_[-np.ones(K), np.ones(K)], np.r_[-np.ones(K), np.ones(K)])
    gw = np.exp(-0.5 * (np.linspace(-2, 2, 2 * K)) ** 2)
    g = g * np.outer(gw, gw)
    Sp = np.pad(S, K, mode='edge')
    nov = np.array([np.sum(Sp[i:i + 2 * K, i:i + 2 * K] * g) for i in range(sec)])
    nov = np.maximum(nov, 0)
    nov /= nov.max() + 1e-9
    pk, _ = find_peaks(nov, distance=16, prominence=0.08)
    bounds = [0] + [int(p) for p in pk if 8 < p < sec - 8] + [sec]
    # snap boundaries to the nearest downbeat
    db_s = downbeats / fps
    snapped = sorted(set([0.0] + [float(db_s[np.argmin(np.abs(db_s - b))]) for b in bounds[1:-1]] + [dur]))
    energy_s = uniform_filter1d(rms_n, size=fps * 2)[::fps][:sec]
    sections = []
    for s0, s1 in zip(snapped[:-1], snapped[1:]):
        i0, i1 = int(s0 * fps), max(int(s0 * fps) + 1, int(s1 * fps))
        sections.append({'start': round(s0, 3), 'end': round(s1, 3), 'energy': round(float(rms_n[i0:i1].mean()), 3),
                         'bass': round(float(bands[i0:i1, 1].mean()), 3), 'air': round(float(bands[i0:i1, 6].mean()), 3)})
    print(f'  {len(beats)} beats, {len(downbeats)} downbeats, {len(sections)} sections')
    for s in sections:
        print(f"    {s['start']:7.2f} - {s['end']:7.2f}  energy {s['energy']:.2f}  bass {s['bass']:.2f}  air {s['air']:.2f}")

    onsets, props = find_peaks(flux_n, height=0.35, distance=int(fps * 0.09))

    # ---- oscilloscope samples ----
    wave = np.zeros((F, NWAVE), np.float32)
    pk_abs = np.percentile(np.abs(mono), 99.9) + 1e-9
    for i, s in enumerate(starts):
        seg = mono[int(s):int(s) + int(hop)]
        if len(seg) < NWAVE:
            continue
        wave[i] = seg[np.linspace(0, len(seg) - 1, NWAVE).astype(int)] / pk_abs
    wave = np.clip(wave, -1, 1)

    # ---- pack ----
    rec = np.zeros((F, STRIDE), np.uint8)
    q = lambda v: np.clip(np.round(v * 255), 0, 255).astype(np.uint8)
    rec[:, :NB] = q(spec_vis)
    rec[:, NB:NB + 7] = q(bands_vis)
    o = NB + 7
    rec[:, o] = q(rms_n); rec[:, o + 1] = q(flux_n); rec[:, o + 2] = q(release(kick_n, 0.8))
    rec[:, o + 3] = q(release(snare_n, 0.8)); rec[:, o + 4] = q(release(hat_n, 0.7))
    rec[:, o + 5:] = np.clip(np.round(wave * 127 + 128), 0, 255).astype(np.uint8)
    rec.tofile(os.path.join(a.out, 'audio.bin'))

    meta = {
        'source': os.path.basename(a.wav), 'title': a.title or os.path.splitext(os.path.basename(a.wav))[0], 'sampleRate': sr, 'duration': dur, 'fps': fps, 'frames': F, 'stride': STRIDE,
        'layout': {'spec': [0, NB], 'bands': [NB, 7], 'rms': o, 'flux': o + 1, 'kick': o + 2, 'snare': o + 3, 'hat': o + 4, 'wave': [o + 5, NWAVE]},
        'bandNames': ['sub', 'bass', 'lowmid', 'mid', 'highmid', 'presence', 'air'],
        'bpm': round(float(bpm), 3), 'beats': [round(b / fps, 4) for b in beats.tolist()],
        'downbeats': [round(b / fps, 4) for b in downbeats.tolist()],
        'onsets': [[round(int(t) / fps, 4), round(float(h), 3)] for t, h in zip(onsets, props['peak_heights'])],
        'sections': sections, 'novelty': [round(float(v), 3) for v in nov], 'energy': [round(float(v), 3) for v in energy_s],
    }
    with open(os.path.join(a.out, 'audio.json'), 'w') as f:
        json.dump(meta, f)
    print(f'  -> {a.out}/audio.bin ({rec.nbytes / 1e6:.1f} MB), audio.json')


if __name__ == '__main__':
    main()
