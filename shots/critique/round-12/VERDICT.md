# Round 12 — verdict

Round 8 of the critic loop, taking R18, R19 and R20 from `round-11/VERDICT.md`.
Same rig: 1440x810, tier 2, 900k tracers.

| Shot | R2 | R9 | R10 | R11 | R12 | Verdict |
|---|---|---|---|---|---|---|
| cosmos-wide | 4 | 7 | 7 | 8 | 8 | PASS |
| cosmos-close | 3 | 7 | 7 | 7 | 7 | FAIL |
| system-wide | 6 | 7 | 8 | 8 | 8 | PASS |
| planet-lit | 4 | 8 | 8 | 8 | 8 | PASS |
| planet-crescent | 1 | 8 | 8 | 8 | 8 | PASS |
| rings | 3 | 8 | 8 | 8 | 8 | PASS |
| gasgiant | 5 | 8 | 8 | 8 | 8 | PASS |

Six of seven pass, unchanged. This round produced more measurements than score
movement, which is the honest result: two of the three items turned out to be
bounded by the approach rather than by a setting.

## R18 — measured, and closed as a poor trade

The round-11 verdict said the next step was to measure what particle count makes
the tracers merge, rather than keep adjusting the kernel. That measurement is now
done.

Granularity was quantified as mean |pixel − 3×3 mean| over lit pixels, divided by
mean brightness — the relative high-frequency energy, which is what "individually
countable dots" means numerically.

| particles | granularity | vs 900k | buffers |
|---|---|---|---|
| 300,000 | 0.157 | 1.63× | 8 MB |
| 900,000 | 0.096 | 1.00× | 24 MB |
| 1,800,000 | 0.069 | 0.72× | 48 MB |
| 3,000,000 | 0.050 | 0.52× | 80 MB |

The fit is **granularity ∝ N^−0.544**. There is no threshold where the dots
merge — it is a smooth asymptote, so "how many particles does this need" has no
answer, only a price. Halving granularity from where it is now takes **3.2M
particles and 80 MB of buffers**, and a frame-timing probe at those counts
exceeded a ten-minute budget on this software rasteriser without completing.

So the default stays at 900k. `cosmos-close` will not pass by adding particles;
it needs a different representation of the medium at close range, and that is a
design decision rather than a tuning one.

## R20 — closed with a ceiling found

Bloom strength was swept from 2.8 to 10 with the threshold held at 0.55:

| strength | median | p99.5 | max |
|---|---|---|---|
| 2.8 | 11.4 | 68.2 | 125 |
| 4.5 | 11.4 | 74.3 | 126 |
| 7.0 | 11.5 | 81.6 | 134 |
| 10.0 | 11.6 | 89.7 | 147 |

The void floor does not move at all — the median holds within 0.2 across a 3.6×
change in strength — which confirms the round-11 finding that a correctly set
threshold spends only on structure. Strength was therefore raised from 2.8 to
7.0, which is a real gain at literally no cost to the voids.

But nothing exceeds 147/255 even at 10, so **the frames cannot reach white this
way**. The medium's own radiance is too low for the tonemapper to carry it there,
and that is a property of the subject rather than a setting still to be found.
R20 is closed on those terms: the highlights are as bright as this approach
allows, and the earlier instinct to keep pushing was already shown in round 9 to
destroy the voids.

## R19 — partially closed, four hypotheses eliminated

Three genuine band-limiting fixes went in, all correct on their own terms:

- the three optical-depth noise octaves now fade as their wavelength drops below
  the pixel footprint, which is what a mipmap does for a texture;
- the resonance-gap edges widen by the local derivative (round 11);
- the density-wave ridge — the narrowest feature in the shader — fades once the
  footprint exceeds its width.

The dashed quality along the outer arcs is nonetheless **still present**, and
four candidate causes have been ruled out by direct test rather than argument:

1. **Geometry tessellation.** Raising `RingGeometry` segments from 256 to 1024
   (67k → 215k triangles) changed the artefact not at all. Reverted.
2. **The density-wave term.** Band-limiting it did not remove the dashes.
3. **The noise octaves.** Same.
4. **Bloom.** Disabling it entirely leaves the dashes unchanged, so it is not
   mip-chain beading on a thin bright line.

The red fringing alongside them is *not* a defect — it is the lens chromatic
aberration in the composite pass, which increases with radius by design.

What remains is most likely the `tau < 0.002` discard boundary flickering along
the arc where the envelope rolls off, but that was not confirmed and should not
be recorded as though it were. Four eliminations are worth more to the next
attempt than a fifth guess.

## Remaining defects

### R18 — `cosmos-close` resolves individual tracers (carried, now costed)

Not fixable by particle count at any affordable price; see above. Needs a
different close-range representation.

### R19 — dashed structure along the outer ring arcs (carried, narrowed)

Four causes eliminated. Next candidate is the discard threshold.

### R21 — the ring frame's brightest arcs clip to flat white

Visible at the top of the sheet where the A-ring analogue is most inclined: the
brightest annuli reach a uniform white with no structure inside them, which reads
as a blown highlight rather than as ice. Likely the same tonemapper roll-off that
bleaches saturated bright values, noted in `CosmicWeb.js` as a hazard for
tracers.
