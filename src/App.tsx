import { useEffect, useRef, useState } from 'react';
import { TopBar } from './ui/TopBar';
import { TrackList } from './ui/TrackList';
import { PianoRoll } from './ui/PianoRoll';
import { BottomPanel } from './ui/BottomPanel';
import { useRecording } from './ui/useRecording';
import { useStore } from './model/store';
import { engine } from './audio/engine';
import { currentSnapBeats } from './model/store';
import { GRIDS } from './model/music';
import { togglePlay } from './ui/transport';

const AUTOSAVE_KEY = 'midivoice.autosave.v1';

export default function App() {
  const rec = useRecording();
  const project = useStore((s) => s.project);
  const [position, setPosition] = useState(0);
  const [needsGesture, setNeedsGesture] = useState(true);
  const rescheduleRef = useRef<number | null>(null);

  // ---- restore the last session ------------------------------------------
  useEffect(() => {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed?.tracks?.length) useStore.getState().loadProject(parsed);
    } catch {
      /* corrupt autosave, start fresh */
    }
  }, []);

  // ---- autosave -----------------------------------------------------------
  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(project));
      } catch {
        /* quota exceeded, not worth interrupting the user over */
      }
    }, 800);
    return () => window.clearTimeout(id);
  }, [project]);

  // ---- keep the engine in step with the project ---------------------------
  useEffect(() => {
    if (!engine.ready) return;
    if (rescheduleRef.current) window.clearTimeout(rescheduleRef.current);
    rescheduleRef.current = window.setTimeout(() => {
      engine.setBpm(project.bpm);
      engine.setBeatsPerBar(project.beatsPerBar);
      engine.syncTracks(project.tracks);
      engine.scheduleProject(project);
      engine.setProjectLoop(project);
    }, 60);
    return () => {
      if (rescheduleRef.current) window.clearTimeout(rescheduleRef.current);
    };
  }, [project, needsGesture]);

  // ---- playhead readout ---------------------------------------------------
  useEffect(() => {
    const id = window.setInterval(() => setPosition(engine.positionBeats), 60);
    return () => window.clearInterval(id);
  }, []);

  // ---- audio needs a user gesture to start --------------------------------
  useEffect(() => {
    if (!needsGesture) return;
    const unlock = async () => {
      await engine.init();
      const s = useStore.getState();
      engine.setMasterVolume(s.masterVolume);
      engine.setReverbAmount(s.reverbAmount);
      engine.metronomeEnabled = s.metronome;
      engine.setBpm(s.project.bpm);
      engine.setBeatsPerBar(s.project.beatsPerBar);
      engine.syncTracks(s.project.tracks);
      engine.scheduleProject(s.project);
      engine.setProjectLoop(s.project);

      // Zero means "never set", since no real setup has zero round-trip latency.
      if (s.latencyOffsetMs === 0) {
        const estimate = Math.round(engine.outputLatencyMs);
        if (estimate > 0) s.setSetting('latencyOffsetMs', estimate);
      }

      setNeedsGesture(false);
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [needsGesture]);

  // ---- keyboard -----------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;

      const s = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      const reschedule = () => engine.scheduleProject(useStore.getState().project);

      if (mod) {
        switch (e.key.toLowerCase()) {
          case 'z':
            e.preventDefault();
            if (e.shiftKey) s.redo();
            else s.undo();
            reschedule();
            return;
          case 'y':
            e.preventDefault();
            s.redo();
            reschedule();
            return;
          case 'c':
            e.preventDefault();
            if (e.altKey) {
              s.chopSelection();
              reschedule();
            } else {
              s.copySelection();
            }
            return;
          case 'x':
            e.preventDefault();
            s.cutSelection();
            reschedule();
            return;
          case 'v': {
            e.preventDefault();
            // Plain paste lands right after the selected notes; Ctrl+Alt+V
            // pastes at the playhead instead.
            let at = engine.positionBeats;
            if (!e.altKey && s.selectedNoteIds.length > 0) {
              const ids = new Set(s.selectedNoteIds);
              let end = -Infinity;
              for (const t of s.project.tracks) {
                for (const n of t.notes) if (ids.has(n.id)) end = Math.max(end, n.start + n.duration);
              }
              if (isFinite(end)) at = end;
            }
            s.pasteAt(at);
            reschedule();
            return;
          }
          case 'd':
            e.preventDefault();
            s.duplicateSelection();
            reschedule();
            return;
          case 'a':
            e.preventDefault();
            s.selectAllOnTrack(s.activeTrackId);
            return;
          default:
            return;
        }
      }

      switch (e.key) {
        case ' ': {
          e.preventDefault();
          void togglePlay();
          return;
        }
        case 'Escape':
          // Clear a range selection first, so one keypress never does two surprising things at once.
          if (s.region) {
            s.setRegion(null);
            return;
          }
          engine.stop();
          engine.seek(0);
          return;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          s.deleteSelected();
          reschedule();
          return;
        case 'ArrowUp':
          e.preventDefault();
          s.nudgeSelection(0, e.shiftKey ? 12 : 1);
          reschedule();
          return;
        case 'ArrowDown':
          e.preventDefault();
          s.nudgeSelection(0, e.shiftKey ? -12 : -1);
          reschedule();
          return;
        case 'ArrowLeft': {
          e.preventDefault();
          const step = e.shiftKey ? s.project.beatsPerBar : currentSnapBeats() || 0.25;
          s.nudgeSelection(-step, 0);
          reschedule();
          return;
        }
        case 'ArrowRight': {
          e.preventDefault();
          const step = e.shiftKey ? s.project.beatsPerBar : currentSnapBeats() || 0.25;
          s.nudgeSelection(step, 0);
          reschedule();
          return;
        }
        case 'Home':
          e.preventDefault();
          engine.seek(0);
          return;
        case 'End': {
          e.preventDefault();
          let end = 0;
          for (const t of s.project.tracks) {
            for (const n of t.notes) end = Math.max(end, n.start + n.duration);
          }
          engine.seek(end);
          return;
        }
        default:
          break;
      }

      switch (e.key.toLowerCase()) {
        case 'r':
          e.preventDefault();
          rec.toggle();
          return;
        case 'd':
          s.setTool(s.tool === 'draw' ? 'select' : 'draw');
          return;
        case 'q':
          s.quantizeSelection({ starts: true, lengths: false });
          reschedule();
          return;
        case 'l':
          s.legatoSelection();
          reschedule();
          return;
        case 'j':
          s.mergeSelectedNotes();
          reschedule();
          return;
        case '[':
          s.setSetting('gridIndex', Math.max(0, s.gridIndex - 1));
          return;
        case ']':
          s.setSetting('gridIndex', Math.min(GRIDS.length - 1, s.gridIndex + 1));
          return;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rec]);

  return (
    <div className="app">
      <TopBar phase={rec.phase} onToggleRecord={rec.toggle} position={position} />
      <main className="middle">
        <TrackList />
        <PianoRoll />
      </main>
      <BottomPanel rec={rec} />
      {(rec.phase === 'countIn' || rec.phase === 'recording') && (
        <div className={`rec-badge ${rec.phase}`}>
          {rec.phase === 'countIn' ? 'Count-in…' : '● Recording'}
        </div>
      )}
      {needsGesture && (
        <div className="gesture-hint">Click anywhere to start the audio engine</div>
      )}
    </div>
  );
}
