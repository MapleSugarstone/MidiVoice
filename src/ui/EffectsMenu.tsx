import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../model/store';
import { engine } from '../audio/engine';
import { GRIDS, midiToName, drumLaneName, snapToScale } from '../model/music';

/** Dropdown state that closes on outside pointerdown or Escape. */
export function useDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    // Capture phase, so Escape closes the menu without also stopping the transport.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  return { open, setOpen, ref };
}

export function Item({
  label, keys, disabled, danger, onClick,
}: {
  label: string; keys?: string; disabled?: boolean; danger?: boolean; onClick: () => void;
}) {
  return (
    <button className={`menu-item ${danger ? 'danger' : ''}`} role="menuitem" disabled={disabled} onClick={onClick}>
      <span>{label}</span>
      {keys && <kbd>{keys}</kbd>}
    </button>
  );
}

export function EffectsMenu() {
  const { open, setOpen, ref } = useDropdown();
  const selectedNoteIds = useStore((s) => s.selectedNoteIds);
  const project = useStore((s) => s.project);
  const activeTrackId = useStore((s) => s.activeTrackId);
  const gridIndex = useStore((s) => s.gridIndex);
  const store = useStore.getState;

  const track = project.tracks.find((t) => t.id === activeTrackId);
  const selected = useMemo(() => {
    const ids = new Set(selectedNoteIds);
    const out = [];
    for (const t of project.tracks) for (const n of t.notes) if (ids.has(n.id)) out.push({ track: t, note: n });
    return out;
  }, [selectedNoteIds, project]);

  const count = selected.length;
  const none = count === 0;
  const grid = GRIDS[gridIndex].label;

  const avgDetune = count ? selected.reduce((a, s) => a + s.note.detune, 0) / count : 0;

  const after = () => engine.scheduleProject(useStore.getState().project);
  // One-shot actions close the menu; the transpose row and slider stay open.
  const run = (fn: () => void) => {
    fn();
    after();
    setOpen(false);
  };
  const runStay = (fn: () => void) => {
    fn();
    after();
  };

  let summary = 'No selection';
  if (count === 1) {
    const s = selected[0];
    const name = s.track.isDrum
      ? drumLaneName(s.note.midi)
      : midiToName(s.track.snapToScale ? snapToScale(s.note.midi, project.keyRoot, project.scale) : s.note.midi);
    summary = `${name} · ${s.note.duration.toFixed(2)} beats`;
  } else if (count > 1) {
    const lo = midiToName(Math.min(...selected.map((s) => s.note.midi)));
    const hi = midiToName(Math.max(...selected.map((s) => s.note.midi)));
    summary = `${count} notes · ${lo}–${hi}`;
  }
  if (count > 0 && !track?.isDrum && Math.abs(avgDetune) >= 1) {
    summary += ` · drift ${avgDetune > 0 ? '+' : ''}${avgDetune.toFixed(0)}¢`;
  }

  return (
    <div className="menuwrap" ref={ref}>
      <button
        className={`toggle ${open ? 'on' : ''}`}
        onClick={() => setOpen(!open)}
        title="Operations for the selected notes"
      >
        Effects{count ? ` (${count})` : ''} ▾
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-summary">{summary}</div>
          <Item label="Select whole track" keys="Ctrl+A" onClick={() => runStay(() => store().selectAllOnTrack(activeTrackId))} />

          <div className="menu-label">Timing</div>
          <Item label={`Snap starts to ${grid}`} keys="Q" disabled={none} onClick={() => run(() => store().quantizeSelection({ starts: true, lengths: false }))} />
          <Item label="Snap starts + lengths" disabled={none} onClick={() => run(() => store().quantizeSelection({ starts: true, lengths: true }))} />
          <Item label="Close gaps" keys="L" disabled={none} onClick={() => run(() => store().legatoSelection())} />
          <Item label={`Chop to ${grid}`} keys="Ctrl+Alt+C" disabled={none} onClick={() => run(() => store().chopSelection())} />
          {/* Factors are rate changes: 1/0.8 = +25%, 1/(4/3) = −25%. */}
          <Item label="Speed up 25%" disabled={none} onClick={() => run(() => store().scaleSelectionTiming(0.8))} />
          <Item label="Slow down 25%" disabled={none} onClick={() => run(() => store().scaleSelectionTiming(4 / 3))} />

          <div className="menu-label">Pitch</div>
          <Item label="Force into key" disabled={none || !!track?.isDrum} onClick={() => run(() => store().tuneSelectionToScale())} />
          <Item label="Remove tuning drift" disabled={none} onClick={() => run(() => store().flattenSelectionTuning())} />
          <div className="menu-row">
            <span className="menu-row-label">Transpose</span>
            <button className="ghost sm" disabled={none} title="Down an octave" onClick={() => runStay(() => store().nudgeSelection(0, -12))}>−12</button>
            <button className="ghost sm" disabled={none} title="Down a semitone" onClick={() => runStay(() => store().nudgeSelection(0, -1))}>−1</button>
            <button className="ghost sm" disabled={none} title="Up a semitone" onClick={() => runStay(() => store().nudgeSelection(0, 1))}>+1</button>
            <button className="ghost sm" disabled={none} title="Up an octave" onClick={() => runStay(() => store().nudgeSelection(0, 12))}>+12</button>
          </div>

          <div className="menu-label">Edit</div>
          <Item label="Join notes" keys="J" disabled={count < 2} onClick={() => run(() => store().mergeSelectedNotes())} />
          <Item label="Duplicate" keys="Ctrl+D" disabled={none} onClick={() => run(() => store().duplicateSelection())} />
          <Item label="Delete" keys="Del" danger disabled={none} onClick={() => run(() => store().deleteSelected())} />
        </div>
      )}
    </div>
  );
}

