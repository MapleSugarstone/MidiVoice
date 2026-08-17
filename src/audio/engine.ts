import * as Tone from 'tone';
import { createInstrument, type PlayableInstrument } from './instruments';
import { midiToFreq } from '../model/music';
import type { Project, Track } from '../model/types';

interface Channel {
  trackId: string;
  instrumentId: string;
  instrument: PlayableInstrument;
  panner: Tone.Panner;
  volume: Tone.Volume;
  send: Tone.Gain;
  part: Tone.Part | null;
}

/** Where the transport was, and when, in AudioContext time. */
export interface TransportAnchor {
  contextTime: number;
  transportSeconds: number;
}

class AudioEngine {
  private channels = new Map<string, Channel>();
  private master!: Tone.Gain;
  private reverb!: Tone.Reverb;
  private limiter!: Tone.Limiter;
  private click!: Tone.Synth;
  private calClick!: Tone.Synth;
  private metronomeId: number | null = null;
  private metronomeVolume = 0.7;

  ready = false;
  anchor: TransportAnchor | null = null;
  metronomeEnabled = true;
  /** UI hook: a note was auditioned (preview or live MIDI), for key lighting. */
  onAudition: ((midi: number, on: boolean, durationSec?: number) => void) | null = null;
  private beatsPerBar = 4;

  async init(): Promise<void> {
    if (this.ready) return;
    // Tone builds its own context through standardized-audio-context. Leave it
    // alone: substituting a native AudioContext makes Tone run in a shape it
    // isn't normally exercised in, and that breaks differently per browser.
    // The recorder adapts to whatever context Tone chose instead.
    await Tone.start();

    this.limiter = new Tone.Limiter(-1).toDestination();
    this.master = new Tone.Gain(0.9).connect(this.limiter);
    this.reverb = new Tone.Reverb({ decay: 2.4, preDelay: 0.02, wet: 1 }).connect(this.master);
    this.click = new Tone.Synth({
      oscillator: { type: 'square' },
      envelope: { attack: 0.001, decay: 0.03, sustain: 0, release: 0.02 },
      volume: -14,
    }).connect(this.master);
    this.applyMetronomeVolume();
    // Calibration keeps its own click at a fixed level, so it still works with
    // the metronome turned down to silent.
    this.calClick = new Tone.Synth({
      oscillator: { type: 'square' },
      envelope: { attack: 0.001, decay: 0.03, sustain: 0, release: 0.02 },
      volume: -8,
    }).connect(this.master);

    const transport = Tone.getTransport();
    transport.PPQ = 192;
    this.ready = true;
    this.applyLoop();
  }

  get ppq(): number {
    return Tone.getTransport().PPQ;
  }

  /** Output-side latency the browser will admit to, in ms (mic input latency is rarely reported, but this beats starting from zero). */
  get outputLatencyMs(): number {
    if (!this.ready) return 0;
    const ctx = Tone.getContext().rawContext as unknown as Partial<AudioContext>;
    const base = typeof ctx.baseLatency === 'number' ? ctx.baseLatency : 0;
    const output = typeof ctx.outputLatency === 'number' ? ctx.outputLatency : 0;
    return (base + output) * 1000;
  }

  /** The shared AudioContext, possibly a standardized-audio-context wrapper rather than a native one. */
  get context(): AudioContext {
    return Tone.getContext().rawContext as unknown as AudioContext;
  }

  /** Master output node, tapped by the recorder for latency calibration. */
  get masterNode(): Tone.Gain {
    return this.master;
  }

  setMasterVolume(gain: number) {
    if (this.ready) this.master.gain.rampTo(gain, 0.05);
  }

  setMetronomeVolume(v: number) {
    this.metronomeVolume = Math.max(0, Math.min(1, v));
    if (this.ready) this.applyMetronomeVolume();
  }

  private applyMetronomeVolume() {
    const v = this.metronomeVolume;
    this.click.volume.value = v === 0 ? -Infinity : -34 + 28 * v;
  }

  /** The reverb bus stays fully wet, with per-channel send levels setting the amount. */
  setReverbAmount(amount: number) {
    this.reverbAmount = amount;
    if (!this.ready) return;
    const anySolo = this.lastTracks.some((t) => t.solo);
    for (const ch of this.channels.values()) {
      const track = this.lastTracks.find((t) => t.id === ch.trackId);
      const audible = track ? !track.muted && (!anySolo || track.solo) : true;
      ch.send.gain.rampTo(audible ? this.sendLevel(ch.instrument, amount) : 0, 0.05);
    }
  }

  private reverbAmount = 0.35;
  private lastTracks: Track[] = [];

  private sendLevel(inst: PlayableInstrument, amount: number): number {
    return inst.reverbSend * amount;
  }

