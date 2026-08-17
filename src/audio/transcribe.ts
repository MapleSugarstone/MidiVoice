import {
  YinDetector,
  spectralFlux,
  pickOnsets,
  rms,
  ampFromDb,
  median,
  medianFilter,
  fft,
  hannWindow,
} from './dsp';
import { freqToMidi } from '../model/music';
import type { TranscribeSettings } from '../model/types';

export interface RawNote {
  startSec: number;
  durSec: number;
  /** Fractional MIDI note as actually sung. */
  midiFloat: number;
  velocity: number;
}

export interface TranscriptionResult {
  notes: RawNote[];
  /** Sung pitch contour in fractional MIDI, 0 means unvoiced. */
  contour: Float32Array;
  contourHopSec: number;
  /** Time of the first contour sample (the analysis window is centred). */
  contourStartSec: number;
  /** How flat/sharp the whole take was, in cents, relative to A440. */
  tuningOffsetCents: number;
}

/** Hop between pitch frames. 512 @ 48k ≈ 10.7 ms, finer than any note boundary. */
const PITCH_HOP = 512;
/** Onsets need sharper time resolution than pitch, and their FFT is cheaper. */
const ONSET_HOP = 256;
/** Short window used purely for the loudness gate, so notes don't start early. */
const GATE_WIN = 512;

interface ModeConfig {
  frameSize: number;
  minFreq: number;
  maxFreq: number;
}

function modeConfig(mode: TranscribeSettings['mode'], sampleRate: number): ModeConfig {
  // Frame must hold at least two periods of the lowest pitch we want to see.
  if (mode === 'bass') {
    return { frameSize: sampleRate > 32000 ? 4096 : 2048, minFreq: 32, maxFreq: 400 };
  }
  return { frameSize: sampleRate > 32000 ? 2048 : 1024, minFreq: 65, maxFreq: 1400 };
}

/** Circular mean of the fractional part of the pitch track, in cents. */
function estimateTuningOffset(midiVals: number[]): number {
  if (midiVals.length < 8) return 0;
  let x = 0;
  let y = 0;
  for (const m of midiVals) {
    const frac = m - Math.round(m); // [-0.5, 0.5)
    const angle = 2 * Math.PI * frac;
    x += Math.cos(angle);
    y += Math.sin(angle);
  }
  if (Math.hypot(x, y) < midiVals.length * 0.1) return 0; // no consistent bias
  const meanAngle = Math.atan2(y, x);
  return (meanAngle / (2 * Math.PI)) * 100;
}

export function velocityFromDb(db: number, floorDb: number): number {
  const t = (db - floorDb) / (0 - floorDb);
  return Math.max(0.25, Math.min(1, 0.3 + 0.7 * Math.max(0, Math.min(1, t))));
}

export interface PitchContour {
  /** Re-centred fractional-MIDI contour, 0 means unvoiced. */
  tuned: Float32Array;
  /** Short-window RMS at each frame centre. */
  amp: Float32Array;
  hopSec: number;
  contourStartSec: number;
  tuningOffsetCents: number;
}

