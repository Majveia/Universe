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
npm run build
node tools/critique.mjs --out shots/critique/round-N
```

Then look at every frame. Not a sample — every frame. Write the verdict into
`shots/critique/round-N/VERDICT.md` with a line per shot, and keep the previous
round on disk so the two can be compared directly.

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

- Reversed-edge `smoothstep` is undefined in GLSL and produces hard rectangular
  artefacts. Always order the edges and negate the argument instead.
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
