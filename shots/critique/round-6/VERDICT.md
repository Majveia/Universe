# Round 6 — verdict

The state after the round-2 defects were fixed. Same rig: 1440x810, tier 2,
900k tracers. Rounds 3-5 were intermediate captures taken while confirming each
fix; round 6 is the first full set where every frame matches the final source.

| Shot | Round 2 | Round 6 | Verdict |
|---|---|---|---|
| cosmos-wide | 4 | 7 | FAIL |
| cosmos-close | 3 | 7 | FAIL |
| system-wide | 6 | 6 | FAIL |
| planet-lit | 4 | 7 | FAIL |
| planet-crescent | 1 | 8 | PASS |
| rings | 3 | 8 | PASS |
| gasgiant | 5 | 7 | FAIL |

Two frames pass. Five still fail, with named defects below — the bar is that a
frame passes only when a specific reason to fail cannot be found, and for these
five it can.

## What the fixes changed

- **planet-crescent** went from an empty frame to the shot it was written to be:
  a thin lit rind, a graded limb, the star off to one side, night side dark but
  not black, no stars through the body. Framing now belongs to the realm
  (`focus(index, 'crescent')`), which derives position and aim together so a
  caller cannot desync them.
- **rings** lost the midline seam entirely and gained a correctly open ring
  system that occludes the starfield. Two separate fixes: the view vector is now
  reconstructed in ring-local space from `uCamLocal`, and alpha is now extinction
  (`1 - exp(-tauV)`, premultiplied) rather than scattered radiance.
- **cosmos-wide / cosmos-close** are continuous media. The gold speckle is gone,
  filaments are connected, voids are genuinely empty, and the volume fills the
  frame instead of sitting in it as a ball.
- **planet-lit** is a plausible world under a sun-like star instead of a magenta
  exotic under a red dwarf.
- **gasgiant** separated into zones and belts once the reversed-edge smoothstep
  selecting the belts was corrected.

## Remaining defects

### R1 — `system-wide` has no visible planets (score 6, now the weakest frame)

Ten planets in the system and not one is resolvable; the frame is a star, a
starfield and orbit wires. Bodies are culled below ~1px of angular size, and at
system scale that is all of them, so the view is inert — it shows where planets
would be rather than that they are there.

Fix: a distant-body point-sprite pass with a brightness floor, so a planet below
a pixel still reads as an object rather than vanishing. This is the top item for
the next round.

### R2 — orbit furniture aliases and dominates

The outer ellipses collapse into a bundle of near-horizontal 1px wires across the
upper third, stair-stepping visibly at the frame edges. The rubric asks for orbit
furniture that is legible *without dominating*; at this camera it dominates.
Needs a screen-space-width line with distance fade, not raw `LineBasicMaterial`.

### R3 — gas giant has no resolvable vortex and undifferentiated poles

`giantColor` builds a Great-Spot anticyclone and a polar hood, but neither reads
at this framing: no oval sits in a shear zone, and the poles carry the same
banding as the tropics. The rubric requires both. Likely `uSpotSize` / the
`step(0.0, dot(sp, uSpotDir))` hemisphere gate placing the spot out of view, plus
a polar hood threshold (`abs(lat) > 0.62`) that only bites where foreshortening
hides it.

### R4 — planet surfaces lack detail at three scales

`planet-lit` reads as a soft cloud deck over an indistinct surface; the rubric
asks for structure at three scales and there is really one. The terminator
penumbra and the limb are both good now — this is specifically about
high-frequency surface detail surviving to the visible mip.

### R5 — both cosmos frames are still dim

Legible, and voids should stay near black, but the filaments sit low enough that
the frame reads underexposed rather than dark-by-intent. `uIntensity` was raised
from 7 to 10 during this round on the strength of the captures; it likely has
further to go, and should be set against a bloom-threshold reference rather than
by eye.

### R6 — ring radial structure is flat

Gaps read correctly as thin lines in a continuous sheet, and the sheet now
occludes. But optical depth barely varies with radius, so there is no B-ring/C-ring
character and no visible curved umbra where the planet's shadow crosses the
plane. The shadow-volume code is present and now correctly ordered; it needs a
subject and camera where the umbra actually falls in frame.