/** Gated, octave-repaired, tuning-re-centred YIN contour shared by the classic segmenter and the neural detector. */
export function analyzePitchContour(
  audio: Float32Array,
  sampleRate: number,
  settings: TranscribeSettings,
): PitchContour {
  const cfg = modeConfig(settings.mode, sampleRate);
  const { frameSize } = cfg;
  const halfFrame = frameSize >> 1;
  const hopSec = PITCH_HOP / sampleRate;
  // A frame's estimate describes its window's centre, so the contour starts half a frame in.
  const contourStartSec = halfFrame / sampleRate;
  const frameCount = Math.max(0, Math.floor((audio.length - frameSize) / PITCH_HOP) + 1);

  if (frameCount === 0) {
    return {
      tuned: new Float32Array(0), amp: new Float32Array(0),
      hopSec, contourStartSec, tuningOffsetCents: 0,
    };
  }

  const detector = new YinDetector(frameSize, sampleRate, {
    threshold: 0.15,
    minFreq: cfg.minFreq,
    maxFreq: cfg.maxFreq,
  });

  const rawMidi = new Float32Array(frameCount);
  const amp = new Float32Array(frameCount);
  const gate = ampFromDb(settings.noiseFloorDb);

  for (let f = 0; f < frameCount; f++) {
    const offset = f * PITCH_HOP;
    // Gate on a short window at the frame centre, so it opens with the note rather than the window's tail.
    const a = rms(audio, offset + halfFrame - (GATE_WIN >> 1), GATE_WIN);
    amp[f] = a;
    if (a < gate) continue;
    const { freq, clarity } = detector.detect(audio, offset);
    if (freq > 0 && clarity >= settings.clarity) rawMidi[f] = freqToMidi(freq);
  }

  // A ~30 ms median kills single-frame pitch glitches without smearing real note changes.
  const filterRadius = Math.max(1, Math.round(0.015 / hopSec));
  const smoothed = medianFilter(rawMidi, filterRadius);

  // ---- octave repair -------------------------------------------------------
  // Breathy voices make YIN grab subharmonics, so clear octave outliers get pulled back to the local register.
  const octRadius = Math.max(3, Math.round(0.5 / hopSec));
  const localMed = medianFilter(smoothed, octRadius);
  const repaired = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const m = smoothed[f];
    if (m <= 0) continue;
    const target = localMed[f];
    repaired[f] = m;
    if (target > 0 && Math.abs(m - target) > 7) {
      for (const shift of [-12, 12, -24, 24]) {
        if (Math.abs(m + shift - target) < 4) {
          repaired[f] = m + shift;
          break;
        }
      }
    }
  }

  const voicedVals: number[] = [];
  for (let f = 0; f < frameCount; f++) if (repaired[f] > 0) voicedVals.push(repaired[f]);
  const tuningOffsetCents = estimateTuningOffset(voicedVals);
  const offsetSemis = tuningOffsetCents / 100;

  // Re-centre on the take's own tuning bias so semitone boundaries stay clear of the sung notes.
  const tuned = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) tuned[f] = repaired[f] > 0 ? repaired[f] - offsetSemis : 0;

  return { tuned, amp, hopSec, contourStartSec, tuningOffsetCents };
}

