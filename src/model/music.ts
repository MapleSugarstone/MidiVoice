import type { GridSetting, ScaleId, Track } from './types';

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToName(midi: number): string {
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return `${NOTE_NAMES[pc]}${oct}`;
}

export function isBlackKey(midi: number): boolean {
  const pc = ((midi % 12) + 12) % 12;
  return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
}

export function freqToMidi(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440);
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export const SCALES: Record<ScaleId, { label: string; degrees: number[] }> = {
  chromatic: { label: 'Chromatic (no snapping)', degrees: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  major: { label: 'Major', degrees: [0, 2, 4, 5, 7, 9, 11] },
  naturalMinor: { label: 'Natural minor', degrees: [0, 2, 3, 5, 7, 8, 10] },
  harmonicMinor: { label: 'Harmonic minor', degrees: [0, 2, 3, 5, 7, 8, 11] },
  melodicMinor: { label: 'Melodic minor', degrees: [0, 2, 3, 5, 7, 9, 11] },
  dorian: { label: 'Dorian', degrees: [0, 2, 3, 5, 7, 9, 10] },
  phrygian: { label: 'Phrygian', degrees: [0, 1, 3, 5, 7, 8, 10] },
  lydian: { label: 'Lydian', degrees: [0, 2, 4, 6, 7, 9, 11] },
  mixolydian: { label: 'Mixolydian', degrees: [0, 2, 4, 5, 7, 9, 10] },
  locrian: { label: 'Locrian', degrees: [0, 1, 3, 5, 6, 8, 10] },
  majorPent: { label: 'Major pentatonic', degrees: [0, 2, 4, 7, 9] },
  minorPent: { label: 'Minor pentatonic', degrees: [0, 3, 5, 7, 10] },
  blues: { label: 'Blues', degrees: [0, 3, 5, 6, 7, 10] },
};

/** True if `midi` belongs to the given key/scale. */
export function inScale(midi: number, keyRoot: number, scale: ScaleId): boolean {
  const degrees = SCALES[scale].degrees;
  const pc = (((midi - keyRoot) % 12) + 12) % 12;
  return degrees.includes(pc);
}

/** Nearest in-scale MIDI note. Ties resolve upward. */
export function snapToScale(midi: number, keyRoot: number, scale: ScaleId): number {
  if (scale === 'chromatic') return Math.round(midi);
  const rounded = Math.round(midi);
  for (let dist = 0; dist <= 6; dist++) {
    if (inScale(rounded + dist, keyRoot, scale)) return rounded + dist;
    if (inScale(rounded - dist, keyRoot, scale)) return rounded - dist;
  }
  return rounded;
}

/**
 * Krumhansl-Kessler key profiles: how strongly each scale degree implies the
 * key, from probe-tone experiments. Correlating a piece's duration-weighted
 * pitch-class histogram against all 24 rotations is the standard
 * Krumhansl-Schmuckler key-finding algorithm.
 */
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

export interface DetectedKey {
  keyRoot: number;
  scale: ScaleId;
  /** Pearson fit of the winner, roughly 0.5 (weak) to 0.95 (clear). */
  score: number;
  /** Winner minus runner-up. Below ~0.05 the two keys are hard to tell apart. */
  margin: number;
  runnerUp: { keyRoot: number; scale: ScaleId };
}

/**
 * Fit a key and scale to the notes on all melodic tracks. Votes are weighted
 * by duration so brief passing tones barely count, and capped so a single
 * held drone cannot decide the key by itself. Returns null when there is not
 * enough material to say anything.
 */
export function detectKey(tracks: Track[]): DetectedKey | null {
  const hist = new Array(12).fill(0);
  let total = 0;
  let count = 0;
  for (const t of tracks) {
    if (t.isDrum) continue;
    for (const n of t.notes) {
      const w = Math.min(2, Math.max(0.1, n.duration));
      hist[((n.midi % 12) + 12) % 12] += w;
      total += w;
      count++;
    }
  }
  const usedPcs = hist.filter((v) => v > 0).length;
  if (count < 4 || usedPcs < 3 || total < 2) return null;

  const fits: { keyRoot: number; minor: boolean; r: number }[] = [];
  for (let root = 0; root < 12; root++) {
    const rotated = hist.map((_, degree) => hist[(root + degree) % 12]);
    fits.push({ keyRoot: root, minor: false, r: pearson(rotated, KK_MAJOR) });
    fits.push({ keyRoot: root, minor: true, r: pearson(rotated, KK_MINOR) });
  }
  fits.sort((a, b) => b.r - a.r);
  const [best, second] = fits;

  // The profiles only separate major from minor. A minor result with a real
  // leading tone and no subtonic is closer to harmonic minor for snapping.
  const asScale = (f: { keyRoot: number; minor: boolean }): ScaleId => {
    if (!f.minor) return 'major';
    const leading = hist[(f.keyRoot + 11) % 12];
    const subtonic = hist[(f.keyRoot + 10) % 12];
    return leading > subtonic * 2 && leading >= total * 0.03 ? 'harmonicMinor' : 'naturalMinor';
  };

  return {
    keyRoot: best.keyRoot,
    scale: asScale(best),
    score: best.r,
    margin: best.r - second.r,
    runnerUp: { keyRoot: second.keyRoot, scale: asScale(second) },
  };
}

export const GRIDS: GridSetting[] = [
  { label: 'Off', beats: 0 },
  { label: '1 bar', beats: -1 }, // resolved against beatsPerBar at use site
  { label: '1/4 (beat)', beats: 1 },
  { label: '1/4 triplet', beats: 2 / 3 },
  { label: '1/8', beats: 0.5 },
  { label: '1/8 triplet', beats: 1 / 3 },
  { label: '1/16', beats: 0.25 },
  { label: '1/16 triplet', beats: 1 / 6 },
  { label: '1/32', beats: 0.125 },
];

export function gridBeats(g: GridSetting, beatsPerBar: number): number {
  return g.beats === -1 ? beatsPerBar : g.beats;
}

export function beatsToSeconds(beats: number, bpm: number): number {
  return (beats * 60) / bpm;
}

export function secondsToBeats(seconds: number, bpm: number): number {
  return (seconds * bpm) / 60;
}

/** Snap `value` to the nearest multiple of `step`, blended by `strength` (0..1). */
export function quantizeValue(value: number, step: number, strength = 1): number {
  if (step <= 0) return value;
  const snapped = Math.round(value / step) * step;
  return value + (snapped - value) * strength;
}

export function formatBarBeat(beats: number, beatsPerBar: number): string {
  const bar = Math.floor(beats / beatsPerBar) + 1;
  const beat = Math.floor(beats % beatsPerBar) + 1;
  const tick = Math.floor(((beats % 1) + 1e-9) * 960);
  return `${bar}.${beat}.${String(tick).padStart(3, '0')}`;
}

/** General MIDI drum lanes we transcribe into and display as named rows. */
export const DRUM_LANES: { midi: number; name: string; short: string }[] = [
  { midi: 49, name: 'Crash', short: 'CR' },
  { midi: 46, name: 'Open hat', short: 'OH' },
  { midi: 42, name: 'Closed hat', short: 'CH' },
  { midi: 39, name: 'Clap', short: 'CP' },
  { midi: 38, name: 'Snare', short: 'SN' },
  { midi: 45, name: 'Low tom', short: 'LT' },
  { midi: 36, name: 'Kick', short: 'KD' },
];

export const DRUM_LANE_MIDIS = DRUM_LANES.map((d) => d.midi);

export function drumLaneName(midi: number): string {
  return DRUM_LANES.find((d) => d.midi === midi)?.name ?? midiToName(midi);
}
