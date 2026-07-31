# Round 9 — verdict

Round 5 of the critic loop, taking R8 through R12 from `round-8/VERDICT.md`.
Same rig: 1440x810, tier 2, 900k tracers.

| Shot | R2 | R6 | R7 | R8 | R9 | Verdict |
|---|---|---|---|---|---|---|
| cosmos-wide | 4 | 7 | 7 | 7 | 7 | FAIL |
| cosmos-close | 3 | 7 | 7 | 7 | 7 | FAIL |
| system-wide | 6 | 6 | 7 | 7 | 7 | FAIL |
| planet-lit | 4 | 7 | 7 | 7 | 8 | PASS |
| planet-crescent | 1 | 8 | 8 | 8 | 8 | PASS |
| rings | 3 | 8 | 8 | 8 | 8 | PASS |
| gasgiant | 5 | 7 | 7 | 8 | 8 | PASS |

Four of seven pass. `planet-lit` passes for the first time.

## R8 — closed, and the round-8 diagnosis was wrong

Round 8 recorded this as "the cloud deck covers most of the disc". It was not the
cloud deck. Hiding the cloud shell entirely changed the frame not at all — the
white was coming from the surface shader, and specifically from the ice cap.

Two bugs on one line. The cap latitude was computed as

    1.06 - smoothstep(190, 330, T) * 1.25

which is **inverted**: it hands a hot world a threshold of zero, meaning ice
everywhere, and a frozen one 0.98, meaning none. At this planet's 288 K it
produced 0.08, so "polar" ice began eight per cent of the way to the pole and
covered the globe. And the blend used `cap * uIceCap * 3.0` as its mix factor,
scaling by a uniform that is a *latitude*, not a strength, then tripling it — so
the blend saturated to full white wherever cap merely passed a third.

With the sense corrected and the mix factor reduced to `cap` alone, the planet
reads as a world: oceans, landmasses, a specular sun glint, discrete cloud
systems and a polar cap that is actually polar. It also means the fine surface
detail added in round 8 is finally visible, having been buried under white the
whole time.

## R9 — closed: the band has unresolved light under it

Concentrating the point field toward a plane produced a band made of countable
dots, because what the eye reads as the Milky Way is not resolvable stars at all
— it is the summed light of the ones too faint and too numerous to separate, and
no finite sprite count reproduces that. The diffuse component is now drawn as
what it is: a continuous glow on a sky shell, brightest along the plane, lopsided
toward the galactic centre, and cut by the same rift the point field is cut by.

## R10 — closed: the umbra reads

The shadow now shows as a dark band across the sheet. Getting there took a wrong
turn worth recording: the first attempt moved the camera **anti-sunward**, on the
reasoning that the shadow falls on the far side of the planet. It does — but
crossing over puts the camera on the *unlit* face, where transport correctly
inverts, the optically thick B ring goes black in transmission, and only the gaps
glow. The sheet vanished and what was left was exactly the "concentric wires"
the rubric fails a ring frame for.

The answer was height, not side. Staying sunward keeps the sheet a sheet;
climbing opens the disc so the shadow lying on it has somewhere to show. Height
is itself a trade — it raises muV, which thins the sheet — so the framing sits
where the shadow is legible and the annuli still occlude.

## R11 — closed: zones and belts separate in hue

The base-to-accent lerp was not delivering the split. The belt term pulled 60%
toward a darkened base while the zone term pulled only 50% toward the accent over
a window that barely opened (0.72 to 0.98), so the bright end of the ramp never
arrived anywhere and the disc read as one brown at two brightnesses. The two ends
are now weighted symmetrically and pushed apart in hue as well as value: belts
darker, warmer and more saturated; zones paler and slightly cool. Cream against
rust, which is what Jupiter actually does.

## R12 — closed by rejecting its own premise

The measurement was real: at the old intensity the 99.5th percentile of output
luminance sat at 45/255 with nothing in the frame above 128. The *target* drawn
from it was wrong.

"Filaments should clear the bloom threshold" was my gloss, not something the
rubric asks for. This camera sits **inside** the medium, and a frame taken from
inside a translucent volume legitimately has a low peak. Chasing that target
raised intensity threefold, which lifts the per-tracer floor along with
everything else: the 99.5th reached 106 and the whole frame became uniform blue
haze with no empty space in it — failing "voids must be genuinely empty", which
the rubric does ask for.

Trying to buy contrast instead of exposure — cutting the floor term and leaning
harder on density — brought per-tracer speckle back, the round-2 failure.

Settled at a modest lift (10 to 14): 99.5th percentile near 59, median near 11,
voids still black. Recorded as a case where the honest answer was that the
original frame was closer to right than the metric suggested.

## Finding: 649 KB of the source tree never runs

Not a frame defect, but it turned up while chasing R8 and it is the largest thing
in this report.

`src/cosmos/Nebula.js` contains a JavaScript syntax error — a backtick inside a
GLSL template literal, closing the shader string early — which means it cannot be
imported at all. The build was green regardless, because **nothing imports it**.

Walking the import graph from `src/main.js`: **18 of 45 source files are
reachable**. The other 27, totalling 649 KB, are never bundled and have never
executed. That includes all of `src/civ/` (six files, 204 KB), all of
`src/player/` (nine files, 233 KB), most of `src/ui/`, plus `TerrainGen.js`,
`Biomes.js`, `Galaxy.js` and `Nebula.js`. The catalogue even sets a `hasNebula`
flag that nothing consumes.

This also corrects a round-2 claim. That round fixed "16 reversed-edge smoothstep
sites across 8 files" — accurate as a count, but 10 of the 16 were in files that
never load. Only 6 were in live code.

The syntax error is fixed so the file at least parses. Wiring up 649 KB of
features is a decision for the project, not a critic round.

`tools/lint-shaders.mjs` now parse-checks every file and the harness runs it
before building, so an unreachable file can no longer hide a syntax error behind
a green build.

## Remaining defects

### R13 — the outer system is indistinguishable from the star field

Two of ten planets read; the other eight sit at the magnitude floor among 30,000
stars. The floor was raised deliberately in round 8 and it is still not enough to
separate a planet from a star at a glance. Points alone may not be able to carry
this — what distinguishes a planet in a real system view is usually motion or a
mark, not brightness.

### R14 — cosmos nodes do not punch

Voids are properly dark and filaments are connected, but the gold nodes never
reach a brightness that reads as a cluster. The colour ramp says node; the
luminance does not. This is the part of R12 that was a real defect rather than a
mismeasurement, and it wants the node end of the density ramp lifted specifically
rather than the whole frame.

### R15 — stray orbit-ribbon segment in the rings frame

A thin vertical line hangs above the planet at the top of the frame, and the ring
inner edge shows dotted stair-stepping where it passes near the limb. Likely the
near-plane cull dropping segments unevenly at this camera.
