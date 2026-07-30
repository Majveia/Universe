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