/** Classic monophonic transcription for hummed or sung lines, segmenting the YIN contour with hysteresis. */
export function transcribeMelodic(
  audio: Float32Array,
  sampleRate: number,
  settings: TranscribeSettings,
): TranscriptionResult {
  const { tuned, amp, hopSec, contourStartSec, tuningOffsetCents } =
    analyzePitchContour(audio, sampleRate, settings);
  const frameCount = tuned.length;

  if (frameCount === 0) {
    return {
      notes: [], contour: new Float32Array(0), contourHopSec: hopSec,
      contourStartSec, tuningOffsetCents: 0,
    };
  }

  // Onsets split same-pitch repeats and vouch for fast notes. 40 ms spacing admits sixteenths past 200 bpm.
  const flux = spectralFlux(audio, sampleRate, 1024, ONSET_HOP);
  const onsetFrames = new Set(
    pickOnsets(flux, settings.onsetSensitivity, 0.04).map((t) =>
      Math.round((t - contourStartSec) / hopSec),
    ),
  );

  const minFrames = Math.max(2, Math.round(settings.minNoteMs / 1000 / hopSec));
  /** Floor for onset-backed notes, which stay real below the minimum length (a sixteenth at 120 bpm is 125 ms). */
  const onsetFloorFrames = Math.max(2, Math.round(0.045 / hopSec));
  const splitSemis = settings.splitCents / 100;
  /** Dwell before a pitch change counts as a new note: vibrato has depth but no dwell, a trill note has both. */
  const confirmFastFrames = Math.max(
    2,
    Math.round(Math.min(0.03, settings.minNoteMs / 1000 / 3) / hopSec),
  );
  const confirmSlowFrames = Math.max(confirmFastFrames + 1, Math.round(0.055 / hopSec));
  /** Above this, a move is too big to be vibrato and confirms on the fast path. */
  const DECISIVE_SEMIS = 1;
  /** The reference median must span more than one vibrato cycle or it rides the vibrato and shatters held notes. */
  const refWindowFrames = Math.max(8, Math.round(0.26 / hopSec));
  /** Silence this long ends the current note. */
  const silenceFrames = Math.max(2, Math.round(0.05 / hopSec));

  interface Seg { startF: number; endF: number; vals: number[] }
  const segs: Seg[] = [];
  let cur: Seg | null = null;
  let ref = 0;
  let pending: number[] = [];
  let pendingStart = -1;
  let pendingMaxDev = 0;
  let silentRun = 0;

  const closeCur = (endF: number) => {
    if (cur && endF > cur.startF) {
      cur.endF = endF;
      segs.push(cur);
    }
    cur = null;
  };

  // Segment the continuous contour with hysteresis: quantising first turns every boundary wobble into a note edge.
  /** An onset stays armed briefly because the attack lands a few frames before the first voiced frame. */
  let onsetArmed = -1;
  const onsetGraceFrames = Math.max(2, Math.round(0.035 / hopSec));

  for (let f = 0; f < frameCount; f++) {
    if (onsetFrames.has(f)) onsetArmed = f;
    const m = tuned[f];

    if (m <= 0) {
      silentRun++;
      if (cur && silentRun >= silenceFrames) closeCur(f - silentRun + 1);
      pending = [];
      pendingStart = -1;
      continue;
    }
    silentRun = 0;

    if (!cur) {
      cur = { startF: f, endF: f, vals: [m] };
      ref = m;
      pending = [];
      pendingStart = -1;
      continue;
    }

    if (onsetArmed >= 0 && f - onsetArmed <= onsetGraceFrames) {
      // Split at the attack itself so fast notes land on the beat they were sung on.
      const splitAt = Math.max(cur.startF + 1, Math.min(onsetArmed, f));
      let allowed = splitAt - cur.startF >= onsetFloorFrames;

      // Same-pitch splits need a level dip: re-articulation dips, a stray flux peak inside a note does not.
      if (allowed && Math.abs(m - ref) < splitSemis) {
        let peak = 0;
        for (let k = cur.startF; k < splitAt; k++) peak = Math.max(peak, amp[k]);
        allowed = amp[splitAt] < peak * 0.8;
      }

      if (allowed) {
        closeCur(splitAt);
        cur = { startF: splitAt, endF: f, vals: [m] };
        ref = m;
        pending = [];
        pendingStart = -1;
        onsetArmed = -1;
        continue;
      }
      onsetArmed = -1;
    }

    const dev = Math.abs(m - ref);
    if (dev > splitSemis) {
      if (pendingStart < 0) {
        pendingStart = f;
        pendingMaxDev = 0;
      }
      pending.push(m);
      pendingMaxDev = Math.max(pendingMaxDev, dev);
      const need = pendingMaxDev >= DECISIVE_SEMIS ? confirmFastFrames : confirmSlowFrames;
      if (pending.length >= need) {
        const startF = pendingStart;
        const vals = pending;
        closeCur(startF);
        cur = { startF, endF: f, vals: [...vals] };
        ref = median(vals);
        pending = [];
        pendingStart = -1;
        pendingMaxDev = 0;
      }
    } else {
      // Came back inside the band, so that excursion was vibrato or a scoop.
      if (pending.length) {
        for (const v of pending) cur.vals.push(v);
        pending = [];
        pendingStart = -1;
        pendingMaxDev = 0;
      }
      cur.vals.push(m);
      // Let the reference drift with the note so a slow bend doesn't split it.
      ref = median(cur.vals.slice(-refWindowFrames));
    }
  }
  closeCur(frameCount);

  // ---- absorb fragments ----------------------------------------------------
  // Fold too-short segments into a pitch-close neighbour, judged by attack: a scoop has no onset, a fast note does.
  /** Attack frame for a segment, found by walking back through the unvoiced gap where a consonant bursts, or -1. */
  const onsetLookback = Math.max(3, Math.round(0.08 / hopSec));
  const attackFrame = (s: Seg): number => {
    for (let d = -1; d <= 2; d++) if (onsetFrames.has(s.startF + d)) return s.startF;
    for (let f = s.startF - 2; f >= s.startF - onsetLookback; f--) {
      if (f < 0) break;
      if (tuned[f] > 0) break;
      if (onsetFrames.has(f)) return f;
    }
    return -1;
  };
  const hasOnset = (s: Seg): boolean => attackFrame(s) >= 0;
  const isKeeper = (s: Seg): boolean => {
    const len = s.endF - s.startF;
    return len >= minFrames || (len >= onsetFloorFrames && hasOnset(s));
  };

  const kept = segs.slice();
  for (let guard = 0; guard < kept.length * 3 + 10; guard++) {
    let mergedAny = false;
    for (let i = 0; i < kept.length; i++) {
      const s = kept[i];
      if (s.endF - s.startF >= minFrames) continue;

      const prev = kept[i - 1];
      const next = kept[i + 1];
      const sp = median(s.vals);

      // Forward: a scoop owns the attack and the note it slides into has none, unlike two real fast notes.
      const mergeNext =
        next && next.startF - s.endF <= silenceFrames && !hasOnset(next) && Math.abs(median(next.vals) - sp) < 3;

      // Backward: a tail wobble belongs to its note, held to a tight pitch window so ornaments survive.
      const mergePrev =
        prev && s.startF - prev.endF <= silenceFrames && !hasOnset(s) && Math.abs(median(prev.vals) - sp) < 0.75;

      if (mergeNext && next) {
        next.startF = s.startF;
        next.vals.unshift(...s.vals);
      } else if (mergePrev && prev) {
        prev.endF = s.endF;
        prev.vals.push(...s.vals);
      } else {
        continue;
      }
      kept.splice(i, 1);
      mergedAny = true;
      break;
    }
    if (!mergedAny) break;
  }

  // ---- fold away slides ----------------------------------------------------
  // A portamento arrives as a staircase of chromatic steps, so reject segments
  // on motion: vibrato has range without travel, a fast note travel without range.
  const SWEEP_SLOPE = 6; // semitones per second
  const FLAT_BAND = 0.2; // semitones counted as "sitting on the pitch"
  const FLAT_FRACTION = 0.6;
  const motionOf = (s: Seg): { slope: number; flat: number; range: number } => {
    const all = s.vals;
    // Too few frames to judge motion, and guessing deletes ornaments.
    if (all.length < 8) return { slope: 0, flat: 1, range: 0 };
    // Trim the edges first: every note starts and stops by moving, and the edges make a steady trill note look like a slide.
    const cut = Math.floor(all.length * 0.2);
    const v = all.length >= 8 ? all.slice(cut, all.length - cut) : all;
    if (v.length < 3) return { slope: 0, flat: 1, range: 0 };
    const third = Math.max(1, Math.floor(v.length / 3));
    const head = median(v.slice(0, third));
    const tail = median(v.slice(-third));
    const seconds = Math.max(1e-3, (v.length * hopSec * 2) / 3);
    const mid = median(v);
    // A held note sits in a narrow band around its median, a slide spends little time anywhere.
    const flat = v.filter((x) => Math.abs(x - mid) <= FLAT_BAND).length / v.length;
    const sorted = [...v].sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.1)];
    const hi = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9))];
    return { slope: (tail - head) / seconds, flat, range: hi - lo };
  };

  for (let guard = 0; guard < kept.length * 2 + 10; guard++) {
    let changed = false;
    for (let i = 0; i < kept.length; i++) {
      const s = kept[i];
      const { slope, flat, range } = motionOf(s);
      const sweeping = Math.abs(slope) > SWEEP_SLOPE && flat < FLAT_FRACTION;
      const wild = range > 3 && Math.abs(slope) > 10; // octave glitch mid-note
      if (!sweeping && !wild) continue;

      const prev = kept[i - 1];
      const next = kept[i + 1];
      // A slide donates its time to the landing note but not its pitches, which would drag the median off true.
      if (next && next.startF - s.endF <= silenceFrames) {
        next.startF = s.startF;
      } else if (prev && s.startF - prev.endF <= silenceFrames) {
        prev.endF = s.endF;
      } else {
        continue; // nothing adjacent to absorb it; it may be a real note
      }
      kept.splice(i, 1);
      changed = true;
      break;
    }
    if (!changed) break;
  }

  // ---- rejoin notes that merely drifted ------------------------------------
  // Rejoin a wandering held note split across a semitone boundary, sparing ornaments, which return to the pitch they left.
  // Derived from the pitch threshold so the Detail dial governs this too.
  const DRIFT_SEMIS = Math.max(0.45, splitSemis + 0.05);
  const RETURN_SEMIS = 0.4;
  /** A short note sitting flat on its own pitch is a note, however small the window-compressed move measures. */
  const plateauFrames = Math.max(4, Math.round(0.065 / hopSec));
  const isPlateau = (s: Seg): boolean =>
    s.endF - s.startF >= plateauFrames && motionOf(s).flat >= 0.6;
  for (let guard = 0; guard < kept.length * 2 + 10; guard++) {
    let changed = false;
    for (let i = 1; i < kept.length; i++) {
      const prev = kept[i - 1];
      const s = kept[i];
      const next = kept[i + 1];
      if (s.startF - prev.endF > silenceFrames) continue;

      const mp = median(prev.vals);
      const ms = median(s.vals);
      const move = Math.abs(ms - mp);
      if (move >= DRIFT_SEMIS) continue;

      // An attack only protects a true repeated note, since articulated singing puts an onset on every syllable.
      if (hasOnset(s) && move < 0.3) continue;

      // It settled on a pitch of its own, so it is a note and not a wobble.
      if (move > 0.45 && isPlateau(s)) continue;

      const returns =
        next &&
        next.startF - s.endF <= silenceFrames &&
        Math.abs(median(next.vals) - mp) < RETURN_SEMIS &&
        move > 0.35;
      if (returns) continue; // ornaments return, drifts keep going

      prev.endF = s.endF;
      prev.vals.push(...s.vals);
      kept.splice(i, 1);
      changed = true;
      break;
    }
    if (!changed) break;
  }

  const notes: RawNote[] = [];
  let prevEndF = 0;
  for (const seg of kept) {
    if (!isKeeper(seg)) continue;

    // Start at the attack when one preceded the voicing, since the ear places a note at its consonant.
    const attack = attackFrame(seg);
    const startF = attack >= 0 && attack < seg.startF ? Math.max(attack, prevEndF) : seg.startF;
    const len = seg.endF - startF;
    prevEndF = seg.endF;

    const vals: number[] = [];
    let peakAmp = 0;
    for (let f = seg.startF; f < seg.endF; f++) {
      if (tuned[f] > 0) vals.push(tuned[f]);
      peakAmp = Math.max(peakAmp, amp[f]);
    }
    if (vals.length === 0) continue;

    // Trim 15% off each end before the median, since attacks scoop and releases fall away.
    const trim = Math.floor(vals.length * 0.15);
    const core = vals.length > 6 ? vals.slice(trim, vals.length - trim) : vals;
    const midiFloat = median(core.length ? core : vals);

    const db = 20 * Math.log10(Math.max(peakAmp, 1e-10));
    notes.push({
      startSec: Math.max(0, startF * hopSec + contourStartSec),
      durSec: len * hopSec,
      midiFloat,
      velocity: velocityFromDb(db, settings.noiseFloorDb),
    });
  }

  // The drawn contour must match the notes, so hand back the re-centred one.
  return { notes, contour: tuned, contourHopSec: hopSec, contourStartSec, tuningOffsetCents };
}

