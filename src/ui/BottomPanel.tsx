import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../model/store';
import { engine } from '../audio/engine';
import { getTakeAudio } from '../audio/takeAudio';
import { listInputDevices } from '../audio/recorder';
import { midiInput } from '../audio/midiInput';
import { GRIDS } from '../model/music';
import { ScrollArea } from './ScrollArea';
import type { DetectorEngine, InputMode } from '../model/types';
import { detailToSettings, settingsToDetail } from '../model/types';
import type { useRecording } from './useRecording';
import { NumberField } from './TopBar';
import { Dropdown } from './Dropdown';
import { version } from '../../package.json';

const SOURCE_OPTIONS = [
  { value: 'melody', label: 'Sing: melody / harmony' },
  { value: 'bass', label: 'Sing: bass line' },
  { value: 'drums', label: 'Beatbox: drums' },
  { value: 'midi', label: 'MIDI keyboard' },
];

const COUNT_IN_OPTIONS = [
  { value: '0', label: 'None' },
  { value: '1', label: '1 bar' },
  { value: '2', label: '2 bars' },
];

const ENGINE_OPTIONS = [
  { value: 'neural', label: 'Neural (recommended)' },
  { value: 'classic', label: 'Classic' },
];

type Tab = 'record' | 'timing' | 'detect';

interface Props {
  rec: ReturnType<typeof useRecording>;
}

