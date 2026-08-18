//! The plugin window: the app's Frutiger Aero dressing, painted with egui.

use crate::{MidiVoiceParams, Shared};
use nih_plug::prelude::*;
use nih_plug_egui::{create_egui_editor, egui};
use egui::epaint::{Vertex, WHITE_UV};
use egui::{
    Align2, Color32, CornerRadius, FontId, Margin, Mesh, Pos2, Rect, Sense, Shape, Stroke,
    StrokeKind, Vec2,
};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

const BG_TOP: Color32 = Color32::from_rgb(236, 248, 255);
const BG_MID: Color32 = Color32::from_rgb(218, 240, 255);
const BG_BOTTOM: Color32 = Color32::from_rgb(181, 218, 241);
const PANEL2: Color32 = Color32::from_rgb(235, 246, 253);
const LINE: Color32 = Color32::from_rgb(173, 198, 215);
const TEXT: Color32 = Color32::from_rgb(12, 24, 32);
const MUTED: Color32 = Color32::from_rgb(56, 99, 122);
const ACCENT: Color32 = Color32::from_rgb(0, 102, 134);
const ACCENT_DARK: Color32 = Color32::from_rgb(0, 61, 82);
const METER_A: Color32 = Color32::from_rgb(44, 134, 90);
const METER_B: Color32 = Color32::from_rgb(0, 66, 39);
const CHIP_ON: Color32 = Color32::from_rgb(126, 192, 223);

fn vgrad(painter: &egui::Painter, rect: Rect, top: Color32, bottom: Color32) {
    let mut mesh = Mesh::default();
    let i = mesh.vertices.len() as u32;
    mesh.vertices.push(Vertex { pos: rect.left_top(), uv: WHITE_UV, color: top });
    mesh.vertices.push(Vertex { pos: rect.right_top(), uv: WHITE_UV, color: top });
    mesh.vertices.push(Vertex { pos: rect.right_bottom(), uv: WHITE_UV, color: bottom });
    mesh.vertices.push(Vertex { pos: rect.left_bottom(), uv: WHITE_UV, color: bottom });
    mesh.indices
        .extend_from_slice(&[i, i + 1, i + 2, i + 2, i + 3, i]);
    painter.add(Shape::mesh(mesh));
}

/// Top-half white sheen that makes a flat fill read as glass.
fn sheen(painter: &egui::Painter, rect: Rect) {
    let half = Rect::from_min_max(rect.min, Pos2::new(rect.max.x, rect.center().y));
    vgrad(
        painter,
        half.shrink(1.5),
        Color32::from_white_alpha(110),
        Color32::from_white_alpha(0),
    );
}

fn name_of(n: i32) -> String {
    const NAMES: [&str; 12] = [
        "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
    ];
    format!("{}{}", NAMES[n.rem_euclid(12) as usize], n / 12 - 1)
}

fn sample_cubic(out: &mut Vec<Pos2>, p0: Pos2, p1: Pos2, p2: Pos2, p3: Pos2) {
    for step in 1..=12 {
        let t = step as f32 / 12.0;
        let u = 1.0 - t;
        let x = u * u * u * p0.x + 3.0 * u * u * t * p1.x + 3.0 * u * t * t * p2.x + t * t * t * p3.x;
        let y = u * u * u * p0.y + 3.0 * u * u * t * p1.y + 3.0 * u * t * t * p2.y + t * t * t * p3.y;
        out.push(Pos2::new(x, y));
    }
}

