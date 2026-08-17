# Round 8 — verdict

Round 4 of the critic loop, taking every remaining item from
`round-7/VERDICT.md` — R3 through R7. Same rig: 1440x810, tier 2, 900k tracers.

| Shot | R2 | R6 | R7 | R8 | Verdict |
|---|---|---|---|---|---|
| cosmos-wide | 4 | 7 | 7 | 7 | FAIL |
| cosmos-close | 3 | 7 | 7 | 7 | FAIL |
| system-wide | 6 | 6 | 7 | 7 | FAIL |
| planet-lit | 4 | 7 | 7 | 7 | FAIL |
| planet-crescent | 1 | 8 | 8 | 8 | PASS |
| rings | 3 | 8 | 8 | 8 | PASS |
| gasgiant | 5 | 7 | 7 | 8 | PASS |

Three shots pass. `gasgiant` passes for the first time.

## R3 — closed: vortices and polar character

All three of the rubric's gas-giant requirements are now met: bands shear against
each other, vortices sit in the shear zones, and the poles differ in character
from the equator.

Vortices are no longer placed at random. The shader's zonal jet is
`0.6 sin(7 lat) + 0.25 sin(15 lat)`, so its derivative is the shear; sampling
`|d jet / d lat|` and taking the local maxima puts every storm on a jet boundary
by construction, which is also why the bands visibly wrap around them. There are
now up to four, spread evenly in longitude — one spot at a random longitude is on
the far side half the time, and a still frame cannot wait for the planet to
rotate. Each twists the sampling frame locally and carries a pale collar of
entrained cloud.

The polar hood was rebuilt rather than retuned. Desaturating the same banding was
never going to read as a different regime, and it is not what happens: away from
the tropics the Coriolis parameter stops supporting coherent zonal jets and what
is left is a field of cyclones. So the bands are replaced with cells, and the
hood runs colder and darker.

### Regression caught mid-round

The first polar hood used the Worley `F2 - F1` edge function and came out as hard
polygons — cracked mud, not weather. That function draws cell *boundaries*. A
falloff on the F1 *distance* gives round cyclone cores instead, which is what
Juno actually photographs.

Onset also had to come down from `|lat| > 0.55` to `0.40`: from an equatorial
vantage everything above 0.55 is crushed into the last few pixels of the rim by
foreshortening, so the hood existed in the maths and never reached the eye. The
shot camera was lifted off the equator for the same reason — the rubric's
reference is Juno, whose entire point is the poles.

## R5 — closed: ring radial structure

The optical-depth envelope was flat across the whole sheet, rolling off only at
the very edges, so the rings were one grey annulus with noise on it. Replaced
with Saturn's actual radial ordering: a nearly transparent C ring, an optically
thick B ring carrying most of the brightness, a division, and a moderate A ring
beyond it. That ordering is a *profile*, not a texture, and it is most of what
identifies a ring system.

The umbra needed a different fix — a subject, not a shader change. The shadow
falls on the ring plane only out to `1 / sin(elevation)` planet radii, and at the
47-degree sun elevation chosen in round 7 that is 1.37 against an inner ring edge
at 1.35: it grazed the inner rim and nothing else. But low elevation costs light,
because reflectance carries a `mu0/(mu + mu0)` factor. The way out was not to
compromise on the angle but to sweep for a subject bright enough to afford a low
one — a giant close enough in that illumination is still at the top of its range,
with the shadow reaching 3.1 radii and crossing the whole sheet.

## R7 — closed: the sky is no longer a uniform scatter

Two thirds of the field is now concentrated toward a galactic plane with a
sech-squared profile in latitude — the same vertical profile the Catalog already
uses for stellar density — with dust lanes cutting the band and the remainder
left isotropic for the halo population. Band stars are pushed fainter than halo
stars, because what the eye reads as the Milky Way is not a line of resolvable
stars but the unresolved light of very many of them.

The plane is deliberately tilted away from the ecliptic. The two are unrelated in
reality, and aligning them would have put the band along the orbit furniture.

## R6 — decided: the magnitude floor is an exposure choice

Left alone, the clamp was doing the work for eight of ten bodies and the outer
system collapsed to one indistinguishable value. Strictly that is correct
photometry — a world at 75 AU really is that faint — but it is the wrong answer
for a frame whose job is to show that a system has worlds in it.

Resolved the way the realm already resolves illumination: a real camera exposes
for its subject, and the subject is the system. The floor now sits where the
faintest planet still records as a planet. The magnitude scale still orders them,
so the inner giants stay visibly brighter; what is given up is a couple of stops
of contrast at the bright end that no viewer will miss.

## R4 — partially closed: surface detail

The third scale of relief was gated behind `uDune`, which is zero on any world
that is not a desert — so a temperate planet had continental and orogenic
structure and then nothing, which is why it read as smooth however much the
coarse octaves were doing. There is now an always-present fine octave, weighted
by plate belt and elevation so it roughens mountains and leaves plains and seabed
alone, plus fine albedo texture on land.

Frequency is capped below what the normal's finite-difference epsilon (0.0022)
can resolve; past roughly `1/(4e)` the shading aliases into sparkle rather than
resolving into landscape. Albedo carries the highest frequency precisely because
it is not differentiated.

**Still failing.** The improvement is real but modest: the cloud deck still
covers most of the disc and the frame is dim, so the new detail is doing its work
underneath something that hides it. The next move is the cloud layer's coverage
and opacity, not more terrain octaves.

## Remaining defects

### R8 — `planet-lit` is cloud-dominated and underexposed

Coverage is high enough that surface detail barely gets a say, and the whole
frame sits dark. Both are cloud-layer problems, not terrain problems.

### R9 — the galactic band reads as dots, not glow

Much better than a uniform scatter, but still resolvably granular. A true
unresolved-light component — a faint diffuse band under the point field — is what
would finish it.

### R10 — the ring umbra is present but not prominent

The shadow now reaches across the sheet, and the geometry is right, but at this
camera it does not read as the recognisable curved bite a Cassini portrait has.
Worth framing the shot to put it squarely in view.

### R11 — gas giants are still close to monochrome

Zones, belts, vortices and polar hood all separate correctly now, but almost
entirely in lightness. Jupiter's cream-versus-rust is a hue difference, and the
palette spread between `base` and `accent` is not reaching the render.
