# Round 11 — verdict

Round 7 of the critic loop, taking R14, R16 and R17 from `round-10/VERDICT.md`.
Same rig: 1440x810, tier 2, 900k tracers.

| Shot | R2 | R6 | R7 | R8 | R9 | R10 | R11 | Verdict |
|---|---|---|---|---|---|---|---|---|
| cosmos-wide | 4 | 7 | 7 | 7 | 7 | 7 | 8 | PASS |
| cosmos-close | 3 | 7 | 7 | 7 | 7 | 7 | 7 | FAIL |
| system-wide | 6 | 6 | 7 | 7 | 7 | 8 | 8 | PASS |
| planet-lit | 4 | 7 | 7 | 7 | 8 | 8 | 8 | PASS |
| planet-crescent | 1 | 8 | 8 | 8 | 8 | 8 | 8 | PASS |
| rings | 3 | 8 | 8 | 8 | 8 | 8 | 8 | PASS |
| gasgiant | 5 | 7 | 7 | 8 | 8 | 8 | 8 | PASS |

Six of seven pass. `cosmos-wide` passes for the first time in the project's
history, on the back of R14. `cosmos-close` is the last failing frame.

**A caveat on the comparison.** The frames are gitignored and this round ran on
a fresh clone, so round 10's images were not on disk and the two rounds could
not be put side by side. Scores for the five unchanged shots are carried
forward on the basis that nothing touching them changed; only the cosmos frames
and `rings` were re-judged from scratch. This is weaker evidence than the
rubric asks for and is worth fixing — either keep one reference round in the
repo or re-capture the previous commit before grading.

## R14 — closed: the nodes punch

Collapsed cores now read as clusters. They are compact, gold, sit at points
where filaments converge, and are separated from the medium in luminance rather
than only in tint — which was the whole complaint.

Round 10 ruled out the shader-side fix and said what was needed instead: count
neighbours where neighbours exist, on the CPU, and draw the result as an object.
That is what happened, in three pieces.

**The field had to be portable first.** The web is drawn from a Zel'dovich
displacement evaluated in GLSL. Analysing it on the CPU means evaluating the
same field there, and "the same" turns out to be a strong requirement: the
existing CPU mirror in `tools/probe-web.mjs` uses `core/Noise.js`, a seeded
permutation-table simplex, while the shader uses the seedless Ashima/McEwan
polynomial one. Both are unit-scale simplex noise and the probe says so, which
was fine for what the probe does — sweep an amplitude, read a contrast ratio,
both statistical. It would have been silently useless here, because the two
fields have their peaks in entirely different places and every cluster would
have landed in a void with nothing about the code looking wrong.

So `src/cosmos/ZeldovichField.js` now owns the field in both languages, and
`tools/verify-field.mjs` compiles the real shader chunk, evaluates it at 128
points across the volume, reads the values back as floats and compares. It
earned its keep on the first run.

**The port was wrong, and float32 was why.** The GLSL writes `1/7` as the
truncated literal `0.142857142857`, which rounds slightly BELOW one seventh in
float64 and slightly ABOVE it in float32. The next line takes `floor(j * n_)` to
split a hash into a gradient index, so at `j = 35` the GPU floors 5.0000002 to 5
and an honest float64 transliteration floors 4.999999999995 to 4. Every gradient
after that point is a different one. The symptom was snoise returning a range of
about ±4 where simplex noise lives in ±1 — obvious once measured, invisible from
reading the code, and impossible to catch by eye in a rendered frame. Rounding
the discrete-decision path to float32 with `Math.fround` closes it: the two now
agree to about 1e-5 of each channel's range, two orders inside the gate.

**Then the clusters.** `tools/bake-clusters.mjs` displaces 0.88M mass elements,
bins them in Eulerian space, and takes local maxima of the cell occupancy —
which is real crowding, the quantity the shader cannot compute per-vertex. It
finds 51 candidates at a contrast of 35x peak-to-median.

What is stored is a Lagrangian anchor, not a position, so the vertex shader
re-displaces it at the live growth factor and the sprite tracks its node as the
web keeps evolving. The first version stored the members' Lagrangian centroid
and argued that psi is near zero at a collapse centre because the potential is
extremal there. Measured, that was off by 0.46 units on average and 1.18 at
worst against a mean core radius of 0.67 — the argument ignored that a
collapsing region also moves bodily toward the node, so its pre-image carries
the bulk flow as well as the convergence. Solving `q + D*psi(q) = target`
directly by damped fixed point fixes it: 49 of 51 converge to within 0.02 units.
The two that do not are dropped rather than drawn a core radius off-node.

The sprite is a beta model, `(1 + (r/rc)^2)^(-3/2)`, which is the profile real
clusters have and matters because a Gaussian reads as a soft dot pasted on the
frame while this one grades into the filament around it.

