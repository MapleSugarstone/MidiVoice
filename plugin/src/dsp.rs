//! FFT + YIN ported from the app's src/audio/dsp.ts, plus the live note
//! tracker shared with the web DAW bridge.

pub const HOP: usize = 512;

pub struct Fft {
    cos: Vec<f64>,
    sin: Vec<f64>,
    rev: Vec<usize>,
}

impl Fft {
    pub fn new(n: usize) -> Self {
        let half = n >> 1;
        let mut cos = vec![0.0; half];
        let mut sin = vec![0.0; half];
        for i in 0..half {
            let a = -2.0 * std::f64::consts::PI * i as f64 / n as f64;
            cos[i] = a.cos();
            sin[i] = a.sin();
        }
        let mut bits = 0;
        while 1 << bits < n {
            bits += 1;
        }
        let mut rev = vec![0usize; n];
        for i in 0..n {
            let mut r = 0;
            for b in 0..bits {
                if i & (1 << b) != 0 {
                    r |= 1 << (bits - 1 - b);
                }
            }
            rev[i] = r;
        }
        Self { cos, sin, rev }
    }

    pub fn forward(&self, re: &mut [f64], im: &mut [f64]) {
        let n = re.len();
        if n <= 1 {
            return;
        }
        for i in 0..n {
            let j = self.rev[i];
            if i < j {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let mut len = 2;
        while len <= n {
            let half = len >> 1;
            let stride = n / len;
            let mut s = 0;
            while s < n {
                let mut tw = 0;
                for k in 0..half {
                    let w_re = self.cos[tw];
                    let w_im = self.sin[tw];
                    let a = s + k;
                    let b = a + half;
                    let v_re = re[b] * w_re - im[b] * w_im;
                    let v_im = re[b] * w_im + im[b] * w_re;
                    re[b] = re[a] - v_re;
                    im[b] = im[a] - v_im;
                    re[a] += v_re;
                    im[a] += v_im;
                    tw += stride;
                }
                s += len;
            }
            len <<= 1;
        }
    }

    pub fn inverse(&self, re: &mut [f64], im: &mut [f64]) {
        let n = re.len();
        for v in im.iter_mut() {
            *v = -*v;
        }
        self.forward(re, im);
        let inv = 1.0 / n as f64;
        for i in 0..n {
            re[i] *= inv;
            im[i] *= -inv;
        }
    }
}

pub struct Yin {
    frame_size: usize,
    w: usize,
    rate: f64,
    threshold: f64,
    min_tau: usize,
    max_tau: usize,
    fft: Fft,
    z_re: Vec<f64>,
    z_im: Vec<f64>,
    c_re: Vec<f64>,
    c_im: Vec<f64>,
    cmnd: Vec<f64>,
}

impl Yin {
    pub fn new(frame_size: usize, rate: f32, min_freq: f32, max_freq: f32) -> Self {
        let w = frame_size >> 1;
        Self {
            frame_size,
            w,
            rate: rate as f64,
            threshold: 0.15,
            min_tau: 2.max((rate / max_freq).floor() as usize),
            max_tau: (w - 1).min((rate / min_freq).ceil() as usize),
            fft: Fft::new(frame_size),
            z_re: vec![0.0; frame_size],
            z_im: vec![0.0; frame_size],
            c_re: vec![0.0; frame_size],
            c_im: vec![0.0; frame_size],
            cmnd: vec![0.0; w],
        }
    }

    /// Returns (freq, clarity); freq 0 when unvoiced.
    pub fn detect(&mut self, buf: &[f32]) -> (f32, f32) {
        let fs = self.frame_size;
        let w = self.w;
        if self.max_tau <= self.min_tau {
            return (0.0, 0.0);
        }

        // Two real sequences share one complex transform: the half-window in
        // the real part, the whole frame in the imaginary.
        for i in 0..w {
            let v = buf[i] as f64;
            self.z_re[i] = v;
            self.z_im[i] = v;
        }
        for i in w..fs {
            self.z_re[i] = 0.0;
            self.z_im[i] = buf[i] as f64;
        }
        self.fft.forward(&mut self.z_re, &mut self.z_im);

        for k in 0..fs {
            let nk = if k == 0 { 0 } else { fs - k };
            let zr = self.z_re[k];
            let zi = self.z_im[k];
            let nr = self.z_re[nk];
            let ni = self.z_im[nk];
            let pr = zr + nr;
            let pi = -zi + ni;
            let qr = zr - nr;
            let qi = zi + ni;
            self.c_re[k] = 0.25 * (pr * qi + pi * qr);
            self.c_im[k] = -0.25 * (pr * qr - pi * qi);
        }
        self.fft.inverse(&mut self.c_re, &mut self.c_im);

        let mut p0 = 0.0;
        for i in 0..w {
            let v = buf[i] as f64;
            p0 += v * v;
        }

        let mut running = 0.0;
        let mut p_tau = p0;
        self.cmnd[0] = 1.0;
        for tau in 1..w {
            let drop = buf[tau - 1] as f64;
            let add = buf[tau + w - 1] as f64;
            p_tau += add * add - drop * drop;
            let d = (p0 + p_tau - 2.0 * self.c_re[tau]).max(0.0);
            running += d;
            self.cmnd[tau] = if running == 0.0 { 1.0 } else { d * tau as f64 / running };
        }

        // First dip below the absolute threshold, against octave-down errors.
        let mut best_tau: Option<usize> = None;
        let mut tau = self.min_tau;
        while tau <= self.max_tau {
            if self.cmnd[tau] < self.threshold {
                while tau + 1 <= self.max_tau && self.cmnd[tau + 1] < self.cmnd[tau] {
                    tau += 1;
                }
                best_tau = Some(tau);
                break;
            }
            tau += 1;
        }
        let bt = match best_tau {
            Some(t) => t,
            None => {
                let mut best = self.min_tau;
                for t in self.min_tau..=self.max_tau {
                    if self.cmnd[t] < self.cmnd[best] {
                        best = t;
                    }
                }
                if self.cmnd[best] > 0.55 {
                    return (0.0, 0.0);
                }
                best
            }
        };

        let mut refined = bt as f64;
        if bt > 1 && bt < w - 1 {
            let s0 = self.cmnd[bt - 1];
            let s1 = self.cmnd[bt];
            let s2 = self.cmnd[bt + 1];
            let denom = 2.0 * (2.0 * s1 - s2 - s0);
            if denom.abs() > 1e-12 {
                let shift = (s2 - s0) / denom;
                if shift.abs() < 1.0 {
                    refined = bt as f64 + shift;
                }
            }
        }

        let freq = self.rate / refined;
        if !freq.is_finite() || freq <= 0.0 {
            return (0.0, 0.0);
        }
        (freq as f32, (1.0 - self.cmnd[bt]).clamp(0.0, 1.0) as f32)
    }
}

pub enum TrackerEvent {
    On { note: u8, velocity: u8 },
    Off,
}

pub struct Tracker {
    pub gate_db: f32,
    pub split_cents: f32,
    /// Clarity needed to start a note; holding one needs 0.2 less (floor 0.15).
    pub conf: f32,
    /// Voiced hops that must agree before a note starts or moves. 2..=12.
    pub settle_hops: usize,
    /// Unvoiced hops before the sounding note releases. 2..=20.
    pub release_hops: u32,
    /// Milliseconds per hop at the current sample rate.
    pub hop_ms: f32,
    yin: Yin,
    frame: Vec<f32>,
    filled: usize,
    note: i32,
    on_buf: Vec<f32>,
    drift_buf: Vec<(f32, f32)>,
    off_run: u32,
    pub last_db: f32,
    pub last_midi: f32,
}

fn spread(v: &[f32]) -> f32 {
    let mut lo = f32::INFINITY;
    let mut hi = f32::NEG_INFINITY;
    for &x in v {
        lo = lo.min(x);
        hi = hi.max(x);
    }
    hi - lo
}

fn median(v: &[f32]) -> f32 {
    let mut buf = [0.0f32; 16];
    let n = v.len().min(16);
    buf[..n].copy_from_slice(&v[..n]);
    let s = &mut buf[..n];
    s.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap());
    s[n / 2]
}

impl Tracker {
    pub fn new(bass: bool, rate: f32) -> Self {
        let size = if bass { 4096 } else { 2048 };
        let yin = if bass {
            Yin::new(size, rate, 28.0, 500.0)
        } else {
            Yin::new(size, rate, 55.0, 1200.0)
        };
        Self {
            gate_db: -45.0,
            split_cents: 80.0,
            conf: 0.5,
            settle_hops: 3,
            release_hops: 5,
            hop_ms: HOP as f32 * 1000.0 / rate,
            yin,
            frame: vec![0.0; size],
            filled: 0,
            note: -1,
            on_buf: Vec::with_capacity(16),
            drift_buf: Vec::with_capacity(16),
            off_run: 0,
            last_db: -120.0,
            last_midi: 0.0,
        }
    }