/// The logo fish from the app's favicon, flattened to solid fills.
fn fish(painter: &egui::Painter, origin: Pos2, s: f32) {
    let p = |x: f32, y: f32| Pos2::new(origin.x + (x - 6.5) * s, origin.y + (y - 20.0) * s);
    let body_fill = Color32::from_rgb(55, 169, 124);
    let fin_fill = Color32::from_rgb(47, 143, 104);

    // Tail, as two convex halves around its concave notch at (54.4, 38).
    for half in [
        [(43.5, 38.0), (56.0, 27.5), (54.4, 38.0)],
        [(43.5, 38.0), (54.4, 38.0), (56.0, 48.5)],
    ] {
        let pts: Vec<Pos2> = half.iter().map(|&(x, y)| p(x, y)).collect();
        painter.add(Shape::convex_polygon(pts, fin_fill, Stroke::NONE));
    }

    // Top fin.
    let fin: Vec<Pos2> = [(26.0, 27.8), (28.5, 21.5), (36.8, 21.4), (32.4, 27.2)]
        .iter()
        .map(|&(x, y)| p(x, y))
        .collect();
    painter.add(Shape::convex_polygon(fin, fin_fill, Stroke::NONE));

    // Body: four cubics from the SVG path.
    let mut pts = vec![p(7.5, 38.0)];
    sample_cubic(&mut pts, p(7.5, 38.0), p(12.0, 29.5), p(20.5, 26.2), p(28.8, 26.6));
    sample_cubic(&mut pts, p(28.8, 26.6), p(37.0, 27.0), p(43.4, 31.4), p(45.6, 38.0));
    sample_cubic(&mut pts, p(45.6, 38.0), p(43.4, 44.6), p(37.0, 49.0), p(28.8, 49.4));
    sample_cubic(&mut pts, p(28.8, 49.4), p(20.5, 49.8), p(12.0, 46.5), p(7.5, 38.0));
    painter.add(Shape::convex_polygon(pts, body_fill, Stroke::NONE));

    // Gloss and eye.
    painter.add(Shape::ellipse_filled(
        p(27.3, 32.5),
        Vec2::new(12.0 * s, 4.2 * s),
        Color32::from_white_alpha(95),
    ));
    painter.circle_filled(p(15.8, 35.2), 3.5 * s, Color32::WHITE);
    painter.circle_filled(p(16.0, 34.9), 2.85 * s, Color32::from_rgb(8, 37, 48));
    painter.circle_filled(p(16.8, 33.5), 0.8 * s, Color32::WHITE);
}

fn heading(ui: &mut egui::Ui, text: &str) {
    ui.label(egui::RichText::new(text).color(MUTED).size(11.0));
}

fn set_bool(setter: &ParamSetter, param: &BoolParam, value: bool) {
    setter.begin_set_parameter(param);
    setter.set_parameter(param, value);
    setter.end_set_parameter(param);
}

fn set_int(setter: &ParamSetter, param: &IntParam, value: i32) {
    setter.begin_set_parameter(param);
    setter.set_parameter(param, value);
    setter.end_set_parameter(param);
}

fn chip(ui: &mut egui::Ui, label: &str, on: bool, width: f32) -> bool {
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(width, 24.0), Sense::click());
    let painter = ui.painter();
    let fill = if on {
        CHIP_ON
    } else if resp.hovered() {
        Color32::from_rgb(213, 235, 251)
    } else {
        PANEL2
    };
    let stroke_color = if on { ACCENT } else { LINE };
    painter.rect_filled(rect, CornerRadius::same(12), fill);
    sheen(painter, rect);
    painter.rect_stroke(rect, CornerRadius::same(12), Stroke::new(1.0_f32, stroke_color), StrokeKind::Inside);
    painter.text(
        rect.center(),
        Align2::CENTER_CENTER,
        label,
        FontId::proportional(12.5),
        if on { Color32::from_rgb(13, 25, 33) } else { TEXT },
    );
    resp.clicked()
}

fn slider_row(ui: &mut egui::Ui, setter: &ParamSetter, param: &FloatParam, label: &str) {
    ui.horizontal(|ui| {
        ui.add_sized(
            [118.0, 20.0],
            egui::Label::new(egui::RichText::new(label).color(MUTED).size(12.0)),
        );
        let width = (ui.available_width() - 66.0).max(60.0);
        let (rect, resp) = ui.allocate_exact_size(Vec2::new(width, 20.0), Sense::click_and_drag());

        let painter = ui.painter();
        let track = Rect::from_center_size(rect.center(), Vec2::new(rect.width(), 8.0));
        painter.rect_filled(track, CornerRadius::same(4), PANEL2);
        painter.rect_stroke(track, CornerRadius::same(4), Stroke::new(1.0_f32, LINE), StrokeKind::Inside);

        let norm = param.unmodulated_normalized_value();
        let x = track.left() + 9.0 + norm * (track.width() - 18.0);
        let center = Pos2::new(x, rect.center().y);
        painter.circle_filled(center, 8.5, ACCENT_DARK);
        painter.circle_filled(center, 7.5, ACCENT);
        painter.circle_filled(
            Pos2::new(center.x, center.y - 2.5),
            4.5,
            Color32::from_white_alpha(120),
        );

        if resp.drag_started() {
            setter.begin_set_parameter(param);
        }
        if resp.dragged() {
            if let Some(pos) = resp.interact_pointer_pos() {
                let n = ((pos.x - track.left() - 9.0) / (track.width() - 18.0)).clamp(0.0, 1.0);
                setter.set_parameter_normalized(param, n);
            }
        }
        if resp.drag_stopped() {
            setter.end_set_parameter(param);
        }
        if resp.clicked() {
            if let Some(pos) = resp.interact_pointer_pos() {
                let n = ((pos.x - track.left() - 9.0) / (track.width() - 18.0)).clamp(0.0, 1.0);
                setter.begin_set_parameter(param);
                setter.set_parameter_normalized(param, n);
                setter.end_set_parameter(param);
            }
        }

        ui.add_sized(
            [58.0, 20.0],
            egui::Label::new(
                egui::RichText::new(param.to_string())
                    .font(FontId::monospace(11.0))
                    .color(TEXT),
            ),
        );
    });
}

