/**
 * Main-thread entry point for transcription. Work goes to a background worker
 * so the UI stays live during "Transcribing…"; anything that stops the worker
 * (no OffscreenCanvas for WebGL, a crash, a blocked script) falls back to the
 * same pipeline on the main thread, which is the old behaviour.
 */
import { transcribeAsync as transcribeLocal, type AsyncTranscriptionResult } from './transcribe';
import type { TranscribeSettings } from '../model/types';
import type { WorkerRequest, WorkerResponse } from './transcribeWorker';

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (r: AsyncTranscriptionResult) => void; reject: (err: Error) => void }
>();

/** The neural model needs WebGL, which inside a worker rides on OffscreenCanvas. */
function workerSupported(): boolean {
  return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
}

/** Absolute model URL: the worker cannot resolve the app's relative base itself. */
function modelUrl(): string {
  return new URL(`${import.meta.env.BASE_URL}basic-pitch/model.json`, document.baseURI).href;
}

function failAll(err: Error) {
  workerBroken = true;
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./transcribeWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if ('result' in e.data) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error));
    };
    worker.onerror = (e) => failAll(new Error(e.message || 'transcription worker crashed'));
  }
  return worker;
}

function post(msg: WorkerRequest) {
  getWorker().postMessage(msg);
}

export async function transcribeAsync(
  audio: Float32Array,
  sampleRate: number,
  settings: TranscribeSettings,
): Promise<AsyncTranscriptionResult> {
  if (workerBroken || !workerSupported()) return transcribeLocal(audio, sampleRate, settings);
  try {
    return await new Promise<AsyncTranscriptionResult>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      post({ type: 'transcribe', id, audio, sampleRate, settings, modelUrl: modelUrl() });
    });
  } catch (err) {
    console.warn('Transcription worker unavailable; running on the main thread.', err);
    return transcribeLocal(audio, sampleRate, settings);
  }
}

/** Fetch and warm the neural model wherever the next take will actually run. */
export function preloadTranscription(): void {
  if (workerBroken || !workerSupported()) {
    void import('./neuralPitch').then((m) => m.preloadNeural()).catch(() => {});
    return;
  }
  try {
    post({ type: 'preload', modelUrl: modelUrl() });
  } catch {
    /* the take itself will fall back */
  }
}
