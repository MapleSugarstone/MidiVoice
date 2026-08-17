export type Id = string;

/** A single note. All times are in BEATS (quarter notes), not seconds. */
export interface Note {
  id: Id;
  /** Start position on the timeline, in beats from song start. */
  start: number;
  /** Length in beats. */
  duration: number;
  /** Integer MIDI note number (60 = middle C). */
  midi: number;
  /** 0..1 */
  velocity: number;
  /** Cents away from the integer `midi`, as actually sung. Used for tuning/autotune. */
  detune: number;
  /** Take this note came from, if it was recorded rather than drawn. */
  takeId?: Id;
}

export type InstrumentId =
  | 'aeroKeys'
  | 'aeroPad'
  | 'bubblePluck'
  | 'glassChime'
  | 'skySaw'
  | 'airFlute'
  | 'waterDrop'
  | 'grandPiano'
  | 'electricPiano'
  | 'organ'
  | 'nylonGuitar'
  | 'cleanGuitar'
  | 'fingerBass'
  | 'subBass'
  | 'synthBass'
  | 'strings'
  | 'warmPad'
  | 'brass'
  | 'sawLead'
  | 'squareLead'
  | 'pluck'
  | 'bell'
  | 'marimba'
  | 'choir'
  | 'drumKit';

export interface Track {
  id: Id;
  name: string;
  instrument: InstrumentId;
  /** dB, -60..+6 */
  volume: number;
  /** -1..1 */
  pan: number;
  muted: boolean;
  solo: boolean;
  /** Hue 0..360 used to colour notes in the roll. */
  hue: number;
  notes: Note[];
  /** Drum tracks show a named-lane grid instead of a piano keyboard. */
  isDrum: boolean;
  /** Autotune: snap playback pitch to the project scale. */
  snapToScale: boolean;
  /** 0 = play exactly as sung, 1 = fully snapped to the integer MIDI note. */
  tuneStrength: number;
  /** Draw the sung pitch line of this track's takes behind its notes. */
  showContour: boolean;
}

/**
 * One recording pass. Kept as its own object so the whole pass can be nudged,
 * re-transcribed or re-tuned as a unit after the fact.
 *
 * The raw audio lives in a side map (see `audio/takeAudio.ts`) rather than
 * here, so undo snapshots stay cheap and the project stays serialisable.
 */
export interface Take {
  id: Id;
  trackId: Id;
  name: string;
  /** Transport position (beats) of the take's first sample, after auto-offset. */
  startBeat: number;
  /** User timing correction in ms. Negative pulls the take earlier. */
  nudgeMs: number;
  /**
   * Tempo correction for the take, as a multiplier on its note positions about
   * `startBeat`. Above 1 spreads the performance out (you sang faster than the
   * click), below 1 pulls it in. 1 is untouched.
   */
  stretch: number;
  /** Latency compensation already applied at capture time, in ms. */
  autoOffsetMs: number;
  /** Length of the captured audio, in seconds. */
  durationSec: number;
  createdAt: number;
  settings: TranscribeSettings;
  noteIds: Id[];
  /** Overall sharp/flat bias the transcriber measured, in cents. */
  tuningOffsetCents: number;
}

export type InputMode = 'melody' | 'bass' | 'drums';

/** Where a recording comes from: the microphone, or a connected MIDI keyboard. */
export type RecordSource = 'mic' | 'midi';

/**
 * Which detector runs on melodic takes: Basic Pitch ('neural', a ~1 MB local
 * model) or the YIN pipeline ('classic', also the automatic fallback).
 * Optional so takes saved before this field existed still parse.
 */
export type DetectorEngine = 'neural' | 'classic';

export interface TranscribeSettings {
  mode: InputMode;
  engine?: DetectorEngine;
  /** Noise floor in dB; frames quieter than this are treated as silence. */
  noiseFloorDb: number;
  /** 0..1, how confident the pitch tracker must be to call a frame voiced. */
  clarity: number;
  /** Notes shorter than this (ms) are discarded. */
  minNoteMs: number;
  /** Cents of drift tolerated before a held note is split in two. */
  splitCents: number;
  /** Onset sensitivity, 0..1. Higher = more notes. */
  onsetSensitivity: number;
}

/** The Detail dial moves the three thresholds together, and its default sits low because ornament recall comes from the dwell and return rules rather than a twitchy threshold. */
export function detailToSettings(detail: number): Pick<TranscribeSettings, 'splitCents' | 'minNoteMs' | 'onsetSensitivity'> {
  const d = Math.max(0, Math.min(1, detail));
  return {
    // Pitch threshold does the real work across the range.
    splitCents: Math.round(110 - 75 * d),
    // Stays short even at the smooth end, since raising the minimum deletes ornaments rather than smoothing them.
    minNoteMs: Math.round(110 - 55 * d),
    onsetSensitivity: Math.round((0.35 + 0.3 * d) * 100) / 100,
  };
}

/** Recover the dial position from the thresholds, for display. */
export function settingsToDetail(s: TranscribeSettings): number {
  return Math.max(0, Math.min(1, (110 - s.splitCents) / 75));
}

export const DEFAULT_DETAIL = 0.55;

export const DEFAULT_TRANSCRIBE: TranscribeSettings = {
  mode: 'melody',
  engine: 'neural',
  noiseFloorDb: -45,
  clarity: 0.72,
  ...detailToSettings(DEFAULT_DETAIL),
};

export type ScaleId =
  | 'chromatic'
  | 'major'
  | 'naturalMinor'
  | 'harmonicMinor'
  | 'melodicMinor'
  | 'dorian'
  | 'phrygian'
  | 'lydian'
  | 'mixolydian'
  | 'locrian'
  | 'majorPent'
  | 'minorPent'
  | 'blues';

/** Piano-roll pointer tool: select/move notes, or place them with a click. */
export type NoteTool = 'select' | 'draw';

/** Grid resolution for snapping, expressed in beats. */
export interface GridSetting {
  label: string;
  /** Beats per grid step. */
  beats: number;
}

export interface Project {
  name: string;
  bpm: number;
  beatsPerBar: number;
  /** Tonic pitch class, 0 = C. */
  keyRoot: number;
  scale: ScaleId;
  tracks: Track[];
  takes: Take[];
  /** Song length in bars, grows automatically. */
  bars: number;
  loopEnabled: boolean;
  /** Loop bounds in beats, matching the range highlighted on the ruler. */
  loopStartBeat: number;
  loopEndBeat: number;
}
