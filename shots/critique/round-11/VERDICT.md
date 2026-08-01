# Round 11 — verdict

Round 7 of the critic loop, taking R14, R16 and R17 from `round-10/VERDICT.md`.
Same rig: 1440x810, tier 2, 900k tracers.

| Shot | R2 | R8 | R9 | R10 | R11 | Verdict |
|---|---|---|---|---|---|---|
| cosmos-wide | 4 | 7 | 7 | 7 | 8 | PASS |
| cosmos-close | 3 | 7 | 7 | 7 | 7 | FAIL |
| system-wide | 6 | 7 | 7 | 8 | 8 | PASS |
| planet-lit | 4 | 7 | 8 | 8 | 8 | PASS |
| planet-crescent | 1 | 8 | 8 | 8 | 8 | PASS |
| rings | 3 | 8 | 8 | 8 | 8 | PASS |
| gasgiant | 5 | 8 | 8 | 8 | 8 | PASS |

Six of seven pass. `cosmos-close` is the last failure.

## R14 — closed, using the discriminator the shader could not provide

Nodes now separate from the filaments in brightness as well as colour, with
visible bright knots at filament intersections.

Round 10 ruled out the obvious approach: scaling a tracer's output by its own
Zel'dovich density brought per-tracer speckle back at every threshold, because
that density describes one mass element's compression and says nothing about how
crowded its neighbourhood is. The quantity that *does* mean "many splats landed
here" is the accumulated HDR value at a pixel — and that is exactly what a bloom
threshold tests.

So the discrimination happens one stage later, in the post chain. A lone
high-density tracer cannot clear the threshold however compressed it is; a
genuine node, where hundreds overlap, clears it comfortably. The cosmos realm now
sets its own bloom on enter and restores the previous values on exit, because the
default is tuned for a system view where a star is the only thing meant to bloom
and a web filament peaks far below it.

Threshold and strength were swept live against the captured frame: below about
0.4 the filaments bloom along with the nodes and the whole field lifts; above
about 0.7 so little clears that extra strength cannot pay for it.

Measured effect at the wide camera: 99.5th percentile 59 → 68, top 0.05%
72 → 86, while the median moved 11.2 → 11.4. The bright end lifted and the void
floor did not, which is the shape of the change that was wanted and the one that
raising intensity could not produce.

## R16 — not a defect; the hypothesis was wrong

`cosmos-close` reads softer than `cosmos-wide` at identical settings, and the
suspicion was that the splat size cap (26px) was too generous — flying inside the
volume puts many splats at the cap at once, all the same width.

Dropping it to 16 made the frame **worse**, in precisely the way this file's own
header warns about: a kernel narrower than the mean interparticle spacing turns a
finite particle count into confetti, and the medium visibly began coming apart
into dots. Reverted to 26.

The close-range softness is the price of a kernel wide enough to stay continuous,
not a symptom of the cap being wrong. Recorded in the source so the next person
does not retry it.

## R17 — closed: the ring gap edges are antialiased

The innermost annuli no longer break into dashes where the sheet passes the
planet's limb.

Where the ring is seen at a grazing angle the normalised radius `t` changes by
more across one pixel than an entire gap is wide, so a fixed feather is sampled
far below its own frequency. The gap edges now widen by the local screen-space
derivative, which is standard analytic antialiasing and costs one builtin.

## Remaining defects

### R18 — `cosmos-close` still resolves individual tracers

The medium survives proximity — filaments are connected and voids are dark, so it
does not collapse the way round 2 did — but gold high-density tracers are still
individually countable, and that is the specific thing this shot exists to catch.
An ablation confirms these are tracers, not the galaxy layer: rendered alone, the
galaxies are black.

At 900k tracers this may be a particle-count floor rather than a tuning problem.
The honest next step is to measure what count makes the dots merge at radius 8
and decide whether that is affordable, rather than to keep adjusting the kernel —
which round 10 and this round have now both shown pulls the other way.

### R19 — faint dashed structure in the outer ring arcs

Reduced but not gone. The `fwidth` widening addresses the gap term; the outermost
arcs at a grazing angle still show some stepping, which is likely the optical
depth's own noise octaves rather than the gaps.

### R20 — the cosmos frames have no true white

Nothing in either frame exceeds 132/255. The nodes now punch relative to their
surroundings, which was the ask, but the whole image still lives in the lower
half of the range. Whether that is right is a deliberate call about the subject —
see round 9, where chasing peak luminance destroyed the voids — but it is worth
revisiting once the tracer count question above is settled.
