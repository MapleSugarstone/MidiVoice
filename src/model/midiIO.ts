import { Midi } from '@tonejs/midi';
import type { InstrumentId, Project, Track } from './types';
import { beatsToSeconds, secondsToBeats, snapToScale } from './music';
import { makeProject, makeTrack, newId } from './store';

/** General MIDI program numbers so exported files open with sensible sounds. */
const GM_PROGRAM: Record<InstrumentId, number> = {
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
  if (program <= 7) return 'electricPiano';
  if (program <= 15) return 'marimba';
  if (program <= 23) return 'organ';
  if (program <= 26) return 'nylonGuitar';
  if (program <= 31) return 'cleanGuitar';
  if (program <= 39) return 'fingerBass';
  if (program <= 47) return 'strings';
  if (program <= 55) return 'choir';
  if (program <= 63) return 'brass';
  if (program <= 79) return 'strings';
  if (program <= 87) return 'sawLead';
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
      const midiNote = track.snapToScale
        ? snapToScale(note.midi, project.keyRoot, project.scale)
        : note.midi;
      t.addNote({
        midi: Math.max(0, Math.min(127, Math.round(midiNote))),
        time: beatsToSeconds(note.start, project.bpm),
        duration: Math.max(0.02, beatsToSeconds(note.duration, project.bpm)),
        velocity: Math.max(0.01, Math.min(1, note.velocity)),
      });
    }
  }

  return midi.toArray();
}

export function midiToProject(data: ArrayBuffer, fallbackName = 'Imported'): Project {
  const midi = new Midi(data);
  const project = makeProject();
  project.tracks = [];
  project.takes = [];
  project.name = midi.header.name || fallbackName;

  const bpm = midi.header.tempos[0]?.bpm ?? 120;
  project.bpm = Math.round(bpm * 100) / 100;
  const ts = midi.header.timeSignatures[0]?.timeSignature;
  if (ts && ts[0]) project.beatsPerBar = ts[0];

  let index = 0;
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
      start: secondsToBeats(n.time, project.bpm),
      duration: Math.max(1 / 32, secondsToBeats(n.duration, project.bpm)),
      midi: n.midi,
      velocity: n.velocity,
      detune: 0,
    }));
    project.tracks.push(track);
    index++;
  }

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

export function exportProjectFile(project: Project): void {
  const json = JSON.stringify({ format: 'midivoice.v1', project }, null, 2);
  downloadBlob(new Blob([json], { type: 'application/json' }), `${safeFilename(project.name)}.midivoice.json`);
}

export function parseProjectFile(text: string): Project {
  const parsed = JSON.parse(text);
  const project: Project = parsed.project ?? parsed;
  if (!project || !Array.isArray(project.tracks)) throw new Error('Not a MidiVoice project file');
  // Takes reference audio that only ever lived in memory, so the metadata survives for nudge history but can no longer be re-transcribed.
  project.takes = Array.isArray(project.takes) ? project.takes : [];
  return project;
}
