# Round 2 — verdict

Captured from `4a8f3c5` (settings panel) at 1440x810, tier 2, 900k tracers.
Scored against `docs/CRITIQUE.md`. Default verdict is FAIL; below 8 fails.

| Shot | Score | Verdict |
|---|---|---|
| cosmos-wide | 4 | FAIL |
| cosmos-close | 3 | FAIL |
| system-wide | 6 | FAIL |
| planet-lit | 4 | FAIL |
| planet-crescent | 1 | FAIL |
| rings | 3 | FAIL |
| gasgiant | 5 | FAIL |

Nothing passed.

## Defects

### D1 — `planet-crescent` contains no planet (score 1)

The frame is starfield and one orbit line. `tris=80` confirms the body was never
submitted.

Cause: the shot drove the camera by writing `followOffset` directly after
calling `focus()`. `focus()` derives `yaw`/`pitch` from the offset *it* set, so
overwriting the offset afterwards moved the camera to the anti-sunward side
while it went on looking along the vector computed for the sunward side — about
100 degrees off. The subject left the frustum entirely.

Not a renderer defect. The realm exposed position and aim as independently
writable state when they are only meaningful together.

### D2 — hard horizontal seam across the ring plane (score 3, also hits gasgiant)

A straight, axis-aligned brightness step runs the full width of the ring sheet.
Ring band structure continues across it unbroken, so it is an overlay, not
geometry. Measured at **y=405 in an 810-tall frame — exactly the middle
scanline**.

Cause: `Rings.js` interpolated `vWorldDir = -(modelViewMatrix * position)`, a
**view-space** vector, and the fragment shader then used `V.y` as the component
along the ring's local +Y normal and compared it against `uSunLocal`, which is in
**ring-local** space. In view space `V.y` is "how far up the screen this fragment
is", so `lit = (V.y * uSunLocal.y) > 0.0` flipped at the screen midline, putting
the reflection branch on one half of the frame and the transmission branch on the
other.

The tell: `uCamLocal` was already computed correctly in `sync()`, declared in the
shader, and never read.

### D3 — cosmic web is per-tracer speckle at both distances (scores 4 and 3)

Named failure mode for both cosmos shots. A faint continuous wash with thousands
of discrete gold dots riding on top; at `cosmos-close` the medium collapses into
individually resolvable sprites, which is precisely what that shot exists to
catch.

Cause (established by ablation — rendering each layer alone): **not** the galaxy
layer, which contributes almost nothing. It is the tracer brightness law,
`(0.16 + pow(d, 1.55) * 0.62)`. Tracers carry equal mass, so density is already
expressed by how many land on a pixel; weighting each additionally by its own
local density counts the clustering twice and gives the top few per cent of
tracers ~34x the mean — enough to punch through flux normalisation as individual
points. The file's own header states the principle this violates: "the brightness
of a filament has to come from hundreds of faint overlaps, not from any one
tracer being loud."

### D4 — web reads as a ball floating in a void (contributes to cosmos-wide)

A distinctly rounded silhouette with black all around it. A spherical simulation
boundary is a visible box edge by another name.

Cause: horizon fade began at `rq = 0.62` of a box half-extent of 18, giving a
visible radius of ~11, viewed from a camera radius of 26 — i.e. the whole volume
seen from outside, fitting inside the frame with room to spare.

### D5 — `planet-lit` cannot test its own criterion (score 4)

Saturated magenta surface patches and a hot-pink line tracing the entire limb,
night side included.

Cause: the shot selected by `hasLife*3 + atmosphere + ocean*2` with no type
filter, and at seed 911 that picks `Valaeon-64`, an **EXOTIC** world whose palette
is `accent [0.90, 0.28, 0.62]` and `atmo [0.70, 0.24, 0.90]` — magenta and violet
by design. "Albedo plausible for the stated planet type" is untestable when the
stated type is deliberately alien. The shot was grading the renderer on a subject
that could not exercise the criterion.

### D6 — gas giant is single-hue (score 5)

Bands shear and carry fine detail, but the whole disc is one orange; the cream
`accent [0.94, 0.88, 0.74]` never appears, so zones and belts do not separate.

Cause: `PlanetBody.js:308` used `smoothstep(0.55, 0.10, bands)` — reversed edges,
undefined per the GLSL spec — to select the darker belts.

### D7 — `rings` and `gasgiant` framed the same body

At seed 1 both shots resolved to planet index 1, so two rubric lines were spent
on one picture at two zoom levels, and band structure was judged through a ring
plane crossing the disc.

## Audit

Sweeping all shader source for reversed-edge `smoothstep` (undefined per spec,
and the first entry in the standing failure list) found **16 GLSL call sites**
across 8 files, not one. Three further hits are JavaScript and are *not* bugs:
the helper in `core/Noise.js` computes `(x - e0) / (e1 - e0)`, whose negative
denominator flips the ramp correctly.

Verified against this renderer (ANGLE / SwiftShader / Vulkan) with a dedicated
test: reversed-edge `smoothstep` returns results **identical** to the corrected
form here. So D2 was *not* caused by it, and the 16 sites are latent portability
bugs rather than the source of any artefact in these frames. They were fixed
regardless — the spec makes no promise and the project has recorded them
breaking elsewhere.

## Harness defects found while running the round

- `screenshot.mjs` spawned `vite preview` via `npx` and killed only the wrapper,
  orphaning the server on port 4173 and failing every subsequent run with
  `Port 4173 is already in use`.
- `critique.mjs` checked only that `dist/` existed. A failed build left the old
  bundle in place and the round captured stale frames that did not correspond to
  the source being judged — which it did, silently, once during this round. A
  critic that reviews stale output is worse than no critic.
