/**
 * Small DSP toolbox: FFT, YIN pitch detection, spectral-flux onset detection.
 * Plain math on typed arrays, no dependencies, so it can run anywhere.
 */

export type FloatArr = Float32Array | Float64Array;

interface Twiddles {
  cos: Float64Array;
  sin: Float64Array;
  rev: Uint32Array;
}

const twiddleCache = new Map<number, Twiddles>();

/** Twiddle factors and the bit-reversal permutation, cached per FFT size. */
function tablesFor(n: number): Twiddles {
  let t = twiddleCache.get(n);
  if (t) return t;

  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    const a = (-2 * Math.PI * i) / n;
    cos[i] = Math.cos(a);
    sin[i] = Math.sin(a);
  }

  const rev = new Uint32Array(n);
  let bits = 0;
  while (1 << bits < n) bits++;
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rev[i] = r;
  }

  t = { cos, sin, rev };
  twiddleCache.set(n, t);
  return t;
}

/** In-place iterative radix-2 FFT. Length must be a power of two. */
export function fft(re: FloatArr, im: FloatArr): void {
  const n = re.length;
  if (n <= 1) return;
  const { cos, sin, rev } = tablesFor(n);

  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const stride = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0, tw = 0; k < half; k++, tw += stride) {
        const wRe = cos[tw];
        const wIm = sin[tw];
        const a = i + k;
        const b = a + half;
        const xRe = re[b];
        const xIm = im[b];
        const vRe = xRe * wRe - xIm * wIm;
        const vIm = xRe * wIm + xIm * wRe;
        re[b] = re[a] - vRe;
        im[b] = im[a] - vIm;
        re[a] += vRe;
        im[a] += vIm;
      }
    }
  }
}

/** Inverse FFT via the conjugate trick. */
export function ifft(re: FloatArr, im: FloatArr): void {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  const inv = 1 / n;
  for (let i = 0; i < n; i++) {
    re[i] *= inv;
    im[i] *= -inv;
  }
}

export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

export function rms(buf: Float32Array, start: number, len: number): number {
  let sum = 0;
  const end = Math.min(start + len, buf.length);
  for (let i = Math.max(0, start); i < end; i++) sum += buf[i] * buf[i];
  const count = Math.max(1, end - Math.max(0, start));
  return Math.sqrt(sum / count);
}

export function dbFromAmp(amp: number): number {
  return 20 * Math.log10(Math.max(amp, 1e-10));
}

export function ampFromDb(db: number): number {
  return Math.pow(10, db / 20);
}

export interface PitchResult {
  /** Hz, or 0 when unvoiced. */
  freq: number;
  /** 0..1 confidence. */
  clarity: number;
}

/** YIN fundamental-frequency estimator (de Cheveigné and Kawahara 2002), with the difference function computed through the FFT so each frame costs O(N log N) instead of O(W^2). */
export class YinDetector {
  private readonly frameSize: number;
  private readonly W: number;
  private readonly sampleRate: number;
  private readonly threshold: number;
  private readonly minTau: number;
  private readonly maxTau: number;

  private zRe: Float64Array;
  private zIm: Float64Array;
  private cRe: Float64Array;
  private cIm: Float64Array;
  private cmnd: Float64Array;

  constructor(
    frameSize: number,
    sampleRate: number,
    opts: { threshold?: number; minFreq?: number; maxFreq?: number } = {},
  ) {
    if ((frameSize & (frameSize - 1)) !== 0) throw new Error('frameSize must be a power of two');
    this.frameSize = frameSize;
    this.W = frameSize >> 1;
    this.sampleRate = sampleRate;
    this.threshold = opts.threshold ?? 0.15;
    this.minTau = Math.max(2, Math.floor(sampleRate / (opts.maxFreq ?? 1400)));
    this.maxTau = Math.min(this.W - 1, Math.ceil(sampleRate / (opts.minFreq ?? 55)));

    this.zRe = new Float64Array(frameSize);
    this.zIm = new Float64Array(frameSize);
    this.cRe = new Float64Array(frameSize);
    this.cIm = new Float64Array(frameSize);
    this.cmnd = new Float64Array(this.W);
  }

