# The critic rubric

This is the standard every frame in `shots/critique/` gets held to. It exists
because "looks good" is not a claim anyone can check, and because the failure
modes of procedural rendering are specific and repeatable enough to be named
in advance.

**Be harsh.** The default verdict is FAIL. A frame passes only when a specific
reason to fail cannot be found. Grading generously here costs nothing today and
costs everything at the end, when the whole thing looks like a tech demo and
nobody can say which decision made it one.

## How to run a round

```bash
node tools/critique.mjs --out shots/critique/round-N
```

The harness builds for itself and refuses to run if the build fails, because a
round captured against a stale `dist/` reviews code that is not the code on disk.
Pass `--no-build` only when you have just built by hand.

Then look at every frame. Not a sample — every frame. Write the verdict into
`shots/critique/round-N/VERDICT.md` with a line per shot, and keep the previous
round on disk so the two can be compared directly. The frames are gitignored;
the `VERDICT.md` files are not, so the findings survive the machine that made
them.

Before blaming a shader, check that the shot is testing what it claims to. A
criterion is only exercised if the subject can exercise it: judging "albedo
plausible for the stated type" on an EXOTIC world, or band structure through a
ring plane crossing the disc, grades the renderer on a frame that was never
capable of passing. Seeds in `tools/critique.mjs` are chosen for this and each
carries a note saying what it was chosen for.

And prefer an ablation to an argument. Rendering one layer at a time settles in
a minute what a plausible-sounding causal story can get wrong for an hour — in
round 2 the speckle was confidently attributed to the galaxy layer, and turning
that layer off changed the frame not at all.

## Scoring

Each shot is scored 1–10 against the reference bar. Anything below 8 is a FAIL
and must produce a concrete, actionable defect, not an adjective.

| Score | Meaning |
|---|---|
| 10 | Indistinguishable from a shipped AAA frame of the same subject |
| 9 | Shipped quality; one small refinement away |
| 8 | Convincing; would survive a trailer at speed but not a still |
| 6–7 | Reads correctly but obviously real-time-procedural |
| 4–5 | Recognisable as the intended subject, clearly unfinished |
| 1–3 | Broken, or reads as noise |

A defect is only useful if it names the cause. "The planet looks flat" is not
a defect. "The terminator falls off over ~2px because the surface uses raw
N·L with no wrap term, so there is no penumbra" is.

## Reference bar, per shot

The comparison targets are the games and imagery this project is explicitly
aiming at. Judge against what those actually do, not against a memory of them
being impressive.

- **cosmos-wide** — SDSS/Millennium survey renders, *Cosmos: Possible Worlds*.
  Filaments must be *connected*, voids must be genuinely empty, nodes must sit
  at filament intersections. Failure modes: uniform fog; visible simulation-box
  edges; per-tracer speckle instead of a continuous medium; banding in the
  near-black.
- **cosmos-close** — the medium has to survive proximity. Failure mode: the
  illusion collapses into individually resolvable sprites.
- **system-wide** — *No Man's Sky* / *Elite Dangerous* system views. Scale must
  feel vast, the star must bloom like a light source rather than a white disc,
  orbit furniture must be legible without dominating.
- **planet-lit** — *Starfield* orbital views, ISS photography. Surface needs
  detail at three scales; the terminator needs a real penumbra; albedo must be
  plausible for the stated planet type. Failure modes: noise-textured ball;
  hard terminator; colours that no rock produces.
- **planet-crescent** — Apollo/Cassini crescent imagery. The atmospheric limb
  is the subject: it should be a graded band, orange at the terminator and
  blue at altitude, not a uniform outline. Night side must not be pure black,
  and stars must not shine through the body.
- **rings** — Cassini. Optical depth must invert between the lit and unlit
  faces, the umbra must be a curved shadow volume, gaps must be thin lines in
  a continuous sheet rather than concentric wires.
- **gasgiant** — Juno imagery of Jupiter. Bands must shear against each other,
  vortices must sit in the shear zones, and the poles must differ in character
  from the equator.

## Standing failure list

Defects found in earlier rounds, kept here so they are not rediscovered:

