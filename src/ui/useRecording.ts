import { useCallback, useEffect, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { MicRecorder, type MicOptions } from '../audio/recorder';
import { midiInput } from '../audio/midiInput';
import { transcribeAsync } from '../audio/transcribe';
import { calibrateLatency, type CalibrationResult } from '../audio/calibration';
import { useStore } from '../model/store';
import { beatsToSeconds, secondsToBeats } from '../model/music';

export type RecordPhase = 'idle' | 'arming' | 'countIn' | 'recording' | 'transcribing' | 'calibrating';

/** Kept outside React so the same mic stream survives re-renders. */
const recorder = new MicRecorder();
let seededInputLatency = false;

export function useRecording() {
  const [phase, setPhase] = useState<RecordPhase>('idle');
  const [level, setLevel] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const [calibration, setCalibration] = useState<CalibrationResult | null>(null);
  const punchBeatRef = useRef(0);
  const countInEndRef = useRef(0);
  const midiActiveRef = useRef(false);
  const midiEventsRef = useRef<{ midi: number; vel: number; on: boolean; beat: number }[]>([]);

  useEffect(() => {
    recorder.onLevel = (l) => setLevel(l);
    return () => {
      recorder.onLevel = null;
    };
  }, []);

  // MIDI keys always play through the active track's instrument, and are
  // captured with the transport position while a recording is running.
  useEffect(() => {
    midiInput.onNote = (midi, vel, on) => {
      const s = useStore.getState();
      if (s.recordSource !== 'midi') return;
      if (on) engine.liveNoteOn(s.activeTrackId, midi, vel);
      else engine.liveNoteOff(s.activeTrackId, midi);
      if (midiActiveRef.current) {
        midiEventsRef.current.push({ midi, vel, on, beat: engine.positionBeats });
      }
    };
    return () => {
      midiInput.onNote = null;
    };
  }, []);

  const ensureMic = useCallback(async (): Promise<boolean> => {
    const store = useStore.getState();
    try {
      await engine.init();
      await recorder.arm(engine.context, store.micOptions);

      // Fold in the mic's reported latency once a stream is open, and only if actually reported, since guessing beats nothing but loses to calibration.
      if (!seededInputLatency) {
        seededInputLatency = true;
        const inputMs = recorder.inputLatencySec * 1000;
        if (inputMs > 0) {
          const s = useStore.getState();
          s.setSetting('latencyOffsetMs', Math.round((s.latencyOffsetMs + inputMs) * 10) / 10);
        }
      }

      setMicError(null);
      return true;
    } catch (err) {
      const msg =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Microphone permission was denied. Allow it in the browser address bar, then try again.'
          : `Could not open the microphone: ${(err as Error).message}`;
      setMicError(msg);
      store.setStatus(msg);
      setPhase('idle');
      return false;
    }
  }, []);

  const startMidi = useCallback(async () => {
    const store = useStore.getState();
    setPhase('arming');
    await engine.init();
    if (!(await midiInput.enable())) {
      store.setStatus(midiInput.error ?? 'MIDI is not available.');
      setPhase('idle');
      return;
    }
    if (midiInput.devices.length === 0) {
      store.setStatus('No MIDI device detected. Plug in a keyboard and try again.');
      setPhase('idle');
      return;
    }

    const { project, countInBars, metronome } = store;
    engine.metronomeEnabled = metronome;
    engine.setBpm(project.bpm);
    engine.setBeatsPerBar(project.beatsPerBar);
    engine.syncTracks(project.tracks);
    engine.scheduleProject(project);
    engine.setLoopSuspended(true);

    const punchBeat = engine.positionBeats;
    punchBeatRef.current = punchBeat;
    const countInBeats = countInBars * project.beatsPerBar;
    midiEventsRef.current = [];
    midiActiveRef.current = true;

    const { audioStartTime } = engine.play(punchBeat, countInBeats, project.bpm);
    const preRollSec = Math.max(0, audioStartTime - engine.context.currentTime)
      + beatsToSeconds(Math.min(countInBeats, punchBeat), project.bpm);
    countInEndRef.current = performance.now() + preRollSec * 1000;

    setPhase(countInBeats > 0 ? 'countIn' : 'recording');
    if (countInBeats > 0) {
      window.setTimeout(() => {
        setPhase((p) => (p === 'countIn' ? 'recording' : p));
      }, preRollSec * 1000);
    }
    store.setStatus('Recording. Play your keyboard.');
  }, []);

  const stopMidi = useCallback(() => {
    const store = useStore.getState();
    midiActiveRef.current = false;
    const endBeat = engine.positionBeats;
    engine.stop();
    engine.setLoopSuspended(false);

    const events = midiEventsRef.current;
    midiEventsRef.current = [];

    // Pair note-ons with their note-offs, and anything still held ends at stop.
    const open = new Map<number, { beat: number; vel: number }>();
    const played: { start: number; duration: number; midi: number; velocity: number; detune: number }[] = [];
    for (const ev of events) {
      if (ev.on) {
        if (!open.has(ev.midi)) open.set(ev.midi, { beat: ev.beat, vel: ev.vel });
      } else {
        const o = open.get(ev.midi);
        if (o) {
          open.delete(ev.midi);
          played.push({ start: o.beat, duration: Math.max(1 / 32, ev.beat - o.beat), midi: ev.midi, velocity: o.vel, detune: 0 });
        }
      }
    }
    for (const [midi, o] of open) {
      played.push({ start: o.beat, duration: Math.max(1 / 32, endBeat - o.beat), midi, velocity: o.vel, detune: 0 });
    }

    // Notes struck during the count-in (before the punch point) don't count.
    const kept = played
      .filter((n) => n.start >= punchBeatRef.current - 0.05)
      .map((n) => ({ ...n, start: Math.max(0, n.start) }));

    setPhase('idle');
    if (kept.length === 0) {
      store.setStatus('No MIDI notes were played.');
      return;
    }
    store.commitMidiRecording(store.activeTrackId, kept);
  }, []);

  const start = useCallback(async () => {
    const store = useStore.getState();
    if (!store.activeTrackId) {
      store.setStatus('Add a track first, so the recording has somewhere to land.');
      return;
    }

    if (store.recordSource === 'midi') {
      await startMidi();
      return;
    }

    setPhase('arming');
    if (!(await ensureMic())) return;

    // Fetch the neural model during the count-in so it's warm by the time the
    // take ends. Fire-and-forget: a failure just means the fallback runs later.
    if ((store.transcribeSettings.engine ?? 'neural') === 'neural' && store.inputMode !== 'drums') {
      void import('../audio/neuralPitch').then((m) => m.preloadNeural()).catch(() => {});
    }

    const { project, countInBars, metronome } = store;
    engine.metronomeEnabled = metronome;
    engine.setBpm(project.bpm);
    engine.setBeatsPerBar(project.beatsPerBar);
    engine.syncTracks(project.tracks);
    engine.scheduleProject(project);
    engine.setLoopSuspended(true); // looping during a take would double-record

    const punchBeat = engine.positionBeats;
    punchBeatRef.current = punchBeat;
    const countInBeats = countInBars * project.beatsPerBar;

    // Capture starts before the transport so the count-in is on tape too, and the pre-punch audio is trimmed once the exact alignment is known.
    recorder.start();
    const { audioStartTime } = engine.play(punchBeat, countInBeats, project.bpm);

    const preRollSec = Math.max(0, audioStartTime - engine.context.currentTime)
      + beatsToSeconds(Math.min(countInBeats, punchBeat), project.bpm);
    countInEndRef.current = performance.now() + preRollSec * 1000;

    setPhase(countInBeats > 0 ? 'countIn' : 'recording');
    if (countInBeats > 0) {
      window.setTimeout(() => {
        setPhase((p) => (p === 'countIn' ? 'recording' : p));
      }, preRollSec * 1000);
    }
    store.setStatus('Recording. Sing it.');
  }, [ensureMic, startMidi]);

  const stop = useCallback(async () => {
    if (midiActiveRef.current) {
      stopMidi();
      return;
    }

    const store = useStore.getState();
    const { project, latencyOffsetMs, transcribeSettings, inputMode, activeTrackId } = store;

    setPhase('transcribing');
    store.setStatus('Transcribing…');

    const result = await recorder.stop();
    // Must read the transport mapping before stopping, while the anchor lives.
    const firstSampleTransportSec = engine.contextTimeToTransportSeconds(result.startContextTime);
    engine.stop();
    engine.setLoopSuspended(false);

    if (result.audio.length === 0 || firstSampleTransportSec === null) {
      setPhase('idle');
      store.setStatus('Nothing was captured.');
      return;
    }

    const bpm = project.bpm;
    const latencySec = latencyOffsetMs / 1000;
    const compensatedFirstSampleSec = firstSampleTransportSec - latencySec;

    // Trim off the count-in, keeping a little pre-roll so a slightly early
    // entry still makes it into the take.
    const punchSec = beatsToSeconds(punchBeatRef.current, bpm);
    const PRE_ROLL = 0.15;
    let sliceStart = Math.round((punchSec - PRE_ROLL - compensatedFirstSampleSec) * result.sampleRate);
    sliceStart = Math.max(0, Math.min(sliceStart, Math.max(0, result.audio.length - 1)));
    const audio = result.audio.slice(sliceStart);
    const takeStartSec = compensatedFirstSampleSec + sliceStart / result.sampleRate;
    const takeStartBeat = secondsToBeats(takeStartSec, bpm);

    const settings = { ...transcribeSettings, mode: inputMode };

    // Yield a frame so "Transcribing…" actually paints before we block.
    await new Promise((r) => setTimeout(r, 16));
    const t0 = performance.now();
    const transcription = await transcribeAsync(audio, result.sampleRate, settings);
    const elapsed = Math.round(performance.now() - t0);

    if (transcription.notes.length === 0) {
      setPhase('idle');
      store.setStatus('No notes detected. Try singing louder, or lower the noise gate in Detection.');
      return;
    }

    store.commitTake({
      trackId: activeTrackId,
      startBeat: takeStartBeat,
      autoOffsetMs: latencyOffsetMs,
      durationSec: audio.length / result.sampleRate,
      settings,
      raw: transcription.notes,
      tuningOffsetCents: transcription.tuningOffsetCents,
      audio,
      sampleRate: result.sampleRate,
      contour: transcription.contour,
      contourHopSec: transcription.contourHopSec,
      contourStartSec: transcription.contourStartSec,
    });

    const fellBack = (settings.engine ?? 'neural') === 'neural' && transcription.engineUsed === 'classic';
    setPhase('idle');
    store.setStatus(
      `${transcription.notes.length} notes in ${elapsed} ms` +
        (Math.abs(transcription.tuningOffsetCents) > 12
          ? `. You sang ${transcription.tuningOffsetCents > 0 ? 'sharp' : 'flat'} by ${Math.abs(
              Math.round(transcription.tuningOffsetCents),
            )} cents overall`
          : '') +
        (fellBack ? ' (classic detector, the neural model could not load)' : ''),
    );
  }, [stopMidi]);

  const toggle = useCallback(() => {
    if (phase === 'idle') void start();
    else if (phase === 'recording' || phase === 'countIn') void stop();
  }, [phase, start, stop]);

  const runCalibration = useCallback(async () => {
    const store = useStore.getState();
    setPhase('calibrating');
    store.setStatus('Calibrating. Play through speakers and keep quiet…');
    if (!(await ensureMic())) return;
    try {
      const res = await calibrateLatency(recorder);
      setCalibration(res);
      if (res.ok) store.setSetting('latencyOffsetMs', Math.round(res.latencyMs * 10) / 10);
      store.setStatus(res.message);
    } catch (err) {
      store.setStatus(`Calibration failed: ${(err as Error).message}`);
    } finally {
      setPhase('idle');
    }
  }, [ensureMic]);

  const releaseMic = useCallback(() => {
    recorder.disarm();
    setLevel(0);
  }, []);

  /** Change mic settings, reconfiguring the live stream when the browser allows it and reopening only on device change, so a failed reopen cannot leave the input dead. */
  const applyMicOptions = useCallback(async (next: MicOptions) => {
    const store = useStore.getState();
    store.setSetting('micOptions', next);
    if (!recorder.armed) return;

    if (await recorder.applyOptions(next)) {
      store.setStatus('Microphone settings updated');
      return;
    }

    recorder.disarm();
    setLevel(0);
    try {
      await recorder.arm(engine.context, next);
      setMicError(null);
      store.setStatus('Microphone reopened');
    } catch (err) {
      const msg = `Could not reopen the microphone: ${(err as Error).message}`;
      setMicError(msg);
      store.setStatus(msg);
    }
  }, []);

  return {
    phase,
    level,
    micError,
    calibration,
    isArmed: recorder.armed,
    inputLatencyHintMs: recorder.inputLatencySec * 1000,
    start,
    stop,
    toggle,
    ensureMic,
    runCalibration,
    releaseMic,
    applyMicOptions,
  };
}