**One bug worth recording.** The first working version put the brightness into
both the colour and the alpha under `THREE.AdditiveBlending`, which is
SrcAlpha/One — so emitted light went as level *squared*, and a factor of eight
in the uniform became a factor of sixty in the frame. That is why the layer went
from invisible at one setting to blown out at the next with nothing usable
between. It also squared the profile, quietly turning the beta model's -3/2
exponent into -3 and discarding the heavy wings that were the reason for
choosing it. Premultiplied colour with One/One blending fixes both.

## R16 — not fixed, and the obvious approach is now ruled out

`cosmos-close` still reads granular, and the medium still carries more kernel
than structure. Two attempts, both reverted, both recorded in `WEB_VERT`.

The first came from a real measurement: the tracer size cap engages at 11 units,
so from inside the volume most of what fills the frame is drawn smaller than its
world footprint — at 2 units a tracer covers 3% of it while still emitting all
its light, which is thirty times the per-pixel value, as a hard dot. Normalising
flux by the wanted size rather than the drawn size corrects the per-pixel level,
but it does so by removing the light rather than spreading it. The medium lost
most of its brightness and the galaxy layer, unchanged, was left dominating a
dimmer background. Worse, and worse in the way the round was trying to fix.

The second was to raise the cap so no coverage is lost. Captured at 26 and at 64
with nothing else changed, the two frames are the same picture: median 8, p99 49,
p99.5 58 in both, and the void fraction slightly worse at 64 (30.9% against
32.6%).

That null result is the useful part, and it retires round 10's hypothesis that
the kernel width should scale with camera depth. Flux conservation is precisely
the guarantee that spreading a fixed amount of light over more pixels leaves the
integrated image alone — so kernel width under a conserved flux is close to a
no-op, and no amount of tuning it will change how the medium reads. Whatever
R16 is, it is not the kernel width, and the next attempt should not start there.

The likeliest remaining explanation is simply sampling density: at close range
the same 900k tracers cover a much smaller volume, so fewer overlap per pixel
and the medium is genuinely undersampled. If that is right, the fix is not a
kernel parameter but either more tracers at close range or an analytic term that
takes over as the discrete sampling thins out.

## R17 — improved, not closed

The dashed quality along the ring's inner edge is reduced but still visible on
the far arc, where the sheet passes closest to the planet's limb.

The cause identified in round 10 was correct as far as it went. At a grazing
angle the whole radial coordinate compresses into a few pixels, so one pixel
spans several periods of the fine banding, and sampling a periodic function once
per period returns an arbitrary point on it. `Rings.js` now band-limits each
banding octave against `fwidth(t)` and widens the gap feather to at least a
pixel, which is the correct anti-aliasing fix and does help.

It is not the whole story, since the speckle survives. The banding octaves are
now provably gone at that footprint, so the remaining artefact has to come from
something else — the radial envelope, the `tau < 0.002` discard cutting fragments
on and off between adjacent pixels, or the mesh tessellation itself showing at
grazing incidence. The discard is the cheapest to test and the easiest to
believe: a hard threshold on a quantity that varies fast across a pixel is
exactly how a continuous sheet turns into dots.

## New tooling

- `tools/verify-field.mjs` — gates the CPU port of the field against the shader.
  Anything that analyses the web on the CPU depends on this passing.
- `tools/bake-clusters.mjs` — finds the nodes offline and writes
  `src/cosmos/clusters.generated.js`. Re-run it if the box size or either field
  parameter changes; `CosmicWeb` checks the recorded configuration and skips the
  layer rather than drawing clusters in the wrong places.
- `tools/frame-stats.mjs` — luminance percentiles, void fraction and a bleached
  fraction for a captured frame. Verdicts have been quoting numbers like "the
  99.5th sits at 45/255" since round 6 with nothing computing them; this does.
  It also corrected a wrong call this round — the cluster layer looked bleached
  by eye at one setting and measured zero bleached pixels, which moved the
  diagnosis from exposure to sprite shape.

## Remaining defects

### R16 — cosmos-close is undersampled at close range (carried, narrowed)

As above. Not the kernel width. Probably tracer count per unit solid angle.

### R17 — ring inner edge still speckles at grazing incidence (carried, narrowed)

As above. Band-limiting the noise was necessary and insufficient. Suspect the
`tau < 0.002` discard next.

### R18 — the round could not be compared against its predecessor

Frames are gitignored, so a fresh clone cannot put round N next to round N-1,
which is exactly what the rubric asks a reviewer to do. Five of this round's
seven scores are carried forward on an argument rather than a comparison. Either
keep one reference round in the repo, or have the harness re-capture the
previous commit alongside the current one.
