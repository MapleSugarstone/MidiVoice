import { create } from 'zustand';
import type {
  GridSetting,
  InputMode,
  InstrumentId,
  Note,
  NoteTool,
  Project,
  RecordSource,
  ScaleId,
  Take,
  TranscribeSettings,
  Track,
} from './types';
import { DEFAULT_TRANSCRIBE } from './types';
import { GRIDS, beatsToSeconds, gridBeats, quantizeValue, secondsToBeats, snapToScale } from './music';
import type { RawNote } from '../audio/transcribe';
import { transcribeAsync } from '../audio/transcribe';
import { dropTakeAudio, getTakeAudio, putTakeAudio } from '../audio/takeAudio';
import type { MicOptions } from '../audio/recorder';
import { DEFAULT_MIC_OPTIONS } from '../audio/recorder';

let idCounter = 0;
export function newId(prefix = 'n'): string {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

const TRACK_HUES = [205, 150, 35, 330, 265, 15, 95, 185];

export function makeTrack(index: number, partial: Partial<Track> = {}): Track {
  const isDrum = partial.isDrum ?? false;
  return {
    id: newId('t'),
    name: partial.name ?? (isDrum ? 'Drums' : `Track ${index + 1}`),
    instrument: partial.instrument ?? (isDrum ? 'drumKit' : 'grandPiano'),
    volume: partial.volume ?? -3,
    pan: partial.pan ?? 0,
    muted: false,
    solo: false,
    hue: partial.hue ?? TRACK_HUES[index % TRACK_HUES.length],
    notes: [],
    isDrum,
    snapToScale: partial.snapToScale ?? false,
    tuneStrength: partial.tuneStrength ?? 1,
    showContour: partial.showContour ?? true,
  };
}

export function makeProject(): Project {
  const first = makeTrack(0, { name: 'Melody' });
  return {
    name: 'Untitled song',
    bpm: 100,
    beatsPerBar: 4,
    keyRoot: 0,
    scale: 'major',
    tracks: [first],
    takes: [],
    bars: 16,
    loopEnabled: false,
    loopStartBeat: 0,
    loopEndBeat: 0,
  };
}

/**
 * Fill in fields added after a project was saved. Loop bounds used to be
 * counted in bars, so an old file's numbers are multiplied up into beats.
 */
export function migrateProject(raw: any): Project {
  const { loopStart, loopEnd, ...p } = raw as Project & { loopStart?: number; loopEnd?: number };
  const beatsPerBar = p.beatsPerBar || 4;
  const legacyStart = typeof loopStart === 'number' ? loopStart * beatsPerBar : 0;
  const legacyEnd = typeof loopEnd === 'number' ? loopEnd * beatsPerBar : 0;
  return {
    ...p,
    tracks: (p.tracks ?? []).map((t) => ({ ...t, showContour: t.showContour ?? true })),
    takes: (p.takes ?? []).map((t) => ({ ...t, stretch: t.stretch ?? 1 })),
    loopEnabled: p.loopEnabled ?? false,
    loopStartBeat: p.loopStartBeat ?? legacyStart,
    loopEndBeat: p.loopEndBeat ?? legacyEnd,
  };
}

/** Last beat with anything on it, rounded up to a whole bar. */
function songEndBeat(p: Project): number {
  let end = 0;
  for (const t of p.tracks) for (const n of t.notes) end = Math.max(end, n.start + n.duration);
  const bars = Math.max(1, Math.ceil(end / p.beatsPerBar));
  return bars * p.beatsPerBar;
}

export interface AppState {
  project: Project;
  activeTrackId: string;
  selectedNoteIds: string[];
  selectedTakeId: string | null;

  gridIndex: number;
  quantizeStrength: number;
  tool: NoteTool;

  /** Time range selected on the ruler, in project beats. */
  region: { startBeat: number; endBeat: number } | null;

  clipboard: { notes: Note[]; anchorBeat: number; fromDrum: boolean } | null;
  past: Project[];
  future: Project[];

  // Session settings (persisted separately from the project).
  latencyOffsetMs: number;
  countInBars: number;
  metronome: boolean;
  masterVolume: number;
  reverbAmount: number;
  inputMode: InputMode;
  recordSource: RecordSource;
  transcribeSettings: TranscribeSettings;
  micOptions: MicOptions;
  showContour: boolean;

  status: string;

  // ---- meta ----
  setStatus: (s: string) => void;
  pushHistory: () => void;
  transact: (fn: (p: Project) => void, history?: boolean) => void;
  undo: () => void;
  redo: () => void;

  // ---- project ----
  loadProject: (p: Project) => void;
  resetProject: () => void;
  setProjectMeta: (patch: Partial<Pick<Project, 'name' | 'bpm' | 'beatsPerBar' | 'keyRoot' | 'scale' | 'bars'>>) => void;
  /** Set the loop bounds, in beats. */
  setLoop: (enabled: boolean, startBeat?: number, endBeat?: number) => void;
  /** Switch looping on over the loop bounds, the selected range, or the whole song. */
  toggleLoop: () => void;

  // ---- tracks ----
  addTrack: (partial?: Partial<Track>) => string;
  removeTrack: (id: string) => void;
  /** Shift a track up (-1) or down (+1) in the list. */
  moveTrack: (id: string, delta: number) => void;
  updateTrack: (id: string, patch: Partial<Track>) => void;
  setActiveTrack: (id: string) => void;
  setInstrument: (trackId: string, instrument: InstrumentId) => void;

  // ---- notes ----
  select: (ids: string[]) => void;
  selectAdd: (ids: string[]) => void;
  selectAllOnTrack: (trackId: string) => void;
  clearSelection: () => void;
  addNote: (trackId: string, note: Omit<Note, 'id'>) => string;
  deleteSelected: () => void;
  deleteNotes: (ids: string[], history?: boolean) => void;
  /** Slice the selected notes into grid-sized pieces. */
  chopSelection: () => void;
  updateNotes: (ids: string[], patch: (n: Note) => Partial<Note>, history?: boolean) => void;
  nudgeSelection: (deltaBeats: number, deltaSemis: number, history?: boolean) => void;
  resizeSelection: (deltaBeats: number, history?: boolean) => void;
  setSelectionVelocity: (v: number) => void;
  quantizeSelection: (opts: { starts: boolean; lengths: boolean }) => void;
  legatoSelection: () => void;
  /** Squeeze (or stretch) the selection in time, about its first note. */
  scaleSelectionTiming: (factor: number) => void;
  tuneSelectionToScale: () => void;
  flattenSelectionTuning: () => void;
  copySelection: () => void;
  cutSelection: () => void;
  pasteAt: (beat: number, trackId?: string) => void;
  duplicateSelection: () => void;
  /** Join the selected notes into one per track. */
  mergeSelectedNotes: () => void;

  // ---- regions ----
  setRegion: (region: { startBeat: number; endBeat: number } | null) => void;
  /** Re-detect only the notes inside the region, leaving the rest alone. */
  retranscribeRegion: (settings: TranscribeSettings) => Promise<void>;

  // ---- takes ----
  commitTake: (args: {
    trackId: string;
    startBeat: number;
    autoOffsetMs: number;
    durationSec: number;
    settings: TranscribeSettings;
    raw: RawNote[];
    tuningOffsetCents: number;
    audio: Float32Array;
    sampleRate: number;
    contour: Float32Array;
    contourHopSec: number;
    contourStartSec: number;
  }) => string;
  /** Add notes played on a MIDI keyboard, as one undoable step. */
  commitMidiRecording: (trackId: string, notes: Omit<Note, 'id' | 'takeId'>[]) => void;
  setTakeNudge: (takeId: string, nudgeMs: number) => void;
  setTakeStretch: (takeId: string, stretch: number) => void;
  /** Search stretch + offset that best lands this take's notes on the grid. */
  fitTakeToGrid: (takeId: string) => void;
  /** Change tempo while keeping every note at the same point in real time. */
  setBpmKeepTiming: (bpm: number) => void;
  retranscribeTake: (takeId: string, settings: TranscribeSettings) => Promise<void>;
  deleteTake: (takeId: string) => void;
  selectTake: (takeId: string | null) => void;

  // ---- settings ----
  setTool: (tool: NoteTool) => void;
  setSetting: <K extends keyof AppState>(key: K, value: AppState[K]) => void;
  setTranscribeSetting: <K extends keyof TranscribeSettings>(key: K, value: TranscribeSettings[K]) => void;
}

const HISTORY_LIMIT = 80;

function cloneProject(p: Project): Project {
  return JSON.parse(JSON.stringify(p)) as Project;
}

function grow(p: Project) {
  let maxBeat = p.bars * p.beatsPerBar;
  for (const t of p.tracks) {
    for (const n of t.notes) maxBeat = Math.max(maxBeat, n.start + n.duration);
  }
  const neededBars = Math.ceil(maxBeat / p.beatsPerBar) + 2;
  if (neededBars > p.bars) p.bars = neededBars;
}

/** Every note in the project, paired with the track it belongs to. */
function findNotes(p: Project, ids: string[]): { track: Track; note: Note }[] {
  const idSet = new Set(ids);
  const out: { track: Track; note: Note }[] = [];
  for (const track of p.tracks) {
    for (const note of track.notes) if (idSet.has(note.id)) out.push({ track, note });
  }
  return out;
}

export const useStore = create<AppState>((set, get) => ({
  project: makeProject(),
  activeTrackId: '',
  selectedNoteIds: [],
  selectedTakeId: null,

  gridIndex: 6, // 1/16
  quantizeStrength: 1,
  tool: 'select',

  region: null,
  clipboard: null,
  past: [],
  future: [],

  latencyOffsetMs: 0,
  countInBars: 1,
  metronome: true,
  masterVolume: 0.9,
  reverbAmount: 0.3,
  inputMode: 'melody',
  recordSource: 'mic',
  transcribeSettings: { ...DEFAULT_TRANSCRIBE },
  micOptions: { ...DEFAULT_MIC_OPTIONS },
  showContour: true,

  status: 'Ready',

  setStatus: (status) => set({ status }),

  pushHistory: () => {
    const { project, past } = get();
    const next = [...past, cloneProject(project)];
    if (next.length > HISTORY_LIMIT) next.shift();
    set({ past: next, future: [] });
  },

  transact: (fn, history = true) => {
    const { project, past } = get();
    if (history) {
      const nextPast = [...past, cloneProject(project)];
      if (nextPast.length > HISTORY_LIMIT) nextPast.shift();
      set({ past: nextPast, future: [] });
    }
    const draft = cloneProject(project);
    fn(draft);
    grow(draft);
    set({ project: draft });
  },

  undo: () => {
    const { past, future, project } = get();
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    set({
      project: prev,
      past: past.slice(0, -1),
      future: [cloneProject(project), ...future].slice(0, HISTORY_LIMIT),
      selectedNoteIds: [],
      status: 'Undo',
    });
  },

  redo: () => {
    const { past, future, project } = get();
    if (future.length === 0) return;
    const next = future[0];
    set({
      project: next,
      future: future.slice(1),
      past: [...past, cloneProject(project)].slice(-HISTORY_LIMIT),
      selectedNoteIds: [],
      status: 'Redo',
    });
  },

  loadProject: (p) =>
    set({
      project: migrateProject(p),
      activeTrackId: p.tracks[0]?.id ?? '',
      selectedNoteIds: [],
      selectedTakeId: null,
      past: [],
      future: [],
      status: `Loaded "${p.name}"`,
    }),

  resetProject: () => {
    const p = makeProject();
    set({
      project: p,
      activeTrackId: p.tracks[0].id,
      selectedNoteIds: [],
      selectedTakeId: null,
      past: [],
      future: [],
      status: 'New song',
    });
  },

  setProjectMeta: (patch) => get().transact((p) => Object.assign(p, patch)),

  setLoop: (enabled, startBeat, endBeat) =>
    get().transact((p) => {
      p.loopEnabled = enabled;
      if (startBeat !== undefined) p.loopStartBeat = Math.max(0, startBeat);
      if (endBeat !== undefined) p.loopEndBeat = Math.max(0, endBeat);
    }, false),

  toggleLoop: () => {
    const { project, region } = get();
    if (project.loopEnabled) {
      get().setLoop(false);
      set({ status: 'Loop off' });
      return;
    }
    let { loopStartBeat: a, loopEndBeat: b } = project;
    if (b <= a) {
      if (region && region.endBeat > region.startBeat) {
        a = region.startBeat;
        b = region.endBeat;
      } else {
        a = 0;
        b = songEndBeat(project);
      }
    }
    get().setLoop(true, a, b);
    const bar = (beat: number) => (beat / project.beatsPerBar + 1).toFixed(2).replace(/\.00$/, '');
    set({ status: `Looping bars ${bar(a)} to ${bar(b)}. Drag across the ruler to move the loop.` });
  },

  addTrack: (partial) => {
    const id = newId('t');
    get().transact((p) => {
      const track = makeTrack(p.tracks.length, partial);
      track.id = id;
      p.tracks.push(track);
    });
    set({ activeTrackId: id });
    return id;
  },

  removeTrack: (id) => {
    const { project } = get();
    const index = project.tracks.findIndex((t) => t.id === id);
    if (index < 0) return;
    for (const take of project.takes) if (take.trackId === id) dropTakeAudio(take.id);
    get().transact((p) => {
      p.tracks = p.tracks.filter((t) => t.id !== id);
      p.takes = p.takes.filter((t) => t.trackId !== id);
    });
    const remaining = get().project.tracks;
    if (get().activeTrackId === id) {
      // Whichever track slid into the gap, or the one above it if that was the last.
      const next = remaining[Math.min(index, remaining.length - 1)];
      set({ activeTrackId: next?.id ?? '', selectedNoteIds: [], selectedTakeId: null });
    }
    if (remaining.length === 0) set({ status: 'No tracks left. Add a part to start writing again.' });
  },

  moveTrack: (id, delta) =>
    get().transact((p) => {
      const from = p.tracks.findIndex((t) => t.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= p.tracks.length) return;
      const [track] = p.tracks.splice(from, 1);
      p.tracks.splice(to, 0, track);
    }),

  updateTrack: (id, patch) =>
    get().transact((p) => {
      const t = p.tracks.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
    }, false),

  setActiveTrack: (id) => set({ activeTrackId: id }),

  setInstrument: (trackId, instrument) =>
    get().transact((p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      if (!t) return;
      t.instrument = instrument;
      t.isDrum = instrument === 'drumKit';
    }),

  select: (ids) => set({ selectedNoteIds: ids }),
  selectAdd: (ids) => set({ selectedNoteIds: Array.from(new Set([...get().selectedNoteIds, ...ids])) }),
  selectAllOnTrack: (trackId) => {
    const track = get().project.tracks.find((t) => t.id === trackId);
    set({ selectedNoteIds: track ? track.notes.map((n) => n.id) : [] });
  },
  clearSelection: () => set({ selectedNoteIds: [] }),

  addNote: (trackId, note) => {
    const id = newId();
    get().transact((p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      if (t) t.notes.push({ ...note, id });
    });
    return id;
  },

  deleteSelected: () => {
    const ids = new Set(get().selectedNoteIds);
    if (ids.size === 0) return;
    get().transact((p) => {
      for (const t of p.tracks) t.notes = t.notes.filter((n) => !ids.has(n.id));
      for (const take of p.takes) take.noteIds = take.noteIds.filter((n) => !ids.has(n));
    });
    set({ selectedNoteIds: [], status: `Deleted ${ids.size} note${ids.size === 1 ? '' : 's'}` });
  },

  deleteNotes: (ids, history = true) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    get().transact((p) => {
      for (const t of p.tracks) t.notes = t.notes.filter((n) => !idSet.has(n.id));
      for (const take of p.takes) take.noteIds = take.noteIds.filter((n) => !idSet.has(n));
    }, history);
    set({ selectedNoteIds: get().selectedNoteIds.filter((id) => !idSet.has(id)) });
  },

  /**
   * The inverse of joining: each selected note becomes a run of grid-length
   * notes covering the same span, for turning a held note into a rhythm.
   */
  chopSelection: () => {
    const { selectedNoteIds, gridIndex, project } = get();
    const step = gridBeats(GRIDS[gridIndex], project.beatsPerBar);
    if (step <= 0) {
      set({ status: 'Pick a snap value first, since chopping slices at the grid size' });
      return;
    }
    if (selectedNoteIds.length === 0) {
      set({ status: 'Select notes to chop first' });
      return;
    }
    const anyLong = findNotes(project, selectedNoteIds).some(({ note }) => note.duration > step + 1e-6);
    if (!anyLong) {
      set({ status: `Nothing longer than ${GRIDS[gridIndex].label} to chop` });
      return;
    }
    const keepIds: string[] = [];
    get().transact((p) => {
      for (const { track, note } of findNotes(p, selectedNoteIds)) {
        keepIds.push(note.id);
        if (note.duration <= step + 1e-6) continue;
        const end = note.start + note.duration;
        note.duration = step;
        for (let b = note.start + step; b < end - 1e-6; b += step) {
          const id = newId();
          keepIds.push(id);
          track.notes.push({ ...note, id, start: b, duration: Math.min(step, end - b) });
          if (note.takeId) p.takes.find((t) => t.id === note.takeId)?.noteIds.push(id);
        }
      }
    });
    set({ selectedNoteIds: keepIds, status: `Chopped into ${GRIDS[gridIndex].label} pieces` });
  },

  updateNotes: (ids, patch, history = true) =>
    get().transact((p) => {
      for (const { note } of findNotes(p, ids)) Object.assign(note, patch(note));
    }, history),

  nudgeSelection: (deltaBeats, deltaSemis, history = true) => {
    const ids = get().selectedNoteIds;
    if (ids.length === 0) return;
    get().transact((p) => {
      for (const { note } of findNotes(p, ids)) {
        note.start = Math.max(0, note.start + deltaBeats);
        note.midi = Math.max(0, Math.min(127, note.midi + deltaSemis));
      }
    }, history);
  },

  resizeSelection: (deltaBeats, history = true) => {
    const ids = get().selectedNoteIds;
    if (ids.length === 0) return;
    get().transact((p) => {
      for (const { note } of findNotes(p, ids)) {
        note.duration = Math.max(1 / 64, note.duration + deltaBeats);
      }
    }, history);
  },

  setSelectionVelocity: (v) => {
    const ids = get().selectedNoteIds;
    if (ids.length === 0) return;
    get().transact((p) => {
      for (const { note } of findNotes(p, ids)) note.velocity = Math.max(0.05, Math.min(1, v));
    });
  },

  quantizeSelection: ({ starts, lengths }) => {
    const { selectedNoteIds, gridIndex, quantizeStrength, project } = get();
    const step = gridBeats(GRIDS[gridIndex], project.beatsPerBar);
    if (step <= 0) {
      set({ status: 'Set a grid value first, snapping is off' });
      return;
    }
    const ids = selectedNoteIds.length
      ? selectedNoteIds
      : (project.tracks.find((t) => t.id === get().activeTrackId)?.notes ?? []).map((n) => n.id);
    if (ids.length === 0) return;

    get().transact((p) => {
      for (const { note } of findNotes(p, ids)) {
        if (starts) note.start = Math.max(0, quantizeValue(note.start, step, quantizeStrength));
        if (lengths) {
          const q = quantizeValue(note.duration, step, quantizeStrength);
          note.duration = Math.max(step / 2, q);
        }
      }
    });
    set({ status: `Quantised ${ids.length} note${ids.length === 1 ? '' : 's'} to ${GRIDS[gridIndex].label}` });
  },

  /** Stretch each note until the next one starts, killing gaps from breathy takes. */
  legatoSelection: () => {
    const { selectedNoteIds, activeTrackId } = get();
    get().transact((p) => {
      for (const track of p.tracks) {
        const ids = selectedNoteIds.length
          ? new Set(selectedNoteIds)
          : track.id === activeTrackId
            ? new Set(track.notes.map((n) => n.id))
            : new Set<string>();
        if (ids.size === 0) continue;
        const sorted = [...track.notes].sort((a, b) => a.start - b.start);
        for (let i = 0; i < sorted.length - 1; i++) {
          if (!ids.has(sorted[i].id)) continue;
          const gap = sorted[i + 1].start - sorted[i].start;
          if (gap > 0) sorted[i].duration = gap;
        }
      }
    });
    set({ status: 'Extended notes to meet the next one' });
  },

  /**
   * Rescale the gaps and the note lengths together, so the passage plays
   * faster or slower without changing its shape. The first selected note stays
   * put, since that is the beat the phrase is pinned to.
   */
  scaleSelectionTiming: (factor) => {
    const { selectedNoteIds, project } = get();
    const found = findNotes(project, selectedNoteIds);
    if (found.length === 0) {
      set({ status: 'Select the notes you want to speed up first' });
      return;
    }
    const anchor = Math.min(...found.map(({ note }) => note.start));
    get().transact((p) => {
      for (const { note } of findNotes(p, selectedNoteIds)) {
        note.start = Math.max(0, anchor + (note.start - anchor) * factor);
        note.duration = Math.max(1 / 64, note.duration * factor);
      }
    });
    const percent = Math.round(Math.abs(1 / factor - 1) * 100);
    set({
      status: `${found.length} note${found.length === 1 ? '' : 's'} now play ${percent}% ${
        factor < 1 ? 'faster' : 'slower'
      }`,
    });
  },

  tuneSelectionToScale: () => {
    const { selectedNoteIds, project, activeTrackId } = get();
    const ids = selectedNoteIds.length
      ? selectedNoteIds
      : (project.tracks.find((t) => t.id === activeTrackId)?.notes ?? []).map((n) => n.id);
    if (ids.length === 0) return;
    get().transact((p) => {
      for (const { track, note } of findNotes(p, ids)) {
        if (track.isDrum) continue;
        note.midi = snapToScale(note.midi, p.keyRoot, p.scale);
      }
    });
    set({ status: 'Snapped selection into key' });
  },

  /** Throw away the sung cents offset so notes sit dead on the grid pitch. */
  flattenSelectionTuning: () => {
    const ids = get().selectedNoteIds;
    if (ids.length === 0) return;
    get().transact((p) => {
      for (const { note } of findNotes(p, ids)) note.detune = 0;
    });
    set({ status: 'Tuning flattened to exact pitches' });
  },

  copySelection: () => {
    const { selectedNoteIds, project } = get();
    const found = findNotes(project, selectedNoteIds);
    if (found.length === 0) return;
    const notes = found.map(({ note }) => ({ ...note }));
    const anchorBeat = Math.min(...notes.map((n) => n.start));
    set({
      clipboard: { notes, anchorBeat, fromDrum: found[0].track.isDrum },
      status: `Copied ${notes.length} note${notes.length === 1 ? '' : 's'}`,
    });
  },

  cutSelection: () => {
    get().copySelection();
    get().deleteSelected();
  },

  pasteAt: (beat, trackId) => {
    const { clipboard, activeTrackId } = get();
    if (!clipboard) return;
    const target = trackId ?? activeTrackId;
    const newIds: string[] = [];
    get().transact((p) => {
      const track = p.tracks.find((t) => t.id === target);
      if (!track) return;
      for (const n of clipboard.notes) {
        const id = newId();
        newIds.push(id);
        track.notes.push({
          ...n,
          id,
          takeId: undefined,
          start: Math.max(0, beat + (n.start - clipboard.anchorBeat)),
        });
      }
    });
    set({ selectedNoteIds: newIds, status: `Pasted ${newIds.length} note${newIds.length === 1 ? '' : 's'}` });
  },

  duplicateSelection: () => {
    const { selectedNoteIds, project } = get();
    const found = findNotes(project, selectedNoteIds);
    if (found.length === 0) return;
    const starts = found.map(({ note }) => note.start);
    const ends = found.map(({ note }) => note.start + note.duration);
    const span = Math.max(...ends) - Math.min(...starts);
    const newIds: string[] = [];
    get().transact((p) => {
      for (const track of p.tracks) {
        const ids = new Set(selectedNoteIds);
        const copies: Note[] = [];
        for (const n of track.notes) {
          if (!ids.has(n.id)) continue;
          const id = newId();
          newIds.push(id);
          copies.push({ ...n, id, takeId: undefined, start: n.start + span });
        }
        track.notes.push(...copies);
      }
    });
    set({ selectedNoteIds: newIds, status: 'Duplicated' });
  },

  /**
   * Join the selected notes into one per track: the span of all of them, at the
   * pitch of the longest, since that's the one the ear already hears as the
   * note. Useful when a held note came back split into two or three pieces.
   */
  mergeSelectedNotes: () => {
    const { selectedNoteIds, project } = get();
    if (selectedNoteIds.length < 2) {
      set({ status: 'Select two or more notes to join them' });
      return;
    }

    const byTrack = new Map<string, Note[]>();
    for (const track of project.tracks) {
      const mine = track.notes.filter((n) => selectedNoteIds.includes(n.id));
      if (mine.length >= 2) byTrack.set(track.id, mine);
    }
    if (byTrack.size === 0) {
      set({ status: 'Those notes are on different tracks. Select two on the same track.' });
      return;
    }

    const keptIds: string[] = [];
    get().transact((p) => {
      for (const [trackId, group] of byTrack) {
        const track = p.tracks.find((t) => t.id === trackId);
        if (!track) continue;
        const ids = new Set(group.map((n) => n.id));
        const notes = track.notes.filter((n) => ids.has(n.id));
        if (notes.length < 2) continue;

        const start = Math.min(...notes.map((n) => n.start));
        const end = Math.max(...notes.map((n) => n.start + n.duration));
        const longest = notes.reduce((a, b) => (b.duration > a.duration ? b : a));

        const survivor = track.notes.find((n) => n.id === longest.id)!;
        survivor.start = start;
        survivor.duration = Math.max(1 / 64, end - start);
        survivor.velocity = Math.max(...notes.map((n) => n.velocity));
        keptIds.push(survivor.id);

        const drop = new Set(notes.filter((n) => n.id !== longest.id).map((n) => n.id));
        track.notes = track.notes.filter((n) => !drop.has(n.id));
        for (const take of p.takes) take.noteIds = take.noteIds.filter((id) => !drop.has(id));
      }
    });
    set({ selectedNoteIds: keptIds, status: `Joined into ${keptIds.length} note${keptIds.length === 1 ? '' : 's'}` });
  },

  setRegion: (region) => set({ region }),

  /** Re-detect just the notes inside the selected range, padding the audio slice for edge context and keeping only notes that start inside the range so the padding can't duplicate neighbours. */
  retranscribeRegion: async (settings) => {
    const { project, region } = get();
    if (!region || region.endBeat <= region.startBeat) {
      set({ status: 'Drag across the ruler to choose a range first' });
      return;
    }
    const bpm = project.bpm;
    const PAD_SEC = 0.15;
    set({ status: 'Detecting…' });

    const work: { takeId: string; trackId: string; notes: RawNote[] }[] = [];
    for (const take of project.takes) {
      const stored = getTakeAudio(take.id);
      if (!stored) continue;
      const st = take.stretch || 1;
      const audioDur = stored.audio.length / stored.sampleRate;
      // Region bounds expressed in this take's own audio timeline.
      const regionStartSec = beatsToSeconds((region.startBeat - take.startBeat) / st, bpm);
      const regionEndSec = beatsToSeconds((region.endBeat - take.startBeat) / st, bpm);
      if (regionEndSec <= 0 || regionStartSec >= audioDur) continue;

      const s0 = Math.max(0, regionStartSec - PAD_SEC);
      const s1 = Math.min(audioDur, regionEndSec + PAD_SEC);
      if (s1 - s0 < 0.05) continue;
      const slice = stored.audio.slice(
        Math.floor(s0 * stored.sampleRate),
        Math.ceil(s1 * stored.sampleRate),
      );
      const result = await transcribeAsync(slice, stored.sampleRate, settings);
      const notes = result.notes
        .map((n) => ({ ...n, startSec: n.startSec + s0 }))
        .filter((n) => n.startSec >= regionStartSec - 0.02 && n.startSec < regionEndSec);
      work.push({ takeId: take.id, trackId: take.trackId, notes });
    }

    if (work.length === 0) {
      set({ status: 'No take audio in that range (audio is kept for the session only)' });
      return;
    }

    let added = 0;
    let removed = 0;
    get().transact((p) => {
      for (const job of work) {
        const tk = p.takes.find((t) => t.id === job.takeId);
        const track = p.tracks.find((t) => t.id === job.trackId);
        if (!tk || !track) continue;
        const st = tk.stretch || 1;

        const mine = new Set(tk.noteIds);
        const dropped = new Set<string>();
        track.notes = track.notes.filter((n) => {
          const inside = mine.has(n.id) && n.start >= region.startBeat - 1e-6 && n.start < region.endBeat;
          if (inside) dropped.add(n.id);
          return !inside;
        });
        tk.noteIds = tk.noteIds.filter((id) => !dropped.has(id));
        removed += dropped.size;

        for (const r of job.notes) {
          const id = newId();
          const midiRounded = Math.round(r.midiFloat);
          track.notes.push({
            id,
            start: Math.max(0, tk.startBeat + secondsToBeats(r.startSec, bpm) * st),
            duration: Math.max(1 / 32, secondsToBeats(r.durSec, bpm) * st),
            midi: Math.max(0, Math.min(127, midiRounded)),
            velocity: r.velocity,
            detune: track.isDrum ? 0 : (r.midiFloat - midiRounded) * 100,
            takeId: tk.id,
          });
          tk.noteIds.push(id);
          added++;
        }
      }
    });

    set({
      selectedNoteIds: [],
      status: `Re-detected the selected range: ${removed} note${removed === 1 ? '' : 's'} replaced by ${added}`,
    });
  },

  commitTake: ({
    trackId, startBeat, autoOffsetMs, durationSec, settings, raw, tuningOffsetCents,
    audio, sampleRate, contour, contourHopSec, contourStartSec,
  }) => {
    const takeId = newId('take');
    const { project } = get();
    const bpm = project.bpm;
    const noteIds: string[] = [];

    get().transact((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (!track) return;
      for (const r of raw) {
        const id = newId();
        noteIds.push(id);
        const midiRounded = Math.round(r.midiFloat);
        track.notes.push({
          id,
          start: Math.max(0, startBeat + secondsToBeats(r.startSec, bpm)),
          duration: Math.max(1 / 32, secondsToBeats(r.durSec, bpm)),
          midi: Math.max(0, Math.min(127, midiRounded)),
          velocity: r.velocity,
          detune: track.isDrum ? 0 : (r.midiFloat - midiRounded) * 100,
          takeId,
        });
      }
      const take: Take = {
        id: takeId,
        trackId,
        name: `Take ${p.takes.filter((t) => t.trackId === trackId).length + 1}`,
        startBeat,
        nudgeMs: 0,
        stretch: 1,
        autoOffsetMs,
        durationSec,
        createdAt: Date.now(),
        settings: { ...settings },
        noteIds,
        tuningOffsetCents,
      };
      p.takes.push(take);
    });

    putTakeAudio(takeId, audio, sampleRate, contour, contourHopSec, contourStartSec);
    set({
      selectedTakeId: takeId,
      selectedNoteIds: noteIds,
      status: `${raw.length} note${raw.length === 1 ? '' : 's'} transcribed`,
    });
    return takeId;
  },

  commitMidiRecording: (trackId, notes) => {
    if (notes.length === 0) return;
    const ids: string[] = [];
    get().transact((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (!track) return;
      for (const n of notes) {
        const id = newId();
        ids.push(id);
        track.notes.push({ ...n, id });
      }
    });
    set({
      selectedNoteIds: ids,
      status: `${notes.length} note${notes.length === 1 ? '' : 's'} recorded from the MIDI keyboard`,
    });
  },

  /** Slide a whole take in time. Manual edits inside the take ride along. */
  setTakeNudge: (takeId, nudgeMs) => {
    const { project } = get();
    const take = project.takes.find((t) => t.id === takeId);
    if (!take) return;
    const deltaBeats = secondsToBeats((nudgeMs - take.nudgeMs) / 1000, project.bpm);
    if (deltaBeats === 0) return;

    get().transact((p) => {
      const tk = p.takes.find((t) => t.id === takeId);
      if (!tk) return;
      const ids = new Set(tk.noteIds);
      for (const track of p.tracks) {
        if (track.id !== tk.trackId) continue;
        for (const n of track.notes) if (ids.has(n.id)) n.start = Math.max(0, n.start + deltaBeats);
      }
      tk.startBeat += deltaBeats;
      tk.nudgeMs = nudgeMs;
    }, false);
  },

  /**
   * Rescale a take about its own start. This is the "I drifted from the click"
   * correction: nudge fixes a take that came in late, stretch fixes one that
   * ran fast or slow across its length.
   */
  setTakeStretch: (takeId, stretch) => {
    const { project } = get();
    const take = project.takes.find((t) => t.id === takeId);
    if (!take) return;
    const next = Math.max(0.5, Math.min(2, stretch));
    const rel = next / (take.stretch || 1);
    if (!isFinite(rel) || rel === 1) return;

    get().transact((p) => {
      const tk = p.takes.find((t) => t.id === takeId);
      if (!tk) return;
      const ids = new Set(tk.noteIds);
      for (const track of p.tracks) {
        if (track.id !== tk.trackId) continue;
        for (const n of track.notes) {
          if (!ids.has(n.id)) continue;
          n.start = Math.max(0, tk.startBeat + (n.start - tk.startBeat) * rel);
          n.duration = Math.max(1 / 64, n.duration * rel);
        }
      }
      tk.stretch = next;
    }, false);
  },

  /** Brute-force search for the stretch and offset that land the take's note starts closest to the grid, chosen over gradient methods because the cost surface is periodic and full of local minima. */
  fitTakeToGrid: (takeId) => {
    const { project, gridIndex } = get();
    const take = project.takes.find((t) => t.id === takeId);
    if (!take) return;
    const step = gridBeats(GRIDS[gridIndex], project.beatsPerBar);
    if (step <= 0) {
      set({ status: 'Pick a snap value first, grid fitting needs something to aim at' });
      return;
    }

    const ids = new Set(take.noteIds);
    const notes: { start: number; weight: number }[] = [];
    for (const track of project.tracks) {
      if (track.id !== take.trackId) continue;
      for (const n of track.notes) {
        if (ids.has(n.id)) notes.push({ start: n.start, weight: Math.min(1, n.duration * 2) });
      }
    }
    if (notes.length < 3) {
      set({ status: 'Need at least three notes in the take to fit a grid' });
      return;
    }

    const t0 = take.startBeat;
    const cost = (stretch: number, offset: number): number => {
      let total = 0;
      for (const n of notes) {
        const pos = t0 + (n.start - t0) * stretch + offset;
        const d = Math.abs(pos - Math.round(pos / step) * step);
        total += d * d * n.weight;
      }
      return total;
    };

    let best = { stretch: 1, offset: 0, cost: Infinity };
    for (let s = 0.86; s <= 1.16001; s += 0.004) {
      for (let o = -step / 2; o <= step / 2 + 1e-9; o += step / 48) {
        const c = cost(s, o);
        if (c < best.cost) best = { stretch: s, offset: o, cost: c };
      }
    }

    const absStretch = (take.stretch || 1) * best.stretch;
    get().setTakeStretch(takeId, absStretch);
    const offsetMs = (best.offset * 60000) / project.bpm;
    get().setTakeNudge(takeId, Math.round((get().project.takes.find((t) => t.id === takeId)!.nudgeMs + offsetMs) * 10) / 10);

    const impliedBpm = project.bpm / absStretch;
    set({
      status:
        `Fitted to the ${GRIDS[gridIndex].label} grid: stretched ${((best.stretch - 1) * 100).toFixed(1)}%, ` +
        `shifted ${offsetMs.toFixed(0)} ms. You sang this at about ${impliedBpm.toFixed(1)} bpm.`,
    });
  },

  /**
   * Change the song tempo without moving anything in real time: note positions
   * are in beats, so they all rescale by the tempo ratio. Use this when the
   * grid was wrong rather than the performance.
   */
  setBpmKeepTiming: (bpm) => {
    const { project } = get();
    const next = Math.max(20, Math.min(300, bpm));
    const ratio = next / project.bpm;
    if (!isFinite(ratio) || ratio === 1) return;
    get().transact((p) => {
      for (const track of p.tracks) {
        for (const n of track.notes) {
          n.start *= ratio;
          n.duration *= ratio;
        }
      }
      for (const tk of p.takes) tk.startBeat *= ratio;
      p.bpm = next;
    });
    set({ status: `Tempo now ${next} bpm, everything still where you sang it` });
  },

  retranscribeTake: async (takeId, settings) => {
    const { project } = get();
    const take = project.takes.find((t) => t.id === takeId);
    const stored = getTakeAudio(takeId);
    if (!take || !stored) {
      set({ status: 'That take’s audio is no longer in memory (it is not saved across reloads)' });
      return;
    }

    set({ status: 'Detecting…' });
    const result = await transcribeAsync(stored.audio, stored.sampleRate, settings);
    const bpm = project.bpm;
    const newIds: string[] = [];

    get().transact((p) => {
      const tk = p.takes.find((t) => t.id === takeId);
      const track = p.tracks.find((t) => t.id === take.trackId);
      if (!tk || !track) return;
      const old = new Set(tk.noteIds);
      track.notes = track.notes.filter((n) => !old.has(n.id));
      for (const r of result.notes) {
        const id = newId();
        newIds.push(id);
        const midiRounded = Math.round(r.midiFloat);
        track.notes.push({
          id,
          start: Math.max(0, tk.startBeat + secondsToBeats(r.startSec, bpm)),
          duration: Math.max(1 / 32, secondsToBeats(r.durSec, bpm)),
          midi: Math.max(0, Math.min(127, midiRounded)),
          velocity: r.velocity,
          detune: track.isDrum ? 0 : (r.midiFloat - midiRounded) * 100,
          takeId,
        });
      }
      tk.noteIds = newIds;
      tk.settings = { ...settings };
      tk.tuningOffsetCents = result.tuningOffsetCents;
      // Positions are rebuilt from the audio, so any stretch is gone with them.
      // (startBeat already carries the nudge, so that part survives.)
      tk.stretch = 1;
    });

    putTakeAudio(
      takeId, stored.audio, stored.sampleRate,
      result.contour, result.contourHopSec, result.contourStartSec,
    );
    const fellBack = (settings.engine ?? 'neural') === 'neural' && result.engineUsed === 'classic';
    set({
      selectedNoteIds: newIds,
      status: `Re-detected ${result.notes.length} notes` +
        (fellBack ? ' (classic detector, the neural model could not load)' : ''),
    });
  },

  deleteTake: (takeId) => {
    get().transact((p) => {
      const tk = p.takes.find((t) => t.id === takeId);
      if (!tk) return;
      const ids = new Set(tk.noteIds);
      for (const track of p.tracks) track.notes = track.notes.filter((n) => !ids.has(n.id));
      p.takes = p.takes.filter((t) => t.id !== takeId);
    });
    dropTakeAudio(takeId);
    set({ selectedTakeId: null, selectedNoteIds: [], status: 'Take deleted' });
  },

  selectTake: (takeId) => {
    if (!takeId) {
      set({ selectedTakeId: null });
      return;
    }
    const take = get().project.takes.find((t) => t.id === takeId);
    set({ selectedTakeId: takeId, selectedNoteIds: take ? [...take.noteIds] : [] });
  },

  setTool: (tool) =>
    set({
      tool,
      status:
        tool === 'draw'
          ? 'Draw tool: click places a note, drag sets its length, right-click deletes. Press D to go back.'
          : 'Select tool',
    }),

  setSetting: (key, value) => set({ [key]: value } as any),

  setTranscribeSetting: (key, value) =>
    set({ transcribeSettings: { ...get().transcribeSettings, [key]: value } }),
}));

// The initial project is created before the store exists, so wire up the
// active track once on load.
const initial = useStore.getState();
if (!initial.activeTrackId) {
  useStore.setState({ activeTrackId: initial.project.tracks[0].id });
}

export function currentGrid(): GridSetting {
  return GRIDS[useStore.getState().gridIndex];
}

export function currentSnapBeats(): number {
  const s = useStore.getState();
  return gridBeats(GRIDS[s.gridIndex], s.project.beatsPerBar);
}

export type { ScaleId };
