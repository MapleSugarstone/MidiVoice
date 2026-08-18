import { Midi } from '@tonejs/midi';
import type { InstrumentId, Project, Track } from './types';
import { beatsToSeconds, secondsToBeats } from './music';
import { makeProject, makeTrack, newId } from './store';
import { getTakeAudio, putTakeAudio } from '../audio/takeAudio';
import { float32ToWav } from '../audio/render';

/** Note volume is not editable per note; everything plays and exports at this level. */
export const FIXED_VELOCITY = 0.8;

/** General MIDI program numbers so exported files open with sensible sounds. */
const GM_PROGRAM: Record<InstrumentId, number> = {
  aeroKeys: 5, // Electric Piano 2 (the glassy DX one)
  bubblePluck: 102, // FX 7 (echoes)
  glassChime: 98, // FX 3 (crystal)
  aeroPad: 88, // Pad 1 (new age)
  skySaw: 90, // Pad 3 (polysynth)
  airFlute: 78, // Whistle
  waterDrop: 96, // FX 1 (rain)
  grandPiano: 0,
  electricPiano: 4,
  organ: 16,
  marimba: 12,
  bell: 14,
  nylonGuitar: 24,
  cleanGuitar: 27,
  pluck: 46,
  fingerBass: 33,
  synthBass: 38,
  subBass: 39,
  strings: 48,
  warmPad: 89,
  brass: 61,
  choir: 52,
  sawLead: 81,
  squareLead: 80,
  drumKit: 0,
};

/** Rough inverse of the above, for guessing an instrument on import. */
function instrumentFromProgram(program: number, isDrum: boolean): InstrumentId {
  if (isDrum) return 'drumKit';
  if (program <= 3) return 'grandPiano';
  if (program === 5) return 'aeroKeys';
  if (program <= 7) return 'electricPiano';
  if (program <= 15) return 'marimba';
  if (program <= 23) return 'organ';
  if (program <= 26) return 'nylonGuitar';
  if (program <= 31) return 'cleanGuitar';
  if (program <= 39) return 'fingerBass';
  if (program <= 47) return 'strings';
  if (program <= 55) return 'choir';
  if (program <= 63) return 'brass';
  if (program <= 71) return 'strings';
  if (program <= 79) return 'airFlute';
  if (program <= 87) return 'sawLead';
  if (program === 88) return 'aeroPad';
  if (program <= 95) return 'warmPad';
  if (program === 96) return 'waterDrop';
  if (program === 102) return 'bubblePluck';
  if (program <= 103) return 'glassChime';
  return 'warmPad';
}

export function projectToMidi(project: Project): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(project.bpm);
  midi.header.timeSignatures.push({
    ticks: 0,
    timeSignature: [project.beatsPerBar, 4],
  } as any);
  midi.header.name = project.name;

  let channel = 0;
  for (const track of project.tracks) {
    const t = midi.addTrack();
    t.name = track.name;
    if (track.isDrum) {
      t.channel = 9;
    } else {
      if (channel === 9) channel = 10;
      t.channel = channel % 16;
      channel++;
    }
    t.instrument.number = GM_PROGRAM[track.instrument] ?? 0;

    for (const note of track.notes) {
      t.addNote({
        midi: Math.max(0, Math.min(127, Math.round(note.midi))),
        time: beatsToSeconds(note.start, project.bpm),
        duration: Math.max(0.02, beatsToSeconds(note.duration, project.bpm)),
        velocity: FIXED_VELOCITY,
      });
    }
  }

  return midi.toArray();
}

/** Build MidiVoice tracks from a parsed MIDI file; startIndex drives naming and hue. */
function tracksFromMidi(midi: Midi, startIndex: number): Track[] {
  const bpm = Math.round((midi.header.tempos[0]?.bpm ?? 120) * 100) / 100;
  const tracks: Track[] = [];
  let index = startIndex;
  for (const t of midi.tracks) {
    if (t.notes.length === 0) continue;
    const isDrum = t.channel === 9;
    const track: Track = makeTrack(index, {
      name: t.name || (isDrum ? 'Drums' : `Track ${index + 1}`),
      isDrum,
      instrument: instrumentFromProgram(t.instrument?.number ?? 0, isDrum),
    });
    track.notes = t.notes.map((n) => ({
      id: newId(),
      start: secondsToBeats(n.time, bpm),
      duration: Math.max(1 / 32, secondsToBeats(n.duration, bpm)),
      midi: n.midi,
      velocity: n.velocity,
      detune: 0,
    }));
    tracks.push(track);
    index++;
  }
  return tracks;
}

/** Tracks from a MIDI file, in the file's own beat grid, for adding to an existing song. */
export function midiToTracks(data: ArrayBuffer, startIndex = 0): Track[] {
  return tracksFromMidi(new Midi(data), startIndex);
}

