import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../model/store';
import { engine } from '../audio/engine';
import { playFrom } from './transport';
import { getTakeAudio } from '../audio/takeAudio';
import {
  DRUM_LANES,
  GRIDS,
  gridBeats,
  inScale,
  isBlackKey,
  midiToName,
  quantizeValue,
  secondsToBeats,
} from '../model/music';
import type { Note, Project, Track } from '../model/types';

const KEY_WIDTH = 68;
const RULER_HEIGHT = 30;
const MIN_PX_PER_BEAT = 12;
const MAX_PX_PER_BEAT = 320;
const MIN_ROW_H = 5;
const MAX_ROW_H = 64;
const RESIZE_HANDLE_PX = 7;
/** Row height each lane type opens at: drums want fat lanes, notes want range. */
const DEFAULT_ROW_H = { melodic: 15, drum: 34 };
/** Firefox reports wheel deltas in lines rather than pixels. */
const LINE_PX = 16;

interface View {
  pxPerBeat: number;
  rowH: number;
  scrollBeat: number;
  scrollRow: number;
}

type DragKind = 'move' | 'resize' | 'select' | 'draw' | 'pan' | 'erase' | null;

interface DragState {
  kind: DragKind;
  startX: number;
  startY: number;
  startBeat: number;
  startRow: number;
  curX: number;
  curY: number;
  primaryId: string | null;
  originals: Map<string, { start: number; midi: number; duration: number }>;
  additive: boolean;
  scrollBeat0: number;
  scrollRow0: number;
  lastPreviewMidi: number;
  /** A plain click must not move or resize anything, so edits wait for real travel. */
  moved: boolean;
  /** Erase sweeps push one undo entry, on the first note actually removed. */
  historyPushed?: boolean;
}

const DRAG_THRESHOLD_PX = 4;

function rowCount(track: Track | undefined): number {
  return track?.isDrum ? DRUM_LANES.length : 128;
}

function rowOfMidi(track: Track | undefined, midi: number): number {
  if (track?.isDrum) {
    const i = DRUM_LANES.findIndex((d) => d.midi === midi);
    return i >= 0 ? i : DRUM_LANES.length - 1;
  }
  return 127 - midi;
}

function midiOfRow(track: Track | undefined, row: number): number {
  if (track?.isDrum) {
    const clamped = Math.max(0, Math.min(DRUM_LANES.length - 1, Math.round(row)));
    return DRUM_LANES[clamped].midi;
  }
  return 127 - Math.round(row);
}


