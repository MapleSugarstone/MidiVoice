import { engine } from '../audio/engine';
import { useStore } from '../model/store';

/** Push everything the transport depends on into the engine before it starts. */
async function prime() {
  await engine.init();
  const s = useStore.getState();
  engine.metronomeEnabled = s.metronome;
  engine.setBpm(s.project.bpm);
  engine.setBeatsPerBar(s.project.beatsPerBar);
  engine.syncTracks(s.project.tracks);
  engine.scheduleProject(s.project);
  engine.setProjectLoop(s.project);
  return s;
}

export async function togglePlay(): Promise<void> {
  if (engine.isPlaying) {
    engine.pause();
    useStore.getState().setStatus('Paused');
    return;
  }
  const s = await prime();
  engine.play(engine.positionBeats, 0, s.project.bpm);
}

/** Jump to a point and play from there, whether or not the song was running. */
export async function playFrom(beat: number): Promise<void> {
  const s = await prime();
  engine.seek(beat);
  if (!engine.isPlaying) engine.play(beat, 0, s.project.bpm);
}

export function stopAll(): void {
  engine.stop();
  engine.seek(0);
}