  /** Create/destroy/update channel strips so they match the project's tracks. */
  syncTracks(tracks: Track[]) {
    if (!this.ready) return;
    this.lastTracks = tracks;

    const wanted = new Set(tracks.map((t) => t.id));
    for (const [id, ch] of this.channels) {
      if (!wanted.has(id)) {
        ch.part?.dispose();
        ch.instrument.dispose();
        ch.panner.dispose();
        ch.volume.dispose();
        ch.send.dispose();
        this.channels.delete(id);
      }
    }

    const anySolo = tracks.some((t) => t.solo);

    for (const track of tracks) {
      let ch = this.channels.get(track.id);

      if (ch && ch.instrumentId !== track.instrument) {
        ch.instrument.dispose();
        const instrument = createInstrument(track.instrument);
        instrument.output.connect(ch.panner);
        instrument.output.connect(ch.send);
        ch.instrument = instrument;
        ch.instrumentId = track.instrument;
      }

      if (!ch) {
        const volume = new Tone.Volume(track.volume).connect(this.master);
        const panner = new Tone.Panner(track.pan).connect(volume);
        const send = new Tone.Gain(0).connect(this.reverb);
        const instrument = createInstrument(track.instrument);
        instrument.output.connect(panner);
        instrument.output.connect(send);
        ch = {
          trackId: track.id,
          instrumentId: track.instrument,
          instrument,
          panner,
          volume,
          send,
          part: null,
        };
        this.channels.set(track.id, ch);
      }

      const audible = !track.muted && (!anySolo || track.solo);
      ch.volume.volume.rampTo(audible ? track.volume : -Infinity, 0.03);
      ch.panner.pan.rampTo(track.pan, 0.03);
      ch.send.gain.rampTo(
        audible ? this.sendLevel(ch.instrument, this.reverbAmount) : 0,
        0.03,
      );
    }
  }

  /**
   * Rebuild the scheduled parts. Event times are expressed in transport TICKS
   * so changing the tempo re-times everything for free.
   */
  scheduleProject(project: Project) {
    if (!this.ready) return;
    const ppq = this.ppq;

    for (const track of project.tracks) {
      const ch = this.channels.get(track.id);
      if (!ch) continue;

      ch.part?.dispose();

      const events = track.notes.filter((n) => n.start >= 0).map((note) => {
        // Playback is always at the exact stored semitone.
        const freq = midiToFreq(note.midi);
        return {
          time: `${Math.round(note.start * ppq)}i`,
          freq,
          midi: note.midi,
          durationTicks: Math.max(1, Math.round(note.duration * ppq)),
          // Notes have no individual volume; the track's volume fader is the only level control.
          velocity: 0.8,
        };
      });

      const part = new Tone.Part((time, value: any) => {
        ch.instrument.trigger(value.freq, value.midi, `${value.durationTicks}i`, time, value.velocity);
      }, events);
      part.start(0);
      ch.part = part;
    }
  }

  setBpm(bpm: number) {
    if (this.ready) Tone.getTransport().bpm.value = bpm;
  }

  setBeatsPerBar(n: number) {
    this.beatsPerBar = n;
    if (this.ready) Tone.getTransport().timeSignature = n;
  }

  private wantedLoop = { enabled: false, startBeat: 0, endBeat: 0 };
  private loopSuspended = false;

  setLoop(enabled: boolean, startBeat: number, endBeat: number) {
    this.wantedLoop = { enabled, startBeat, endBeat };
    this.applyLoop();
  }

  /** Keep the transport's loop matching the project's, wherever the project changed. */
  setProjectLoop(project: Project) {
    this.setLoop(project.loopEnabled, project.loopStartBeat, project.loopEndBeat);
  }

  /**
   * Hold looping off without forgetting the user's range, so a take can't be
   * recorded twice over the same bars and the loop returns afterwards.
   */
  setLoopSuspended(suspended: boolean) {
    this.loopSuspended = suspended;
    this.applyLoop();
  }

  private appliedLoop = { on: false, startBeat: -1, endBeat: -1 };

  private applyLoop() {
    if (!this.ready) return;
    const { enabled, startBeat, endBeat } = this.wantedLoop;
    const on = enabled && !this.loopSuspended && endBeat > startBeat;
    // Transport.loop is a timeline of values, so only write when it changed.
    const next = { on, startBeat: on ? startBeat : -1, endBeat: on ? endBeat : -1 };
    const prev = this.appliedLoop;
    if (next.on === prev.on && next.startBeat === prev.startBeat && next.endBeat === prev.endBeat) return;
    this.appliedLoop = next;

    const t = Tone.getTransport();
    if (on) {
      t.loopStart = `${Math.round(startBeat * this.ppq)}i`;
      t.loopEnd = `${Math.round(endBeat * this.ppq)}i`;
    }
    t.loop = on;
  }

