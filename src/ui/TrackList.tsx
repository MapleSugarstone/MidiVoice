import { useStore } from '../model/store';
import { engine } from '../audio/engine';
import { INSTRUMENTS } from '../audio/instruments';
import { ScrollArea } from './ScrollArea';
import { Dropdown } from './Dropdown';
import type { InstrumentId } from '../model/types';

const GROUPS = Array.from(new Set(INSTRUMENTS.map((i) => i.group)));

const INSTRUMENT_OPTIONS = GROUPS.flatMap((g) =>
  INSTRUMENTS.filter((i) => i.group === g).map((i) => ({ value: i.id, label: i.label, group: g })),
);

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

              <div className="instrument" onClick={(e) => e.stopPropagation()}>
                <Dropdown
                  ariaLabel="Instrument"
                  value={track.instrument}
                  options={INSTRUMENT_OPTIONS}
                  onChange={(v) => {
                    store().setInstrument(track.id, v as InstrumentId);
                    const s = store();
                    engine.syncTracks(s.project.tracks);
                    engine.scheduleProject(s.project);
                  }}
                />
              </div>

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

            </div>
          );
        })}
      </ScrollArea>
    </aside>
  );
}