- Reversed-edge `smoothstep` is undefined in GLSL. Always order the edges and
  negate the argument, or write `1.0 - smoothstep(lo, hi, x)`. Note that the
  JavaScript helper in `core/Noise.js` *does* handle reversed edges correctly —
  its denominator goes negative and flips the ramp — so JS call sites are fine
  and only GLSL ones need fixing. Worth measuring before blaming: on ANGLE /
  SwiftShader the reversed form returns results identical to the corrected one,
  so it can sit latent for a long time and then break on a driver that folds it
  differently. Sweep for it with a script; round 2 found sixteen GLSL sites when
  the list implied one.

- A vector is only meaningful with the space it lives in. `-(modelViewMatrix *
  position)` is a **view-space** view direction; comparing its `.y` against a
  quantity computed in object-local space silently reinterprets "distance above
  the plane" as "height up the screen", and the discontinuity lands on the middle
  scanline. If a hard artefact sits at exactly half the frame height or width,
  suspect a space mismatch before suspecting geometry.

- Coverage and radiance are different quantities. For a participating medium,
  alpha is extinction along the view path (`1 - exp(-tau)`) and rgb is the light
  scattered toward the eye; driving alpha from the radiance makes a dimly-lit
  volume transparent, so stars read straight through a sheet several optical
  depths thick. Premultiplied alpha lets the shader emit the two independently.

- With equal-mass tracers, density is already encoded in how many land on a
  pixel. Multiplying each tracer by its own local density on top of that counts
  the clustering twice and lets the densest few per cent punch through as
  individual points — the medium is sampled correctly and then buried under its
  own brightest samples. Keep any per-tracer density exponent below one and let
  overlap carry the structure.

- Position and aim are one quantity. Any camera API that lets a caller move the
  viewpoint without re-deriving the look direction will eventually be called that
  way, and the subject leaves the frame. A near-empty `tris` count in the capture
  log is the cheapest possible detector for it.

- Rings lit edge-on are *correctly* almost invisible: single-scattering
  reflectance carries a `mu0/(mu + mu0)` factor, and Saturn all but disappears at
  equinox. If a ring shot looks empty, check the star's elevation above the ring
  plane before touching the shader.

- Express cull thresholds in projected pixels, never in radians or world units.
  A threshold of `1.5e-4` radians sounds conservative and is a fifth of a pixel
  at a 70-degree field of view, so bodies passed the test, entered the draw list,
  cost a full shader, and could not be seen. If "visible" does not mean "can be
  seen", the flag is lying. Anything below roughly two pixels needs a different
  representation, not a smaller triangle.

- A power curve cannot compress a range spanning many orders of magnitude while
  keeping the ordering readable. One system spans about nine orders in irradiance
  and no exponent gentle enough to lift the faint end off the floor leaves the
  bright end distinguishable — most of the population clamps to one value. Use a
  logarithm: apparent magnitude, `-2.5 * log10(E / E_ref)`, exists for precisely
  this and holds nine orders in a span of about 23.

- When one colour carries both hue and brightness, separate them. Multiplying a
  computed brightness by a dark base colour dims a dark object twice over — once
  for the physical reason already in the brightness term, once again for its
  albedo. Normalise the tint to unit luminance and let the magnitude carry level.

- Screen-space ribbon lines must cull segments with an endpoint at or behind the
  near plane. The perpendicular offset is divided back through `w`, so a `w` near
  zero turns a 1.6px ribbon into a wedge across the entire frame. This does not
  show up in wide shots and appears the moment the camera approaches anything the
  line passes near. A hardware line clipped at the near plane stays one pixel
  wide, which is why swapping `THREE.Line` for a strip needs this guard added at
  the same time.

- Navigational furniture should fade when it stops carrying information. An orbit
  whose angular radius exceeds the field of view is no longer an ellipse, just a
  line across the screen; several of those stack into a bundle that dominates the
  frame while telling the viewer nothing.