  private startMetronome() {
    if (this.metronomeId !== null) return;
    const transport = Tone.getTransport();
    this.metronomeId = transport.scheduleRepeat((time) => {
      if (!this.metronomeEnabled) return;
      const beat = Math.round(transport.getTicksAtTime(time) / this.ppq);
      const accent = ((beat % this.beatsPerBar) + this.beatsPerBar) % this.beatsPerBar === 0;
      this.click.triggerAttackRelease(accent ? 1760 : 1170, 0.02, time, accent ? 0.9 : 0.55);
    }, '4n');
  }

  private stopMetronome() {
    if (this.metronomeId !== null) {
      Tone.getTransport().clear(this.metronomeId);
      this.metronomeId = null;
    }
  }

  /**
   * Start playback at `startBeat`, optionally preceded by a count-in.
   *
   * If there isn't enough song before the punch point to hold the count-in, the
   * remaining clicks are played in real time before the transport starts, so
   * you always get the full count even when recording from bar 1.
   */
  play(startBeat: number, countInBeats = 0, bpm = 120): { audioStartTime: number } {
    if (!this.ready) return { audioStartTime: 0 };
    const transport = Tone.getTransport();
    this.startMetronome();

    const preRoll = Math.min(countInBeats, startBeat);
    const transportStart = startBeat - preRoll;
    const extraBeats = Math.max(0, countInBeats - preRoll);
    const beatSec = 60 / bpm;

    const now = Tone.now() + 0.15;
    for (let i = 0; i < extraBeats; i++) {
      const accent = i % this.beatsPerBar === 0;
      if (this.metronomeEnabled) {
        this.click.triggerAttackRelease(accent ? 1760 : 1170, 0.02, now + i * beatSec, accent ? 0.9 : 0.55);
      }
    }

    const audioStartTime = now + extraBeats * beatSec;
    transport.start(audioStartTime, `${Math.round(transportStart * this.ppq)}i`);

    this.anchor = {
      contextTime: audioStartTime,
      transportSeconds: (transportStart * 60) / bpm,
    };

    return { audioStartTime };
  }

  stop() {
    if (!this.ready) return;
    Tone.getTransport().stop();
    this.stopMetronome();
    this.anchor = null;
    for (const ch of this.channels.values()) ch.instrument.releaseAll();
  }

  pause() {
    if (!this.ready) return;
    Tone.getTransport().pause();
    this.anchor = null;
    for (const ch of this.channels.values()) ch.instrument.releaseAll();
  }

  seek(beat: number) {
    if (!this.ready) return;
    const t = Tone.getTransport();
    const target = Math.max(0, beat);
    t.ticks = Math.round(target * this.ppq);
    if (t.state === 'started') {
      // Notes already sounding belong to the place we just left.
      for (const ch of this.channels.values()) ch.instrument.releaseAll();
      this.anchor = { contextTime: Tone.now(), transportSeconds: (target * 60) / t.bpm.value };
    }
  }

  get positionBeats(): number {
    if (!this.ready) return 0;
    return Tone.getTransport().ticks / this.ppq;
  }

  get isPlaying(): boolean {
    return this.ready && Tone.getTransport().state === 'started';
  }

  /** Convert an AudioContext timestamp into a transport position in seconds. */
  contextTimeToTransportSeconds(contextTime: number): number | null {
    if (!this.anchor) return null;
    return this.anchor.transportSeconds + (contextTime - this.anchor.contextTime);
  }

  /** Held-note input from a MIDI keyboard: sound follows key down/up. */
  liveNoteOn(trackId: string, midi: number, _velocity: number) {
    const ch = this.channels.get(trackId);
    if (!ch) return;
    const freq = midiToFreq(midi);
    // Uniform level to match playback, where notes carry no individual volume.
    if (ch.instrument.noteOn) ch.instrument.noteOn(freq, midi, 0.8);
    else ch.instrument.trigger(freq, midi, 0.4, Tone.now(), 0.8);
    this.onAudition?.(midi, true);
  }

  liveNoteOff(trackId: string, midi: number) {
    const ch = this.channels.get(trackId);
    if (!ch) return;
    ch.instrument.noteOff?.(midiToFreq(midi), midi);
    this.onAudition?.(midi, false);
  }

  /** Audition a single note, e.g. when dragging it in the piano roll. */
  preview(trackId: string, midi: number, detune = 0, duration = 0.35) {
    const ch = this.channels.get(trackId);
    if (!ch) return;
    const freq = midiToFreq(midi + detune / 100);
    ch.instrument.trigger(freq, midi, duration, Tone.now(), 0.8);
    this.onAudition?.(midi, true, duration);
  }

  /** Latency calibration click, played at an exact audio-context time. */
  calibrationClick(time: number) {
    if (!this.ready) return;
    this.calClick.triggerAttackRelease(2000, 0.01, time, 1);
  }
}

export const engine = new AudioEngine();