/** Energy in a frequency band, from a magnitude spectrum. */
function bandEnergy(
  mag: Float64Array,
  sampleRate: number,
  fftSize: number,
  loHz: number,
  hiHz: number,
): number {
  const binHz = sampleRate / fftSize;
  const lo = Math.max(0, Math.floor(loHz / binHz));
  const hi = Math.min(mag.length - 1, Math.ceil(hiHz / binHz));
  let sum = 0;
  for (let i = lo; i <= hi; i++) sum += mag[i] * mag[i];
  return sum;
}

/** Beatbox transcription: onsets classified by spectral balance into kick, snare, clap and hats, kept coarse because dragging a wrong hit beats fighting a confident classifier. */
export function transcribeDrums(
  audio: Float32Array,
  sampleRate: number,
  settings: TranscribeSettings,
): TranscriptionResult {
  const flux = spectralFlux(audio, sampleRate, 1024, ONSET_HOP);
  const onsets = pickOnsets(flux, settings.onsetSensitivity, 0.05);
  const hopSec = ONSET_HOP / sampleRate;

  const FFT_SIZE = 2048;
  const window = hannWindow(FFT_SIZE);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const mag = new Float64Array(FFT_SIZE >> 1);

  const notes: RawNote[] = [];
  const gate = ampFromDb(settings.noiseFloorDb);

  for (let i = 0; i < onsets.length; i++) {
    const startSample = Math.round(onsets[i] * sampleRate);
    if (startSample + FFT_SIZE > audio.length) break;

    const peakAmp = rms(audio, startSample, Math.round(0.03 * sampleRate));
    if (peakAmp < gate) continue;

    for (let j = 0; j < FFT_SIZE; j++) re[j] = audio[startSample + j] * window[j];
    im.fill(0);
    fft(re, im);
    for (let j = 0; j < mag.length; j++) mag[j] = Math.hypot(re[j], im[j]);

    const low = bandEnergy(mag, sampleRate, FFT_SIZE, 20, 180);
    const mid = bandEnergy(mag, sampleRate, FFT_SIZE, 180, 1200);
    const high = bandEnergy(mag, sampleRate, FFT_SIZE, 3000, Math.min(12000, sampleRate / 2 - 1));
    const total = low + mid + high + 1e-12;
    const lowR = low / total;
    const highR = high / total;

    // Sustain ratio separates an open hat from a closed one.
    const early = rms(audio, startSample, Math.round(0.025 * sampleRate));
    const late = rms(audio, startSample + Math.round(0.06 * sampleRate), Math.round(0.06 * sampleRate));
    const sustain = late / Math.max(early, 1e-9);

    let midi: number;
    if (lowR > 0.5) midi = 36; // kick
    else if (highR > 0.4) midi = sustain > 0.45 ? 46 : 42; // open / closed hat
    else if (highR > 0.22 && lowR < 0.2) midi = 39; // clap-ish
    else midi = 38; // snare

    const next = onsets[i + 1] ?? onsets[i] + 0.25;
    const durSec = Math.min(0.3, Math.max(0.05, (next - onsets[i]) * 0.9));
    const db = 20 * Math.log10(Math.max(peakAmp, 1e-10));

    notes.push({
      startSec: onsets[i],
      durSec,
      midiFloat: midi,
      velocity: velocityFromDb(db, settings.noiseFloorDb),
    });
  }

  return {
    notes, contour: new Float32Array(0), contourHopSec: hopSec,
    contourStartSec: 0, tuningOffsetCents: 0,
  };
}

