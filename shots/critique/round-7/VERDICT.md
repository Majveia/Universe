# Round 7 — verdict

Round 3 of the critic loop, taking the two top items from `round-6/VERDICT.md`.
Same rig: 1440x810, tier 2, 900k tracers.

| Shot | R2 | R6 | R7 | Verdict |
|---|---|---|---|---|
| cosmos-wide | 4 | 7 | 7 | FAIL |
| cosmos-close | 3 | 7 | 7 | FAIL |
| system-wide | 6 | 6 | 7 | FAIL |
| planet-lit | 4 | 7 | 7 | FAIL |
| planet-crescent | 1 | 8 | 8 | PASS |
| rings | 3 | 8 | 8 | PASS |
| gasgiant | 5 | 7 | 7 | FAIL |

Two shots still pass. `system-wide` moved for the first time in three rounds.

## R1 — closed: planets are visible

The system view now shows worlds. Two read unambiguously — an ice giant sitting
on the inner ellipse and a gas giant on the outer — and they read *because* they
sit on their orbit lines, which is the cue that separates a planet from the
30,000 background stars around it.

Three separate things were wrong, and only the first was the one named in
round 6:

1. **The cull was expressed in radians, not pixels.** `angular > 1.5e-4` is about
   a fifth of a pixel at this field of view, so bodies were "visible" in a sense
   that could not be seen — two planets passed the test and still rasterised to
   nothing, because a sphere smaller than a pixel either misses every sample
   point or catches one and flickers. The threshold is now a projected diameter
   in pixels, and everything below it is handed to a sprite pass.

2. **A power curve cannot compress nine orders of magnitude.** The first
   brightness model used `pow(raw / REF, 0.22)`; no exponent gentle enough to
   lift the outer worlds off the floor left the inner ones distinguishable, and
   eight of ten bodies clamped to the same value. Replaced with apparent
   magnitude — `-2.5 * log10(E / E_ref)` — which is the scale built for exactly
   this problem and holds the range in a span of about 23.

3. **Brightness was being multiplied by a dark base colour.** A basalt world came
   out dim twice over, once for being far away and once for being dark, when its
   albedo was already in the irradiance term. The sprite colour is now normalised
   to unit luminance so hue comes from the surface and brightness comes only from
   the magnitude.

A fourth issue was purely visual: the point-spread kernel was tight enough
(`exp(-r2 * 6.0)`) that a 5px sprite rendered as a 1.5px speck, so the size
computed from magnitude never reached the screen.

## R2 — closed: orbit furniture no longer dominates

The bundle of six near-parallel aliased wires across the upper third is gone.
Two changes:

- **Ribbons instead of hardware lines.** `THREE.Line` rasterises a one-pixel line
  with no coverage information, and `lineWidth` above 1 is a no-op on virtually
  every WebGL driver — so every near-horizontal orbit stair-stepped. Orbits are
  now two-triangle strips offset perpendicular to the segment *in screen space*,
  with alpha falling off across the width. That falloff is the antialiasing.

- **Fade an orbit once it stops fitting the frame.** An orbit whose angular
  radius exceeds the field of view is not an ellipse any more, it is a line
  crossing the screen carrying no information about where anything is. Six of
  those stacked is what made the furniture dominate rather than inform.

### Regression caught and fixed mid-round

The first ribbon implementation put a thick bright wedge across `planet-lit` and
`planet-crescent`. Screen-space offsets are divided back through `w`, so a
segment with an endpoint at or behind the eye — which happens on any close
approach, where the orbit ellipse passes the camera — turns a 1.6px ribbon into a
wedge spanning the frame. A hardware line clipped at the near plane is still one
pixel wide; a ribbon is not. Segments with an endpoint behind the near plane are
now culled in the vertex shader.

## Remaining defects

### R3 — gas giant has no resolvable vortex, no polar character (unchanged)

`giantColor` builds a Great-Spot anticyclone and a polar hood; neither reads at
this framing. Suspect the `step(0.0, dot(sp, uSpotDir))` hemisphere gate placing
the spot out of view, and a polar threshold that only bites where foreshortening
hides it. The rubric requires both.

### R4 — surfaces lack detail at three scales (unchanged)

`planet-lit` is a soft cloud deck over an indistinct surface. Terminator and limb
are good; this is specifically high-frequency surface detail surviving to the
visible mip.

### R5 — ring radial structure is flat (unchanged)

Optical depth barely varies with radius, so no B-ring/C-ring character and no
curved umbra in frame.

### R6 — the outer system is still invisible (new, narrower than R1)

Eight of ten planets sit on the magnitude floor and are lost among the sky stars.
This is arguably correct — a world at 75 AU genuinely is that faint — but it
means the frame reads as a two-planet system. Options are a larger floor, or
treating outer bodies as navigational marks rather than photometric ones. Worth
deciding deliberately rather than leaving to the clamp.

### R7 — the sky field is a uniform random scatter (new)

30,000 stars distributed with no clustering, no Milky Way band, no dark lanes.
Against the improved foreground it now reads as the least considered part of the
frame, and it is what the two cosmos shots already know how to do properly.