- Worley `F2 - F1` draws cell *boundaries* and gives hard polygons — cracked mud,
  crazed glaze, a Voronoi diagram. For round blobs (cyclones, craters, colonies,
  anything organic) use a falloff on the F1 *distance* instead. Reaching for the
  edge function by habit is the single fastest way to make a natural surface look
  manufactured.

- A feature can be geometrically correct and still never reach the eye.
  Foreshortening crushes everything above about 55 degrees of latitude into the
  last few pixels of the rim, so a polar effect defined to start there is
  invisible from any equatorial vantage. Check where a feature lands *on screen*,
  not where it lands on the sphere — and if the shot cannot see the thing the
  rubric asks about, move the camera.

- Detail gated behind a type-specific parameter is absent on every other type.
  The third scale of terrain relief sat behind a dune strength that is zero on
  anything but a desert, so temperate worlds had continental and orogenic
  structure and then nothing at all. If the rubric asks for three scales, one of
  them cannot be optional.

- Finite-difference normals impose a frequency ceiling. With epsilon `e`, detail
  above roughly `1/(4e)` aliases into sparkle instead of resolving into surface.
  Put the highest-frequency variation in albedo, which is never differentiated
  and therefore costs nothing to sample finely.

- A clamp is not a decision. When a floor ends up doing the work for most of the
  population, the range mapping has already failed and the clamp is hiding it —
  and whatever it clamps to is a value nobody chose. Either fix the mapping or
  make the floor an explicit, stated choice with a reason.

- Before changing a shader to make something visible, check whether the subject
  can show it at all. A ring umbra reaches `1/sin(sun elevation)` planet radii;
  against an inner ring edge at 1.35 radii, any elevation above about 48 degrees
  puts the shadow entirely inside the hole. Two rubric criteria pulling opposite
  ways — bright rings want high elevation, a visible shadow wants low — is a sign
  to change the subject, not to compromise the angle.

- Backticks inside a `/* glsl */` template literal terminate the shader string
  and produce a JavaScript syntax error somewhere unrelated-looking. Do not
  quote identifiers in shader comments. This has cost four build failures, and
  `tools/lint-shaders.mjs` now parse-checks every file before a round captures.

- A green build does not mean the tree is sound. The bundler only parses what is
  reachable from the entry point, so a syntax error in an unreferenced file never
  surfaces — `Nebula.js` carried one for four rounds. Walk the import graph
  occasionally: 27 of 45 files here turned out never to run at all.

- Check the sense of a derived parameter, not just its range. An ice-cap latitude
  computed as `1.06 - smoothstep(190, 330, T) * 1.25` stays inside its clamp for
  every input and is monotonic the wrong way — hot worlds got global ice, frozen
  ones got none. Anchor such a formula on two known cases (Earth at 288 K, a
  snowball at 250 K) and check both, because a plausible-looking expression with
  an inverted slope produces plausible-looking numbers.

- A uniform is one quantity. Using a latitude threshold as an opacity multiplier
  — `cap * uIceCap * 3.0` — type-checks, runs, and is meaningless. If a name says
  where, it cannot also mean how much.

- Exposure is not contrast, and a metric is not a criterion. Raising overall
  intensity lifts the per-tracer floor along with the structure, so a frame with
  a low peak gets brighter without getting better and eventually loses the empty
  space the rubric actually asks for. Before optimising a number, check the
  rubric asks for that number: "peak luminance is low" is expected when the
  camera is inside a translucent medium.

- When a camera move fixes one rubric line, check it has not broken another.
  Crossing to the anti-sunward side of a ring system reveals the shadow and
  simultaneously puts the camera on the unlit face, where the dense annuli
  correctly go black and the sheet collapses into the concentric wires the same
  rubric fails the shot for.

- Matching a new population's brightness to an existing one is not the safe
  choice — it is a claim about which should dominate, and it can be flatly
  wrong. Planets were drawn to overlap the sky field's range, when from inside a
  system the planets are the brightest things in it after the star: Venus at
  −4.9 against Sirius at −1.5 is more than twenty in flux. Ask what the real sky
  does before deciding two populations should look comparable.