export function transcribe(
  audio: Float32Array,
  sampleRate: number,
  settings: TranscribeSettings,
): TranscriptionResult {
  return settings.mode === 'drums'
    ? transcribeDrums(audio, sampleRate, settings)
    : transcribeMelodic(audio, sampleRate, settings);
}

export type EngineUsed = 'neural' | 'classic' | 'drums';

export interface AsyncTranscriptionResult extends TranscriptionResult {
  engineUsed: EngineUsed;
}

/** Preferred entry point: melodic takes use the lazily imported neural detector when asked, falling back to the classic pipeline on any failure. */
export async function transcribeAsync(
  audio: Float32Array,
  sampleRate: number,
  settings: TranscribeSettings,
): Promise<AsyncTranscriptionResult> {
  if (settings.mode === 'drums') {
    return { ...transcribeDrums(audio, sampleRate, settings), engineUsed: 'drums' };
  }
  if ((settings.engine ?? 'neural') === 'neural') {
    try {
      const { transcribeNeural } = await import('./neuralPitch');
      return { ...(await transcribeNeural(audio, sampleRate, settings)), engineUsed: 'neural' };
    } catch (err) {
      console.warn('Neural note detection unavailable; using the classic detector.', err);
    }
  }
  return { ...transcribeMelodic(audio, sampleRate, settings), engineUsed: 'classic' };
}