  detect(buf: Float32Array, offset: number): PitchResult {
    const { frameSize, W, zRe, zIm, cRe, cIm, cmnd } = this;
    if (offset < 0 || offset + frameSize > buf.length) return { freq: 0, clarity: 0 };
    if (this.maxTau <= this.minTau) return { freq: 0, clarity: 0 };

    // Two real sequences share one complex transform: the half-window in the real part, the frame in the imaginary.
    for (let i = 0; i < W; i++) {
      zRe[i] = buf[offset + i];
      zIm[i] = buf[offset + i];
    }
    for (let i = W; i < frameSize; i++) {
      zRe[i] = 0;
      zIm[i] = buf[offset + i];
    }

    fft(zRe, zIm);

    // A[k] = (Z[k] + conj(Z[N-k]))/2,  B[k] = (Z[k] - conj(Z[N-k]))/(2i)
    // C[k] = conj(A[k]) * B[k], which works out to (Im(PQ)/4, -Re(PQ)/4)
    // with P = conj(Z[k]) + Z[N-k] and Q = Z[k] - conj(Z[N-k]).
    for (let k = 0; k < frameSize; k++) {
      const nk = k === 0 ? 0 : frameSize - k;
      const zr = zRe[k], zi = zIm[k];
      const nr = zRe[nk], ni = zIm[nk];
      const pr = zr + nr;
      const pi = -zi + ni;
      const qr = zr - nr;
      const qi = zi + ni;
      const pqr = pr * qr - pi * qi;
      const pqi = pr * qi + pi * qr;
      cRe[k] = 0.25 * pqi;
      cIm[k] = -0.25 * pqr;
    }
    ifft(cRe, cIm);
    // cRe[tau] is now r(tau) for tau in [0, W).

    // Running power sums: p(tau) = sum of x[tau..tau+W-1]^2
    let p0 = 0;
    for (let i = 0; i < W; i++) {
      const v = buf[offset + i];
      p0 += v * v;
    }

    // Difference function + cumulative mean normalisation in one pass.
    let running = 0;
    let pTau = p0;
    cmnd[0] = 1;
    let bestTau = -1;
    for (let tau = 1; tau < W; tau++) {
      const drop = buf[offset + tau - 1];
      const add = buf[offset + tau + W - 1];
      pTau += add * add - drop * drop;
      const d = Math.max(0, p0 + pTau - 2 * cRe[tau]);
      running += d;
      cmnd[tau] = running === 0 ? 1 : (d * tau) / running;
    }

    // Take the first dip below the absolute threshold, which prevents autocorrelation's octave-down errors.
    for (let tau = this.minTau; tau <= this.maxTau; tau++) {
      if (cmnd[tau] < this.threshold) {
        while (tau + 1 <= this.maxTau && cmnd[tau + 1] < cmnd[tau]) tau++;
        bestTau = tau;
        break;
      }
    }

    if (bestTau === -1) {
      let best = this.minTau;
      for (let tau = this.minTau; tau <= this.maxTau; tau++) if (cmnd[tau] < cmnd[best]) best = tau;
      if (cmnd[best] > 0.55) return { freq: 0, clarity: 0 };
      bestTau = best;
    }

    // Parabolic interpolation around the dip for sub-sample precision.
    let refined = bestTau;
    if (bestTau > 1 && bestTau < W - 1) {
      const s0 = cmnd[bestTau - 1];
      const s1 = cmnd[bestTau];
      const s2 = cmnd[bestTau + 1];
      const denom = 2 * (2 * s1 - s2 - s0);
      if (Math.abs(denom) > 1e-12) {
        const shift = (s2 - s0) / denom;
        if (Math.abs(shift) < 1) refined = bestTau + shift;
      }
    }

    const freq = this.sampleRate / refined;
    if (!isFinite(freq) || freq <= 0) return { freq: 0, clarity: 0 };
    return { freq, clarity: Math.max(0, Math.min(1, 1 - cmnd[bestTau])) };
  }
}

export interface OnsetTrack {
  flux: Float32Array;
  hopSize: number;
  sampleRate: number;
}

/** Half-wave-rectified spectral flux, the standard onset novelty function. */
export function spectralFlux(
  buf: Float32Array,
  sampleRate: number,
  frameSize = 1024,
  hopSize = 256,
): OnsetTrack {
  const window = hannWindow(frameSize);
  const frameCount = Math.max(0, Math.floor((buf.length - frameSize) / hopSize) + 1);
  const flux = new Float32Array(frameCount);
  const half = frameSize >> 1;
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  let prev = new Float64Array(half);
  const mag = new Float64Array(half);

  for (let f = 0; f < frameCount; f++) {
    const base = f * hopSize;
    for (let i = 0; i < frameSize; i++) re[i] = buf[base + i] * window[i];
    im.fill(0);
    fft(re, im);
    // Log compression keeps quiet hits visible next to loud ones.
    for (let i = 0; i < half; i++) mag[i] = Math.log1p(Math.hypot(re[i], im[i]) * 20);

    if (f > 0) {
      let sum = 0;
      for (let i = 0; i < half; i++) {
        const d = mag[i] - prev[i];
        if (d > 0) sum += d;
      }
      flux[f] = sum;
    }
    prev.set(mag);
  }

  return { flux, hopSize, sampleRate };
}