export function BottomPanel({ rec }: Props) {
  const [tab, setTab] = useState<Tab>('record');
  // Landscape phones have no height to spare, so the panel starts folded there
  // and folds again on rotation into landscape. Unfolding is left to the user.
  const [collapsed, setCollapsed] = useState(() => window.matchMedia('(max-height: 520px)').matches);
  const status = useStore((s) => s.status);

  useEffect(() => {
    const mq = window.matchMedia('(max-height: 520px)');
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setCollapsed(true);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return (
    <section className="bottom">
      <nav className="tabs">
        {(
          [
            ['record', 'Record'],
            ['timing', 'Timing'],
            ['detect', 'Detection'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            className={tab === id && !collapsed ? 'tab active' : 'tab'}
            onClick={() => {
              if (tab === id && !collapsed) {
                setCollapsed(true);
              } else {
                setTab(id);
                setCollapsed(false);
              }
            }}
          >
            {label}
          </button>
        ))}
        <div className="status" title={status}>
          {status}
        </div>
        <button
          className="tab"
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? 'Show panel' : 'Hide panel'}
          aria-label={collapsed ? 'Show panel' : 'Hide panel'}
        >
          {collapsed ? '▴' : '▾'}
        </button>
      </nav>

      {!collapsed && (
        <ScrollArea className="tabbody">
          {tab === 'record' && <RecordTab rec={rec} />}
          {tab === 'timing' && <TimingTab rec={rec} />}
          {tab === 'detect' && <DetectTab />}
          <p className="credits">
            Note detection: Basic Pitch by Spotify (Apache 2.0). Audio: Tone.js. MIDI: @tonejs/midi
            and midi-file. Built with React, zustand, and fflate (MIT). All other rights reserved.
            <br />© {new Date().getFullYear()} · MidiVoice v{version}
          </p>
        </ScrollArea>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- Record ----

const SOURCE_HINTS: Record<string, string> = {
  melody: 'Sing or hum a line. Pitch is tracked from about C2 up.',
  bass: 'Tracks low notes. Sing an octave down if needed.',
  drums: 'Beatbox into the mic. Hits are classified as kick, snare, clap, or hats.',
  midi: 'Play a connected MIDI keyboard. Notes are recorded onto the active track.',
};

function RecordTab({ rec }: Props) {
  const inputMode = useStore((s) => s.inputMode);
  const recordSource = useStore((s) => s.recordSource);
  const countInBars = useStore((s) => s.countInBars);
  const micOptions = useStore((s) => s.micOptions);
  const activeTrack = useStore((s) => s.project.tracks.find((t) => t.id === s.activeTrackId));
  const store = useStore.getState;

  const isMidi = recordSource === 'midi';
  const sourceValue = isMidi ? 'midi' : inputMode;

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    if (rec.isArmed) void listInputDevices().then(setDevices);
  }, [rec.isArmed]);

  const [midiDevices, setMidiDevices] = useState<{ id: string; name: string }[]>(midiInput.devices);
  useEffect(() => {
    midiInput.onDevicesChanged = () => setMidiDevices([...midiInput.devices]);
    return () => {
      midiInput.onDevicesChanged = null;
    };
  }, []);

  const recording = rec.phase === 'recording' || rec.phase === 'countIn';

  return (
    <div className="pane record-pane">
      <div className="col">
        <h3>Record</h3>
        <div className="row wrap">
          <label className="field">
            <span>Source</span>
            <Dropdown
              ariaLabel="Recording source"
              value={sourceValue}
              options={SOURCE_OPTIONS}
              onChange={(v) => {
                if (v === 'midi') {
                  store().setSetting('recordSource', 'midi');
                  void midiInput.enable().then(() => setMidiDevices([...midiInput.devices]));
                } else {
                  store().setSetting('recordSource', 'mic');
                  store().setSetting('inputMode', v as InputMode);
                  store().setTranscribeSetting('mode', v as InputMode);
                }
              }}
            />
          </label>

          <label className="field">
            <span>Count-in</span>
            <Dropdown
              ariaLabel="Count-in bars"
              value={String(countInBars)}
              options={COUNT_IN_OPTIONS}
              onChange={(v) => store().setSetting('countInBars', Number(v))}
            />
          </label>

          <button
            className={`bigrecord ${recording ? 'on' : ''}`}
            onClick={rec.toggle}
            disabled={
              !activeTrack ||
              rec.phase === 'transcribing' ||
              rec.phase === 'calibrating' ||
              rec.phase === 'arming'
            }
          >
            {rec.phase === 'countIn'
              ? 'Counting in…'
              : rec.phase === 'recording'
                ? isMidi ? 'Stop recording' : 'Stop & transcribe'
                : rec.phase === 'transcribing'
                  ? 'Transcribing…'
                  : rec.phase === 'arming'
                    ? isMidi ? 'Waiting for MIDI…' : 'Opening mic…'
                    : activeTrack
                      ? '● Record'
                      : 'Add a track to record onto'}
          </button>
        </div>

        <p className="hint">{SOURCE_HINTS[sourceValue]}</p>

        <p className="hint">
          Existing tracks play back while recording.
          {!isMidi && <> Use headphones so the mic does not pick them up.</>}
        </p>
      </div>

      <div className="col narrow">
        <h3>Input</h3>
        {isMidi && (
          <>
            {!midiInput.supported && (
              <p className="error">This browser does not support MIDI. Use Chrome or Edge.</p>
            )}
            {midiInput.supported && midiDevices.length === 0 && (
              <p className="hint">
                No MIDI device detected. Connect a keyboard; it is detected automatically.
                {!midiInput.enabled && (
                  <>
                    {' '}
                    <button className="ghost sm" onClick={() => void midiInput.enable().then(() => setMidiDevices([...midiInput.devices]))}>
                      Enable MIDI
                    </button>
                  </>
                )}
              </p>
            )}
            {midiDevices.map((d) => (
              <p key={d.id} className="meta">Connected: {d.name}</p>
            ))}
            {midiInput.error && <p className="error">{midiInput.error}</p>}
          </>
        )}
        {!isMidi && (
          <>
        <LevelMeter level={rec.level} />
        {!rec.isArmed && (
          <button className="ghost" onClick={() => void rec.ensureMic()}>
            Enable microphone
          </button>
        )}
        {rec.isArmed && (
          <button className="ghost" onClick={rec.releaseMic}>
            Release microphone
          </button>
        )}
        {rec.micError && <p className="error">{rec.micError}</p>}

        {devices.length > 0 && (
          <label className="field">
            <span>Device</span>
            <Dropdown
              ariaLabel="Microphone device"
              value={micOptions.deviceId ?? ''}
              options={[
                { value: '', label: 'System default' },
                ...devices.map((d) => ({ value: d.deviceId, label: d.label || 'Microphone' })),
              ]}
              onChange={(v) => {
                void rec.applyMicOptions({ ...micOptions, deviceId: v || undefined });
              }}
            />
          </label>
        )}

        <label className="check" title="Browser noise suppression distorts pitch tracking. Leave off unless required.">
          <input
            type="checkbox"
            checked={micOptions.noiseSuppression}
            onChange={(e) =>
              void rec.applyMicOptions({ ...micOptions, noiseSuppression: e.target.checked })
            }
          />
          Noise suppression
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={micOptions.echoCancellation}
            onChange={(e) =>
              void rec.applyMicOptions({ ...micOptions, echoCancellation: e.target.checked })
            }
          />
          Echo cancellation
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={micOptions.autoGainControl}
            onChange={(e) =>
              void rec.applyMicOptions({ ...micOptions, autoGainControl: e.target.checked })
            }
          />
          Auto gain
        </label>
          </>
        )}
      </div>
    </div>
  );
}

function LevelMeter({ level }: { level: number }) {
  const db = 20 * Math.log10(Math.max(level, 1e-5));
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  const hot = db > -3;
  return (
    <div className="meter" title={`${db.toFixed(1)} dB`}>
      <div className={`meter-fill ${hot ? 'hot' : ''}`} style={{ width: `${pct}%` }} />
      <span className="meter-label">{level > 0.0001 ? `${db.toFixed(0)} dB` : 'silent'}</span>
    </div>
  );
}

// ---------------------------------------------------------------- Timing ----

function TimingTab({ rec }: Props) {
  const project = useStore((s) => s.project);
  const selectedTakeId = useStore((s) => s.selectedTakeId);
  const latencyOffsetMs = useStore((s) => s.latencyOffsetMs);
  const gridIndex = useStore((s) => s.gridIndex);
  const quantizeStrength = useStore((s) => s.quantizeStrength);
  const store = useStore.getState;

  const takes = useMemo(() => [...project.takes].sort((a, b) => b.createdAt - a.createdAt), [project.takes]);
  const take = takes.find((t) => t.id === selectedTakeId) ?? takes[0];

  function nudgeBy(ms: number) {
    if (!take) return;
    store().setTakeNudge(take.id, Math.round((take.nudgeMs + ms) * 10) / 10);
    engine.scheduleProject(store().project);
  }

  return (
    <div className="pane">
      <div className="col">
        <h3>Take timing</h3>
        {!take && <p className="hint">No takes recorded.</p>}

        {take && (
          <>
            <div className="row wrap">
              <Dropdown
                className="takepick"
                ariaLabel="Take"
                value={take.id}
                options={takes.map((t) => {
                  const track = project.tracks.find((x) => x.id === t.trackId);
                  return {
                    value: t.id,
                    label: `${track?.name ?? '?'}: ${t.name} (${t.noteIds.length} notes)`,
                  };
                })}
                onChange={(v) => store().selectTake(v)}
              />
              <button className="ghost sm" onClick={() => store().deleteTake(take.id)}>
                Delete take
              </button>
            </div>

            <div className="nudge">
              <div className="nudge-row">
                <button className="ghost sm" onClick={() => nudgeBy(-10)} title="10 ms earlier">
                  ⏪ 10
                </button>
                <button className="ghost sm" onClick={() => nudgeBy(-1)} title="1 ms earlier">
                  ◀ 1
                </button>
                <input
                  type="range"
                  min={-400}
                  max={400}
                  step={1}
                  value={take.nudgeMs}
                  onChange={(e) => {
                    store().setTakeNudge(take.id, Number(e.target.value));
                    engine.scheduleProject(store().project);
                  }}
                />
                <button className="ghost sm" onClick={() => nudgeBy(1)} title="1 ms later">
                  1 ▶
                </button>
                <button className="ghost sm" onClick={() => nudgeBy(10)} title="10 ms later">
                  10 ⏩
                </button>
                <output className="nudge-value">
                  {take.nudgeMs > 0 ? '+' : ''}
                  {take.nudgeMs.toFixed(0)} ms
                </output>
                <button className="ghost sm" onClick={() => { store().setTakeNudge(take.id, 0); engine.scheduleProject(store().project); }}>
                  Reset
                </button>
              </div>
              <p className="hint">
                Drag left if the take is late, right if it is early. Changes apply during playback.
              </p>
            </div>

            <div className="nudge">
              <div className="nudge-row">
                <strong className="nudge-title">Bars</strong>
                <button
                  className="ghost sm"
                  onClick={() => { store().setTakeStretch(take.id, (take.stretch || 1) * 0.995); engine.scheduleProject(store().project); }}
                  title="Pull the performance in slightly"
                >
                  slower ◀
                </button>
                <input
                  type="range"
                  min={0.86}
                  max={1.16}
                  step={0.002}
                  value={take.stretch || 1}
                  onChange={(e) => {
                    store().setTakeStretch(take.id, Number(e.target.value));
                    engine.scheduleProject(store().project);
                  }}
                />
                <button
                  className="ghost sm"
                  onClick={() => { store().setTakeStretch(take.id, (take.stretch || 1) * 1.005); engine.scheduleProject(store().project); }}
                  title="Spread the performance out slightly"
                >
                  ▶ faster
                </button>
                <output className="nudge-value">
                  {(((take.stretch || 1) - 1) * 100).toFixed(1)}%
                </output>
                <button
                  className="ghost sm"
                  onClick={() => { store().setTakeStretch(take.id, 1); engine.scheduleProject(store().project); }}
                >
                  Reset
                </button>
              </div>
              <div className="row wrap">
                <button
                  className="ghost"
                  onClick={() => { store().fitTakeToGrid(take.id); engine.scheduleProject(store().project); }}
                  title={`Search for the stretch and shift that best lands this take on the ${GRIDS[gridIndex].label} grid`}
                >
                  Fit take to grid
                </button>
                <span className="meta">
                  sung at ≈{(project.bpm / (take.stretch || 1)).toFixed(1)} bpm
                </span>
              </div>
              <p className="hint">
                Nudge shifts the whole take. <strong>Bars</strong> stretches it. <strong>Fit take to grid</strong>{' '}
                sets both automatically.
              </p>
            </div>

            <div className="row wrap">
              <button
                className="ghost"
                onClick={() => {
                  store().setSetting('latencyOffsetMs', Math.round((latencyOffsetMs - take.nudgeMs) * 10) / 10);
                  store().setStatus(
                    `Future recordings will land ${Math.abs(take.nudgeMs).toFixed(0)} ms ${
                      take.nudgeMs < 0 ? 'earlier' : 'later'
                    }.`,
                  );
                }}
                disabled={take.nudgeMs === 0}
                title="Roll this correction into the default latency offset"
              >
                Use this correction for future takes
              </button>
              <button
                className="ghost"
                onClick={() => {
                  store().select([...take.noteIds]);
                  store().quantizeSelection({ starts: true, lengths: false });
                  engine.scheduleProject(store().project);
                }}
                title={`Snap this take's notes to ${GRIDS[gridIndex].label}`}
              >
                Snap take to {GRIDS[gridIndex].label}
              </button>
            </div>

            <p className="meta">
              Recorded at bar {Math.floor(take.startBeat / project.beatsPerBar) + 1}, {take.durationSec.toFixed(1)} s,
              latency compensation {take.autoOffsetMs.toFixed(0)} ms
              {getTakeAudio(take.id) ? '' : ' · audio no longer in memory'}
            </p>
          </>
        )}
      </div>

      <div className="col narrow">
        <h3>Recording latency</h3>
        <label className="field">
          <span>Offset</span>
          <div className="row">
            <NumberField
              min={-2000}
              max={2000}
              value={latencyOffsetMs}
              onCommit={(v) => store().setSetting('latencyOffsetMs', v)}
            />
            <span className="unit">ms</span>
          </div>
        </label>
        <p className="hint">
          Recordings are shifted earlier by this amount to compensate for round-trip delay.
        </p>
        <p className="meta">
          Browser reports {engine.outputLatencyMs.toFixed(0)} ms output
          {rec.inputLatencyHintMs > 0 ? `, ${rec.inputLatencyHintMs.toFixed(0)} ms input` : ''}
        </p>
        <button className="ghost" onClick={() => void rec.runCalibration()} disabled={rec.phase === 'calibrating'}>
          {rec.phase === 'calibrating' ? 'Measuring…' : 'Measure automatically'}
        </button>
        <p className="hint small">
          Plays six clicks through the <strong>speakers</strong> and measures the delay. Remove headphones and
          keep the room quiet.
        </p>
        {rec.calibration && (
          <p className={rec.calibration.ok ? 'ok' : 'error'}>{rec.calibration.message}</p>
        )}

        <h3>Song tempo</h3>
        <label className="field">
          <span>Re-grid to</span>
          <div className="row">
            <NumberField
              min={20}
              max={300}
              step={0.5}
              mode="blur"
              value={project.bpm}
              onCommit={(v) => {
                store().setBpmKeepTiming(v);
                engine.setBpm(store().project.bpm);
                engine.scheduleProject(store().project);
              }}
            />
            <span className="unit">bpm</span>
          </div>
        </label>
        <p className="hint small">
          Moves the bar grid without changing note timing. Use when the click was set wrong. The Tempo field
          in the top bar changes playback speed instead.
        </p>

        <label className="field">
          <span>Quantise strength</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={quantizeStrength}
            onChange={(e) => store().setSetting('quantizeStrength', Number(e.target.value))}
          />
          <span className="unit">{Math.round(quantizeStrength * 100)}%</span>
        </label>
        <p className="hint small">
          Below 100%, notes move only part of the way to the grid.
        </p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- Detection ----

function DetectTab() {
  const settings = useStore((s) => s.transcribeSettings);
  const selectedTakeId = useStore((s) => s.selectedTakeId);
  const project = useStore((s) => s.project);
  const showContour = useStore((s) => s.showContour);
  const region = useStore((s) => s.region);
  const store = useStore.getState;

  const take = project.takes.find((t) => t.id === selectedTakeId) ?? project.takes[project.takes.length - 1];
  const canRedo = take ? !!getTakeAudio(take.id) : false;

  const engineChoice: DetectorEngine = settings.engine ?? 'neural';

  return (
    <div className="pane">
      <div className="col">
        <h3>Detector</h3>
        <label className="field">
          <span>Engine</span>
          <Dropdown
            ariaLabel="Detector engine"
            value={engineChoice}
            options={ENGINE_OPTIONS}
            onChange={(v) => {
              store().setTranscribeSetting('engine', v as DetectorEngine);
              if (take && getTakeAudio(take.id)) {
                void store()
                  .retranscribeTake(take.id, { ...store().transcribeSettings, mode: take.settings.mode })
                  .then(() => engine.scheduleProject(store().project));
              }
            }}
          />
        </label>
        <p className="hint small">
          Neural runs Spotify’s Basic Pitch model on this device (about 1 MB, fetched once). Classic is used
          if the model cannot load. Changing this re-detects the selected take.
        </p>

        <h3>Detail</h3>
        <div className="detail-dial">
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={settingsToDetail(settings)}
            onChange={(e) => {
              const next = detailToSettings(Number(e.target.value));
              store().setTranscribeSetting('splitCents', next.splitCents);
              store().setTranscribeSetting('minNoteMs', next.minNoteMs);
              store().setTranscribeSetting('onsetSensitivity', next.onsetSensitivity);
            }}
            onPointerUp={() => {
              if (take && getTakeAudio(take.id)) {
                void store()
                  .retranscribeTake(take.id, { ...store().transcribeSettings, mode: take.settings.mode })
                  .then(() => engine.scheduleProject(store().project));
              }
            }}
          />
          <div className="detail-ends">
            <span>Fewer, longer notes</span>
            <strong>{Math.round(settingsToDetail(settings) * 100)}</strong>
            <span>More, shorter notes</span>
          </div>
        </div>
        <p className="hint">
          Release the slider to re-detect the selected take.
          {take && !getTakeAudio(take.id) && <> (Requires a take recorded this session.)</>}
        </p>
        <p className="hint">
          Raise it if short notes are missing. Lower it if extra notes appear. Set per take.
        </p>

        <h3>Fine tuning</h3>
        <div className="sliders">
          <Slider
            label="Noise gate"
            value={settings.noiseFloorDb}
            min={-70}
            max={-15}
            step={1}
            unit="dB"
            hint="Raise to remove stray notes from room noise. Lower if quiet singing is dropped."
            onChange={(v) => store().setTranscribeSetting('noiseFloorDb', v)}
          />
          <Slider
            label="Pitch confidence"
            value={settings.clarity}
            min={0.3}
            max={0.95}
            step={0.01}
            unit=""
            hint="Higher keeps only clearly pitched sound. Lower for breathy or nasal input."
            onChange={(v) => store().setTranscribeSetting('clarity', v)}
          />
          <Slider
            label="Shortest note"
            value={settings.minNoteMs}
            min={20}
            max={300}
            step={5}
            unit="ms"
            hint="Notes shorter than this are discarded."
            onChange={(v) => store().setTranscribeSetting('minNoteMs', v)}
          />
          <Slider
            label="New-note sensitivity"
            value={settings.splitCents}
            min={30}
            max={200}
            step={5}
            unit="¢"
            hint="Pitch change required to start a new note. Lower to catch trills. Raise if vibrato splits into extra notes."
            onChange={(v) => store().setTranscribeSetting('splitCents', v)}
          />
          <Slider
            label="Attack sensitivity"
            value={settings.onsetSensitivity}
            min={0}
            max={1}
            step={0.01}
            unit=""
            hint="Splits repeated notes on the same pitch. Raise for fast rhythms. Lower if notes double."
            onChange={(v) => store().setTranscribeSetting('onsetSensitivity', v)}
          />
        </div>
        <p className="hint small">
          At {project.bpm} bpm a 1/8 note lasts {Math.round((60 / project.bpm / 2) * 1000)} ms and a 1/16
          lasts {Math.round((60 / project.bpm / 4) * 1000)} ms. Keep <strong>Shortest note</strong> below the
          fastest note intended.
          {settings.minNoteMs > (60 / project.bpm / 4) * 1000 * 0.7 && (
            <> The current value will remove sixteenths at this tempo.</>
          )}
        </p>
      </div>

      <div className="col narrow">
        <h3>Re-detect</h3>
        <p className="hint">
          Take audio is kept for this session. Change settings and re-detect without re-recording.
        </p>
        <button
          className={region ? 'ghost primary' : 'ghost'}
          disabled={!region}
          onClick={() => {
            void store()
              .retranscribeRegion({ ...store().transcribeSettings, mode: take?.settings.mode ?? 'melody' })
              .then(() => engine.scheduleProject(store().project));
          }}
          title="Re-detect only the notes inside the range selected on the ruler"
        >
          {region
            ? `Re-detect bars ${(region.startBeat / project.beatsPerBar + 1).toFixed(2)} to ${(region.endBeat / project.beatsPerBar + 1).toFixed(2)}`
            : 'Re-detect selected range'}
        </button>
        <p className="hint small">
          Drag across the ruler to select a range. Only notes starting inside it are re-detected.
        </p>

        <button
          className="ghost"
          disabled={!canRedo}
          onClick={() => {
            if (!take) return;
            void store()
              .retranscribeTake(take.id, { ...store().transcribeSettings, mode: take.settings.mode })
              .then(() => engine.scheduleProject(store().project));
          }}
        >
          {take ? `Re-detect all of “${take.name}”` : 'No take selected'}
        </button>
        {take && !canRedo && <p className="error">Audio for this take is no longer available. Takes are not kept across reloads.</p>}

        <button
          className="ghost"
          disabled={!canRedo}
          onClick={async () => {
            if (!take) return;
            const stored = getTakeAudio(take.id);
            if (!stored) return;
            const { float32ToWav } = await import('../audio/render');
            const { downloadBlob, safeFilename } = await import('../model/midiIO');
            downloadBlob(
              float32ToWav(stored.audio, stored.sampleRate),
              `${safeFilename(project.name)}-${safeFilename(take.name)}-raw.wav`,
            );
          }}
          title="Save the unprocessed recording, before note detection"
        >
          Save raw take audio (.wav)
        </button>

        <label className="check">
          <input
            type="checkbox"
            checked={showContour}
            onChange={(e) => store().setSetting('showContour', e.target.checked)}
          />
          Show the sung pitch line
        </label>
        <p className="hint small">
          The gold line is the sung pitch. A note above or below it was rounded to a different semitone.
        </p>
      </div>
    </div>
  );
}

function Slider({
  label, value, min, max, step, unit, hint, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number; unit: string; hint: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="slider-row" title={hint}>
      <span className="slabel">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="svalue">
        {step < 1 ? value.toFixed(2) : value} {unit}
      </span>
    </label>
  );
}
