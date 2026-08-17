import * as Tone from 'tone';
import type { InstrumentId } from '../model/types';

export interface InstrumentDef {
  id: InstrumentId;
  label: string;
  group: string;
}

export const INSTRUMENTS: InstrumentDef[] = [
  { id: 'grandPiano', label: 'Grand Piano', group: 'Keys' },
  { id: 'electricPiano', label: 'Electric Piano', group: 'Keys' },
  { id: 'organ', label: 'Organ', group: 'Keys' },
  { id: 'marimba', label: 'Marimba', group: 'Keys' },
  { id: 'bell', label: 'Bells', group: 'Keys' },
  { id: 'nylonGuitar', label: 'Nylon Guitar', group: 'Plucked' },
  { id: 'cleanGuitar', label: 'Clean Guitar', group: 'Plucked' },
  { id: 'pluck', label: 'Pluck / Harp', group: 'Plucked' },
  { id: 'fingerBass', label: 'Finger Bass', group: 'Bass' },
  { id: 'synthBass', label: 'Synth Bass', group: 'Bass' },
  { id: 'subBass', label: 'Sub Bass', group: 'Bass' },
  { id: 'strings', label: 'Strings', group: 'Sustained' },
  { id: 'warmPad', label: 'Warm Pad', group: 'Sustained' },
  { id: 'brass', label: 'Brass', group: 'Sustained' },
  { id: 'choir', label: 'Choir Aah', group: 'Sustained' },
  { id: 'sawLead', label: 'Saw Lead', group: 'Lead' },
  { id: 'squareLead', label: 'Square Lead', group: 'Lead' },
  { id: 'drumKit', label: 'Drum Kit', group: 'Drums' },
];

export interface PlayableInstrument {
  /** `note` is a frequency in Hz so we can play microtonal (as-sung) pitches. */
  trigger(note: number, midi: number, duration: Tone.Unit.Time, time: Tone.Unit.Time, velocity: number): void;
  /** Held-note input (MIDI keyboard). One-shot instruments omit these. */
  noteOn?(note: number, midi: number, velocity: number): void;
  noteOff?(note: number, midi: number): void;
  output: Tone.ToneAudioNode;
  releaseAll(): void;
  dispose(): void;
  /** Default reverb send for this preset, 0..1. */
  reverbSend: number;
}

/**
 * Round-robin pool of monophonic voices. Needed for instruments Tone's
 * PolySynth can't wrap (PluckSynth isn't a Monophonic subclass).
 */
class VoicePool implements PlayableInstrument {
  private voices: Tone.PluckSynth[] = [];
  private idx = 0;
  output: Tone.Gain;
  reverbSend: number;

  constructor(factory: () => Tone.PluckSynth, count: number, reverbSend: number) {
    this.output = new Tone.Gain(1);
    this.reverbSend = reverbSend;
    for (let i = 0; i < count; i++) {
      const v = factory();
      v.connect(this.output);
      this.voices.push(v);
    }
  }

  trigger(note: number, _midi: number, duration: Tone.Unit.Time, time: Tone.Unit.Time, velocity: number) {
    const v = this.voices[this.idx % this.voices.length];
    this.idx++;
    v.triggerAttackRelease(note, duration, time, velocity);
  }

  releaseAll() {
    for (const v of this.voices) {
      try {
        (v as any).triggerRelease?.(Tone.now());
      } catch {
        /* voice wasn't playing */
      }
    }
  }

  dispose() {
    for (const v of this.voices) v.dispose();
    this.output.dispose();
  }
}

class PolyInstrument implements PlayableInstrument {
  private synth: Tone.PolySynth<any>;
  output: Tone.ToneAudioNode;
  reverbSend: number;

  constructor(synth: Tone.PolySynth<any>, reverbSend: number, chain: Tone.ToneAudioNode[] = []) {
    this.synth = synth;
    this.reverbSend = reverbSend;
    if (chain.length) {
      let node: Tone.ToneAudioNode = synth;
      for (const fx of chain) {
        node.connect(fx);
        node = fx;
      }
      this.output = node;
    } else {
      this.output = synth;
    }
  }

