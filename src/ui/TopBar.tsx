import { useEffect, useRef, useState } from 'react';
import { useStore } from '../model/store';
import { engine } from '../audio/engine';
import { GRIDS, NOTE_NAMES, SCALES, formatBarBeat } from '../model/music';
import {
  exportMidiFile,
  exportFishFile,
  midiToProject,
  parseProjectFile,
  parseFishFile,
  downloadBlob,
  safeFilename,
} from '../model/midiIO';
import { renderProject } from '../audio/render';
import { stopAll, togglePlay } from './transport';
import { EffectsMenu, ShortcutsMenu, useDropdown, Item } from './EffectsMenu';
import type { ScaleId } from '../model/types';
import type { RecordPhase } from './useRecording';

interface Props {
  phase: RecordPhase;
  onToggleRecord: () => void;
  position: number;
}

/** A beat position as a bar number, with the fraction only when there is one. */
function barLabel(beat: number, beatsPerBar: number): string {
  const bar = beat / beatsPerBar + 1;
  return Number.isInteger(bar) ? String(bar) : bar.toFixed(2);
}

export function TopBar({ phase, onToggleRecord, position }: Props) {
  const project = useStore((s) => s.project);
  const gridIndex = useStore((s) => s.gridIndex);
  const tool = useStore((s) => s.tool);
  const metronome = useStore((s) => s.metronome);
  const metronomeVolume = useStore((s) => s.metronomeVolume);
  const masterVolume = useStore((s) => s.masterVolume);
  const reverbAmount = useStore((s) => s.reverbAmount);
  const past = useStore((s) => s.past.length);
  const future = useStore((s) => s.future.length);

  const fileRef = useRef<HTMLInputElement>(null);
  const [rendering, setRendering] = useState(false);
  const [playing, setPlaying] = useState(false);

  // Cheap poll rather than subscribing the whole bar to a rAF loop.
  useAnimationPoll(() => setPlaying(engine.isPlaying));

  const store = useStore.getState;
  const recording = phase === 'recording' || phase === 'countIn';

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      if (file.name.endsWith('.fish')) {
        store().loadProject(await parseFishFile(await file.arrayBuffer()));
      } else if (file.name.endsWith('.json')) {
        store().loadProject(parseProjectFile(await file.text()));
      } else {
        store().loadProject(midiToProject(await file.arrayBuffer(), file.name.replace(/\.midi?$/i, '')));
      }
    } catch (err) {
      store().setStatus(`Import failed: ${(err as Error).message}`);
    }
    e.target.value = '';
  }

  async function handleRender() {
    setRendering(true);
    store().setStatus('Bouncing to audio…');
    try {
      const blob = await renderProject(store().project, store().reverbAmount);
      downloadBlob(blob, `${safeFilename(store().project.name)}.wav`);
      store().setStatus('Audio exported');
    } catch (err) {
      store().setStatus(`Render failed: ${(err as Error).message}`);
    } finally {
      setRendering(false);
    }
  }

  return (
    <header className="topbar">
      <div className="topbar-row">
      <div className="brand">
        <img className="logo" src={`${import.meta.env.BASE_URL}logo-fish.svg`} alt="MidiVoice" />
        <input
          className="songname"
          value={project.name}
          onChange={(e) => store().setProjectMeta({ name: e.target.value })}
          spellCheck={false}
        />
      </div>

      <div className="group right">
        <button className="ghost icon" onClick={() => store().undo()} disabled={past === 0} title="Undo (Ctrl+Z)">
          <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
            <path d="M5 1.8 L1.8 5 L5 8.2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M1.8 5 H10.3 A3.6 3.6 0 0 1 10.3 12.2 H6.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </button>
        <button className="ghost icon" onClick={() => store().redo()} disabled={future === 0} title="Redo (Ctrl+Shift+Z)">
          <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
            <path d="M11 1.8 L14.2 5 L11 8.2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M14.2 5 H5.7 A3.6 3.6 0 0 0 5.7 12.2 H9.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </button>
        <button className="ghost m-hide" onClick={() => fileRef.current?.click()} title="Open a .fish, .mid, or .json file">
          Open
        </button>
        <button className="ghost m-hide" onClick={() => exportMidiFile(project)} title="Export a standard MIDI file">
          MIDI
        </button>
        <button
          className="ghost m-hide"
          onClick={() => {
            void exportFishFile(project).then(() => store().setStatus(`Saved ${safeFilename(project.name)}.fish`));
          }}
          title="Save the full project with take audio (.fish, Ctrl+S)"
        >
          Save
        </button>
        <button className="ghost m-hide" onClick={handleRender} disabled={rendering} title="Bounce the song to a .wav">
          {rendering ? '…' : 'WAV'}
        </button>
        <ShortcutsMenu className="m-hide" />
        <FileMenu
          rendering={rendering}
          onOpen={() => fileRef.current?.click()}
          onSave={() => {
            void exportFishFile(project).then(() => store().setStatus(`Saved ${safeFilename(project.name)}.fish`));
          }}
          onMidi={() => exportMidiFile(project)}
          onWav={() => void handleRender()}
        />
        <input ref={fileRef} type="file" accept=".mid,.midi,.json,.fish" hidden onChange={handleImport} />
      </div>
      </div>

      <div className="topbar-row">
      <div className="group transport">
        <button
          className={`transport-btn ${playing ? 'active' : ''}`}
          onClick={() => void togglePlay()}
          title="Play / pause (Space)"
        >
          {playing ? (
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <rect x="3" y="2.5" width="3" height="9" rx="1" fill="currentColor" />
              <rect x="8" y="2.5" width="3" height="9" rx="1" fill="currentColor" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M4.4 2.8 L11.2 7 L4.4 11.2 Z"
                fill="currentColor"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
        <button className="transport-btn" onClick={stopAll} title="Stop and return to start">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <rect x="3.2" y="3.2" width="7.6" height="7.6" rx="1.5" fill="currentColor" />
          </svg>
        </button>
        <button
          className={`transport-btn record ${recording ? 'armed' : ''}`}
          onClick={onToggleRecord}
          disabled={
            project.tracks.length === 0 ||
            phase === 'transcribing' ||
            phase === 'calibrating' ||
            phase === 'arming'
          }
          title={project.tracks.length === 0 ? 'Add a track first' : 'Record (R)'}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="4.4" fill="currentColor" />
          </svg>
        </button>
        <div className="position" title="Bar . beat . tick">
          {formatBarBeat(position, project.beatsPerBar)}
        </div>
      </div>

      <div className="group m-hide">
        <label className="field">
          <span>Tempo</span>
          <NumberField
            min={20}
            max={300}
            value={project.bpm}
            onCommit={(bpm) => {
              store().setProjectMeta({ bpm });
              engine.setBpm(bpm);
            }}
          />
        </label>
        <label className="field">
          <span>Beats/bar</span>
          <NumberField
            min={1}
            max={16}
            value={project.beatsPerBar}
            onCommit={(n) => {
              store().setProjectMeta({ beatsPerBar: n });
              engine.setBeatsPerBar(n);
            }}
          />
        </label>
      </div>

      <div className="group m-hide">
        <label className="field">
          <span>Key</span>
          <select
            value={project.keyRoot}
            onChange={(e) => store().setProjectMeta({ keyRoot: Number(e.target.value) })}
          >
            {NOTE_NAMES.map((n, i) => (
              <option key={n} value={i}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Scale</span>
          <select
            value={project.scale}
            onChange={(e) => store().setProjectMeta({ scale: e.target.value as ScaleId })}
          >
            {Object.entries(SCALES).map(([id, s]) => (
              <option key={id} value={id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="group tools">
        <button
          className={`toggle ${tool === 'select' ? 'on' : ''}`}
          onClick={() => store().setTool('select')}
          title="Select and move notes (D switches tools)"
        >
          Select
        </button>
        <button
          className={`toggle ${tool === 'draw' ? 'on' : ''}`}
          onClick={() => store().setTool('draw')}
          title="Click to place a note, drag to set its length, right-click to delete (D switches tools)"
        >
          ✎ Draw
        </button>
        <label className="field m-hide">
          <span>Snap</span>
          <select value={gridIndex} onChange={(e) => store().setSetting('gridIndex', Number(e.target.value))}>
            {GRIDS.map((g, i) => (
              <option key={g.label} value={i}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        <EffectsMenu />
        <SongMenu />
        <button
          className={`toggle m-hide ${metronome ? 'on' : ''}`}
          onClick={() => {
            const next = !metronome;
            store().setSetting('metronome', next);
            engine.metronomeEnabled = next;
          }}
          title="Metronome click"
        >
          Click
        </button>
        <button
          className={`toggle m-hide ${project.loopEnabled ? 'on' : ''}`}
          onClick={() => {
            store().toggleLoop();
            engine.setProjectLoop(store().project);
          }}
          title="Loop the highlighted ruler section, or the whole song if none is highlighted"
        >
          ⟳ Loop
        </button>
        {project.loopEnabled && project.loopEndBeat > project.loopStartBeat && (
          <span className="loop-range m-hide" title="Drag across the ruler to move the loop">
            bars {barLabel(project.loopStartBeat, project.beatsPerBar)}–
            {barLabel(project.loopEndBeat, project.beatsPerBar)}
          </span>
        )}
      </div>

      <div className="group m-hide">
        <label className="field slider" title="Master volume">
          <span>Vol</span>
          <input
            type="range"
            min={0}
            max={1.2}
            step={0.01}
            value={masterVolume}
            onChange={(e) => {
              const v = Number(e.target.value);
              store().setSetting('masterVolume', v);
              engine.setMasterVolume(v);
            }}
          />
        </label>
        <label className="field slider" title="Reverb amount">
          <span>Reverb</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={reverbAmount}
            onChange={(e) => {
              const v = Number(e.target.value);
              store().setSetting('reverbAmount', v);
              engine.setReverbAmount(v);
            }}
          />
        </label>
        <label className="field slider" title="Metronome volume">
          <span>Click</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={metronomeVolume}
            onChange={(e) => {
              const v = Number(e.target.value);
              store().setSetting('metronomeVolume', v);
              engine.setMetronomeVolume(v);
            }}
          />
        </label>
      </div>

      </div>
    </header>
  );
}

/** Number input that doesn't fight the keyboard: 'live' mode applies in-range values per keystroke and clamps only on blur or Enter, 'blur' mode holds every change until then, and the steppers are our own buttons because Chrome's native spin button can't be themed. */
export function NumberField({
  value, min, max, step = 1, mode = 'live', onCommit,
}: {
  value: number; min: number; max: number; step?: number; mode?: 'live' | 'blur';
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  const bump = (dir: 1 | -1) => {
    const typed = draft !== null && draft !== '' ? Number(draft) : NaN;
    const base = isFinite(typed) ? typed : value;
    setDraft(null);
    onCommit(clamp(Math.round((base + dir * step) * 1000) / 1000));
  };
  // Hold-to-repeat. The ref always points at the latest bump so repeats read
  // fresh state, not the closure from the press that started them.
  const bumpRef = useRef(bump);
  bumpRef.current = bump;
  const holdRef = useRef<{ t: number | null; i: number | null }>({ t: null, i: null });
  const endHold = () => {
    if (holdRef.current.t !== null) window.clearTimeout(holdRef.current.t);
    if (holdRef.current.i !== null) window.clearInterval(holdRef.current.i);
    holdRef.current = { t: null, i: null };
  };
  const startHold = (dir: 1 | -1) => {
    endHold();
    bumpRef.current(dir);
    holdRef.current.t = window.setTimeout(() => {
      holdRef.current.i = window.setInterval(() => bumpRef.current(dir), 70);
    }, 400);
  };
  useEffect(() => endHold, []);
  return (
    <span className="numfield">
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft ?? value}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          const n = Number(raw);
          if (mode === 'live' && raw !== '' && isFinite(n) && n >= min && n <= max) onCommit(n);
        }}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (e.target.value !== '' && isFinite(n)) onCommit(clamp(n));
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      <span className="numsteps">
        <button
          type="button"
          tabIndex={-1}
          aria-label="Increase"
          onPointerDown={(e) => { e.preventDefault(); startHold(1); }}
          onPointerUp={endHold}
          onPointerLeave={endHold}
          onPointerCancel={endHold}
        >
          <svg width="8" height="5" viewBox="0 0 8 5" aria-hidden="true">
            <path d="M1 4l3-3 3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label="Decrease"
          onPointerDown={(e) => { e.preventDefault(); startHold(-1); }}
          onPointerUp={endHold}
          onPointerLeave={endHold}
          onPointerCancel={endHold}
        >
          <svg width="8" height="5" viewBox="0 0 8 5" aria-hidden="true">
            <path d="M1 1l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </span>
    </span>
  );
}

/** Phone-only stand-in for the file button row (see the m-only/m-hide pair in styles.css). */
function FileMenu({
  rendering, onOpen, onSave, onMidi, onWav,
}: {
  rendering: boolean; onOpen: () => void; onSave: () => void; onMidi: () => void; onWav: () => void;
}) {
  const { open, setOpen, ref } = useDropdown();
  const run = (fn: () => void) => {
    fn();
    setOpen(false);
  };
  return (
    <div className="menuwrap m-only" ref={ref}>
      <button className={`toggle ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} title="Open, save, export">
        File ▾
      </button>
      {open && (
        <div className="menu right" role="menu">
          <Item label="Open…" onClick={() => run(onOpen)} />
          <Item label="Save project (.fish)" onClick={() => run(onSave)} />
          <Item label="Export MIDI (.mid)" onClick={() => run(onMidi)} />
          <Item label={rendering ? 'Exporting…' : 'Export audio (.wav)'} disabled={rendering} onClick={() => run(onWav)} />
        </div>
      )}
    </div>
  );
}

/** Phone-only stand-in for the tempo, key, snap, and level controls. */
function SongMenu() {
  const { open, setOpen, ref } = useDropdown();
  const project = useStore((s) => s.project);
  const gridIndex = useStore((s) => s.gridIndex);
  const metronome = useStore((s) => s.metronome);
  const metronomeVolume = useStore((s) => s.metronomeVolume);
  const masterVolume = useStore((s) => s.masterVolume);
  const reverbAmount = useStore((s) => s.reverbAmount);
  const store = useStore.getState;

  return (
    <div className="menuwrap m-only" ref={ref}>
      <button className={`toggle ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} title="Tempo, key, snap, and levels">
        Song ▾
      </button>
      {open && (
        <div className="menu song-menu" role="menu">
          <div className="menu-label">Song</div>
          <div className="menu-row">
            <span className="menu-row-label">Tempo</span>
            <NumberField
              min={20}
              max={300}
              value={project.bpm}
              onCommit={(bpm) => {
                store().setProjectMeta({ bpm });
                engine.setBpm(bpm);
              }}
            />
          </div>
          <div className="menu-row">
            <span className="menu-row-label">Beats/bar</span>
            <NumberField
              min={1}
              max={16}
              value={project.beatsPerBar}
              onCommit={(n) => {
                store().setProjectMeta({ beatsPerBar: n });
                engine.setBeatsPerBar(n);
              }}
            />
          </div>
          <div className="menu-row">
            <span className="menu-row-label">Key</span>
            <select
              value={project.keyRoot}
              onChange={(e) => store().setProjectMeta({ keyRoot: Number(e.target.value) })}
            >
              {NOTE_NAMES.map((n, i) => (
                <option key={n} value={i}>
                  {n}
                </option>
              ))}
            </select>
            <select
              value={project.scale}
              onChange={(e) => store().setProjectMeta({ scale: e.target.value as ScaleId })}
            >
              {Object.entries(SCALES).map(([id, s]) => (
                <option key={id} value={id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="menu-row">
            <span className="menu-row-label">Snap</span>
            <select value={gridIndex} onChange={(e) => store().setSetting('gridIndex', Number(e.target.value))}>
              {GRIDS.map((g, i) => (
                <option key={g.label} value={i}>
                  {g.label}
                </option>
              ))}
            </select>
            <button
              className={`toggle ${project.loopEnabled ? 'on' : ''}`}
              onClick={() => {
                store().toggleLoop();
                engine.setProjectLoop(store().project);
              }}
              title="Loop the highlighted ruler section, or the whole song if none is highlighted"
            >
              ⟳ Loop
            </button>
          </div>
          <div className="menu-label">Levels</div>
          <div className="menu-row">
            <span className="menu-row-label">Volume</span>
            <input
              type="range"
              min={0}
              max={1.2}
              step={0.01}
              value={masterVolume}
              onChange={(e) => {
                const v = Number(e.target.value);
                store().setSetting('masterVolume', v);
                engine.setMasterVolume(v);
              }}
            />
          </div>
          <div className="menu-row">
            <span className="menu-row-label">Reverb</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={reverbAmount}
              onChange={(e) => {
                const v = Number(e.target.value);
                store().setSetting('reverbAmount', v);
                engine.setReverbAmount(v);
              }}
            />
          </div>
          <div className="menu-row">
            <button
              className={`toggle ${metronome ? 'on' : ''}`}
              onClick={() => {
                const next = !metronome;
                store().setSetting('metronome', next);
                engine.metronomeEnabled = next;
              }}
              title="Metronome click"
            >
              Click
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={metronomeVolume}
              onChange={(e) => {
                const v = Number(e.target.value);
                store().setSetting('metronomeVolume', v);
                engine.setMetronomeVolume(v);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** Poll a few times a second without dragging the whole tree into a rAF loop. */
function useAnimationPoll(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const id = window.setInterval(() => ref.current(), 100);
    return () => window.clearInterval(id);
  }, []);
}