- Clip and cull thresholds must use the real near plane, not a token epsilon.
  Testing `w <= 1e-4` against a near plane of `0.02` lets vertices well inside it
  through; their screen position is xy over a thousandth, which swamps any
  direction computed from it, and the hardware clips them afterwards leaving a
  sliver. Compare against the actual value and pass it in as a uniform.

- A curve sampled at a fixed count undersamples when the camera comes close.
  192 samples around an orbit are ample from outside and arbitrarily far apart on
  screen from within it, so guard on projected segment length — anything spanning
  several frame heights is not part of a curve any more.

- A per-particle quantity is not a measure of local crowding, and no threshold
  makes it one. Boosting tracer brightness by the Zel'dovich density to make
  cluster cores read brings back per-tracer speckle at every gate setting,
  because that density describes how much one mass element was compressed, not
  how many neighbours it has on screen. If the goal is "this region should look
  like a cluster", the count has to happen somewhere neighbours exist — on the
  CPU — and the cluster drawn as an object.
- Additive blending integrates the full depth of a volume, which averages
  independent structures together and cancels them. Depth extinction is what
  restores a legible slab.
- A splat kernel narrower than the mean interparticle spacing turns any finite
  particle count into confetti, no matter how many particles there are.
- Background star fields must depth-test, or stars shine through planets.
- Raw inverse-square flux spans four orders of magnitude within one system and
  renders outer worlds pure black. Compress it the way a camera exposes.
- Unit-radius geometry needs the body's physical radius in its holder scale;
  forgetting it renders everything at ~1e-7 of its size.

- A CPU mirror of a GPU field must be the *same* function, not a similar one.
  Two implementations of "simplex noise" agree on every statistic and disagree
  about where every peak is, so a mirror is fine for sweeping an amplitude and
  useless for saying "there is a node here" and having the GPU draw one there.
  `probe-web.mjs` says it is not bit-identical and was right to; anything doing
  geometry rather than statistics needs `ZeldovichField.js` and the
  `verify-field.mjs` gate.

- A float literal can round in opposite directions in float32 and float64, and
  when a `floor` follows it that is a logic difference, not a precision one. The
  GLSL simplex writes `1/7` as `0.142857142857`, which is below one seventh in
  double and above it in float — so `floor(35 * n_)` is 4 on the CPU and 5 on the
  GPU, every gradient after it differs, and the noise comes back with a range of
  ±4 instead of ±1. Port the discrete-decision path through `Math.fround`. This
  class of bug is invisible in code review and obvious in one comparison, which
  is the argument for having the comparison.

- `THREE.AdditiveBlending` is SrcAlpha/One, so it multiplies the emitted colour
  by alpha. Writing `vec4(col * level, level)` therefore emits level SQUARED: a
  factor of eight in a uniform becomes a factor of sixty in the frame, and a
  layer goes from invisible to blown out with no usable setting between. It also
  squares whatever shape is in the alpha, so a carefully chosen profile silently
  becomes its own square. Use premultiplied colour with One/One blending when
  coverage and radiance need to stay independent.

- Kernel width under conserved flux is close to a no-op. Flux conservation is
  exactly the statement that spreading a fixed amount of light over more pixels
  leaves the integrated image unchanged, so tuning a splat's size while
  normalising by that size cannot change how a medium reads — measured at 26px
  and 64px, the frames matched to within a percentile point. If a medium looks
  wrong, suspect the sampling density or the flux level, not the kernel.

- Prefer a gate relative to the measured range over an absolute epsilon. A
  per-channel tolerance has to be picked, and then widened whenever it trips,
  which turns it into a record of what the code does rather than a check on it.
  Quantities that differ by five orders of magnitude cannot share one epsilon,
  and four hand-tuned ones are four places to hide a defect. Float32 rounding
  lands near 1e-5 of range and a logic divergence near 1e0, so a gate at 1e-3
  needs no tuning and has two orders of margin either side.

- Measure before diagnosing, including when the frame looks obvious. The cluster
  layer read as bleached white by eye and measured zero pixels above 200/255 —
  the defect was the sprite's shape, not its exposure, and the two call for
  opposite fixes. `tools/frame-stats.mjs` exists for this.