  trigger(note: number, _midi: number, duration: Tone.Unit.Time, time: Tone.Unit.Time, velocity: number) {
    this.synth.triggerAttackRelease(note, duration, time, velocity);
  }

  noteOn(note: number, _midi: number, velocity: number) {
    this.synth.triggerAttack(note, Tone.now(), velocity);
  }

  noteOff(note: number) {
    this.synth.triggerRelease(note, Tone.now());
  }

  releaseAll() {
    this.synth.releaseAll();
  }

  dispose() {
    this.synth.dispose();
  }
}

/**
 * Synthesised drum kit keyed by General MIDI note number. Sample-free so the
 * app works offline and loads instantly.
 */
class DrumKit implements PlayableInstrument {
  output: Tone.Gain;
  reverbSend = 0.12;

  private kick: Tone.MembraneSynth;
  private tom: Tone.MembraneSynth;
  private snare: Tone.NoiseSynth;
  private snareTone: Tone.Synth;
  private clap: Tone.NoiseSynth;
  private hatClosed: Tone.MetalSynth;
  private hatOpen: Tone.MetalSynth;
  private crash: Tone.MetalSynth;

  constructor() {
    this.output = new Tone.Gain(1);

    this.kick = new Tone.MembraneSynth({
      pitchDecay: 0.035,
      octaves: 6,
      envelope: { attack: 0.001, decay: 0.42, sustain: 0, release: 0.1 },
    }).connect(this.output);

    this.tom = new Tone.MembraneSynth({
      pitchDecay: 0.06,
      octaves: 3,
      envelope: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.1 },
    }).connect(this.output);

    const snareFilter = new Tone.Filter(1400, 'bandpass').connect(this.output);
    this.snare = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.16, sustain: 0, release: 0.03 },
    }).connect(snareFilter);
    this.snareTone = new Tone.Synth({
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.001, decay: 0.09, sustain: 0, release: 0.02 },
      volume: -12,
    }).connect(this.output);

    const clapFilter = new Tone.Filter(1100, 'bandpass').connect(this.output);
    this.clap = new Tone.NoiseSynth({
      noise: { type: 'pink' },
      envelope: { attack: 0.002, decay: 0.22, sustain: 0, release: 0.05 },
    }).connect(clapFilter);

    const hatFilter = new Tone.Filter(7000, 'highpass').connect(this.output);
    this.hatClosed = new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: 0.045, release: 0.01 },
      harmonicity: 5.1,
      modulationIndex: 32,
      resonance: 6000,
      octaves: 1.5,
      volume: -18,
    }).connect(hatFilter);
    this.hatOpen = new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: 0.4, release: 0.2 },
      harmonicity: 5.1,
      modulationIndex: 32,
      resonance: 5000,
      octaves: 1.5,
      volume: -20,
    }).connect(hatFilter);
    this.crash = new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: 1.6, release: 0.6 },
      harmonicity: 3.4,
      modulationIndex: 24,
      resonance: 3000,
      octaves: 2,
      volume: -22,
    }).connect(hatFilter);
  }

  /**
   * One-shot percussion voices are monophonic: Tone throws if the same voice is
   * retriggered at a time that isn't strictly later than its last hit. Two
   * copies of a hit on the same beat is a normal thing for a user to end up
   * with, so drop the duplicate rather than letting it kill playback.
   */
  private lastHit = new Map<string, number>();

  private gate(voice: string, time: Tone.Unit.Time): boolean {
    if (typeof time !== 'number') return true;
    const last = this.lastHit.get(voice);
    if (last !== undefined && time <= last) return false;
    this.lastHit.set(voice, time);
    return true;
  }

  trigger(_note: number, midi: number, duration: Tone.Unit.Time, time: Tone.Unit.Time, velocity: number) {
    switch (midi) {
      case 36:
      case 35:
        if (this.gate('kick', time)) this.kick.triggerAttackRelease(55, '8n', time, velocity);
        break;
      case 38:
      case 40:
        if (this.gate('snare', time)) {
          this.snare.triggerAttackRelease('16n', time, velocity);
          this.snareTone.triggerAttackRelease(190, '32n', time, velocity * 0.7);
        }
        break;
      case 39:
        if (this.gate('clap', time)) this.clap.triggerAttackRelease('16n', time, velocity);
        break;
      case 42:
      case 44:
        // MetalSynth is a Monophonic instrument: note comes first, then length.
        if (this.gate('hatClosed', time)) this.hatClosed.triggerAttackRelease(400, '64n', time, velocity);
        break;
      case 46:
        if (this.gate('hatOpen', time)) this.hatOpen.triggerAttackRelease(400, '8n', time, velocity);
        break;
      case 49:
      case 51:
      case 57:
        if (this.gate('crash', time)) this.crash.triggerAttackRelease(300, '2n', time, velocity);
        break;
      case 41:
      case 43:
      case 45:
      case 47:
      case 48:
      case 50: {
        // Toms follow the note number so several lanes give different pitches.
        const freq = 90 * Math.pow(2, (midi - 45) / 12);
        if (this.gate('tom', time)) this.tom.triggerAttackRelease(freq, '8n', time, velocity);
        break;
      }
      default:
        if (this.gate('snare', time)) this.snare.triggerAttackRelease('16n', time, velocity);
    }
  }

  releaseAll() {
    /* percussion is one-shot, nothing to release */
  }

  dispose() {
    this.kick.dispose();
    this.tom.dispose();
    this.snare.dispose();
    this.snareTone.dispose();
    this.clap.dispose();
    this.hatClosed.dispose();
    this.hatOpen.dispose();
    this.crash.dispose();
    this.output.dispose();
  }
}