fn card_frame() -> egui::Frame {
    egui::Frame::default()
        .fill(Color32::from_rgba_unmultiplied(255, 255, 255, 150))
        .stroke(Stroke::new(1.0_f32, LINE))
        .corner_radius(CornerRadius::same(14))
        .inner_margin(Margin::same(12))
}

pub fn create(params: Arc<MidiVoiceParams>, shared: Arc<Shared>) -> Option<Box<dyn Editor>> {
    let egui_state = params.editor_state.clone();
    create_egui_editor(
        egui_state,
        (),
        |egui_ctx, _| {
            egui_ctx.set_visuals(egui::Visuals::light());
            let mut fonts = egui::FontDefinitions::default();
            for path in ["C:\\Windows\\Fonts\\Candara.ttf", "/System/Library/Fonts/Optima.ttc"] {
                if let Ok(bytes) = std::fs::read(path) {
                    fonts.font_data.insert(
                        "aero".to_owned(),
                        Arc::new(egui::FontData::from_owned(bytes)),
                    );
                    fonts
                        .families
                        .get_mut(&egui::FontFamily::Proportional)
                        .unwrap()
                        .insert(0, "aero".to_owned());
                    break;
                }
            }
            egui_ctx.set_fonts(fonts);
        },
        move |egui_ctx, setter, _| {
            egui::CentralPanel::default()
                .frame(egui::Frame::default())
                .show(egui_ctx, |ui| {
                    let full = ui.max_rect().expand(8.0);
                    let painter = ui.painter();
                    let mid = Rect::from_min_max(
                        full.min,
                        Pos2::new(full.max.x, full.min.y + full.height() * 0.45),
                    );
                    let low = Rect::from_min_max(mid.left_bottom(), full.max);
                    vgrad(painter, mid, BG_TOP, BG_MID);
                    vgrad(painter, low, BG_MID, BG_BOTTOM);

                    ui.spacing_mut().item_spacing = Vec2::new(8.0, 8.0);

                    // Header.
                    ui.horizontal(|ui| {
                        let (logo_rect, _) =
                            ui.allocate_exact_size(Vec2::new(48.0, 30.0), Sense::hover());
                        fish(ui.painter(), logo_rect.left_top(), 0.95);
                        ui.label(egui::RichText::new("MidiVoice").color(TEXT).size(20.0));
                        let (pill, _) = ui.allocate_exact_size(Vec2::new(44.0, 20.0), Sense::hover());
                        let painter = ui.painter();
                        painter.rect_filled(pill, CornerRadius::same(10), PANEL2);
                        sheen(painter, pill);
                        painter.rect_stroke(pill, CornerRadius::same(10), Stroke::new(1.0_f32, LINE), StrokeKind::Inside);
                        painter.text(
                            pill.center(),
                            Align2::CENTER_CENTER,
                            "VST",
                            FontId::proportional(11.0),
                            ACCENT,
                        );
                    });
                    ui.label(
                        egui::RichText::new("Sing into this track. MIDI notes come out.")
                            .color(MUTED)
                            .size(12.5),
                    );
                    ui.add_space(2.0);

                    let db = f32::from_bits(shared.db.load(Ordering::Relaxed));
                    let midi = f32::from_bits(shared.midi.load(Ordering::Relaxed));
                    let active = shared.active.load(Ordering::Relaxed);

                    card_frame().show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        heading(ui, "LISTENING");

                        // Level meter.
                        let (meter, _) = ui.allocate_exact_size(
                            Vec2::new(ui.available_width(), 20.0),
                            Sense::hover(),
                        );
                        let painter = ui.painter();
                        vgrad(painter, meter, Color32::from_rgb(201, 223, 239), Color32::from_rgb(238, 248, 255));
                        let frac = ((db + 60.0) / 60.0).clamp(0.0, 1.0);
                        if frac > 0.0 {
                            let fill = Rect::from_min_size(
                                meter.min,
                                Vec2::new(meter.width() * frac, meter.height()),
                            );
                            vgrad(painter, fill, METER_A, METER_B);
                        }
                        sheen(painter, meter);
                        painter.rect_stroke(meter, CornerRadius::same(10), Stroke::new(1.0_f32, LINE), StrokeKind::Inside);
                        let label = if db <= -59.5 {
                            "quiet".to_owned()
                        } else {
                            format!("{:.0} dB", db)
                        };
                        painter.text(
                            meter.center(),
                            Align2::CENTER_CENTER,
                            label,
                            FontId::monospace(11.0),
                            TEXT,
                        );

                        // Sung pitch readout.
                        let (pitch_rect, _) = ui.allocate_exact_size(
                            Vec2::new(ui.available_width(), 46.0),
                            Sense::hover(),
                        );
                        let painter = ui.painter();
                        vgrad(painter, pitch_rect, Color32::from_rgb(207, 238, 253), Color32::from_rgb(233, 251, 255));
                        painter.rect_stroke(pitch_rect, CornerRadius::same(12), Stroke::new(1.0_f32, LINE), StrokeKind::Inside);
                        let text = if midi > 0.0 {
                            let near = midi.round() as i32;
                            let cents = ((midi - near as f32) * 100.0).round() as i32;
                            format!("{} {}{}\u{a2}", name_of(near), if cents < 0 { "-" } else { "+" }, cents.abs())
                        } else {
                            "\u{b7}".to_owned()
                        };
                        painter.text(
                            pitch_rect.center(),
                            Align2::CENTER_CENTER,
                            text,
                            FontId::monospace(22.0),
                            ACCENT,
                        );

                        ui.label(
                            egui::RichText::new(if active >= 0 {
                                format!("out  {}", name_of(active))
                            } else {
                                "out  \u{b7}".to_owned()
                            })
                            .font(FontId::monospace(11.0))
                            .color(MUTED),
                        );
                    });

                    card_frame().show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        heading(ui, "DETECTION");
                        slider_row(ui, setter, &params.gate, "Gate");
                        slider_row(ui, setter, &params.conf, "Pitch confidence");
                        slider_row(ui, setter, &params.split, "New-note distance");
                        slider_row(ui, setter, &params.settle, "Note settle");
                        slider_row(ui, setter, &params.release, "Release");
                        ui.label(
                            egui::RichText::new(
                                "Stray notes: raise Gate, Pitch confidence and Note settle.",
                            )
                            .color(MUTED)
                            .size(11.0),
                        );
                        ui.add_space(2.0);

                        ui.horizontal(|ui| {
                            let bass = params.bass.value();
                            if chip(ui, "Melody", !bass, 74.0) && bass {
                                set_bool(setter, &params.bass, false);
                            }
                            if chip(ui, "Bass", bass, 60.0) && !bass {
                                set_bool(setter, &params.bass, true);
                            }
                            ui.add_space(10.0);
                            ui.label(egui::RichText::new("OCTAVE").color(MUTED).size(10.5));
                            let oct = params.octave.value();
                            for v in [-2i32, -1, 0, 1, 2] {
                                let label = if v > 0 {
                                    format!("+{}", v)
                                } else {
                                    format!("{}", v)
                                };
                                if chip(ui, &label, oct == v, 34.0) && oct != v {
                                    set_int(setter, &params.octave, v);
                                }
                            }
                        });

                        ui.horizontal(|ui| {
                            let bend = params.bend.value();
                            if chip(ui, "Pitch bend", bend, 92.0) {
                                set_bool(setter, &params.bend, !bend);
                            }
                            let thru = params.passthrough.value();
                            if chip(ui, "Pass audio through", thru, 140.0) {
                                set_bool(setter, &params.passthrough, !thru);
                            }
                        });
                        ui.label(
                            egui::RichText::new(
                                "Pitch bend needs the synth's bend range at \u{b1}2 semitones.",
                            )
                            .color(MUTED)
                            .size(11.0),
                        );
                    });

                    ui.add_space(2.0);
                    ui.label(
                        egui::RichText::new(
                            "Add a synth after this plugin in this track's FX chain. Arm, monitor, sing.\nSet Record: output (MIDI) to keep the notes for editing.",
                        )
                        .color(MUTED)
                        .size(11.5),
                    );
                });

            egui_ctx.request_repaint_after(Duration::from_millis(33));
        },
    )
}
