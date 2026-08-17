import * as Tone from 'tone';
import { createInstrument } from './instruments';
import { midiToFreq, snapToScale, beatsToSeconds } from '../model/music';
import type { Project } from '../model/types';

/** Encode an AudioBuffer as a 16-bit PCM WAV. */
export function audioBufferToWav(buffer: AudioBuffer): Blob {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  return pcmToWav(channels, buffer.sampleRate);
}

/** Encode raw take audio (mono) as a 16-bit PCM WAV. */
export function float32ToWav(samples: Float32Array, sampleRate: number): Blob {
  return pcmToWav([samples], sampleRate);
}

export function pcmToWav(channels: Float32Array[], sampleRate: number): Blob {
  const numChannels = channels.length;
  const frames = channels[0]?.length ?? 0;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = frames * blockAlign;

  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([out], { type: 'audio/wav' });
}

/**
 * Bounce the whole arrangement to audio offline (faster than real time).
 * Instruments are rebuilt inside the offline context, so this is independent
 * of whatever the live engine is currently doing.
 */
export async function renderProject(
  project: Project,
  reverbAmount: number,
  tailSeconds = 3,
): Promise<Blob> {
  let lastBeat = 0;
  for (const track of project.tracks) {
    for (const note of track.notes) lastBeat = Math.max(lastBeat, note.start + note.duration);
  }
  const duration = beatsToSeconds(lastBeat, project.bpm) + tailSeconds;
  if (duration <= tailSeconds) throw new Error('Nothing to render. The song is empty.');

  const buffer = await Tone.Offline(async (ctx) => {
    const limiter = new Tone.Limiter(-1).toDestination();
    const master = new Tone.Gain(0.9).connect(limiter);
    const reverb = new Tone.Reverb({ decay: 2.4, preDelay: 0.02, wet: 1 }).connect(master);
    await reverb.ready;

    const anySolo = project.tracks.some((t) => t.solo);

    for (const track of project.tracks) {
      const audible = !track.muted && (!anySolo || track.solo);
      if (!audible || track.notes.length === 0) continue;

      const volume = new Tone.Volume(track.volume).connect(master);
      const panner = new Tone.Panner(track.pan).connect(volume);
      const instrument = createInstrument(track.instrument);
      const send = new Tone.Gain(instrument.reverbSend * reverbAmount).connect(reverb);
      instrument.output.connect(panner);
      instrument.output.connect(send);

      for (const note of track.notes) {
        const playedMidi = track.snapToScale
          ? snapToScale(note.midi, project.keyRoot, project.scale)
          : note.midi;
        const cents = note.detune * (1 - track.tuneStrength);
        const freq = track.isDrum ? midiToFreq(playedMidi) : midiToFreq(playedMidi + cents / 100);
        const time = beatsToSeconds(note.start, project.bpm);
        if (time < 0) continue;
        instrument.trigger(
          freq,
          playedMidi,
          Math.max(0.02, beatsToSeconds(note.duration, project.bpm)),
          time,
          note.velocity,
        );
      }
    }

    ctx.transport.start(0);
  }, duration, 2);

  return audioBufferToWav(buffer.get() as AudioBuffer);
}