/** Output trim per preset in dB, measured offline against a common 0.22 peak so changing instrument does not change how loud a part is (the raw patches spanned 32 dB). */
const TRIM_DB: Record<InstrumentId, number> = {
  grandPiano: 6.7,
  electricPiano: 6.1,
  organ: 0.9,
  marimba: 5.9,
  bell: 12.7,
  nylonGuitar: 0.8,
  cleanGuitar: -4.1,
  pluck: 1.7,
  fingerBass: -7.9,
  synthBass: -5.6,
  subBass: -5.4,
  strings: 6.1,
  warmPad: 18.6,
  brass: 1.6,
  choir: 19.1,
  sawLead: 9.2,
  squareLead: 5.3,
  drumKit: -12.1,
};

/** Wraps an instrument in its calibration trim. */
class Trimmed implements PlayableInstrument {
  private inner: PlayableInstrument;
  private trim: Tone.Volume;
  output: Tone.ToneAudioNode;

  constructor(inner: PlayableInstrument, trimDb: number) {
    this.inner = inner;
    this.trim = new Tone.Volume(trimDb);
    inner.output.connect(this.trim);
    this.output = this.trim;
  }

  get reverbSend(): number {
    return this.inner.reverbSend;
  }

  set reverbSend(v: number) {
    this.inner.reverbSend = v;
  }

  trigger(note: number, midi: number, duration: Tone.Unit.Time, time: Tone.Unit.Time, velocity: number) {
    this.inner.trigger(note, midi, duration, time, velocity);
  }

  noteOn(note: number, midi: number, velocity: number) {
    if (this.inner.noteOn) this.inner.noteOn(note, midi, velocity);
    else this.inner.trigger(note, midi, 0.4, Tone.now(), velocity);
  }

  noteOff(note: number, midi: number) {
    this.inner.noteOff?.(note, midi);
  }

  releaseAll() {
    this.inner.releaseAll();
  }

  dispose() {
    this.inner.dispose();
    this.trim.dispose();
  }
}