export function midiToProject(data: ArrayBuffer, fallbackName = 'Imported'): Project {
  const midi = new Midi(data);
  const project = makeProject();
  project.takes = [];
  project.name = midi.header.name || fallbackName;

  const bpm = midi.header.tempos[0]?.bpm ?? 120;
  project.bpm = Math.round(bpm * 100) / 100;
  const ts = midi.header.timeSignatures[0]?.timeSignature;
  if (ts && ts[0]) project.beatsPerBar = ts[0];

  project.tracks = tracksFromMidi(midi, 0);
  if (project.tracks.length === 0) project.tracks.push(makeTrack(0, { name: 'Melody' }));

  let maxBeat = 0;
  for (const t of project.tracks) for (const n of t.notes) maxBeat = Math.max(maxBeat, n.start + n.duration);
  project.bars = Math.max(8, Math.ceil(maxBeat / project.beatsPerBar) + 2);
  project.loopStartBeat = 0;
  project.loopEndBeat = project.bars * project.beatsPerBar;

  return project;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(name: string): string {
  return (name.trim() || 'song').replace(/[^\w\-. ]+/g, '_').slice(0, 80);
}

export function exportMidiFile(project: Project): void {
  const bytes = projectToMidi(project);
  // Copy into a fresh buffer so the Blob gets a plain ArrayBuffer.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  downloadBlob(new Blob([copy.buffer], { type: 'audio/midi' }), `${safeFilename(project.name)}.mid`);
}

export function parseProjectFile(text: string): Project {
  const parsed = JSON.parse(text);
  const project: Project = parsed.project ?? parsed;
  if (!project || !Array.isArray(project.tracks)) throw new Error('Not a MidiVoice project file');
  // Takes reference audio that only ever lived in memory, so the metadata survives for nudge history but can no longer be re-transcribed.
  project.takes = Array.isArray(project.takes) ? project.takes : [];
  return project;
}

// ------------------------------------------------------------- .fish file ---
// A .fish file is a plain ZIP: project.json plus each take's audio as a real
// WAV under takes/, so a reopened project can be re-detected, and renaming the
// file to .zip hands back every recording.

interface FishTakeMeta {
  contourHopSec: number;
  contourStartSec: number;
}

/** Decode the fixed-layout mono 16-bit WAV that float32ToWav writes. */
function wavToFloat32(bytes: Uint8Array): { audio: Float32Array; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleRate = view.getUint32(24, true);
  const dataSize = view.getUint32(40, true);
  const frames = Math.min(dataSize / 2, (bytes.byteLength - 44) / 2) | 0;
  const audio = new Float32Array(frames);
  for (let i = 0; i < frames; i++) audio[i] = view.getInt16(44 + i * 2, true) / 32768;
  return { audio, sampleRate };
}

export async function exportFishFile(project: Project): Promise<void> {
  const { zipSync, strToU8 } = await import('fflate');
  const takeMeta: Record<string, FishTakeMeta> = {};
  const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};

  for (const take of project.takes) {
    const stored = getTakeAudio(take.id);
    if (!stored) continue;
    const wavBytes = new Uint8Array(await float32ToWav(stored.audio, stored.sampleRate).arrayBuffer());
    // WAV data barely compresses; store it so saving stays instant.
    entries[`takes/${take.id}.wav`] = [wavBytes, { level: 0 }];
    entries[`takes/${take.id}.contour.f32`] = [
      new Uint8Array(stored.contour.buffer, stored.contour.byteOffset, stored.contour.byteLength),
      { level: 6 },
    ];
    takeMeta[take.id] = { contourHopSec: stored.contourHopSec, contourStartSec: stored.contourStartSec };
  }

  const json = JSON.stringify({ format: 'midivoice.fish.v1', project, takeMeta }, null, 2);
  entries['project.json'] = [strToU8(json), { level: 6 }];

  const zipped = zipSync(entries);
  downloadBlob(new Blob([zipped as BlobPart], { type: 'application/zip' }), `${safeFilename(project.name)}.fish`);
}

/** Parse a .fish zip and restore its take audio into the session store. */
export async function parseFishFile(data: ArrayBuffer): Promise<Project> {
  const { unzipSync, strFromU8 } = await import('fflate');
  const files = unzipSync(new Uint8Array(data));
  const projectEntry = files['project.json'];
  if (!projectEntry) throw new Error('Not a MidiVoice .fish file (no project.json inside)');

  const parsed = JSON.parse(strFromU8(projectEntry));
  const project = parseProjectFile(strFromU8(projectEntry));
  const takeMeta: Record<string, FishTakeMeta> = parsed.takeMeta ?? {};

  for (const take of project.takes) {
    const wavBytes = files[`takes/${take.id}.wav`];
    if (!wavBytes) continue;
    const { audio, sampleRate } = wavToFloat32(wavBytes);
    const contourBytes = files[`takes/${take.id}.contour.f32`];
    // Copy so the Float32Array view starts at byte 0 of its own buffer.
    const contour = contourBytes
      ? new Float32Array(contourBytes.slice().buffer, 0, Math.floor(contourBytes.byteLength / 4))
      : new Float32Array(0);
    const meta = takeMeta[take.id];
    putTakeAudio(take.id, audio, sampleRate, contour, meta?.contourHopSec ?? 0.01, meta?.contourStartSec ?? 0);
  }
  return project;
}
