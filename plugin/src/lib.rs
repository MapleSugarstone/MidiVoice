//! MidiVoice as a DAW plugin: track audio in, live MIDI notes out.

mod dsp;
mod editor;

use dsp::{Tracker, TrackerEvent, HOP};
use nih_plug::prelude::*;
use nih_plug_egui::EguiState;
use std::sync::atomic::{AtomicI32, AtomicU32, Ordering};
use std::sync::Arc;

/// Meter and readout state shared with the editor thread.
pub struct Shared {
    /// f32 bits: input level in dB.
    pub db: AtomicU32,
    /// f32 bits: detected pitch as a fractional MIDI note, 0.0 when unvoiced.
    pub midi: AtomicU32,
    /// Note number currently sounding at the host, -1 when silent.
    pub active: AtomicI32,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            db: AtomicU32::new((-120.0f32).to_bits()),
            midi: AtomicU32::new(0.0f32.to_bits()),
            active: AtomicI32::new(-1),
        }
    }
}

pub struct MidiVoice {
    params: Arc<MidiVoiceParams>,
    shared: Arc<Shared>,
    melody: Option<Tracker>,
    bass: Option<Tracker>,
    using_bass: bool,
    stage: [f32; HOP],
    stage_len: usize,
    events: Vec<TrackerEvent>,
    active: i32,
    last_bend: f32,
    kill_active: bool,
}

#[derive(Params)]
pub struct MidiVoiceParams {
    #[persist = "editor-state"]
    pub editor_state: Arc<EguiState>,

    #[id = "gate"]
    pub gate: FloatParam,
    #[id = "split"]
    pub split: FloatParam,
    #[id = "bass"]
    pub bass: BoolParam,
    #[id = "octave"]
    pub octave: IntParam,
    #[id = "bend"]
    pub bend: BoolParam,
    #[id = "thru"]
    pub passthrough: BoolParam,
}

impl Default for MidiVoice {
    fn default() -> Self {
        Self {
            params: Arc::new(MidiVoiceParams::default()),
            shared: Arc::new(Shared::default()),
            melody: None,
            bass: None,
            using_bass: false,
            stage: [0.0; HOP],
            stage_len: 0,
            events: Vec::with_capacity(8),
            active: -1,
            last_bend: 0.5,
            kill_active: false,
        }
    }
}

impl Default for MidiVoiceParams {
    fn default() -> Self {
        Self {
            editor_state: EguiState::from_size(460, 550),
            gate: FloatParam::new(
                "Gate",
                -45.0,
                FloatRange::Linear {
                    min: -60.0,
                    max: -25.0,
                },
            )
            .with_step_size(1.0)
            .with_unit(" dB"),
            split: FloatParam::new(
                "New-note distance",
                80.0,
                FloatRange::Linear {
                    min: 40.0,
                    max: 150.0,
                },
            )
            .with_step_size(5.0)
            .with_unit(" cents"),
            bass: BoolParam::new("Bass range", false),
            octave: IntParam::new("Octave", 0, IntRange::Linear { min: -2, max: 2 }),
            bend: BoolParam::new("Pitch bend", false),
            passthrough: BoolParam::new("Pass audio through", false),
        }
    }
}

impl Plugin for MidiVoice {
    const NAME: &'static str = "MidiVoice";
    const VENDOR: &'static str = "maplesugarstone";
    const URL: &'static str = "https://maplesugarstone.github.io/MidiVoice/";
    const EMAIL: &'static str = "";
    const VERSION: &'static str = env!("CARGO_PKG_VERSION");