export function createInstrument(id: InstrumentId): PlayableInstrument {
  return new Trimmed(createRawInstrument(id), TRIM_DB[id] ?? 0);
}

function createRawInstrument(id: InstrumentId): PlayableInstrument {
  switch (id) {
    case 'grandPiano':
      return new PolyInstrument(
        new Tone.PolySynth(Tone.FMSynth, {
          harmonicity: 3.01,
          modulationIndex: 12,
          oscillator: { type: 'triangle' },
          envelope: { attack: 0.002, decay: 1.4, sustain: 0.04, release: 1.1 },
          modulation: { type: 'square' },
          modulationEnvelope: { attack: 0.002, decay: 0.3, sustain: 0, release: 0.1 },
          volume: -8,
        }),
        0.18,
      );

    case 'electricPiano':
      return new PolyInstrument(
        new Tone.PolySynth(Tone.FMSynth, {
          harmonicity: 2.0,
          modulationIndex: 5,
          oscillator: { type: 'sine' },
          envelope: { attack: 0.003, decay: 1.8, sustain: 0.12, release: 0.9 },
          modulation: { type: 'sine' },
          modulationEnvelope: { attack: 0.004, decay: 0.6, sustain: 0.1, release: 0.4 },
          volume: -8,
        }),
        0.15,
        [new Tone.Chorus(1.6, 2.5, 0.3).start()],
      );

    case 'organ':
      return new PolyInstrument(
        new Tone.PolySynth(Tone.Synth, {
          oscillator: { type: 'sine4' },
          envelope: { attack: 0.012, decay: 0.05, sustain: 0.95, release: 0.12 },
          volume: -12,
        }),
        0.14,
      );

    case 'marimba':
      return new PolyInstrument(
        new Tone.PolySynth(Tone.FMSynth, {
          harmonicity: 4.01,
          modulationIndex: 3,
          oscillator: { type: 'sine' },
          envelope: { attack: 0.001, decay: 0.55, sustain: 0, release: 0.4 },
          modulation: { type: 'sine' },
          modulationEnvelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.1 },
          volume: -7,
        }),
        0.2,
      );

    case 'bell':
      return new PolyInstrument(
        new Tone.PolySynth(Tone.FMSynth, {
          harmonicity: 8.5,
          modulationIndex: 18,
          oscillator: { type: 'sine' },
          envelope: { attack: 0.001, decay: 2.6, sustain: 0, release: 2.2 },
          modulation: { type: 'sine' },
          modulationEnvelope: { attack: 0.001, decay: 0.9, sustain: 0, release: 0.6 },
          volume: -14,
        }),
        0.32,
      );

    case 'nylonGuitar':
      return new VoicePool(
        () => new Tone.PluckSynth({ attackNoise: 0.6, dampening: 3200, resonance: 0.94, volume: -4 }),
        10,
        0.18,
      );

    case 'cleanGuitar':
      return new VoicePool(
        () => new Tone.PluckSynth({ attackNoise: 1.4, dampening: 5200, resonance: 0.97, volume: -4 }),
        10,
        0.16,
      );

    case 'pluck':
      return new VoicePool(
        () => new Tone.PluckSynth({ attackNoise: 0.3, dampening: 6500, resonance: 0.98, volume: -5 }),
        12,
        0.28,
      );

    case 'fingerBass':
      return new PolyInstrument(
        new Tone.PolySynth(Tone.MonoSynth, {
          oscillator: { type: 'fmsquare', modulationType: 'triangle', modulationIndex: 1.6 } as any,
          envelope: { attack: 0.008, decay: 0.35, sustain: 0.35, release: 0.25 },
          filter: { Q: 2, type: 'lowpass', rolloff: -24 },
          filterEnvelope: { attack: 0.005, decay: 0.22, sustain: 0.2, release: 0.3, baseFrequency: 90, octaves: 3.2 },
          volume: -8,
        }),
        0.05,
      );

    case 'synthBass':
      return new PolyInstrument(
        new Tone.PolySynth(Tone.MonoSynth, {
          oscillator: { type: 'sawtooth' },
          envelope: { attack: 0.004, decay: 0.25, sustain: 0.5, release: 0.2 },
          filter: { Q: 3, type: 'lowpass', rolloff: -24 },
          filterEnvelope: { attack: 0.004, decay: 0.16, sustain: 0.25, release: 0.2, baseFrequency: 70, octaves: 3.6 },
          volume: -10,
        }),
        0.04,
      );

    case 'subBass':
      return new PolyInstrument(
        new Tone.PolySynth(Tone.Synth, {
          oscillator: { type: 'sine' },
          envelope: { attack: 0.012, decay: 0.2, sustain: 0.9, release: 0.25 },
          volume: -6,
        }),
        0.0,
      );

    case 'strings':
      return new PolyInstrument(
        new Tone.PolySynth(Tone.Synth, {
          oscillator: { type: 'fatsawtooth', count: 3, spread: 24 } as any,
          envelope: { attack: 0.16, decay: 0.3, sustain: 0.85, release: 0.9 },
          volume: -18,
        }),
        0.4,
        [new Tone.Filter(3200, 'lowpass'), new Tone.Chorus(0.8, 3.5, 0.4).start()],
      );

    case 'warmPad':
      return new PolyInstrument(
        new Tone.PolySynth(Tone.AMSynth, {
          harmonicity: 2.2,
          oscillator: { type: 'sine' },
          envelope: { attack: 0.6, decay: 0.5, sustain: 0.9, release: 1.8 },
          modulation: { type: 'sine' },
          modulationEnvelope: { attack: 1.2, decay: 0.4, sustain: 0.7, release: 1.5 },
          volume: -16,
        }),
        0.5,
        [new Tone.Chorus(0.5, 4, 0.5).start()],
      );

    case 'brass':
      return new PolyInstrument(
        new Tone.PolySynth(Tone.MonoSynth, {
          oscillator: { type: 'sawtooth' },
          envelope: { attack: 0.055, decay: 0.2, sustain: 0.75, release: 0.25 },
          filter: { Q: 1.5, type: 'lowpass', rolloff: -12 },
          filterEnvelope: { attack: 0.07, decay: 0.25, sustain: 0.6, release: 0.3, baseFrequency: 260, octaves: 3 },
          volume: -14,
        }),
        0.25,
      );

    case 'choir':
      return new PolyInstrument(
        new Tone.PolySynth(Tone.AMSynth, {
          harmonicity: 1.5,
          oscillator: { type: 'sine2' },
          envelope: { attack: 0.28, decay: 0.4, sustain: 0.85, release: 1.1 },
          modulation: { type: 'triangle' },
          modulationEnvelope: { attack: 0.4, decay: 0.3, sustain: 0.6, release: 0.9 },
          volume: -16,
        }),
        0.45,
        [new Tone.Vibrato(4.6, 0.06), new Tone.Filter(2600, 'lowpass')],
      );

    case 'sawLead':
      return new PolyInstrument(
        new Tone.PolySynth(Tone.Synth, {
          oscillator: { type: 'fatsawtooth', count: 2, spread: 16 } as any,
          envelope: { attack: 0.01, decay: 0.18, sustain: 0.65, release: 0.2 },
          volume: -16,
        }),
        0.22,
        [new Tone.Filter(5200, 'lowpass')],
      );

    case 'squareLead':
      return new PolyInstrument(
        new Tone.PolySynth(Tone.Synth, {
          oscillator: { type: 'square' },
          envelope: { attack: 0.006, decay: 0.14, sustain: 0.6, release: 0.16 },
          volume: -18,
        }),
        0.2,
        [new Tone.Filter(4200, 'lowpass')],
      );

    case 'drumKit':
      return new DrumKit();

    default:
      return new PolyInstrument(new Tone.PolySynth(Tone.Synth), 0.2);
  }
}
