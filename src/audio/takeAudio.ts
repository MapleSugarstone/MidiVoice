import { envelope } from './dsp';

export interface TakeAudio {
  audio: Float32Array;
  sampleRate: number;
  /** Sung pitch contour in fractional MIDI; 0 = unvoiced. */
  contour: Float32Array;
  contourHopSec: number;
  /** Time of contour[0] within the take. */
  contourStartSec: number;
  /** Pre-computed peak envelope for drawing the take strip. */
  peaks: Float32Array;
}

/**
 * Raw take audio lives here rather than in the project so that undo snapshots
 * stay cheap and the project object stays JSON-serialisable. It is deliberately
 * session-only: reload the page and you keep the notes, not the megabytes.
 */
const store = new Map<string, TakeAudio>();

export function putTakeAudio(
  id: string,
  audio: Float32Array,
  sampleRate: number,
  contour: Float32Array,
  contourHopSec: number,
  contourStartSec: number,
): void {
  store.set(id, {
    audio,
    sampleRate,
    contour,
    contourHopSec,
    contourStartSec,
    peaks: envelope(audio, Math.max(1, Math.min(4000, Math.round(audio.length / 256)))),
  });
}

export function getTakeAudio(id: string): TakeAudio | undefined {
  return store.get(id);
}

export function hasTakeAudio(id: string): boolean {
  return store.has(id);
}

export function dropTakeAudio(id: string): void {
  store.delete(id);
}

export function clearTakeAudio(): void {
  store.clear();
}

/** Total bytes held, so the UI can warn before memory gets silly. */
export function takeAudioBytes(): number {
  let total = 0;
  for (const t of store.values()) total += t.audio.byteLength + t.contour.byteLength;
  return total;
}