    pub fn reset(&mut self) {
        self.frame.fill(0.0);
        self.filled = 0;
        self.note = -1;
        self.on_buf.clear();
        self.drift_buf.clear();
        self.off_run = 0;
        self.last_db = -120.0;
        self.last_midi = 0.0;
    }

    pub fn push_hop(&mut self, hop: &[f32], events: &mut Vec<TrackerEvent>) {
        let len = self.frame.len();
        self.frame.copy_within(HOP.., 0);
        self.frame[len - HOP..].copy_from_slice(hop);
        self.filled = (self.filled + HOP).min(len);

        // Short level window so a note is judged by its own attack.
        let mut sum = 0.0;
        for &v in &self.frame[len - 512..] {
            sum += v * v;
        }
        let db = 20.0 * (sum / 512.0).sqrt().max(1e-6).log10();
        self.last_db = db;

        let mut m = 0.0;
        let mut clarity = 0.0;
        if self.filled >= len {
            let (freq, c) = self.yin.detect(&self.frame);
            if freq > 0.0 {
                m = 69.0 + 12.0 * (freq / 440.0).log2();
                clarity = c;
            }
        }
        self.last_midi = m;

        // Hysteresis: starting a note demands more evidence than holding one.
        let need = if self.note >= 0 {
            (self.conf - 0.2).max(0.15)
        } else {
            self.conf
        };
        let voiced = db >= self.gate_db && m > 0.0 && clarity >= need;
        let settle = self.settle_hops.clamp(2, 16);

        if voiced {
            if self.note < 0 {
                self.on_buf.push(m);
                while self.on_buf.len() > settle {
                    self.on_buf.remove(0);
                }
                // Agreeing frames let the scoop into a note settle first.
                if self.on_buf.len() == settle && spread(&self.on_buf) <= 0.8 {
                    self.start_note(median(&self.on_buf), db, events);
                }
            } else {
                let gap = self.off_run;
                self.off_run = 0;
                let away = (m - self.note as f32).abs();
                if gap >= 2 && away <= 0.8 {
                    // Brief unvoiced dip at the same pitch: re-articulation.
                    events.push(TrackerEvent::Off);
                    self.start_note(m, db, events);
                } else if away * 100.0 > self.split_cents {
                    self.drift_buf.push((m, clarity));
                    while self.drift_buf.len() > settle {
                        self.drift_buf.remove(0);
                    }
                    if self.drift_buf.len() == settle {
                        let mut pitches = [0.0f32; 16];
                        let mut clar_sum = 0.0;
                        for (i, &(p, c)) in self.drift_buf.iter().enumerate() {
                            pitches[i] = p;
                            clar_sum += c;
                        }
                        let pitches = &pitches[..settle];
                        if spread(pitches) <= 1.0 {
                            let target = median(pitches);
                            let mean_clar = clar_sum / settle as f32;
                            let jump = (target - self.note as f32).abs();
                            // A soft, clean octave step is usually YIN grabbing
                            // a subharmonic: hold instead.
                            if !((jump - 12.0).abs() < 1.0 && mean_clar < 0.6) {
                                events.push(TrackerEvent::Off);
                                self.start_note(target, db, events);
                            }
                            self.drift_buf.clear();
                        }
                    }
                } else {
                    self.drift_buf.clear();
                }
            }
        } else {
            self.on_buf.clear();
            self.drift_buf.clear();
            if self.note >= 0 {
                self.off_run += 1;
                if self.off_run >= self.release_hops {
                    events.push(TrackerEvent::Off);
                    self.note = -1;
                    self.off_run = 0;
                }
            }
        }
    }

