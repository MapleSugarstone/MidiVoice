/**
 * Web MIDI input. One shared instance listens on every connected input port,
 * so plugging a keyboard in mid-session just works (statechange re-scans).
 */

export interface MidiDeviceInfo {
  id: string;
  name: string;
}

type NoteHandler = (midi: number, velocity: number, on: boolean) => void;

class MidiInput {
  readonly supported = typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;

  devices: MidiDeviceInfo[] = [];
  error: string | null = null;
  onNote: NoteHandler | null = null;
  onDevicesChanged: (() => void) | null = null;

  private access: MIDIAccess | null = null;

  get enabled(): boolean {
    return this.access !== null;
  }

  async enable(): Promise<boolean> {
    if (!this.supported) {
      this.error = 'This browser has no MIDI support. Chrome and Edge do.';
      return false;
    }
    if (this.access) return true;
    try {
      this.access = await navigator.requestMIDIAccess();
    } catch {
      this.error = 'MIDI access was blocked. Allow it in the browser address bar, then try again.';
      return false;
    }
    this.error = null;
    this.access.onstatechange = () => {
      this.refresh();
      this.onDevicesChanged?.();
    };
    this.refresh();
    return true;
  }

  private refresh() {
    if (!this.access) return;
    this.devices = [...this.access.inputs.values()].map((i) => ({
      id: i.id,
      name: i.name || 'MIDI device',
    }));
    for (const input of this.access.inputs.values()) {
      input.onmidimessage = (e: MIDIMessageEvent) => this.handle(e);
    }
  }

  private handle(e: MIDIMessageEvent) {
    const d = e.data;
    if (!d || d.length < 3) return;
    const status = d[0] & 0xf0;
    // Note-on with velocity 0 is the wire format many keyboards use for note-off.
    if (status === 0x90 && d[2] > 0) this.onNote?.(d[1], Math.max(0.05, d[2] / 127), true);
    else if (status === 0x80 || (status === 0x90 && d[2] === 0)) this.onNote?.(d[1], 0, false);
  }
}

export const midiInput = new MidiInput();
