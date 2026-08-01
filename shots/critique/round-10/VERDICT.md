# Round 10 — verdict

Round 6 of the critic loop, taking R13 through R15 from `round-9/VERDICT.md`.
Same rig: 1440x810, tier 2, 900k tracers.

| Shot | R2 | R6 | R7 | R8 | R9 | R10 | Verdict |
|---|---|---|---|---|---|---|---|
| cosmos-wide | 4 | 7 | 7 | 7 | 7 | 7 | FAIL |
| cosmos-close | 3 | 7 | 7 | 7 | 7 | 7 | FAIL |
| system-wide | 6 | 6 | 7 | 7 | 7 | 8 | PASS |
| planet-lit | 4 | 7 | 7 | 7 | 8 | 8 | PASS |
| planet-crescent | 1 | 8 | 8 | 8 | 8 | 8 | PASS |
| rings | 3 | 8 | 8 | 8 | 8 | 8 | PASS |
| gasgiant | 5 | 7 | 7 | 8 | 8 | 8 | PASS |

Five of seven pass. `system-wide` passes for the first time, having been the
worst frame in the set for four rounds.

## R13 — closed: planets outshine the star field

Four planets now read unambiguously, brighter and larger than any background
star, with the inner one sitting on its orbit ellipse.

The previous setting matched the sprite population's brightness range to the sky
field's, which sounds conservative and is the wrong way round. Seen from inside a
planetary system the planets are the brightest points in it after the star:
Venus reaches magnitude −4.9 and Jupiter −2.9 against Sirius at −1.5, a
difference of more than twenty in flux. Drawing a world dimmer than an arbitrary
background star was not caution, it was an error — and it is why eight of the ten
were lost in the field. The floor now sits at roughly the brightest star's level
and the inner giants sit well above it.

## R15 — closed: the stray ribbon is gone

Two guards, both against the same underlying problem.

The near-plane cull was comparing `w` against a token `1e-4` when the camera's
near plane is `0.02`. A vertex well inside the near plane therefore passed, and
its screen position — xy divided by a w of a thousandth — comes out
astronomically large, swamping the segment direction and leaving the
perpendicular pointing anywhere. The hardware clipped the vertex afterwards and
what survived was a long thin sliver hanging off the geometry. The threshold is
now the actual near distance.

Separately, a segment whose screen-space length exceeds several frame heights is
not a segment at all: with a fixed 192 samples around an ellipse, an orbit
passing near the camera puts adjacent samples arbitrarily far apart. Those are
dropped too.

## R14 — not fixed, and the obvious fix is ruled out

Collapsed cores still separate from the filaments in colour but not in luminance,
so a cluster reads as a differently-tinted piece of filament rather than as a
cluster.

The obvious remedy is a density-gated multiplier on per-tracer brightness. It was
tried twice — `smoothstep(4, 12) * 2.2`, then the much tighter
`smoothstep(9, 20) * 1.5` — and **both brought the round-2 speckle straight
back**, visibly, across the whole frame. Both were reverted.

The reason is worth stating because it rules out the whole approach rather than
just those two constants. The density here is the Zel'dovich Jacobian, which
every particle carries individually: it says how much that one mass element was
compressed, not how crowded its neighbourhood is on screen. A single tracer in an
ordinary sheet can hold a high value, and any multiplier keyed to it turns that
tracer into a hard dot. There is no threshold that separates "in a cluster" from
"individually dense", because the quantity does not carry that distinction.

Making nodes punch needs a different mechanism: find the clusters on the CPU,
where neighbours can actually be counted, and draw them as objects rather than
scaling whichever tracers happen to be inside them. That is a feature, not a
tuning pass, and it is left for a round that can take it on properly. A comment
in `CosmicWeb.js` records the two failed attempts so the next person does not
spend the same afternoon.

## Remaining defects

### R14 — cosmos nodes do not punch (carried, with the approach narrowed)

As above. Needs CPU-side cluster detection, not a shader multiplier.

### R16 — cosmos frames read slightly hazy at close range

`cosmos-close` holds together and the voids are dark, but the medium is softer
than `cosmos-wide` at the same settings — the splat kernel is doing more of the
work than the structure is. Worth checking whether the kernel width should scale
with how far inside the volume the camera has come.

### R17 — the ring inner edge shows faint dotted stair-stepping

Much reduced by the R15 guards but not gone: where the sheet passes closest to
the planet's limb there is still a dashed quality to the innermost annulus.
Likely the gap `clear` term aliasing at a grazing angle rather than anything to
do with the ribbons.