export function PianoRoll() {
  const project = useStore((s) => s.project);
  const activeTrackId = useStore((s) => s.activeTrackId);
  const selectedNoteIds = useStore((s) => s.selectedNoteIds);
  const gridIndex = useStore((s) => s.gridIndex);
  const showContour = useStore((s) => s.showContour);
  const region = useStore((s) => s.region);
  const tool = useStore((s) => s.tool);

  const gridRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const keysRef = useRef<HTMLCanvasElement>(null);
  const rulerRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const [size, setSize] = useState({ w: 800, h: 400 });
  const [view, setView] = useState<View>({
    pxPerBeat: 64,
    rowH: DEFAULT_ROW_H.melodic,
    scrollBeat: 0,
    scrollRow: 127 - 84, // top of view ≈ C6
  });
  // Zoom is kept per lane type, so hopping to a drum track and back doesn't
  // throw away the row height you set.
  const rowHMemo = useRef({ ...DEFAULT_ROW_H });

  const dragRef = useRef<DragState | null>(null);
  // Touch: active fingers on the grid, the pinch between the first two, and
  // the scroll-or-tap state of a finger on the keys column.
  const touchesRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number } | null>(null);
  const keysPanRef = useRef<{ startY: number; scrollRow0: number; panning: boolean } | null>(null);
  // Length given to the next drawn note, following whatever was last drawn or resized.
  const lastDrawDurRef = useRef<number | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const activeTrack = project.tracks.find((t) => t.id === activeTrackId);
  const snapBeats = gridBeats(GRIDS[gridIndex], project.beatsPerBar);

  // Drum tracks want fatter lanes, melodic tracks more of the keyboard.
  useEffect(() => {
    setView((v) => {
      const wanted = rowHMemo.current[activeTrack?.isDrum ? 'drum' : 'melodic'];
      if (v.rowH === wanted) return v;
      return {
        ...v,
        rowH: wanted,
        scrollRow: activeTrack?.isDrum ? 0 : 127 - 84,
      };
    });
  }, [activeTrack?.isDrum]);

  // ---- sizing -------------------------------------------------------------
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth - KEY_WIDTH, h: el.clientHeight - RULER_HEIGHT });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth - KEY_WIDTH, h: el.clientHeight - RULER_HEIGHT });
    return () => ro.disconnect();
  }, []);

  function prepare(canvas: HTMLCanvasElement | null, w: number, h: number): CanvasRenderingContext2D | null {
    if (!canvas) return null;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return ctx;
  }

  const beatToX = useCallback((beat: number) => (beat - viewRef.current.scrollBeat) * viewRef.current.pxPerBeat, []);
  const xToBeat = useCallback((x: number) => x / viewRef.current.pxPerBeat + viewRef.current.scrollBeat, []);
  const rowToY = useCallback((row: number) => (row - viewRef.current.scrollRow) * viewRef.current.rowH, []);
  const yToRow = useCallback((y: number) => y / viewRef.current.rowH + viewRef.current.scrollRow, []);

  // ---- main draw ----------------------------------------------------------
  const draw = useCallback(() => {
    const { w, h } = size;
    const v = viewRef.current;
    const ctx = prepare(gridRef.current, w, h);
    if (!ctx) return;

    const firstBeat = v.scrollBeat;
    const lastBeat = v.scrollBeat + w / v.pxPerBeat;
    const firstRow = Math.floor(v.scrollRow);
    const lastRow = Math.ceil(v.scrollRow + h / v.rowH);
    const total = rowCount(activeTrack);

    // --- row backgrounds ---
    for (let row = Math.max(0, firstRow); row <= Math.min(total - 1, lastRow); row++) {
      const y = rowToY(row);
      const midi = midiOfRow(activeTrack, row);
      let fill: string;
      if (activeTrack?.isDrum) {
        fill = row % 2 === 0 ? '#ebf6fd' : '#e7f4fd';
      } else if (isBlackKey(midi)) {
        fill = '#e0eef8';
      } else {
        // Light scheme: in-scale rows read as the open, playable lanes.
        fill = inScale(midi, project.keyRoot, project.scale) ? '#f3faff' : '#ddebf5';
      }
      ctx.fillStyle = fill;
      ctx.fillRect(0, y, w, v.rowH);
      // Octave separator
      if (!activeTrack?.isDrum && midi % 12 === 0) {
        ctx.fillStyle = 'rgba(1, 7, 14, 0.09)';
        ctx.fillRect(0, y + v.rowH - 1, w, 1);
      }
    }

    // --- loop range: shaded inside, with edges when it is actually looping ---
    if (project.loopEndBeat > project.loopStartBeat) {
      const x0 = beatToX(project.loopStartBeat);
      const x1 = beatToX(project.loopEndBeat);
      ctx.fillStyle = project.loopEnabled ? 'rgba(0, 102, 134, 0.10)' : 'rgba(0, 102, 134, 0.04)';
      ctx.fillRect(x0, 0, x1 - x0, h);
      if (project.loopEnabled) {
        ctx.strokeStyle = 'rgba(0, 102, 134, 0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x0) + 0.5, 0);
        ctx.lineTo(Math.round(x0) + 0.5, h);
        ctx.moveTo(Math.round(x1) - 0.5, 0);
        ctx.lineTo(Math.round(x1) - 0.5, h);
        ctx.stroke();
      }
    }

    // --- selected time range ---
    if (region && region.endBeat > region.startBeat) {
      const x0 = beatToX(region.startBeat);
      const x1 = beatToX(region.endBeat);
      ctx.fillStyle = 'rgba(60, 29, 0, 0.1)';
      ctx.fillRect(x0, 0, x1 - x0, h);
      ctx.strokeStyle = 'rgba(60, 29, 0, 0.65)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x0) + 0.5, 0);
      ctx.lineTo(Math.round(x0) + 0.5, h);
      ctx.moveTo(Math.round(x1) + 0.5, 0);
      ctx.lineTo(Math.round(x1) + 0.5, h);
      ctx.stroke();
    }

    // --- vertical grid ---
    const sub = snapBeats > 0 ? snapBeats : 1;
    if (sub * v.pxPerBeat >= 6) {
      ctx.strokeStyle = 'rgba(1, 7, 14, 0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let b = Math.ceil(firstBeat / sub) * sub; b < lastBeat; b += sub) {
        const x = Math.round(beatToX(b)) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(1, 7, 14, 0.11)';
    ctx.beginPath();
    for (let b = Math.ceil(firstBeat); b < lastBeat; b += 1) {
      const x = Math.round(beatToX(b)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(1, 7, 14, 0.24)';
    ctx.beginPath();
    for (
      let b = Math.ceil(firstBeat / project.beatsPerBar) * project.beatsPerBar;
      b < lastBeat;
      b += project.beatsPerBar
    ) {
      const x = Math.round(beatToX(b)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    ctx.stroke();

    // --- ghost notes from other tracks ---
    for (const track of project.tracks) {
      if (track.id === activeTrackId || track.muted) continue;
      if (!!track.isDrum !== !!activeTrack?.isDrum) continue; // different row space
      ctx.fillStyle = `hsla(${track.hue}, 45%, 55%, 0.20)`;
      for (const note of track.notes) {
        const x = beatToX(note.start);
        const nw = Math.max(2, note.duration * v.pxPerBeat);
        if (x + nw < 0 || x > w) continue;
        const y = rowToY(rowOfMidi(track, note.midi));
        ctx.fillRect(x, y + 1, nw, v.rowH - 2);
      }
    }

    // --- sung pitch contour for takes on this track ---
    if (showContour && activeTrack && !activeTrack.isDrum && activeTrack.showContour !== false) {
      for (const take of project.takes) {
        if (take.trackId !== activeTrackId) continue;
        const stored = getTakeAudio(take.id);
        if (!stored || stored.contour.length === 0) continue;
        ctx.strokeStyle = 'rgba(45, 23, 0, 0.75)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let penDown = false;
        for (let i = 0; i < stored.contour.length; i++) {
          const m = stored.contour[i];
          if (m <= 0) {
            penDown = false;
            continue;
          }
          const beat =
            take.startBeat +
            secondsToBeats(stored.contourStartSec + i * stored.contourHopSec, project.bpm);
          const x = beatToX(beat);
          if (x < -20 || x > w + 20) {
            penDown = false;
            continue;
          }
          // Row space is integer-per-semitone, so a fractional MIDI maps to a fractional row, which is what makes drift visible.
          const y = rowToY(127 - m) + v.rowH / 2;
          if (penDown) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
          penDown = true;
        }
        ctx.stroke();
      }
    }

    // --- active track notes ---
    const selected = new Set(selectedNoteIds);
    if (activeTrack) {
      for (const note of activeTrack.notes) {
        const x = beatToX(note.start);
        const nw = Math.max(3, note.duration * v.pxPerBeat);
        if (x + nw < 0 || x > w) continue;
        const shown = note.midi;
        const y = rowToY(rowOfMidi(activeTrack, shown));
        if (y + v.rowH < 0 || y > h) continue;

        const isSel = selected.has(note.id);
        const hue = activeTrack.hue;
        const sat = isSel ? 90 : 70;
        const base = isSel ? 74 : 57;
        const top = y + 1;
        const bh = v.rowH - 2;
        const rad = Math.min(3, v.rowH / 4);

        // Glass fill: white sheen above a midline break, deeper colour below.
        const g = ctx.createLinearGradient(0, top, 0, top + bh);
        g.addColorStop(0, `hsl(${hue}, ${sat}%, ${Math.min(95, base + 25)}%)`);
        g.addColorStop(0.45, `hsl(${hue}, ${sat}%, ${base + 6}%)`);
        g.addColorStop(0.52, `hsl(${hue}, ${sat}%, ${base - 2}%)`);
        g.addColorStop(1, `hsl(${hue}, ${sat}%, ${base - 12}%)`);
        ctx.fillStyle = g;
        roundRect(ctx, x, top, nw, bh, rad);
        ctx.fill();

        ctx.strokeStyle = isSel ? '#01070e' : `hsla(${hue}, 55%, 32%, 0.55)`;
        ctx.lineWidth = isSel ? 1.5 : 1;
        roundRect(ctx, x + 0.5, top + 0.5, nw - 1, bh - 1, rad);
        ctx.stroke();

        // Inner highlight along the top edge, skipped when the row is too thin to carry it.
        if (bh >= 7 && nw >= 8) {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x + rad + 0.5, top + 1.5);
          ctx.lineTo(x + nw - rad - 0.5, top + 1.5);
          ctx.stroke();
        }

        if (v.rowH >= 15 && nw > 34 && !activeTrack.isDrum) {
          ctx.fillStyle = 'rgba(8, 24, 34, 0.7)';
          ctx.font = '10px ui-monospace, Cascadia Code, Source Code Pro, Menlo, Consolas, DejaVu Sans Mono, monospace';
          ctx.textBaseline = 'middle';
          ctx.fillText(midiToName(shown), x + 4, y + v.rowH / 2);
        }
      }
    }

    drawKeys();
    drawRuler();
  }, [size, project, activeTrackId, selectedNoteIds, snapBeats, showContour, activeTrack, region]);

  // Hover/pressed key feedback lives in refs and redraws the keys canvas
  // directly, so mouse movement never re-renders the component tree.
  const hoverKeyRef = useRef(-1);
  const pressedKeyRef = useRef(-1);
  // Pitches sounding under the playhead, whose keys render pressed too.
  const playingKeysRef = useRef<Set<number>>(new Set());
  // Keys flashed by auditions, keyed by midi with a timer id, or -1 for a held MIDI key waiting for its note-off.
  const flashKeysRef = useRef<Map<number, number>>(new Map());

  const drawKeys = useCallback(() => {
    const v = viewRef.current;
    const ctx = prepare(keysRef.current, KEY_WIDTH, size.h);
    if (!ctx) return;
    const total = rowCount(activeTrack);
    const firstRow = Math.max(0, Math.floor(v.scrollRow));
    const lastRow = Math.min(total - 1, Math.ceil(v.scrollRow + size.h / v.rowH));
    const hoverKey = hoverKeyRef.current;
    const playing = playingKeysRef.current;
    const isPressed = (midi: number) =>
      midi === pressedKeyRef.current || playing.has(midi) || flashKeysRef.current.has(midi);

    ctx.fillStyle = '#d4eaf9';
    ctx.fillRect(0, 0, KEY_WIDTH, size.h);

    if (activeTrack?.isDrum) {
      for (let row = firstRow; row <= lastRow; row++) {
        const y = rowToY(row);
        const midi = DRUM_LANES[row].midi;
        ctx.fillStyle = row % 2 === 0 ? '#b9cedc' : '#c2d7e6';
        ctx.fillRect(0, y, KEY_WIDTH, v.rowH - 1);
        if (isPressed(midi)) {
          ctx.fillStyle = 'rgba(0, 45, 75, 0.28)';
          ctx.fillRect(0, y, KEY_WIDTH, v.rowH - 1);
        } else if (midi === hoverKey) {
          ctx.fillStyle = 'rgba(0, 45, 75, 0.10)';
          ctx.fillRect(0, y, KEY_WIDTH, v.rowH - 1);
        }
        ctx.fillStyle = '#19252d';
        ctx.font = '11px Optima, Candara, Noto Sans, source-sans-pro, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(DRUM_LANES[row].name, 7, y + v.rowH / 2);
      }
    } else {
      // Full-length black keys: the classic MIDI keyboard layout with
      // realistic key faces. The bed only peeks out when a key is pressed.
      const blackW = KEY_WIDTH;
      ctx.lineWidth = 1;
      for (let row = firstRow; row <= lastRow; row++) {
        const midi = midiOfRow(activeTrack, row);
        const y = rowToY(row);
        const pressed = isPressed(midi);
        const hovered = midi === hoverKey && !pressed;

        const g = ctx.createLinearGradient(0, 0, KEY_WIDTH, 0);
        if (isBlackKey(midi)) {
          g.addColorStop(0, '#dce5eb');
          g.addColorStop(0.62, '#e5edf2');
          g.addColorStop(1, '#d2dce3');
        } else if (pressed) {
          g.addColorStop(0, '#e0e9ef');
          g.addColorStop(0.5, '#d6e1e9');
          g.addColorStop(1, '#c2d1dc');
        } else {
          g.addColorStop(0, '#ffffff');
          g.addColorStop(0.62, '#f7fafc');
          g.addColorStop(0.9, '#e9f0f4');
          g.addColorStop(1, '#d9e3e9');
        }
        ctx.fillStyle = g;
        ctx.fillRect(0, y, KEY_WIDTH, v.rowH);
        if (!isBlackKey(midi)) {
          if (hovered) {
            ctx.fillStyle = 'rgba(25, 55, 80, 0.08)';
            ctx.fillRect(0, y, KEY_WIDTH, v.rowH);
          }
          if (pressed) {
            // A pressed key sinks: shadow along its top edge.
            ctx.fillStyle = 'rgba(20, 40, 60, 0.25)';
            ctx.fillRect(0, y, KEY_WIDTH, 1.5);
          }
        }

        // Seam under every lane, so every key reads as one equal lane.
        const seamY = Math.round(y + v.rowH) - 0.5;
        ctx.strokeStyle = 'rgba(30, 55, 75, 0.18)';
        ctx.beginPath();
        ctx.moveTo(0, seamY);
        ctx.lineTo(KEY_WIDTH, seamY);
        ctx.stroke();
      }

      // Black keys: shorter than the column, soft shadow onto the whites,
      // side-lit gradient and a glossy top edge.
      for (let row = firstRow; row <= lastRow; row++) {
        const midi = midiOfRow(activeTrack, row);
        if (!isBlackKey(midi)) continue;
        const y = rowToY(row);
        const pressed = isPressed(midi);
        const hovered = midi === hoverKey && !pressed;
        const bw = pressed ? blackW - 1.5 : blackW;
        const by = y + 0.5;
        const bh = v.rowH - 1;

        ctx.save();
        ctx.shadowColor = 'rgba(10, 25, 40, 0.45)';
        ctx.shadowBlur = pressed ? 1.5 : 3;
        ctx.shadowOffsetX = pressed ? 1 : 2;
        ctx.shadowOffsetY = 1;
        const g = ctx.createLinearGradient(0, 0, bw, 0);
        if (pressed) {
          g.addColorStop(0, '#101c24');
          g.addColorStop(0.85, '#0b141b');
          g.addColorStop(1, '#080f15');
        } else {
          g.addColorStop(0, '#3c4d59');
          g.addColorStop(0.55, '#22323c');
          g.addColorStop(1, '#101d26');
        }
        ctx.fillStyle = g;
        roundRectRight(ctx, 0, by, bw, bh, 3);
        ctx.fill();
        ctx.restore();

        const gloss = ctx.createLinearGradient(0, by, 0, by + bh * 0.55);
        gloss.addColorStop(0, `rgba(255, 255, 255, ${pressed ? 0.05 : 0.16})`);
        gloss.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = gloss;
        roundRectRight(ctx, 0, by, bw, bh * 0.55, 3);
        ctx.fill();

        if (pressed) {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
          ctx.fillRect(0, by, bw, 1.5);
        } else if (hovered) {
          // Dark-on-dark is invisible, so hover on black keys lifts instead.
          ctx.fillStyle = 'rgba(140, 190, 220, 0.16)';
          roundRectRight(ctx, 0, by, bw, bh, 3);
          ctx.fill();
        }
      }

      // Octave labels on the C keys.
      if (v.rowH >= 9) {
        ctx.fillStyle = '#5f7482';
        ctx.font = '10px ui-monospace, Cascadia Code, Source Code Pro, Menlo, Consolas, DejaVu Sans Mono, monospace';
        ctx.textBaseline = 'middle';
        for (let row = firstRow; row <= lastRow; row++) {
          const midi = midiOfRow(activeTrack, row);
          if (midi % 12 === 0) ctx.fillText(midiToName(midi), KEY_WIDTH - 26, rowToY(row) + v.rowH / 2);
        }
      }
    }

    ctx.strokeStyle = 'rgba(1, 7, 14, 0.12)';
    ctx.beginPath();
    ctx.moveTo(KEY_WIDTH - 0.5, 0);
    ctx.lineTo(KEY_WIDTH - 0.5, size.h);
    ctx.stroke();
  }, [size.h, activeTrack]);

  const drawKeysRef = useRef(drawKeys);
  drawKeysRef.current = drawKeys;

  // Any audition (drawing a note, dragging one to a new pitch, live MIDI) presses the matching key while the sound runs.
  useEffect(() => {
    engine.onAudition = (midi, on, durationSec) => {
      const flashes = flashKeysRef.current;
      const prev = flashes.get(midi);
      if (prev !== undefined && prev >= 0) window.clearTimeout(prev);
      flashes.delete(midi);
      if (on) {
        if (durationSec === undefined) {
          flashes.set(midi, -1); // held until the note-off arrives
        } else {
          flashes.set(midi, window.setTimeout(() => {
            flashes.delete(midi);
            drawKeysRef.current();
          }, Math.max(120, durationSec * 1000)));
        }
      }
      drawKeysRef.current();
    };
    return () => {
      engine.onAudition = null;
    };
  }, []);

  const drawRuler = useCallback(() => {
    const v = viewRef.current;
    const ctx = prepare(rulerRef.current, size.w, RULER_HEIGHT);
    if (!ctx) return;
    ctx.fillStyle = '#e7f4fd';
    ctx.fillRect(0, 0, size.w, RULER_HEIGHT);

    const firstBeat = v.scrollBeat;
    const lastBeat = v.scrollBeat + size.w / v.pxPerBeat;
    const bpb = project.beatsPerBar;

    // The loop lane runs along the top of the ruler, solid while looping and
    // ghosted when it is off, so the range you drew is always visible.
    if (project.loopEndBeat > project.loopStartBeat) {
      const x0 = beatToX(project.loopStartBeat);
      const x1 = beatToX(project.loopEndBeat);
      const on = project.loopEnabled;
      ctx.fillStyle = on ? 'rgba(0, 102, 134, 0.85)' : 'rgba(0, 102, 134, 0.22)';
      ctx.fillRect(x0, 0, x1 - x0, 7);
      ctx.fillStyle = on ? 'rgba(0, 102, 134, 0.14)' : 'rgba(0, 102, 134, 0.05)';
      ctx.fillRect(x0, 0, x1 - x0, RULER_HEIGHT);
      if (on && x1 - x0 > 42) {
        ctx.fillStyle = '#ffffff';
        ctx.font = '9px Optima, Candara, Noto Sans, source-sans-pro, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText('LOOP', Math.max(2, x0 + 4), 4);
      }
    }

    if (region && region.endBeat > region.startBeat) {
      const x0 = beatToX(region.startBeat);
      const x1 = beatToX(region.endBeat);
      ctx.fillStyle = 'rgba(60, 29, 0, 0.85)';
      ctx.fillRect(x0, RULER_HEIGHT - 4, x1 - x0, 4);
      ctx.fillStyle = 'rgba(60, 29, 0, 0.16)';
      ctx.fillRect(x0, 0, x1 - x0, RULER_HEIGHT);
    }

    ctx.font = '11px ui-monospace, Cascadia Code, Source Code Pro, Menlo, Consolas, DejaVu Sans Mono, monospace';
    ctx.textBaseline = 'middle';
    const barPx = bpb * v.pxPerBeat;
    const barStep = barPx < 46 ? Math.ceil(46 / barPx) : 1;

    for (let b = Math.floor(firstBeat / bpb) * bpb; b < lastBeat; b += bpb) {
      const bar = Math.round(b / bpb);
      const x = Math.round(beatToX(b)) + 0.5;
      ctx.strokeStyle = 'rgba(1, 7, 14, 0.3)';
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT - 10);
      ctx.lineTo(x, RULER_HEIGHT);
      ctx.stroke();
      if (bar % barStep === 0) {
        ctx.fillStyle = '#38637a';
        ctx.fillText(String(bar + 1), x + 4, RULER_HEIGHT / 2 - 1);
      }
    }

    if (v.pxPerBeat > 34) {
      ctx.strokeStyle = 'rgba(1, 7, 14, 0.14)';
      ctx.beginPath();
      for (let b = Math.ceil(firstBeat); b < lastBeat; b++) {
        if (b % bpb === 0) continue;
        const x = Math.round(beatToX(b)) + 0.5;
        ctx.moveTo(x, RULER_HEIGHT - 5);
        ctx.lineTo(x, RULER_HEIGHT);
      }
      ctx.stroke();
    }
  }, [size.w, project.beatsPerBar, project.loopEnabled, project.loopStartBeat, project.loopEndBeat, region]);

  useEffect(() => {
    draw();
  }, [draw, view]);

  // ---- overlay: playhead + drag rectangle ---------------------------------
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      // Keys under the playhead press down while their notes sound.
      const wasPlaying = playingKeysRef.current;
      if (engine.isPlaying && activeTrack) {
        const pos = engine.positionBeats;
        const p = useStore.getState().project;
        const next = new Set<number>();
        for (const n of activeTrack.notes) {
          if (n.start <= pos && pos < n.start + n.duration) next.add(n.midi);
        }
        let changed = next.size !== wasPlaying.size;
        if (!changed) for (const m of next) if (!wasPlaying.has(m)) { changed = true; break; }
        if (changed) {
          playingKeysRef.current = next;
          drawKeys();
        }
      } else if (wasPlaying.size > 0) {
        playingKeysRef.current = new Set();
        drawKeys();
      }

      const drag = dragRef.current;

      // Rubber-band drags auto-scroll near the edges, with the anchor in beat/row space so the scrolled-away corner stays put.
      if (drag?.kind === 'select' && drag.moved) {
        const EDGE = 36;
        const v = viewRef.current;
        let dx = 0;
        let dy = 0;
        if (drag.curX > size.w - EDGE) dx = Math.min(14, (drag.curX - (size.w - EDGE)) * 0.25);
        else if (drag.curX < EDGE && v.scrollBeat > 0) dx = Math.max(-14, -(EDGE - drag.curX) * 0.25);
        if (drag.curY > size.h - EDGE) dy = Math.min(14, (drag.curY - (size.h - EDGE)) * 0.25);
        else if (drag.curY < EDGE && v.scrollRow > 0) dy = Math.max(-14, -(EDGE - drag.curY) * 0.25);
        if (dx !== 0 || dy !== 0) {
          setView((prev) => {
            const maxRow = Math.max(0, rowCount(activeTrack) - size.h / prev.rowH);
            return {
              ...prev,
              scrollBeat: Math.max(0, prev.scrollBeat + dx / prev.pxPerBeat),
              scrollRow: Math.max(0, Math.min(maxRow, prev.scrollRow + dy / prev.rowH)),
            };
          });
        }
        // Keep the selected set in step with scrolling (wheel or auto).
        rubberRef.current(drag);
      }

      const ctx = prepare(overlayRef.current, size.w, size.h);
      if (ctx) {
        if (drag?.kind === 'select') {
          const ax = beatToX(drag.startBeat);
          const ay = rowToY(drag.startRow);
          const x0 = Math.min(ax, drag.curX);
          const x1 = Math.max(ax, drag.curX);
          const y0 = Math.min(ay, drag.curY);
          const y1 = Math.max(ay, drag.curY);
          ctx.fillStyle = 'rgba(0, 63, 81, 0.13)';
          ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
          ctx.strokeStyle = 'rgba(0, 50, 65, 0.85)';
          ctx.lineWidth = 1;
          ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
        }

        const pos = engine.positionBeats;
        const x = Math.round(beatToX(pos)) + 0.5;
        if (x >= 0 && x <= size.w) {
          ctx.strokeStyle = '#8b1740';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, size.h);
          ctx.stroke();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [size, activeTrack]);

  // Keep the playhead in view while playing: when it runs off the edge the
  // view glides a page ahead rather than teleporting. A drag or a stop
  // cancels the glide so it never fights the user for the view.
  const followAnimRef = useRef<number | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!engine.isPlaying || followAnimRef.current !== null || dragRef.current) return;
      const v = viewRef.current;
      const pos = engine.positionBeats;
      const visible = size.w / v.pxPerBeat;
      if (pos < v.scrollBeat || pos > v.scrollBeat + visible * 0.92) {
        const from = v.scrollBeat;
        const to = Math.max(0, pos - visible * 0.15);
        const t0 = performance.now();
        const duration = 280;
        const step = (now: number) => {
          if (dragRef.current || !engine.isPlaying) {
            followAnimRef.current = null;
            return;
          }
          const t = Math.min(1, (now - t0) / duration);
          const eased = 1 - Math.pow(1 - t, 3);
          setView((prev) => ({ ...prev, scrollBeat: from + (to - from) * eased }));
          followAnimRef.current = t < 1 ? requestAnimationFrame(step) : null;
        };
        followAnimRef.current = requestAnimationFrame(step);
      }
    }, 120);
    return () => {
      window.clearInterval(id);
      if (followAnimRef.current !== null) cancelAnimationFrame(followAnimRef.current);
      followAnimRef.current = null;
    };
  }, [size.w]);

  // ---- interaction --------------------------------------------------------
  function localPos(e: React.PointerEvent | React.MouseEvent): { x: number; y: number } {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function noteAt(x: number, y: number): Note | null {
    if (!activeTrack) return null;
    const v = viewRef.current;
    const row = Math.floor(yToRow(y));
    const beat = xToBeat(x);
    // Reverse order so the topmost drawn note wins.
    for (let i = activeTrack.notes.length - 1; i >= 0; i--) {
      const n = activeTrack.notes[i];
      if (rowOfMidi(activeTrack, n.midi) !== row) continue;
      const nw = Math.max(3, n.duration * v.pxPerBeat) / v.pxPerBeat;
      if (beat >= n.start && beat <= n.start + nw) return n;
    }
    return null;
  }

  /**
   * Recompute the rubber-band selection from the drag's anchor, which is kept
   * in beat/row space so scrolling mid-drag doesn't move the first corner.
   */
  function applyRubberBand(drag: DragState) {
    if (!activeTrack) return;
    const store = useStore.getState();
    const v = viewRef.current;
    const curBeat = xToBeat(drag.curX);
    const curRow = yToRow(drag.curY);
    const b0 = Math.min(drag.startBeat, curBeat);
    const b1 = Math.max(drag.startBeat, curBeat);
    const r0 = Math.min(drag.startRow, curRow);
    const r1 = Math.max(drag.startRow, curRow);
    const inside = activeTrack.notes
      .filter((n) => {
        // A note fills exactly one row and its own beat span (with the 3px
        // floor the drawing uses), so the box takes what it visibly touches.
        const row = rowOfMidi(activeTrack, n.midi);
        if (row + 1 <= r0 || row >= r1) return false;
        const width = Math.max(3, n.duration * v.pxPerBeat) / v.pxPerBeat;
        return n.start + width > b0 && n.start < b1;
      })
      .map((n) => n.id);
    const next = drag.additive ? Array.from(new Set([...store.selectedNoteIds, ...inside])) : inside;
    if (next.length !== store.selectedNoteIds.length || next.some((id, i) => id !== store.selectedNoteIds[i])) {
      store.select(next);
    }
  }
  const rubberRef = useRef(applyRubberBand);
  rubberRef.current = applyRubberBand;

  const onPointerDown = (e: React.PointerEvent) => {
    if (!activeTrack) return;
    const { x, y } = localPos(e);
    const store = useStore.getState();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    if (e.pointerType === 'touch') {
      touchesRef.current.set(e.pointerId, { x, y });
      // A second finger turns whatever the first was doing into a pinch,
      // unless the first finger already grabbed a note.
      if (touchesRef.current.size === 2 && (!dragRef.current || dragRef.current.kind === 'pan' || dragRef.current.kind === 'select')) {
        const [a, b] = [...touchesRef.current.values()];
        pinchRef.current = { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
        dragRef.current = null;
        return;
      }
    }

    if (e.button === 1 || (e.button === 0 && e.altKey && e.shiftKey)) {
      dragRef.current = {
        kind: 'pan', startX: x, startY: y, startBeat: xToBeat(x), startRow: yToRow(y),
        curX: x, curY: y, primaryId: null, originals: new Map(), additive: false,
        scrollBeat0: viewRef.current.scrollBeat, scrollRow0: viewRef.current.scrollRow, lastPreviewMidi: -1,
        moved: false,
      };
      return;
    }

    const hit = noteAt(x, y);

    // Right button erases: one click for one note, or sweep across several.
    if (e.button === 2) {
      dragRef.current = {
        kind: 'erase', startX: x, startY: y, startBeat: xToBeat(x), startRow: yToRow(y),
        curX: x, curY: y, primaryId: null, originals: new Map(), additive: false,
        scrollBeat0: viewRef.current.scrollBeat, scrollRow0: viewRef.current.scrollRow, lastPreviewMidi: -1,
        moved: false,
      };
      if (hit) {
        store.pushHistory();
        dragRef.current.historyPushed = true;
        store.deleteNotes([hit.id], false);
      }
      return;
    }

    if (hit) {
      const v = viewRef.current;
      const noteEndX = beatToX(hit.start + hit.duration);
      const onHandle = Math.abs(x - noteEndX) <= RESIZE_HANDLE_PX;

      let ids = store.selectedNoteIds;
      if (e.ctrlKey || e.metaKey) {
        ids = ids.includes(hit.id) ? ids.filter((i) => i !== hit.id) : [...ids, hit.id];
        store.select(ids);
      } else if (!ids.includes(hit.id)) {
        ids = e.shiftKey ? [...ids, hit.id] : [hit.id];
        store.select(ids);
      }

      store.pushHistory();
      const originals = new Map<string, { start: number; midi: number; duration: number }>();
      for (const n of activeTrack.notes) {
        if (ids.includes(n.id)) originals.set(n.id, { start: n.start, midi: n.midi, duration: n.duration });
      }
      const previewMidi = hit.midi;
      dragRef.current = {
        kind: onHandle ? 'resize' : 'move',
        startX: x, startY: y, startBeat: xToBeat(x), startRow: yToRow(y),
        curX: x, curY: y, primaryId: hit.id, originals, additive: false,
        scrollBeat0: v.scrollBeat, scrollRow0: v.scrollRow, lastPreviewMidi: previewMidi,
        moved: false,
      };
      engine.preview(activeTrack.id, previewMidi);
      return;
    }

    // Empty space: the draw tool (or alt-drag with the select tool) places a
    // note, otherwise rubber-band select. Shift keeps rubber-band available in
    // draw mode, and alt in draw mode places without snapping.
    const wantsDraw = tool === 'draw' ? !e.shiftKey : e.altKey;
    if (wantsDraw) {
      const free = tool === 'draw' && e.altKey;
      const raw = xToBeat(x);
      const beat = Math.max(0, snapBeats > 0 && !free ? Math.floor(raw / snapBeats) * snapBeats : raw);
      const midi = midiOfRow(activeTrack, Math.floor(yToRow(y)));
      const dur = lastDrawDurRef.current ?? (snapBeats > 0 ? snapBeats : 1);
      const id = store.addNote(activeTrack.id, {
        start: beat, duration: dur, midi, velocity: 0.8, detune: 0,
      });
      store.select([id]);
      engine.preview(activeTrack.id, midi);
      const originals = new Map([[id, { start: beat, midi, duration: dur }]]);
      dragRef.current = {
        kind: 'resize', startX: x, startY: y, startBeat: xToBeat(x), startRow: yToRow(y),
        curX: x, curY: y, primaryId: id, originals, additive: false,
        scrollBeat0: viewRef.current.scrollBeat, scrollRow0: viewRef.current.scrollRow, lastPreviewMidi: midi,
        moved: false,
      };
      return;
    }

    // Touch has no wheel or modifier keys, so a finger on empty space pans
    // the view instead of rubber-banding. A tap still clears the selection.
    if (e.pointerType === 'touch') {
      dragRef.current = {
        kind: 'pan', startX: x, startY: y, startBeat: xToBeat(x), startRow: yToRow(y),
        curX: x, curY: y, primaryId: null, originals: new Map(), additive: false,
        scrollBeat0: viewRef.current.scrollBeat, scrollRow0: viewRef.current.scrollRow, lastPreviewMidi: -1,
        moved: false,
      };
      return;
    }

    if (!e.shiftKey) store.clearSelection();
    dragRef.current = {
      kind: 'select', startX: x, startY: y, startBeat: xToBeat(x), startRow: yToRow(y),
      curX: x, curY: y, primaryId: null, originals: new Map(), additive: e.shiftKey,
      scrollBeat0: viewRef.current.scrollBeat, scrollRow0: viewRef.current.scrollRow, lastPreviewMidi: -1,
      moved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    const { x, y } = localPos(e);

    if (e.pointerType === 'touch' && touchesRef.current.has(e.pointerId)) {
      touchesRef.current.set(e.pointerId, { x, y });
      if (pinchRef.current && touchesRef.current.size >= 2) {
        const [a, b] = [...touchesRef.current.values()];
        const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        zoom(dist / pinchRef.current.dist, (a.x + b.x) / 2, (a.y + b.y) / 2);
        pinchRef.current.dist = dist;
        return;
      }
    }

    if (!drag) {
      // Hover cursor feedback for the resize handle.
      const hit = noteAt(x, y);
      const el = e.currentTarget as HTMLElement;
      if (hit) {
        const endX = beatToX(hit.start + hit.duration);
        el.style.cursor = Math.abs(x - endX) <= RESIZE_HANDLE_PX ? 'ew-resize' : 'grab';
      } else {
        el.style.cursor = tool === 'draw' ? 'crosshair' : 'default';
      }
      return;
    }

    drag.curX = x;
    drag.curY = y;
    if (!drag.moved) {
      if (Math.hypot(x - drag.startX, y - drag.startY) < DRAG_THRESHOLD_PX) {
        // Clicking a note must not snap or resize it, so edits start with real travel.
        if (drag.kind === 'move' || drag.kind === 'resize') return;
      } else {
        drag.moved = true;
      }
    }
    const store = useStore.getState();
    const v = viewRef.current;

    if (drag.kind === 'pan') {
      setView((prev) => ({
        ...prev,
        scrollBeat: Math.max(0, drag.scrollBeat0 - (x - drag.startX) / v.pxPerBeat),
        scrollRow: Math.max(0, drag.scrollRow0 - (y - drag.startY) / v.rowH),
      }));
      return;
    }

    if (drag.kind === 'move' && drag.primaryId) {
      const orig = drag.originals.get(drag.primaryId)!;
      const rawDelta = xToBeat(x) - drag.startBeat;
      // Alt drags freely past the grid for fine placement.
      const targetStart = snapBeats > 0 && !e.altKey
        ? quantizeValue(orig.start + rawDelta, snapBeats, 1)
        : orig.start + rawDelta;
      let deltaBeats = Math.max(targetStart, 0) - orig.start;
      let deltaRows = Math.round(yToRow(y) - drag.startRow);
      // Shift locks the drag to whichever axis has travelled further.
      if (e.shiftKey) {
        if (Math.abs(x - drag.startX) >= Math.abs(y - drag.startY)) deltaRows = 0;
        else deltaBeats = 0;
      }

      store.updateNotes(
        [...drag.originals.keys()],
        (n) => {
          const o = drag.originals.get(n.id)!;
          const origRow = rowOfMidi(activeTrack, o.midi);
          const newMidi = midiOfRow(activeTrack, Math.max(0, Math.min(rowCount(activeTrack) - 1, origRow + deltaRows)));
          return { start: Math.max(0, o.start + deltaBeats), midi: newMidi };
        },
        false,
      );

      // Fresh state: `store` predates the updateNotes call just above.
      const primary = useStore.getState().project.tracks
        .find((t) => t.id === activeTrackId)?.notes.find((n) => n.id === drag.primaryId);
      if (primary) {
        const previewMidi = primary.midi;
        if (previewMidi !== drag.lastPreviewMidi) {
          drag.lastPreviewMidi = previewMidi;
          engine.preview(activeTrackId, previewMidi);
        }
      }
      return;
    }

    if (drag.kind === 'resize' && drag.primaryId) {
      const orig = drag.originals.get(drag.primaryId)!;
      const rawEnd = xToBeat(x);
      const free = e.altKey;
      const target = snapBeats > 0 && !free ? quantizeValue(rawEnd, snapBeats, 1) : rawEnd;
      const newDuration = Math.max(free ? 1 / 32 : snapBeats > 0 ? snapBeats : 1 / 16, target - orig.start);
      const scale = newDuration / Math.max(1e-6, orig.duration);
      store.updateNotes(
        [...drag.originals.keys()],
        (n) => {
          const o = drag.originals.get(n.id)!;
          return { duration: Math.max(1 / 64, drag.originals.size === 1 ? newDuration : o.duration * scale) };
        },
        false,
      );
      return;
    }

    if (drag.kind === 'erase') {
      const swept = noteAt(x, y);
      if (swept) {
        if (!drag.historyPushed) {
          store.pushHistory();
          drag.historyPushed = true;
        }
        store.deleteNotes([swept.id], false);
      }
      return;
    }

    if (drag.kind === 'select') applyRubberBand(drag);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch') {
      touchesRef.current.delete(e.pointerId);
      if (touchesRef.current.size < 2) pinchRef.current = null;
    }
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.kind === 'pan' && !drag.moved && e.pointerType === 'touch') {
      useStore.getState().clearSelection();
    }
    if (drag.kind === 'resize' && drag.moved && drag.primaryId) {
      const n = useStore.getState().project.tracks
        .find((t) => t.id === activeTrackId)?.notes.find((x) => x.id === drag.primaryId);
      if (n) lastDrawDurRef.current = n.duration;
    }
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (!activeTrack) return;
    // In draw mode a double-click is just two placements, and the select-mode add/delete would fight them.
    if (tool === 'draw') return;
    const { x, y } = localPos(e);
    const hit = noteAt(x, y);
    const store = useStore.getState();
    if (hit) {
      store.select([hit.id]);
      store.deleteSelected();
      return;
    }
    const beat = snapBeats > 0 ? Math.floor(xToBeat(x) / snapBeats) * snapBeats : xToBeat(x);
    const midi = midiOfRow(activeTrack, Math.floor(yToRow(y)));
    const id = store.addNote(activeTrack.id, {
      start: Math.max(0, beat),
      duration: lastDrawDurRef.current ?? (snapBeats > 0 ? snapBeats : 1),
      midi,
      velocity: 0.8,
      detune: 0,
    });
    store.select([id]);
    engine.preview(activeTrack.id, midi);
  };

  /**
   * Scale the keyboard and the notes together about a point, so zooming keeps
   * whatever is under the pointer under the pointer.
   */
  const zoom = (factor: number, anchorX = size.w / 2, anchorY = size.h / 2) => {
    const v = viewRef.current;
    const pxPerBeat = Math.max(MIN_PX_PER_BEAT, Math.min(MAX_PX_PER_BEAT, v.pxPerBeat * factor));
    const rowH = Math.max(MIN_ROW_H, Math.min(MAX_ROW_H, v.rowH * factor));
    rowHMemo.current[activeTrack?.isDrum ? 'drum' : 'melodic'] = rowH;
    const beatAt = anchorX / v.pxPerBeat + v.scrollBeat;
    const rowAt = anchorY / v.rowH + v.scrollRow;
    const maxRow = Math.max(0, rowCount(activeTrack) - size.h / rowH);
    setView({
      pxPerBeat,
      rowH,
      scrollBeat: Math.max(0, beatAt - anchorX / pxPerBeat),
      scrollRow: Math.max(0, Math.min(maxRow, rowAt - anchorY / rowH)),
    });
  };

  const onWheel = (e: WheelEvent) => {
    // Ctrl + wheel is also the browser's own page zoom, and React registers
    // wheel listeners as passive, where preventDefault is ignored. Hence the
    // native listener below: without it the whole app zooms along with the roll.
    e.preventDefault();
    const v = viewRef.current;
    const rect = gridRef.current?.getBoundingClientRect();
    const localX = rect ? Math.max(0, e.clientX - rect.left) : 0;
    const localY = rect ? Math.max(0, e.clientY - rect.top) : 0;
    const dy = e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaMode === 2 ? e.deltaY * size.h : e.deltaY;

    if (e.ctrlKey || e.metaKey) {
      zoom(Math.exp(-dy * 0.0022), localX, localY);
    } else if (e.shiftKey) {
      setView({ ...v, scrollBeat: Math.max(0, v.scrollBeat + dy / v.pxPerBeat) });
    } else {
      const maxRow = Math.max(0, rowCount(activeTrack) - size.h / v.rowH);
      setView({ ...v, scrollRow: Math.max(0, Math.min(maxRow, v.scrollRow + dy / v.rowH)) });
    }
  };

  // Attached by hand, non-passive, and on the whole roll so the ruler and the
  // keyboard behave like the note area rather than scrolling the page.
  const wheelRef = useRef(onWheel);
  wheelRef.current = onWheel;
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  // ---- keyboard column: click or glide to audition pitches ----------------
  const keyPreviewMidi = useRef(-1);

  /** The key under a point: one key per lane, black keys included. */
  function keyAt(_x: number, y: number): number {
    return midiOfRow(activeTrack, Math.floor(yToRow(y)));
  }

  const onKeysDown = (e: React.PointerEvent) => {
    if (!activeTrack) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const { x, y } = localPos(e);
    // On touch the keys column is the scroll rail: drag scrolls, tap previews
    // on release once it is clear no scroll was meant.
    if (e.pointerType === 'touch') {
      keysPanRef.current = { startY: y, scrollRow0: viewRef.current.scrollRow, panning: false };
      return;
    }
    const midi = keyAt(x, y);
    keyPreviewMidi.current = midi;
    pressedKeyRef.current = midi;
    hoverKeyRef.current = midi;
    drawKeys();
    engine.preview(activeTrack.id, midi);
  };

  const onKeysMove = (e: React.PointerEvent) => {
    if (!activeTrack) return;
    const { x, y } = localPos(e);
    const pan = keysPanRef.current;
    if (pan) {
      const dy = y - pan.startY;
      if (!pan.panning && Math.abs(dy) > 6) pan.panning = true;
      if (pan.panning) {
        const v = viewRef.current;
        const maxRow = Math.max(0, rowCount(activeTrack) - size.h / v.rowH);
        setView((prev) => ({
          ...prev,
          scrollRow: Math.max(0, Math.min(maxRow, pan.scrollRow0 - dy / v.rowH)),
        }));
      }
      return;
    }
    const midi = keyAt(x, y);
    let dirty = false;
    if (hoverKeyRef.current !== midi) {
      hoverKeyRef.current = midi;
      dirty = true;
    }
    if (keyPreviewMidi.current >= 0 && midi !== keyPreviewMidi.current) {
      keyPreviewMidi.current = midi;
      pressedKeyRef.current = midi;
      dirty = true;
      engine.preview(activeTrack.id, midi);
    }
    if (dirty) drawKeys();
  };

  const onKeysUp = (e: React.PointerEvent) => {
    const pan = keysPanRef.current;
    keysPanRef.current = null;
    if (pan && !pan.panning && activeTrack) {
      const { x, y } = localPos(e);
      engine.preview(activeTrack.id, keyAt(x, y));
    }
    keyPreviewMidi.current = -1;
    pressedKeyRef.current = -1;
    drawKeys();
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  const onKeysLeave = () => {
    if (hoverKeyRef.current === -1) return;
    hoverKeyRef.current = -1;
    drawKeys();
  };

  /**
   * Click the ruler to play from that point, drag across it to highlight a
   * range, which also becomes the loop. The two are told apart by whether the
   * pointer actually travelled, so a slightly shaky click still seeks rather
   * than leaving a sliver of a region.
   */
  const rulerDrag = useRef<{ startBeat: number; moved: boolean } | null>(null);

  const onRulerDown = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const beat = Math.max(0, xToBeat(e.clientX - rect.left));
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    rulerDrag.current = { startBeat: beat, moved: false };
  };

  const onRulerMove = (e: React.PointerEvent) => {
    const drag = rulerDrag.current;
    if (!drag) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const beat = Math.max(0, xToBeat(e.clientX - rect.left));
    if (Math.abs(beat - drag.startBeat) * viewRef.current.pxPerBeat < 4) return;
    drag.moved = true;
    const snap = (b: number) => (snapBeats > 0 && !e.altKey ? Math.round(b / snapBeats) * snapBeats : b);
    const a = snap(drag.startBeat);
    const b = snap(beat);
    useStore.getState().setRegion({ startBeat: Math.min(a, b), endBeat: Math.max(a, b) });
  };

  const onRulerUp = (e: React.PointerEvent) => {
    const drag = rulerDrag.current;
    rulerDrag.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (!drag) return;
    const store = useStore.getState();

    // A drag ends by handing its range to the loop, so the highlighted section
    // and the looped section are the same thing.
    if (drag.moved) {
      const r = store.region;
      if (r && r.endBeat > r.startBeat) {
        store.setLoop(store.project.loopEnabled, r.startBeat, r.endBeat);
        engine.setProjectLoop(useStore.getState().project);
        store.setStatus(
          store.project.loopEnabled
            ? 'Looping the highlighted section'
            : 'Section highlighted. Press Loop to repeat it.',
        );
      }
      return;
    }

    store.setRegion(null);
    const snapped = Math.floor(drag.startBeat / project.beatsPerBar) * project.beatsPerBar;
    const beat = e.shiftKey ? drag.startBeat : snapped;
    // Ctrl-click parks the playhead without starting the song.
    if (e.ctrlKey || e.metaKey) engine.seek(beat);
    else void playFrom(beat);
  };

  return (
    <div className={`pianoroll ${activeTrack ? '' : 'no-track'}`} ref={wrapRef}>
      <div className="pr-corner">
        <button className="mini" title="Zoom out (Ctrl + wheel over the notes)" onClick={() => zoom(1 / 1.25)}>
          −
        </button>
        <button className="mini" title="Zoom in (Ctrl + wheel over the notes)" onClick={() => zoom(1.25)}>
          +
        </button>
      </div>
      <div
        className="pr-ruler"
        onPointerDown={onRulerDown}
        onPointerMove={onRulerMove}
        onPointerUp={onRulerUp}
        onPointerCancel={onRulerUp}
        title="Click to play from there (Ctrl-click just moves the playhead, Shift ignores the bar line) · drag to highlight a section, which becomes the loop"
      >
        <canvas ref={rulerRef} />
      </div>
      <div
        className="pr-keys"
        onPointerDown={onKeysDown}
        onPointerMove={onKeysMove}
        onPointerUp={onKeysUp}
        onPointerCancel={onKeysUp}
        onPointerLeave={onKeysLeave}
        title="Click a key to hear it"
      >
        <canvas ref={keysRef} />
      </div>
      <div
        className="pr-grid"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      >
        <canvas ref={gridRef} />
        <canvas ref={overlayRef} className="overlay" />
      </div>
      {!activeTrack && (
        <div className="pr-empty">
          <p>No track selected</p>
          <button
            className="ghost"
            onClick={() => useStore.getState().addTrack({ name: `Track ${project.tracks.length + 1}` })}
          >
            + Add a part
          </button>
        </div>
      )}
    </div>
  );
}

/** Rect rounded only on its right corners, the visible end of a black key. */
function roundRectRight(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.max(0, Math.min(r, h / 2));
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}
