/**
 * Microphone capture through an AudioWorklet.
 *
 * Every chunk carries the AudioContext timestamp of its first sample, which is
 * what lets a take be placed on the timeline to the sample rather than to
 * "whenever the message happened to arrive on the main thread".
 */

const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(2048);
    this._i = 0;
    this._t = 0;
    this._recording = false;
    this._peak = 0;
    this._sinceMeter = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'record') {
        this._recording = d.value;
        this._i = 0;
      } else if (d.type === 'flush') {
        if (this._i > 0) {
          this.port.postMessage({ type: 'audio', buf: this._buf.slice(0, this._i), time: this._t });
          this._i = 0;
        }
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;

    let peak = 0;
    for (let i = 0; i < ch.length; i++) {
      const a = ch[i] < 0 ? -ch[i] : ch[i];
      if (a > peak) peak = a;
    }
    if (peak > this._peak) this._peak = peak;
    this._sinceMeter += ch.length;
    if (this._sinceMeter >= 1024) {
      this.port.postMessage({ type: 'level', peak: this._peak });
      this._peak = 0;
      this._sinceMeter = 0;
    }

    if (this._recording) {
      let offset = 0;
      while (offset < ch.length) {
        if (this._i === 0) this._t = currentTime + offset / sampleRate;
        const n = Math.min(ch.length - offset, this._buf.length - this._i);
        this._buf.set(ch.subarray(offset, offset + n), this._i);
        this._i += n;
        offset += n;
        if (this._i === this._buf.length) {
          this.port.postMessage({ type: 'audio', buf: this._buf.slice(0), time: this._t });
          this._i = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
`;

/** Build an AudioWorkletNode on `ctx` via Tone's helper when the context is a standardized-audio-context wrapper, which the native constructor rejects. */
async function createWorkletNode(
  ctx: AudioContext,
  name: string,
  options: AudioWorkletNodeOptions,
): Promise<AudioWorkletNode> {
  const BaseCtx = (globalThis as { BaseAudioContext?: Function }).BaseAudioContext;
  if (BaseCtx && ctx instanceof BaseCtx && typeof AudioWorkletNode !== 'undefined') {
    return new AudioWorkletNode(ctx, name, options);
  }
  try {
    const mod = (await import('tone/build/esm/core/context/AudioContext.js')) as {
      createAudioWorkletNode?: (c: unknown, n: string, o: unknown) => AudioWorkletNode;
    };
    if (!mod.createAudioWorkletNode) throw new Error('helper missing');
    return mod.createAudioWorkletNode(ctx, name, options);
  } catch (err) {
    throw new Error(
      `this browser's audio context cannot host a recording worklet (${(err as Error).message}). ` +
        'AudioWorklet also requires a secure context. Use http://localhost or an https:// address, never a file:// path.',
    );
  }
}

/** Contexts with the capture processor registered, tracked because `registerProcessor` claims its name for the context's lifetime and re-arming the mic is normal. */
const moduleRegistered = new WeakSet<object>();

async function registerCaptureModule(ctx: AudioContext): Promise<void> {
  if (moduleRegistered.has(ctx)) return;
  // Blob URL rather than a served file so this works unchanged from a
  // GitHub Pages subpath.
  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
    moduleRegistered.add(ctx);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface RecordingResult {
  audio: Float32Array;
  sampleRate: number;
  /** AudioContext time of the first captured sample. */
  startContextTime: number;
}

export interface MicOptions {
  deviceId?: string;
  /** Browser DSP. Off by default: AGC and noise suppression wreck pitch tracking. */
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export const DEFAULT_MIC_OPTIONS: MicOptions = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

export class MicRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private chunks: { buf: Float32Array; time: number }[] = [];
  private capturing = false;
  private flushResolve: (() => void) | null = null;

  /** 0..1 input peak, updated continuously while armed. */
  level = 0;
  onLevel: ((level: number) => void) | null = null;

  get armed(): boolean {
    return this.node !== null;
  }

  async arm(ctx: AudioContext, options: MicOptions = DEFAULT_MIC_OPTIONS): Promise<void> {
    if (this.node) return;

    if (!window.isSecureContext) {
      throw new Error(
        'microphone capture needs a secure context. Open the app at http://localhost:5273 (npm run dev) or over https://, not from a file:// path.',
      );
    }

    this.ctx = ctx;

    const constraints: MediaStreamConstraints = {
      audio: {
        echoCancellation: options.echoCancellation,
        noiseSuppression: options.noiseSuppression,
        autoGainControl: options.autoGainControl,
        channelCount: 1,
        ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
      },
      video: false,
    };

    this.stream = await navigator.mediaDevices.getUserMedia(constraints);

    // If registration fails we still try to build the node: on a re-arm the
    // processor may already be present, which is a success, not an error.
    let moduleError: unknown = null;
    try {
      await registerCaptureModule(ctx);
    } catch (err) {
      moduleError = err;
    }

    try {
      this.node = await createWorkletNode(ctx, 'capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
      });
      moduleRegistered.add(ctx);
    } catch (err) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      throw moduleError ?? err;
    }

    this.node.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'audio') {
        if (this.capturing) this.chunks.push({ buf: d.buf as Float32Array, time: d.time as number });
      } else if (d.type === 'level') {
        this.level = d.peak;
        this.onLevel?.(d.peak);
      } else if (d.type === 'flushed') {
        this.flushResolve?.();
        this.flushResolve = null;
      }
    };

    this.source = ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.node);
  }

  /** Device the live stream is actually using, if it will say. */
  get activeDeviceId(): string | undefined {
    return this.stream?.getAudioTracks()[0]?.getSettings().deviceId;
  }

  /**
   * Change the browser's DSP settings on the live stream. Returns false if the
   * browser won't do it, in which case the caller should re-open the mic.
   * Preferred over a teardown because the meter keeps running and there's no
   * chance of leaving the user with a dead input.
   */
  async applyOptions(options: MicOptions): Promise<boolean> {
    const track = this.stream?.getAudioTracks()[0];
    if (!track || track.readyState !== 'live') return false;
    if (options.deviceId && options.deviceId !== this.activeDeviceId) return false;
    try {
      await track.applyConstraints({
        echoCancellation: options.echoCancellation,
        noiseSuppression: options.noiseSuppression,
        autoGainControl: options.autoGainControl,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Best guess at input latency in seconds, from the browser if it will say. */
  get inputLatencySec(): number {
    const track = this.stream?.getAudioTracks()[0];
    const settings = track?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined;
    const reported = settings?.latency;
    if (typeof reported === 'number' && reported > 0 && reported < 0.5) return reported;
    return 0;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  start(): void {
    if (!this.node) throw new Error('Recorder is not armed');
    this.chunks = [];
    this.capturing = true;
    this.node.port.postMessage({ type: 'record', value: true });
  }

  async stop(): Promise<RecordingResult> {
    if (!this.node) throw new Error('Recorder is not armed');
    this.node.port.postMessage({ type: 'record', value: false });

    await new Promise<void>((resolve) => {
      this.flushResolve = resolve;
      this.node!.port.postMessage({ type: 'flush' });
      // Don't hang forever if the worklet never answers.
      setTimeout(() => {
        if (this.flushResolve) {
          this.flushResolve = null;
          resolve();
        }
      }, 250);
    });

    this.capturing = false;

    const total = this.chunks.reduce((n, c) => n + c.buf.length, 0);
    const audio = new Float32Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      audio.set(c.buf, offset);
      offset += c.buf.length;
    }
    const startContextTime = this.chunks[0]?.time ?? 0;
    this.chunks = [];

    return { audio, sampleRate: this.sampleRate, startContextTime };
  }

  disarm(): void {
    this.capturing = false;
    this.chunks = [];
    try {
      this.node?.port.postMessage({ type: 'record', value: false });
    } catch {
      /* port already closed */
    }
    this.source?.disconnect();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source = null;
    this.node = null;
    this.stream = null;
    this.level = 0;
    // The worklet module stays registered on purpose: it can only register once, and re-arming reuses it.
  }
}

export async function listInputDevices(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  } catch {
    return [];
  }
}
