# MidiVoice

Hum it instead of clicking it. Sing or beatbox a part, get MIDI notes, pick an
instrument, and keep layering while the song plays back.

Everything runs in the browser. No audio leaves your machine. There is no
server, no upload, and no account.

## Run it locally

**Windows:** double-click `Start MidiVoice.bat`. It installs dependencies the
first time, starts the server, and opens your browser. Keep that window open
while you work, because closing it shuts MidiVoice down.

**macOS / Linux:** run `./start-midivoice.sh` (once: `chmod +x start-midivoice.sh`).

Either way you can do it by hand instead:

```bash
npm install && npm run dev
```

The app is at http://localhost:5273. Click once anywhere to start the audio
engine, since browsers keep audio muted until you interact with the page.

Opening `index.html` directly will not work. The app is TypeScript that has to
be compiled on the fly, and the microphone needs a secure context, which
`file://` is not. The page will tell you so if you try.

## Put it on GitHub Pages

The app is fully static, and GitHub Pages serves over HTTPS, which is what the
microphone needs. Assets are built with relative paths, so it works from any
repo subpath without configuration.

```bash
git init -b main && git add -A && git commit -m "MidiVoice"
```

```bash
gh repo create midivoice --public --source=. --push
```

Then in the repo settings, open Pages and set the source to GitHub Actions. The
included workflow (`.github/workflows/deploy.yml`) builds and publishes on
every push to `main`. Your app lands at `https://<you>.github.io/midivoice/`.

Anyone who opens that URL gets their own private workspace. Projects autosave
to their browser's local storage, not to your repo.

## Using it

1. Set the tempo, then **Record**. You get a count-in, then sing.
2. Notes appear on the active track. If the timing drifted, open **Timing** and
   drag the nudge slider while the song plays. The whole take slides live.
3. Once the nudge is right, hit **Use this correction for future takes** and
   every later recording lands in the right place automatically.
4. Add a track, and record the next part against what you already have.
5. Pick instruments per track, tidy notes in the piano roll, export.

Wear headphones. Otherwise the mic records your backing track along with you.

Click anywhere on the ruler above the piano roll to play from that bar
(<kbd>Ctrl</kbd>-click parks the playhead without playing). Drag across the
ruler to highlight a section, then press **Loop** to play that section round
until you switch it off.

Instrument presets are level-matched to a measured 0.22 peak, so swapping an
instrument does not change how loud a part is.

## Recording latency

The gap between hearing a beat and the mic capturing your response is usually
20 to 150 ms depending on your hardware. Three ways to deal with it, in order
of effort:

- **Measure automatically** (Timing tab): plays six clicks through your
  speakers (headphones off), listens for them, and measures the true round trip.
- **Nudge a take by ear**, then promote that correction to the default.
- **Type an offset** in milliseconds directly.

## Input modes

| Mode | For | Notes |
| --- | --- | --- |
| Melody / harmony | Sung or hummed lines | Tracks from about C2 to D6 |
| Bass line | Low parts | Wider analysis window, tracks down to about 30 Hz |
| Beatbox | Percussion | Sorts hits into kick / snare / clap / hats |

Harmonies are just several melody takes on separate tracks. Record the line,
add a track, sing the third against it.

## Piano roll

| | |
| --- | --- |
| Double-click | Create or delete a note |
| Drag | Move selection (snaps to the grid) |
| Drag right edge | Extend / shorten |
| Drag empty space | Rubber-band select |
| <kbd>Alt</kbd> + drag | Draw a note at a length |
| <kbd>Space</kbd> | Play / pause |
| <kbd>R</kbd> | Record |
| <kbd>↑</kbd> <kbd>↓</kbd> | Transpose (<kbd>Shift</kbd> for octaves) |
| <kbd>←</kbd> <kbd>→</kbd> | Move by one grid step |
| <kbd>Ctrl</kbd>+<kbd>C</kbd>/<kbd>X</kbd>/<kbd>V</kbd>/<kbd>D</kbd> | Copy / cut / paste / duplicate |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> | Undo |
| <kbd>Q</kbd> / <kbd>L</kbd> | Quantise / close gaps |
| <kbd>Ctrl</kbd> + wheel | Zoom |

Snap resolutions include bars, 1/4, 1/8, 1/16, 1/32 and triplets (1/4T, 1/8T,
1/16T). Quantise strength below 100% moves notes partway to the grid, which
keeps the take feeling human.

## Tuning

Sung pitch is kept as a cents offset alongside the rounded note, so nothing is
thrown away at record time.

- **In key** forces the track's recorded notes into the project's key and
  scale. It is off until you turn it on, and it brings the Tune slider with it.
  The notes move on screen as well as in playback, and nothing is rewritten, so
  switching it off gives you back exactly what you sang. If the part was
  already in key the status line says so rather than leaving you guessing.
- **Tune 0%** plays back exactly as sung, drift and all.
- **Tune 100%** snaps to the exact note.

The gold line behind the notes is your actual pitch contour. If a note block
sits away from the line, the detector rounded to a semitone you did not mean.
Drag it, or lower **New-note sensitivity** in the Detection tab. The **∿**
button on a track hides that line when it gets in the way of the notes.

Every take's audio is kept for the session, so you can change detection
settings and **Re-detect** rather than singing it again.

## Export

- **MIDI**: standard `.mid` with General MIDI programs, opens in any DAW.
- **Save**: the full project as JSON, including takes and tuning.
- **WAV**: offline bounce of the arrangement. Slower than real time on long
  songs, and the button shows progress.
- **Save raw take audio** (Detection tab): the unprocessed vocal exactly as the
  mic heard it, before note detection. Worth keeping when a take is good, and
  it is the file to look at when detection gets something wrong.