/** Peak-pick an onset novelty curve with a moving-median adaptive threshold, returning onset times in seconds. */
export function pickOnsets(
  track: OnsetTrack,
  sensitivity = 0.5,
  minSeparationSec = 0.045,
): number[] {
  const { flux, hopSize, sampleRate } = track;
  const n = flux.length;
  if (n === 0) return [];

  let max = 0;
  for (let i = 0; i < n; i++) max = Math.max(max, flux[i]);
  if (max <= 0) return [];
  const norm = new Float32Array(n);
  for (let i = 0; i < n; i++) norm[i] = flux[i] / max;

  const medWin = Math.max(3, Math.round((0.12 * sampleRate) / hopSize));
  // sensitivity 0 is strict (fewer onsets), 1 permissive (more onsets)
  const deltaBase = 0.18 * (1 - sensitivity) + 0.012;
  const multiplier = 1.4 - 0.55 * sensitivity;
  const minSepFrames = Math.max(1, Math.round((minSeparationSec * sampleRate) / hopSize));

  const peaks: number[] = [];
  const scratch: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (!(norm[i] > norm[i - 1] && norm[i] >= norm[i + 1])) continue;

    const lo = Math.max(0, i - medWin);
    const hi = Math.min(n, i + medWin + 1);
    scratch.length = 0;
    for (let j = lo; j < hi; j++) scratch.push(norm[j]);
    scratch.sort((a, b) => a - b);
    const med = scratch[scratch.length >> 1];
    if (norm[i] < med * multiplier + deltaBase) continue;

    const last = peaks[peaks.length - 1];
    if (last !== undefined && i - last < minSepFrames) {
      // Two peaks too close: keep whichever is stronger.
      if (norm[i] > norm[last]) peaks[peaks.length - 1] = i;
      continue;
    }
    peaks.push(i);
  }

  return peaks.map((i) => (i * hopSize) / sampleRate);
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Running median over voiced neighbours, leaving unvoiced frames unvoiced so notes don't smear across their own boundaries. */
export function medianFilter(values: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(values.length);
  const scratch: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] <= 0) continue;
    scratch.length = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
      if (values[j] > 0) scratch.push(values[j]);
    }
    out[i] = scratch.length ? median(scratch) : 0;
  }
  return out;
}

/** Downmix channels to a single Float32Array. */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i];
  for (let i = 0; i < out.length; i++) out[i] /= channels.length;
  return out;
}

/** Peak-normalise a copy of the buffer to the given peak level. */
export function normalized(buf: Float32Array, peak = 0.9): Float32Array {
  let max = 0;
  for (let i = 0; i < buf.length; i++) max = Math.max(max, Math.abs(buf[i]));
  if (max < 1e-6) return buf.slice();
  const g = peak / max;
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] * g;
  return out;
}

/** Amplitude envelope (per-hop peak), used to draw the take waveform. */
export function envelope(buf: Float32Array, buckets: number): Float32Array {
  const out = new Float32Array(buckets);
  const per = buf.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * per);
    const end = Math.min(buf.length, Math.floor((b + 1) * per));
    let peak = 0;
    for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(buf[i]));
    out[b] = peak;
  }
  return out;
}

/**
 * Lanczos-3 windowed-sinc resampler. `step` is how many input samples each
 * output sample advances, so step > 1 decimates and the kernel widens to act
 * as the anti-aliasing lowpass. Replaces OfflineAudioContext resampling in
 * paths that must also run inside a worker, where Web Audio does not exist.
 */
export function resampleSinc(input: Float32Array, step: number, outLength: number): Float32Array {
  const out = new Float32Array(outLength);
  const scale = Math.min(1, 1 / step);
  const half = 3 / scale;
  for (let i = 0; i < outLength; i++) {
    const center = i * step;
    const start = Math.max(0, Math.ceil(center - half));
    const end = Math.min(input.length - 1, Math.floor(center + half));
    let acc = 0;
    let norm = 0;
    for (let m = start; m <= end; m++) {
      const x = (m - center) * scale;
      let w: number;
      if (x === 0) w = 1;
      else if (x <= -3 || x >= 3) w = 0;
      else {
        const px = Math.PI * x;
        w = (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
      }
      acc += input[m] * w;
      norm += w;
    }
    // Normalising by the kernel sum keeps unity gain at the buffer edges too.
    out[i] = norm > 1e-9 ? acc / norm : 0;
  }
  return out;
}
