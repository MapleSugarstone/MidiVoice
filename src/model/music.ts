import type { GridSetting, ScaleId } from './types';

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
