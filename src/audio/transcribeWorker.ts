/**
 * Runs the full transcription pipeline (classic and neural) off the main
 * thread. The neural model stays a dynamic import so classic-only sessions
 * never download TensorFlow. The model URL comes from the client because this
 * script is served from assets/ and the app builds with a relative base.
 */
import { transcribeAsync, type AsyncTranscriptionResult } from './transcribe';
import type { TranscribeSettings } from '../model/types';

export interface TranscribeRequest {
  type: 'transcribe';
  id: number;
  audio: Float32Array;
  sampleRate: number;
  settings: TranscribeSettings;
  modelUrl: string;
}

export interface PreloadRequest {
  type: 'preload';
  modelUrl: string;
}

export type WorkerRequest = TranscribeRequest | PreloadRequest;

export type WorkerResponse =
  | { id: number; result: AsyncTranscriptionResult }
  | { id: number; error: string };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(msg: WorkerResponse): void;
  addEventListener(type: string, cb: (e: { reason?: unknown; message?: string }) => void): void;
};

// tfjs 3.x probes `window` with a bare reference in its timer paths, which
// throws in a worker scope. Alias it before any model code can load.
(self as { window?: unknown }).window = self;

// Failures that escape a request's own try/catch (e.g. a detached tfjs
// polling loop) must not leave the client waiting forever: fail every
// in-flight request so it falls back to the main thread.
const inFlight = new Set<number>();
function failInFlight(reason: string) {
  for (const id of inFlight) ctx.postMessage({ id, error: reason });
  inFlight.clear();
}
ctx.addEventListener('unhandledrejection', (e) => {
  failInFlight(String((e.reason as Error)?.message ?? e.reason ?? 'worker failure'));
});
ctx.addEventListener('error', (e) => failInFlight(e.message ?? 'worker error'));

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;

  if (msg.type === 'preload') {
    try {
      const m = await import('./neuralPitch');
      m.setModelUrl(msg.modelUrl);
      await m.warmupNeural();
    } catch {
      /* the take itself will retry, and transcribeAsync falls back to classic */
    }
    return;
  }

  inFlight.add(msg.id);
  try {
    if (msg.settings.mode !== 'drums' && (msg.settings.engine ?? 'neural') === 'neural') {
      const m = await import('./neuralPitch');
      m.setModelUrl(msg.modelUrl);
    }
    const result = await transcribeAsync(msg.audio, msg.sampleRate, msg.settings);
    if (inFlight.has(msg.id)) ctx.postMessage({ id: msg.id, result });
  } catch (err) {
    if (inFlight.has(msg.id)) ctx.postMessage({ id: msg.id, error: (err as Error).message || String(err) });
  } finally {
    inFlight.delete(msg.id);
  }
};
