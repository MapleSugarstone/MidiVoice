import { engine } from './engine';
import type { MicRecorder } from './recorder';
import { median } from './dsp';

export interface CalibrationResult {
  latencyMs: number;
  /** Spread across the individual clicks, in ms. Small = trustworthy. */
  spreadMs: number;
  detected: number;
  expected: number;
  ok: boolean;
  message: string;
}

const CLICKS = 6;
const SPACING = 0.42;

/** Measure real round-trip latency by playing clicks through the speakers and hearing them back, which bundles output, input and acoustic delay into exactly the compensation a recording needs. */
export async function calibrateLatency(recorder: MicRecorder): Promise<CalibrationResult> {
  const ctx = engine.context;

  recorder.start();

  const t0 = ctx.currentTime + 0.5;
  const clickTimes: number[] = [];
  for (let i = 0; i < CLICKS; i++) {
    const t = t0 + i * SPACING;
    clickTimes.push(t);
    engine.calibrationClick(t);
  }

  const endTime = t0 + CLICKS * SPACING + 0.4;
  await new Promise((r) => setTimeout(r, (endTime - ctx.currentTime) * 1000));

  const { audio, sampleRate, startContextTime } = await recorder.stop();
  if (audio.length === 0) {
    return {
      latencyMs: 0, spreadMs: 0, detected: 0, expected: CLICKS, ok: false,
      message: 'No audio was captured. Check the microphone permission and input device.',
    };
  }

  // Short-window energy envelope.
  const win = 64;
  const envLen = Math.floor(audio.length / win);
  const env = new Float32Array(envLen);
  for (let i = 0; i < envLen; i++) {
    let sum = 0;
    for (let j = 0; j < win; j++) {
      const v = audio[i * win + j];
      sum += v * v;
    }
    env[i] = Math.sqrt(sum / win);
  }

  const noiseFloor = median(Array.from(env).filter((v) => v > 0)) || 1e-6;
  const deltas: number[] = [];

  for (const clickTime of clickTimes) {
    // Search from the click until well past any plausible latency.
    const searchStart = Math.floor(((clickTime - startContextTime) * sampleRate) / win);
    const searchEnd = Math.min(envLen, searchStart + Math.floor((0.35 * sampleRate) / win));
    if (searchStart < 0 || searchStart >= envLen) continue;

    let peak = 0;
    for (let i = searchStart; i < searchEnd; i++) peak = Math.max(peak, env[i]);
    if (peak < noiseFloor * 5) continue; // click not audible over the room

    // The onset is where energy first crosses a third of the peak.
    const threshold = Math.max(peak * 0.33, noiseFloor * 4);
    for (let i = searchStart; i < searchEnd; i++) {
      if (env[i] >= threshold) {
        const foundTime = startContextTime + (i * win) / sampleRate;
        deltas.push(foundTime - clickTime);
        break;
      }
    }
  }

  if (deltas.length < 3) {
    return {
      latencyMs: 0, spreadMs: 0, detected: deltas.length, expected: CLICKS, ok: false,
      message:
        'Could not hear the clicks. Play through speakers (not headphones), turn the volume up, and keep the room quiet.',
    };
  }

  const med = median(deltas);
  const spread = median(deltas.map((d) => Math.abs(d - med)));
  const latencyMs = med * 1000;
  const spreadMs = spread * 1000;

  const ok = spreadMs < 12 && latencyMs > 0 && latencyMs < 500;
  return {
    latencyMs,
    spreadMs,
    detected: deltas.length,
    expected: CLICKS,
    ok,
    message: ok
      ? `Measured ${latencyMs.toFixed(1)} ms round-trip latency from ${deltas.length}/${CLICKS} clicks.`
      : `Measurement was inconsistent (±${spreadMs.toFixed(1)} ms). Try again in a quieter room, or set the offset by ear.`,
  };
}