Pitch bend is not exported, so a MIDI file carries the corrected notes rather
than your microtonal drift. The WAV bounce does keep it.

## How the note detection works

Melodic takes go through two detectors that split the job. Spotify's Basic
Pitch model (the neural network behind their public hum-to-MIDI demo) decides
where notes begin and end. Its learned onset detection hears the soft
re-articulations of sung repeated notes, and its note decoding was trained on
real voices, so vibrato and scoops stay inside one note. It runs on your
device through TensorFlow.js from about 1 MB of weights served with the app,
so the no-server rule holds. A YIN pitch tracker (de Cheveigné and Kawahara
2002) then measures each note's exact pitch, since the model only resolves
pitch to a third of a semitone and the tuning features need cents. If the
model cannot load, a classic segmenter built on the same YIN contour takes
over automatically, and you can also pick it by hand in the Detection tab.

The YIN difference function is computed through the FFT rather than the
textbook double loop, with two real transforms packed into one complex
transform. That is what makes a 20-second take process in about a second
instead of a minute. Analysis windows are centred and the loudness gate uses a
short window, so notes do not start a full window early. Breathy voices make
YIN occasionally grab a subharmonic, so frames more than 7 semitones off the
local register are pulled back when a shift of one or two octaves lands them
close.

The take's overall sharp or flat bias is measured first, and everything is
re-centred on it before any rounding. The audio the neural model hears is
pitch-shifted onto the semitone grid the same way. This step earns its place:
sit a quarter-tone sharp and every semitone boundary falls in the middle of a
note you sing, so the smallest wobble flips notes between chromatic
neighbours and shreds the melody into fragments.

The classic segmenter works on the continuous pitch contour with hysteresis. A
deviation has to hold for about 40 ms to start a new note, so vibrato and the
scoop into a note stay part of it. Fragments too short to be real notes are
absorbed into whichever neighbour is closest in pitch, spectral-flux onsets
split repeated notes sung on one pitch, and slides are rejected by their
motion rather than their length, so a portamento does not arrive as a
staircase of chromatic steps. Ornaments and vibrato are the same size to a
pitch tracker, so they are told apart by dwell: vibrato sweeps through its
extreme and comes straight back, while a trill note sits at its new pitch.

Drum takes skip pitch tracking entirely. Spectral-flux onsets are classified
into kick, snare, clap and hats by their balance of low, mid and high energy
and their decay time.

## The Detail dial

One control in the **Detection** tab, and the one worth reaching for. It moves
the detection thresholds together (pitch split, minimum note length and attack
sensitivity, with matching thresholds on the neural side), because they only
make sense moved together. Release it and the selected take is detected again
immediately, so you can hear the difference rather than guess.

The default sits deliberately calm. A 43 ms analysis window measures a
semitone trill at only about 65 cents, so catching ornaments requires a
threshold low enough to also split ordinary singing into extra notes. That
trade is real and cannot be tuned away, which is why it is a dial: push it up
for ornamented passages, leave it down for plain ones.

Note length stays short at both ends of the dial, because raising the minimum
deletes ornaments outright rather than smoothing them. The smooth end works by
demanding a bigger pitch move instead.

If short notes go missing, push Detail up. A brief note is measured as a
smaller pitch move than it was sung (a real semitone step in a 90 ms note
reads as about 0.6 of one), so quick grace notes only clear the threshold near
the top of the range. The dial is set per take, so an ornamented phrase can
run hotter than the rest of the song without making everything else jittery.

## Redoing part of a take

Drag across the ruler above the piano roll to select a range (<kbd>Esc</kbd>
clears it). Set Detail for that passage, then press **Re-detect selected
range** in the Detection tab.

Only notes that start inside the range are replaced, so the rest of the take
is left exactly as it was. The audio slice sent to the detector is padded past
both edges to give it context there, since without padding the first and last
notes of every range would come out mangled. The padding cannot leak extra
notes back in, because of the start-inside-the-range rule.

This is the answer to a take that needs two different settings: run the
ornamented bars hot and leave the rest calm.

## Joining notes

Select two or more notes and press <kbd>J</kbd>, or **Join notes** in the
Notes tab. They become one note spanning all of them, at the pitch of the
longest, which is the one the ear already hears as the note. This is the fix
when a held note comes back split into pieces.

## Fixing timing after the fact

In the **Timing** tab, with a take selected:

- **Nudge** slides the whole take. Use it when you came in late or early.
- **Bars** stretches the take about its start, for when you drifted ahead of
  or behind the click over its length. The readout shows the tempo you
  actually sang at.
- **Fit take to grid** searches stretch and shift together for the combination
  that best lands your notes on the current snap value, and tells you the
  tempo it found.
- **Re-grid to \_\_ bpm** moves the bar lines under the whole song without
  moving any note in real time, for when the click was wrong. The tempo box in
  the top bar does the opposite: it makes the song play faster or slower.

## Limitations

- **One note at a time.** Sing chords as separate takes. A strummed guitar or
  a played chord will not come apart into notes.
- **Very wide vibrato** (beyond about 50 cents each way) starts to look like a
  trill and can split into extra notes. Raise **New-note sensitivity** if that
  happens. At that depth the two are genuinely ambiguous from pitch alone.
- Take audio is session-only. Notes survive a reload, the raw audio does not,
  so Re-detect stops working after a refresh.
- Note detection runs on the main thread, so a very long take briefly freezes
  the UI while it processes.
- The neural detector fetches its model files once (about 1 MB, served with
  the app). If they cannot load, the classic detector takes over automatically
  and the status line says so.
- Instruments are synthesised on the fly. They load instantly and stay light,
  and they sound like clean synthesis rather than sampled orchestral
  libraries.
