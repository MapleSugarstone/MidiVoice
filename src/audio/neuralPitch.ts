/** Spotify's Basic Pitch model finds note boundaries in the browser via TensorFlow.js, while the YIN contour supplies cent-level pitch, keeping everything client-side. */
import type { TranscribeSettings } from '../model/types';
import {
  analyzePitchContour,
  velocityFromDb,
  type RawNote,
  type TranscriptionResult,
} from './transcribe';
import { ampFromDb, median } from './dsp';

const MODEL_SAMPLE_RATE = 22050;
const MODEL_FFT_HOP = 256;
/** Contour output resolution: 3 bins per semitone. */
const BINS_PER_SEMITONE = 3;

type BasicPitchLib = typeof import('@spotify/basic-pitch');

interface Loaded {
  lib: BasicPitchLib;
  model: InstanceType<BasicPitchLib['BasicPitch']>;
}

let loaded: Promise<Loaded> | null = null;

function modelUrl(): string {
  return `${import.meta.env.BASE_URL}basic-pitch/model.json`;
}

/** Load the library and model once, clearing the cache on failure so a later take can retry. */
function loadBasicPitch(): Promise<Loaded> {
  if (!loaded) {
    loaded = (async () => {
      const lib = await import('@spotify/basic-pitch');
      const model = new lib.BasicPitch(modelUrl());
      await model.model; // surface a missing model here rather than mid-take
      return { lib, model };
    })().catch((err) => {
      loaded = null;
      throw err;
    });
  }
  return loaded;
}

/** Start fetching the model in the background (e.g. while the mic arms). */
export function preloadNeural(): void {
  loadBasicPitch().catch(() => {});
}

/** Resample to the model's 22050 Hz, de-tuning by shiftSemis via playback rate (times stretch by 1/rate) so sung pitches sit inside the model's absolute semitone bins instead of on their boundaries. */
async function resampleForModel(
  audio: Float32Array,
  sampleRate: number,
  shiftSemis: number,
): Promise<{ samples: Float32Array; timeScale: number }> {
  const rate = Math.pow(2, shiftSemis / 12);
  if (sampleRate === MODEL_SAMPLE_RATE && Math.abs(shiftSemis) < 1e-3) {
    return { samples: audio, timeScale: 1 };
  }
  const durationOut = audio.length / sampleRate / rate;
  const length = Math.max(1, Math.ceil(durationOut * MODEL_SAMPLE_RATE));
  const ctx = new OfflineAudioContext(1, length, MODEL_SAMPLE_RATE);
  const buf = ctx.createBuffer(1, audio.length, sampleRate);
  buf.getChannelData(0).set(audio);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  // An event at output time t happened at t * rate in the original audio.
  return { samples: rendered.getChannelData(0), timeScale: rate };
}

interface TimedNote {
  startTimeSeconds: number;
  durationSeconds: number;
  pitchMidi: number;
  amplitude: number;
  pitchBends?: number[];
}

/** Reduce the polyphonic model's output to one note at a time: heavy overlaps keep the stronger note, small ones are trimmed. */
function toMonophonic(events: TimedNote[]): TimedNote[] {
  const sorted = [...events].sort(
    (a, b) => a.startTimeSeconds - b.startTimeSeconds || b.amplitude - a.amplitude,
  );
  const mono: TimedNote[] = [];
  for (const e of sorted) {
    const last = mono[mono.length - 1];
    if (last) {
      const lastEnd = last.startTimeSeconds + last.durationSeconds;
      const overlap = lastEnd - e.startTimeSeconds;
      const shorter = Math.min(last.durationSeconds, e.durationSeconds);
      if (overlap > 0.5 * shorter) {
        if (e.amplitude > last.amplitude) mono[mono.length - 1] = e;
        continue;
      }
      if (overlap > 0) {
        last.durationSeconds = Math.max(0.02, e.startTimeSeconds - last.startTimeSeconds);
      }
    }
    mono.push(e);
  }
  return mono;
}