    fn start_note(&mut self, m: f32, db: f32, events: &mut Vec<TrackerEvent>) {
        let n = (m.round() as i32).clamp(0, 127);
        let span = (-8.0 - self.gate_db).max(6.0);
        let vel = (30.0 + (db - self.gate_db) / span * 92.0).round().clamp(30.0, 122.0);
        events.push(TrackerEvent::On {
            note: n as u8,
            velocity: vel as u8,
        });
        self.note = n;
        self.on_buf.clear();
        self.drift_buf.clear();
        self.off_run = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(rate: f32, bass: bool, tone: impl Fn(usize) -> f32, seconds: f32) -> Vec<String> {
        let mut tracker = Tracker::new(bass, rate);
        run_tracker(&mut tracker, rate, tone, seconds)
    }

    fn run_tracker(
        tracker: &mut Tracker,
        rate: f32,
        tone: impl Fn(usize) -> f32,
        seconds: f32,
    ) -> Vec<String> {
        let mut events = Vec::new();
        let mut log = Vec::new();
        let mut hop = [0.0f32; HOP];
        let total = (rate * seconds) as usize;
        let mut t = 0;
        while t + HOP <= total {
            for (i, v) in hop.iter_mut().enumerate() {
                *v = tone(t + i);
            }
            t += HOP;
            events.clear();
            tracker.push_hop(&hop, &mut events);
            for e in &events {
                log.push(match e {
                    TrackerEvent::On { note, .. } => format!("on{}", note),
                    TrackerEvent::Off => "off".to_owned(),
                });
            }
        }
        log
    }

    #[test]
    fn sine_becomes_one_note() {
        let rate = 48000.0f32;
        let log = run(
            rate,
            false,
            |t| {
                if t >= 2400 && t < 40800 {
                    (t as f32 * 440.0 / rate * std::f32::consts::TAU).sin() * 0.3
                } else {
                    0.0
                }
            },
            1.0,
        );
        assert_eq!(log, ["on69", "off"]);
    }

    #[test]
    fn two_pitches_retrigger() {
        let rate = 48000.0f32;
        let log = run(
            rate,
            false,
            |t| {
                let freq = if t < 21600 { 440.0f32 } else { 587.33f32 };
                if t >= 2400 && t < 40800 {
                    (t as f32 * freq / rate * std::f32::consts::TAU).sin() * 0.3
                } else {
                    0.0
                }
            },
            1.0,
        );
        assert_eq!(log, ["on69", "off", "on74", "off"]);
    }

    #[test]
    fn longer_settle_skips_a_blip() {
        let rate = 48000.0f32;
        let blip = |t: usize| {
            if t >= 2400 && t < 6600 {
                (t as f32 * 440.0 / rate * std::f32::consts::TAU).sin() * 0.3
            } else {
                0.0
            }
        };
        assert_eq!(run(rate, false, blip, 0.5), ["on69", "off"]);
        let mut strict = Tracker::new(false, rate);
        strict.settle_hops = 12;
        assert_eq!(run_tracker(&mut strict, rate, blip, 0.5), Vec::<String>::new());
    }

    #[test]
    fn release_sets_the_note_off_lag() {
        let rate = 48000.0f32;
        for (release, want_extra) in [(5u32, 5usize), (12, 12)] {
            let mut t = Tracker::new(false, rate);
            t.release_hops = release;
            let mut events = Vec::new();
            let mut hop = [0.0f32; HOP];
            let mut off_at = None;
            // Tone through hop 19, then silence; the off should land
            // `release` hops after the last voiced one.
            for h in 0..60usize {
                for (i, v) in hop.iter_mut().enumerate() {
                    let s = h * HOP + i;
                    *v = if h < 20 {
                        (s as f32 * 440.0 / rate * std::f32::consts::TAU).sin() * 0.3
                    } else {
                        0.0
                    };
                }
                events.clear();
                t.push_hop(&hop, &mut events);
                if off_at.is_none() && events.iter().any(|e| matches!(e, TrackerEvent::Off)) {
                    off_at = Some(h);
                }
            }
            assert_eq!(off_at, Some(19 + want_extra));
        }
    }

    #[test]
    fn bass_mode_tracks_low_a() {
        let rate = 48000.0f32;
        let log = run(
            rate,
            true,
            |t| {
                if t >= 2400 && t < 28800 {
                    (t as f32 * 55.0 / rate * std::f32::consts::TAU).sin() * 0.3
                } else {
                    0.0
                }
            },
            0.8,
        );
        assert_eq!(log, ["on33", "off"]);
    }
}
