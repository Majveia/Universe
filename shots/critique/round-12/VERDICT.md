# Round 12 — verdict

The first round to look at the ground. Three new shots, three failures, and the
causes are specific enough to fix rather than adjectives.

Rig: 1440x810, tier 2, 900k tracers. The seven space shots are unchanged since
round 11 and were not re-captured — nothing landed between the rounds that
touches them (the diff is a new realm, the player, and touch controls). That is
still weaker evidence than the rubric wants and is the same complaint round 11
logged as R18.

| Shot | R12 | Verdict |
|---|---|---|
| surface-ground | 4 | FAIL |
| surface-relief | 3 | FAIL |
| surface-sun | 4 | FAIL |

Not a surprise and not a disappointment: this subsystem has existed for two
commits and has never been graded. The point of the round is the defect list.

## What the frames actually show

All three are the same picture with the camera turned: a flat pale-sage wash
from the bottom of the frame to a stepped horizon, under a blue gradient. It
reads unmistakably as ground and sky, and there is nothing on it. The numbers
agree — median luma 81 to 99 with p99 at 132 to 137, so the entire landscape
occupies about a fifth of the range and has no tonal structure at all.

## R19 — the terrain shader ignores every detail parameter Biomes provides

This is the big one and it accounts for most of what is wrong with all three
frames.

`Biomes.layerUniformArrays()` returns seven arrays per layer: `color`,
`emissive`, `rough`, `macro`, `micro`, `bump`, `sparkle`. The terrain fragment
shader consumes exactly two of them. `uRough` is uploaded and never read;
`macro`, `micro`, `bump` and `sparkle` are not even uploaded. So a fragment's
albedo is a blend of four flat colours weighted by the splat, and there is no
variation at any spatial scale whatsoever — which is precisely why the ground
has no near detail, no mid detail, and no texture at the horizon.

The mechanism was already there and already named. The standing failure list
says it in as many words: *put the highest-frequency variation in albedo, which
is never differentiated and therefore costs nothing to sample finely.* Biomes
supplies the per-layer knobs to do that. The shader I wrote in round 11 simply
did not wire them.

Three scales, as the rubric asks: `macro` at tens of metres, `micro` at
centimetres, `bump` perturbing the normal for relief that costs no geometry.

## R20 — the erosion pass never runs

`TerrainField`'s constructor takes `(planet, frame, erosion)`. `SurfaceRealm`
passes two of the three. `TerrainGen` exports `buildErosionGrid`, the worker
implements a `prep` message that runs it and an `erosion` reply that returns the
grid, and nothing in the project ever sends that message.

So `_erosionDelta` contributes zero everywhere. The hydraulic and thermal
simulation that the TerrainGen header describes as running "once at load on a
coarse grid over the region you can see, carving valleys and depositing fans"
has never executed, and neither has the flow-accumulation pass that "finds where
water collects and cuts river courses down the middle of them".

Two consequences, and the second is the one that took a minute to spot.
Obviously there are no carved valleys. Less obviously, `flowAt` returns
approximately zero everywhere, so the `flow > 0.02` branch in the biome
classifier — the branch that puts sediment and vegetation along drainage — can
never fire, on the CPU or in the shader. A whole term of the material system is
dead code downstream of a message nobody sends.

## R21 — the horizon silhouette steps

Visible in all three frames, and flagged in the two commits that built this
realm without being chased down.

The morph is supposed to make this impossible: a node collapses exactly onto its
parent's surface before the swap, so the silhouette should be continuous across
a level change. At horizon distance it plainly is not. Either the morph band
(`size * split * 1.35` to `1.90`) does not close before the parent hands over,
or the skirt — which hangs from a node's own edge and is not morphed — is what
is showing. The skirt is the better suspect: it is a vertical curtain of depth
`size * 0.055 + 0.5`, which on a 30 km node is 1.7 km of wall, and at a grazing
horizon view that is exactly the kind of thing that reads as a step.

## R22 — no aerial perspective

Near ground and horizon ground sit at the same value, so nothing in the frame
says which is further away.

`uFogDensity` is `1 / (120000 / (1 + atm * 4))`, which on a world with an
Earth-ish atmosphere is about 1/24000. The fog term is `1 - exp(-(d * k)^2)`, so
at 3 km — a distance the frame is full of — it contributes about 1.5%. Haze that
is invisible across the depths a shot actually contains is not a depth cue.

The mistake is what the density is anchored to. It is derived from the root
patch extent, which is a property of the LOD tree, not of the atmosphere or of
the scale at which terrain features separate. It should come from a stated
visibility distance instead.

## R23 — `frame('relief')` searches a window smaller than the landform it wants

My own helper, and wrong on its own terms. It sweeps ±9 km for the highest
ground. The orogenic ridge frequency in TerrainGen is `fRidge = R / 5.5e4` — a
wavelength of about 55 km. A 18 km window cannot contain a mountain range; it is
guaranteed to return a local bump, which is exactly what the frame shows.

This is the "check that the shot is testing what it claims to" rule catching my
own shot rather than the renderer. `surface-relief` scored 3 rather than 4
because it does not merely render its subject badly, it does not contain it.

## Also noted

The ground reads pale and desaturated on every world — mean saturation 0.33 to
0.38. Ambient is scaled by atmosphere to as much as 1.45x the sky colour and
visibly dominates the direct term, which washes the albedo toward the sky's hue.
Worth revisiting once R19 gives the surface something to desaturate.

## Order to take these

R19 and R20 first, and in that order. R19 is confined to one shader and turns a
flat wash into a surface; R20 is a message the realm never sends and turns
smooth ground into eroded ground. Between them they are most of what separates
these frames from the reference bar, and both are wiring rather than invention —
the same shape as the QuadSphere gap, where the mechanism existed and nothing
called it.

R22 is a one-line change to what the fog density is derived from. R23 is a
constant in a framing helper. R21 needs an actual investigation.