export function ShortcutsMenu({ className = '' }: { className?: string }) {
  const { open, setOpen, ref } = useDropdown();
  return (
    <div className={`menuwrap ${className}`} ref={ref}>
      <button
        className={`toggle ${open ? 'on' : ''}`}
        onClick={() => setOpen(!open)}
        title="Keyboard shortcuts"
        aria-label="Keyboard shortcuts"
      >
        ?
      </button>
      {open && (
        <div className="menu right shortcuts-menu">
          <div className="menu-label">Shortcuts</div>
          <ul className="menu-keys">
            <li><kbd>Space</kbd> play / pause · <kbd>Home</kbd>/<kbd>End</kbd> jump</li>
            <li><kbd>R</kbd> record · <kbd>D</kbd> switch tool · <kbd>Ctrl</kbd>+<kbd>S</kbd> save</li>
            <li><kbd>↑</kbd><kbd>↓</kbd> transpose · <kbd>Shift</kbd> octave</li>
            <li><kbd>←</kbd><kbd>→</kbd> move by grid · <kbd>Shift</kbd> bar</li>
            <li><kbd>Q</kbd> snap starts · <kbd>L</kbd> close gaps · <kbd>J</kbd> join</li>
            <li><kbd>Ctrl</kbd>+<kbd>C</kbd>/<kbd>X</kbd>/<kbd>V</kbd>/<kbd>D</kbd> copy / cut / paste / duplicate</li>
            <li><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd> chop · <kbd>[</kbd> <kbd>]</kbd> grid size</li>
            <li><kbd>Alt</kbd>+drag: draw a note · right-click: erase</li>
            <li>while dragging, <kbd>Alt</kbd> ignores snap · <kbd>Shift</kbd> locks one axis</li>
            <li>drag a note's right edge to set its length</li>
            <li><kbd>Ctrl</kbd>+wheel zoom</li>
            <li>click a piano key to preview it</li>
            <li>ruler: click to play from there · drag to set the loop range</li>
          </ul>
        </div>
      )}
    </div>
  );
}