export async function transcribeNeural(
  audio: Float32Array,
  sampleRate: number,
  settings: TranscribeSettings,
): Promise<TranscriptionResult> {
  const { lib, model } = await loadBasicPitch();

  // The YIN pass runs first because its tuning estimate steers the de-tuned resample below.
  const pc = analyzePitchContour(audio, sampleRate, settings);
  const offsetSemis = pc.tuningOffsetCents / 100;

  const { samples: resampled, timeScale } = await resampleForModel(audio, sampleRate, -offsetSemis);

  const frames: number[][] = [];
  const onsets: number[][] = [];
  const contours: number[][] = [];
  await model.evaluateModel(
    resampled,
    (f, o, c) => {
      frames.push(...f);
      onsets.push(...o);
      contours.push(...c);
    },
    () => {},
  );

  const empty: TranscriptionResult = {
    notes: [],
    contour: pc.tuned,
    contourHopSec: pc.hopSec,
    contourStartSec: pc.contourStartSec,
    tuningOffsetCents: pc.tuningOffsetCents,
  };
  if (frames.length === 0) return empty;

  const fps = MODEL_SAMPLE_RATE / MODEL_FFT_HOP;
  const isBass = settings.mode === 'bass';
  // Same registers as the classic detector, which also kills most harmonic ghosts before decoding.
  const minFreq = isBass ? 32 : 65;
  const maxFreq = isBass ? 400 : 1400;
  // Higher sensitivity lowers the threshold, and the default lands near 0.5, Basic Pitch's own default.
  const onsetThresh = Math.min(0.95, Math.max(0.15, 0.8 - 0.6 * settings.onsetSensitivity));
  const frameThresh = 0.3;
  // The 0.6 factor mirrors the classic path, where onset-backed notes may duck under the minimum length.
  const minNoteLen = Math.max(3, Math.round((settings.minNoteMs / 1000) * fps * 0.6));
  // The library default of 11 frames (~128 ms) lets a note coast across a whole sixteenth at 120 bpm, swallowing passing tones.
  const energyTolerance = minNoteLen + 2;

  const events = lib.noteFramesToTime(
    lib.addPitchBendsToNoteEvents(
      contours,
      lib.outputToNotesPoly(
        frames, onsets, onsetThresh, frameThresh, minNoteLen,
        true, maxFreq, minFreq, true, energyTolerance,
      ),
    ),
  );

  const gate = ampFromDb(settings.noiseFloorDb);
  const notes: RawNote[] = [];
  for (const e of toMonophonic(events)) {
    // Model output lives on the de-tuned, time-stretched copy, so map times back.
    const startSec = e.startTimeSeconds * timeScale;
    const durSec = e.durationSeconds * timeScale;
    if (durSec <= 0.02) continue;

    const f0 = Math.max(0, Math.round((startSec - pc.contourStartSec) / pc.hopSec));
    const f1 = Math.min(
      pc.tuned.length,
      Math.round((startSec + durSec - pc.contourStartSec) / pc.hopSec),
    );

    // Enforce the user's noise gate, or breath and reverb tails come back as phantom quiet notes.
    let peakAmp = 0;
    for (let f = f0; f < f1; f++) peakAmp = Math.max(peakAmp, pc.amp[f]);
    if (f1 > f0 && peakAmp < gate) continue;

    // The model heard re-centred audio, so refine its pitch with the median of YIN frames that agree within a semitone.
    const bendSemis = e.pitchBends?.length ? median(e.pitchBends) / BINS_PER_SEMITONE : 0;
    const modelMidi = e.pitchMidi + bendSemis;
    const vals: number[] = [];
    for (let f = f0; f < f1; f++) {
      const m = pc.tuned[f];
      if (m > 0 && Math.abs(m - modelMidi) <= 1) vals.push(m);
    }
    const midiFloat = vals.length >= 4 ? median(vals) : modelMidi;

    const db = 20 * Math.log10(Math.max(peakAmp, 1e-10));
    notes.push({
      startSec: Math.max(0, startSec),
      durSec,
      midiFloat,
      velocity: f1 > f0 ? velocityFromDb(db, settings.noiseFloorDb) : Math.max(0.25, Math.min(1, 0.3 + 0.7 * e.amplitude)),
    });
  }
  notes.sort((a, b) => a.startSec - b.startSec);

  // Merge same-pitch fragments when the level never dipped across the seam, since true re-articulation always dips.
  const frameAt = (sec: number) => Math.round((sec - pc.contourStartSec) / pc.hopSec);
  const merged: RawNote[] = [];
  for (const n of notes) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      Math.abs(prev.midiFloat - n.midiFloat) < 0.6 &&
      n.startSec - (prev.startSec + prev.durSec) < 0.06
    ) {
      const p0 = Math.max(0, frameAt(prev.startSec));
      const p1 = Math.min(pc.amp.length, frameAt(prev.startSec + prev.durSec));
      let peak = 0;
      for (let f = p0; f < p1; f++) peak = Math.max(peak, pc.amp[f]);
      const g0 = Math.max(0, p1 - 1);
      const g1 = Math.min(pc.amp.length, frameAt(n.startSec) + 2);
      let dip = Infinity;
      for (let f = g0; f < g1; f++) dip = Math.min(dip, pc.amp[f]);
      if (peak > 0 && isFinite(dip) && dip > peak * 0.8) {
        prev.durSec = n.startSec + n.durSec - prev.startSec;
        prev.velocity = Math.max(prev.velocity, n.velocity);
        continue;
      }
    }
    merged.push(n);
  }

  return { ...empty, notes: merged };
}