    const AUDIO_IO_LAYOUTS: &'static [AudioIOLayout] = &[
        AudioIOLayout {
            main_input_channels: NonZeroU32::new(1),
            main_output_channels: NonZeroU32::new(1),
            ..AudioIOLayout::const_default()
        },
        AudioIOLayout {
            main_input_channels: NonZeroU32::new(2),
            main_output_channels: NonZeroU32::new(2),
            ..AudioIOLayout::const_default()
        },
    ];

    const MIDI_INPUT: MidiConfig = MidiConfig::None;
    const MIDI_OUTPUT: MidiConfig = MidiConfig::MidiCCs;

    type SysExMessage = ();
    type BackgroundTask = ();

    fn params(&self) -> Arc<dyn Params> {
        self.params.clone()
    }

    fn editor(&mut self, _async_executor: AsyncExecutor<Self>) -> Option<Box<dyn Editor>> {
        editor::create(self.params.clone(), self.shared.clone())
    }

    fn initialize(
        &mut self,
        _audio_io_layout: &AudioIOLayout,
        buffer_config: &BufferConfig,
        _context: &mut impl InitContext<Self>,
    ) -> bool {
        let rate = buffer_config.sample_rate;
        self.melody = Some(Tracker::new(false, rate));
        self.bass = Some(Tracker::new(true, rate));
        self.using_bass = self.params.bass.value();
        true
    }

    fn reset(&mut self) {
        if let Some(t) = self.melody.as_mut() {
            t.reset();
        }
        if let Some(t) = self.bass.as_mut() {
            t.reset();
        }
        self.stage_len = 0;
        self.last_bend = 0.5;
        // The note-off for anything still sounding goes out in the next block.
        self.kill_active = self.active >= 0;
    }

    fn process(
        &mut self,
        buffer: &mut Buffer,
        _aux: &mut AuxiliaryBuffers,
        context: &mut impl ProcessContext<Self>,
    ) -> ProcessStatus {
        if self.kill_active {
            self.kill_active = false;
            if self.active >= 0 {
                context.send_event(NoteEvent::NoteOff {
                    timing: 0,
                    voice_id: None,
                    channel: 0,
                    note: self.active as u8,
                    velocity: 0.5,
                });
                self.active = -1;
                self.shared.active.store(-1, Ordering::Relaxed);
            }
        }

        let use_bass = self.params.bass.value();
        if use_bass != self.using_bass {
            self.using_bass = use_bass;
            let t = if use_bass {
                self.bass.as_mut()
            } else {
                self.melody.as_mut()
            };
            if let Some(t) = t {
                t.reset();
            }
        }
        let tracker = match if use_bass {
            self.bass.as_mut()
        } else {
            self.melody.as_mut()
        } {
            Some(t) => t,
            None => return ProcessStatus::Normal,
        };
        tracker.gate_db = self.params.gate.value();
        tracker.split_cents = self.params.split.value();

        let passthrough = self.params.passthrough.value();
        let octave = self.params.octave.value();
        let send_bend = self.params.bend.value();

        for (i, mut channel_samples) in buffer.iter_samples().enumerate() {
            let n = channel_samples.len();
            let mut mono = 0.0;
            for sample in channel_samples.iter_mut() {
                mono += *sample;
                if !passthrough {
                    *sample = 0.0;
                }
            }
            mono /= n as f32;

            self.stage[self.stage_len] = mono;
            self.stage_len += 1;
            if self.stage_len < HOP {
                continue;
            }
            self.stage_len = 0;

            self.events.clear();
            tracker.push_hop(&self.stage, &mut self.events);
            let timing = i as u32;

            for event in self.events.drain(..) {
                match event {
                    TrackerEvent::On { note, velocity } => {
                        if self.active >= 0 {
                            context.send_event(NoteEvent::NoteOff {
                                timing,
                                voice_id: None,
                                channel: 0,
                                note: self.active as u8,
                                velocity: 0.5,
                            });
                        }
                        let shifted = (note as i32 + octave * 12).clamp(0, 127);
                        if send_bend {
                            let delta = tracker.last_midi + octave as f32 * 12.0 - shifted as f32;
                            let value = (0.5 + delta / 4.0).clamp(0.0, 1.0);
                            self.last_bend = value;
                            context.send_event(NoteEvent::MidiPitchBend {
                                timing,
                                channel: 0,
                                value,
                            });
                        }
                        context.send_event(NoteEvent::NoteOn {
                            timing,
                            voice_id: None,
                            channel: 0,
                            note: shifted as u8,
                            velocity: velocity as f32 / 127.0,
                        });
                        self.active = shifted;
                    }
                    TrackerEvent::Off => {
                        if self.active >= 0 {
                            context.send_event(NoteEvent::NoteOff {
                                timing,
                                voice_id: None,
                                channel: 0,
                                note: self.active as u8,
                                velocity: 0.5,
                            });
                        }
                        self.active = -1;
                        if send_bend && self.last_bend != 0.5 {
                            self.last_bend = 0.5;
                            context.send_event(NoteEvent::MidiPitchBend {
                                timing,
                                channel: 0,
                                value: 0.5,
                            });
                        }
                    }
                }
            }

            // Continuous bend keeps the synth on the sung pitch between notes.
            if send_bend && self.active >= 0 && tracker.last_midi > 0.0 {
                let delta = tracker.last_midi + octave as f32 * 12.0 - self.active as f32;
                let value = (0.5 + delta / 4.0).clamp(0.0, 1.0);
                if (value - self.last_bend).abs() > 0.0005 {
                    self.last_bend = value;
                    context.send_event(NoteEvent::MidiPitchBend {
                        timing,
                        channel: 0,
                        value,
                    });
                }
            }

            self.shared
                .db
                .store(tracker.last_db.to_bits(), Ordering::Relaxed);
            self.shared
                .midi
                .store(tracker.last_midi.to_bits(), Ordering::Relaxed);
            self.shared.active.store(self.active, Ordering::Relaxed);
        }

        ProcessStatus::Normal
    }
}

impl ClapPlugin for MidiVoice {
    const CLAP_ID: &'static str = "com.maplesugarstone.midivoice";
    const CLAP_DESCRIPTION: Option<&'static str> =
        Some("Sing into a track, MIDI notes come out.");
    const CLAP_MANUAL_URL: Option<&'static str> =
        Some("https://maplesugarstone.github.io/MidiVoice/");
    const CLAP_SUPPORT_URL: Option<&'static str> = None;
    const CLAP_FEATURES: &'static [ClapFeature] =
        &[ClapFeature::AudioEffect, ClapFeature::Utility];
}

impl Vst3Plugin for MidiVoice {
    const VST3_CLASS_ID: [u8; 16] = *b"MidiVoiceMapleSg";
    const VST3_SUBCATEGORIES: &'static [Vst3SubCategory] =
        &[Vst3SubCategory::Fx, Vst3SubCategory::Tools];
}

nih_export_clap!(MidiVoice);
nih_export_vst3!(MidiVoice);
