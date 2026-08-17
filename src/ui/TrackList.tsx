import { useStore } from '../model/store';
import { engine } from '../audio/engine';
import { INSTRUMENTS } from '../audio/instruments';
import { NOTE_NAMES, SCALES, snapToScale } from '../model/music';
import { ScrollArea } from './ScrollArea';
import type { InstrumentId, Project, Track } from '../model/types';

const GROUPS = Array.from(new Set(INSTRUMENTS.map((i) => i.group)));

/** Say what switching "in key" did, since on an already-in-key part it does nothing. */
function inKeyReport(track: Track, project: Project, on: boolean): string {
  const key = `${NOTE_NAMES[project.keyRoot]} ${SCALES[project.scale].label.toLowerCase()}`;
  if (!on) return `“${track.name}” plays recorded pitches unchanged`;
  const moved = track.notes.filter(
    (n) => snapToScale(n.midi, project.keyRoot, project.scale) !== n.midi,
  ).length;
  if (track.notes.length === 0) return `New notes on “${track.name}” will snap to ${key}`;
  return moved === 0
    ? `All notes on “${track.name}” were already in ${key}`
    : `${moved} note${moved === 1 ? '' : 's'} on “${track.name}” moved into ${key}`;
}

/** Pan as a mixer would print it: C in the middle, L/R with a percentage. */
function panLabel(pan: number): string {
  const amount = Math.round(Math.abs(pan) * 100);
  if (amount < 3) return 'C';
  return `${pan < 0 ? 'L' : 'R'}${amount}`;
}

export function TrackList() {
  const project = useStore((s) => s.project);
  const activeTrackId = useStore((s) => s.activeTrackId);
  const store = useStore.getState;

  return (
    <aside className="tracklist">
      <div className="panel-head">
        <h2>Tracks</h2>
        <div className="row">
          <button className="ghost sm" onClick={() => store().addTrack({ name: `Track ${project.tracks.length + 1}` })}>
            + Part
          </button>
          <button
            className="ghost sm"
            onClick={() => store().addTrack({ name: 'Drums', isDrum: true, instrument: 'drumKit' })}
          >
            + Drums
          </button>
        </div>
      </div>

      <ScrollArea className="tracks">
        {project.tracks.length === 0 && (
          <p className="hint empty-tracks">
            No tracks. Add a part to begin.
          </p>
        )}
        {project.tracks.map((track, index) => {
          const active = track.id === activeTrackId;
          return (
            <div
              key={track.id}
              className={`track ${active ? 'active' : ''}`}
              style={{ borderLeftColor: `hsl(${track.hue}, 70%, 55%)` }}
              onClick={() => store().setActiveTrack(track.id)}
            >
              <div className="track-top">
                <input
                  className="track-name"
                  value={track.name}
                  onChange={(e) => store().updateTrack(track.id, { name: e.target.value })}
                  spellCheck={false}
                  title={track.name}
                />
                <span className="notecount">{track.notes.length}</span>
                <span className="track-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="x"
                    title="Move this track up"
                    disabled={index === 0}
                    onClick={() => store().moveTrack(track.id, -1)}
                  >
                    ▲
                  </button>
                  <button
                    className="x"
                    title="Move this track down"
                    disabled={index === project.tracks.length - 1}
                    onClick={() => store().moveTrack(track.id, 1)}
                  >
                    ▼
                  </button>
                  <button
                    className="x"
                    title="Delete this track"
                    onClick={() => store().removeTrack(track.id)}
                  >
                    ×
                  </button>
                </span>
              </div>

              <select
                className="instrument"
                value={track.instrument}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  store().setInstrument(track.id, e.target.value as InstrumentId);
                  const s = store();
                  engine.syncTracks(s.project.tracks);
                  engine.scheduleProject(s.project);
                }}
              >
                {GROUPS.map((g) => (
                  <optgroup key={g} label={g}>
                    {INSTRUMENTS.filter((i) => i.group === g).map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>

              <div className="track-controls" onClick={(e) => e.stopPropagation()}>
                <div className="chips">
                  <button
                    className={`chip ${track.muted ? 'on-mute' : ''}`}
                    onClick={() => {
                      store().updateTrack(track.id, { muted: !track.muted });
                      engine.syncTracks(store().project.tracks);
                    }}
                    title="Mute"
                  >
                    M
                  </button>
                  <button
                    className={`chip ${track.solo ? 'on-solo' : ''}`}
                    onClick={() => {
                      store().updateTrack(track.id, { solo: !track.solo });
                      engine.syncTracks(store().project.tracks);
                    }}
                    title="Solo"
                  >
                    S
                  </button>
                  {!track.isDrum && (
                    <button
                      className={`chip ${track.showContour ? 'on-contour' : ''}`}
                      onClick={() => store().updateTrack(track.id, { showContour: !track.showContour })}
                      title="Show or hide the recorded pitch line behind this track's notes"
                    >
                      ∿
                    </button>
                  )}
                </div>

                <label className="mix-row" title={`Volume ${track.volume} dB`}>
                  <span>Volume</span>
                  <input
                    type="range"
                    min={-40}
                    max={6}
                    step={0.5}
                    value={track.volume}
                    onChange={(e) => {
                      store().updateTrack(track.id, { volume: Number(e.target.value) });
                      engine.syncTracks(store().project.tracks);
                    }}
                  />
                  <em>{track.volume > 0 ? '+' : ''}{track.volume.toFixed(0)}</em>
                </label>
                <label className="mix-row" title={`Pan ${panLabel(track.pan)}`}>
                  <span>Pan</span>
                  <input
                    type="range"
                    min={-1}
                    max={1}
                    step={0.02}
                    value={track.pan}
                    onChange={(e) => {
                      store().updateTrack(track.id, { pan: Number(e.target.value) });
                      engine.syncTracks(store().project.tracks);
                    }}
                  />
                  <em>{panLabel(track.pan)}</em>
                </label>
              </div>

              {!track.isDrum && (
                <div className="track-tune" onClick={(e) => e.stopPropagation()}>
                  <label title="Force recorded notes on the track to convert to the selected key.">
                    <input
                      type="checkbox"
                      checked={track.snapToScale}
                      onChange={(e) => {
                        const on = e.target.checked;
                        store().updateTrack(track.id, { snapToScale: on });
                        engine.scheduleProject(store().project);
                        store().setStatus(inKeyReport(track, project, on));
                      }}
                    />
                    In key
                  </label>
                  {track.snapToScale && (
                    <label
                      className="tune-strength"
                      title="0% plays the pitch exactly as you sang it; 100% is fully corrected"
                    >
                      Tune {Math.round(track.tuneStrength * 100)}%
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={track.tuneStrength}
                        onChange={(e) => {
                          store().updateTrack(track.id, { tuneStrength: Number(e.target.value) });
                          engine.scheduleProject(store().project);
                        }}
                      />
                    </label>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </ScrollArea>
    </aside>
  );
}
