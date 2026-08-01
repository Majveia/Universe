/**
 * The cosmic web — structure formation you can watch happen.
 *
 * This is not a particle system with noise sprinkled on it. It is a
 * Zel'dovich approximation, the standard first-order solution to gravitational
 * collapse in an expanding universe:
 *
 *     x(q, t) = q + D(t) · ψ(q)
 *
 * Every particle starts on a uniform Lagrangian grid `q` and is displaced along
 * a fixed field ψ = -∇φ, scaled by the linear growth factor D(t). Because ψ is a
 * gradient field, trajectories converge — and where they cross, you get
 * caustics. Those caustics *are* the filaments, sheets and nodes of the real
 * cosmic web. Turn D up and a smooth early universe fractures into the
 * honeycomb that surveys like SDSS actually measured.
 *
 * Three things had to be right for this to look like the real thing rather
 * than like noise, and each took a specific decision:
 *
 *  1. The potential must be SMOOTH. In linear theory φ ∝ δ/k², so short
 *     wavelengths are suppressed by two powers of k. Taking the gradient then
 *     amplifies by one power of k. Feed it a full-spectrum fbm and the
 *     displacement is dominated by the smallest octave — particles scatter in
 *     random directions and you get a fuzzy ball. Feed it a steeply
 *     red-tilted field and they move coherently over long distances, sheets
 *     form, sheets intersect in filaments, filaments intersect in nodes.
 *     That hierarchy (Zel'dovich's "pancakes") is the whole phenomenon.
 *
 *  2. Density comes from the JACOBIAN, not from the noise value. Mass is
 *     conserved along trajectories, so ρ/ρ̄ = 1/|det(∂x/∂q)|. To first order
 *     that determinant is 1 - D∇²φ, which passes through zero exactly at a
 *     caustic and sends the density to infinity there. Colouring by this
 *     means the bright parts of the image are bright *because* matter has
 *     genuinely piled up, not because a shader was told to make them bright.
 *
 *  3. Per-particle brightness stays very low. Additive blending integrates
 *     along the line of sight, so a node should be bright because a thousand
 *     particles overlap there — not because any one of them is. Get this
 *     backwards and the image clips to white before any structure resolves.
 *
 * Galaxies share the same displacement field, evaluated in their own vertex
 * shader and culled below a density threshold, so they land on the filaments
 * instead of merely near them.
 */

import * as THREE from 'three';
import { GLSL_LIB } from '../shaders/common.js';
import { Rng } from '../core/Rng.js';
import { settings } from '../core/Settings.js';
import { ZELDOVICH_GLSL as ZELDOVICH } from './ZeldovichField.js';
import { CLUSTERS, CLUSTER_BAKE } from './clusters.generated.js';

const WEB_VERT = /* glsl */ `
precision highp float;
${GLSL_LIB}
${ZELDOVICH}

uniform float uTime;
uniform float uScaleFactor;
uniform float uPointScale;
uniform float uBoxHalf;
uniform float uMaxPointPx;
uniform float uFlowAmp;
uniform float uViewportH;

attribute vec3 aLagrangian;
attribute float aSeed;

varying float vDensity;
varying float vSeed;
varying float vDist;
varying float vFlux;
varying float vEdge;

void main(){
  vSeed = aSeed;
  vec3 q = aLagrangian;

  // Fade the simulation volume out along a sphere rather than letting it end
  // at the faces of its cube. A visible box edge is the single fastest way to
  // destroy the illusion of an unbounded universe, and a spherical horizon is
  // the honest shape anyway: what bounds your view of the real cosmos is how
  // far light has had time to travel, which is a sphere centred on you.
  float rq = length(q) / (uBoxHalf);
  // Horizon fade. Kept late and thin: starting it at 0.62 threw away the outer
  // third of the box, which shrank the visible web to a ball of about 11 units
  // and — viewed from outside at 26 — left it sitting in black with a clearly
  // rounded silhouette. That is a visible simulation-box edge by another name.
  vEdge = 1.0 - smoothstep(0.80, 1.0, rq);

  float lap;
  vec3 psi = zeldovich(q, lap);

  // Peculiar velocity — a slow divergence-free drift on top of the Hubble
  // flow, so the web breathes instead of sitting frozen.
  vec3 drift = curlNoise(q * 0.14 + vec3(0.0, uTime * 0.013, 0.0)) * uFlowAmp;

  vec3 x = (q + uGrowth * psi + drift) * uScaleFactor;

  vDensity = zeldovichDensity(lap);

  vec4 mv = modelViewMatrix * vec4(x, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;

  // World-space sizing, so a tracer keeps its apparent size as you fly
  // through — no popping, no resolution dependence.
  //
  // The upper clamp matters as much as the scale. A splat sized to the mean
  // interparticle spacing is correct in world units, but a tracer two units
  // from the eye then covers a third of the screen, and flying through the web
  // becomes flying through soap bubbles. Capping it in pixels keeps the medium
  // reading as a medium at every distance; the cost is only that the very
  // nearest tracers under-cover, which nothing can see.
  float size = uPointScale;
  float pxWanted = size * uViewportH / max(vDist, 0.2);
  float px = clamp(pxWanted, 1.0, uMaxPointPx);
  gl_PointSize = px;

  // Flux conservation: a splat spread over more pixels must be proportionally
  // fainter, or the web brightens every time you fly toward it.
  //
  // NOTE — two attempts at the close-range softness (R16) died here in round 11.
  // Both are recorded because both are the obvious thing to try.
  //
  // First, normalising by pxWanted rather than px. The observation behind it is
  // real: the cap engages at 11 units, so a tracer 2 units away is drawn at 26px
  // when it wants 143, covering 3% of its world footprint while still emitting
  // all its light. But the correction takes that light away instead of spreading
  // it, and since the cap covers most of what fills a close frame, the medium
  // lost the bulk of its brightness. The galaxy layer, unchanged, was left
  // dominating a dimmer background — worse in exactly the way the round was
  // trying to fix.
  //
  // Second, raising the cap so the coverage is simply not lost. Captured at 26
  // and at 64 with nothing else changed, the two frames are the same picture:
  // median 8, p99 49, p99.5 58 in both, and the void fraction slightly WORSE at
  // 64 (30.9% against 32.6%). That is not a surprise once stated — flux
  // conservation is precisely the guarantee that spreading a fixed amount of
  // light over more pixels leaves the integrated image alone. Kernel width under
  // a conserved flux is close to a no-op, so no amount of tuning it will change
  // how the medium reads. Whatever R16 is, it is not the kernel width.
  vFlux = 1.0 / max(px * px, 1.0);
}
`;

const WEB_FRAG = /* glsl */ `
precision highp float;
${GLSL_LIB}

uniform float uFade;
uniform vec3  uVoidColor;
uniform vec3  uSheetColor;
uniform vec3  uFilamentColor;
uniform vec3  uNodeColor;
uniform float uIntensity;
uniform float uExtinction;

varying float vDensity;
varying float vSeed;
varying float vDist;
varying float vFlux;
varying float vEdge;

void main(){
  if (vEdge <= 0.001) discard;
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;

  // A deliberately soft, wide kernel. The instinct is a tight Gaussian, but a
  // tight kernel makes every tracer individually resolvable and the image
  // reads as confetti no matter how many you draw. Overlapping soft splats
  // average into each other, and that averaging is what turns a finite set of
  // samples back into the continuous medium they are sampling.
  float core = exp(-r2 * 2.3);
  float halo = exp(-r2 * 0.75) * 0.55;
  float alpha = (core + halo) * 0.62;

  // Four-stop ramp across the structural hierarchy: void, sheet, filament,
  // node. Because density here is the Jacobian, these thresholds correspond
  // to genuinely different dynamical states, not arbitrary colour bands.
  float d = vDensity;
  vec3 col = uVoidColor;
  col = mix(col, uSheetColor,    smoothstep(0.95, 1.55, d));
  col = mix(col, uFilamentColor, smoothstep(1.60, 3.20, d));
  col = mix(col, uNodeColor,     smoothstep(5.20, 11.00, d));

  // A whisper of per-particle jitter breaks up banding in large uniform
  // regions. It has to stay small: crank it and the colour ramp stops
  // encoding density and starts encoding the random number, which is exactly
  // the speckle that makes procedural work look procedural.
  col *= 0.93 + 0.14 * fract(vSeed * 91.7);

  // Exponential extinction with distance. This is the single change that makes
  // the web legible rather than a glowing brick.
  //
  // Additive blending integrates every tracer along the sightline. Looking
  // through the full depth of the volume therefore averages six or seven
  // independent structures on top of each other, and the filaments cancel out
  // into uniform haze — which is exactly why every real cosmic-web figure you
  // have ever seen is a thin slab, not a cube. Extinction gives that slab for
  // free and does it in a way that follows the camera, so the structure stays
  // resolved from any angle instead of only one.
  //
  // It is also honest: intergalactic dust really does extinguish, and the
  // observable universe really is bounded by how far light has had time to
  // travel.
  float atten = exp(-vDist * uExtinction);

  // Superlinear in density so voids stay genuinely dark on an OLED while
  // nodes still have somewhere to go before the tonemapper rolls them off.
  // Scaled by vFlux so the total light a tracer emits is independent of how
  // many pixels its splat happens to cover.
  // Per-tracer peak is deliberately low. AgX rolls bright saturated values
  // toward white — which is correct for a star, and fatal here: push a single
  // splat hard enough and the tonemapper bleaches it grey before the colour
  // ramp can say anything about density. The brightness of a filament has to
  // come from hundreds of faint overlaps, not from any one tracer being loud.
  // This is the third principle in this file's header, and the one easiest to
  // break while chasing visibility.
  //
  // Which is what a 1.55 density exponent broke. Tracers carry equal mass, so
  // the density of a region is ALREADY expressed by how many of them land on a
  // pixel — that is the whole point of sampling the field with particles.
  // Weighting each one by its own local density on top of that counts the same
  // clustering twice, and at 1.55 it handed the top few per cent of tracers
  // ~34x the mean, which is more than enough to punch through the flux
  // normalisation as an individual point. The result was a faint continuous
  // wash with isolated hard dots riding on it: the medium sampled correctly and
  // then hidden under its own brightest samples.
  //
  // Keep the exponent below one so overlap, not any single splat, carries the
  // structure. Density still drives the colour ramp at full strength, so nodes
  // stay gold and legible — they just have to earn their brightness by there
  // being many of them in one place, which in a collapsed region there are.
  float brightness = (0.85 + pow(d, 0.90) * 0.45) * vFlux * atten * vEdge * uIntensity;

  // NOTE — do not add a per-tracer boost here to make the nodes punch.
  //
  // Collapsed cores separate from the filaments in colour but not in luminance,
  // so a cluster reads as a differently-tinted piece of filament. The obvious
  // fix is a density-gated multiplier on this line, and it was tried twice, at
  // smoothstep(4, 12) * 2.2 and again at the much tighter smoothstep(9, 20) *
  // 1.5. Both brought the round-2 speckle straight back.
  //
  // The reason is that this density is the Zel'dovich Jacobian, which every
  // particle carries individually — it says how much that one mass element was
  // compressed, not how crowded its neighbourhood is on screen. A single tracer
  // in an ordinary sheet can hold a high value, and any multiplier keyed to it
  // makes that tracer a hard dot. There is no threshold that separates "in a
  // cluster" from "individually dense", because the quantity does not carry
  // that distinction.
  //
  // Making nodes punch needs a different mechanism entirely: find the clusters
  // on the CPU, where neighbours can actually be counted, and draw them as
  // objects rather than scaling the tracers that happen to be in them.

  gl_FragColor = vec4(col * brightness * alpha, alpha * uFade);
}
`;

const GAL_VERT = /* glsl */ `
precision highp float;
${GLSL_LIB}
${ZELDOVICH}

uniform float uScaleFactor;
uniform float uViewportH;
uniform float uSizeScale;
uniform float uThreshold;
uniform float uBoxHalf;

attribute vec3 aLagrangian;
attribute float aSeed;
attribute float aSize;

varying vec3 vColor;
varying float vFade;
varying float vSeed;
varying float vPx;
varying float vFlux;

void main(){
  vSeed = aSeed;
  float lap;
  vec3 psi = zeldovich(aLagrangian, lap);
  float d = zeldovichDensity(lap);

  // Galaxies only exist where matter actually collapsed. Culling in the
  // vertex shader (rather than pre-selecting on the CPU) keeps them locked to
  // the filaments even as the growth factor evolves and the web rearranges.
  // Same spherical horizon as the tracers, so the two layers end together.
  float rq = length(aLagrangian) / uBoxHalf;
  if (d < uThreshold || rq > 1.0){
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec3 x = (aLagrangian + uGrowth * psi) * uScaleFactor;
  vec4 mv = modelViewMatrix * vec4(x, 1.0);
  float dist = -mv.z;
  gl_Position = projectionMatrix * mv;

  // The morphology-density relation is real: galaxies in dense cluster cores
  // are old, gas-poor and red; field galaxies out on the filaments are still
  // forming stars and read blue. Colouring by local density reproduces it
  // for free.
  float redness = smoothstep(uThreshold, 9.0, d);
  vec3 blue = vec3(0.62, 0.78, 1.00);
  vec3 red  = vec3(1.00, 0.72, 0.46);
  vColor = mix(blue, red, redness) * (0.75 + 0.5 * fract(aSeed * 37.3));

  vFade = smoothstep(0.6, 3.0, dist) * (1.0 - smoothstep(90.0, 240.0, dist))
        * (1.0 - smoothstep(0.80, 1.0, rq));

  // A galaxy at survey distance subtends far less than a pixel, but a point
  // sprite cannot be drawn smaller than one. Clamping the size without paying
  // for it is what turns a galaxy catalogue into gold dust: every sprite ends up
  // the same one-pixel dot at full strength, and 26k of them sit on top of the
  // density field and erase it.
  //
  // So charge for the clamp. Dim by the area actually subtended over the area
  // drawn, and a sub-pixel galaxy contributes the light it really carries — the
  // population reads as a faint sparkle inside the filaments instead of as a
  // layer covering them.
  float pxWanted = aSize * uSizeScale * uViewportH / max(dist, 0.2);
  float px = clamp(pxWanted, 1.0, 46.0);
  float ratio = pxWanted / px;
  vFlux = min(1.0, ratio * ratio);
  vPx = px;
  gl_PointSize = px;
}
`;

const GAL_FRAG = /* glsl */ `
precision highp float;
${GLSL_LIB}
uniform float uBrightness;
varying vec3 vColor;
varying float vFade;
varying float vSeed;
varying float vPx;
varying float vFlux;

void main(){
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r = length(uv);
  if (r > 1.0) discard;

  // Give each sprite its own inclination so the population reads as a set of
  // discs at random orientations rather than a field of identical coins.
  float incl = 0.25 + 0.75 * fract(vSeed * 13.1);
  float rot = vSeed * 6.283;
  vec2 p = vec2(uv.x * cos(rot) - uv.y * sin(rot), uv.x * sin(rot) + uv.y * cos(rot));
  p.y /= max(incl, 0.18);
  float rr = length(p);

  float ang = atan(p.y, p.x);
  float spiral = 0.5 + 0.5 * cos(2.0 * (ang - log(max(rr, 0.05)) * 3.4));
  float disc  = exp(-rr * rr * 3.0) * (0.30 + 0.70 * spiral);
  float bulge = exp(-rr * rr * 22.0) * 1.6;
  float a = (disc + bulge) * (1.0 - smoothstep(0.75, 1.0, r));

  // Morphology only exists once the sprite is genuinely several pixels across.
  // Below that the warm bulge tint is applied to what is really a point source,
  // and because the bulge term peaks above 1.0 it drags almost the whole sprite
  // to the same warm white — discarding the density colour that was the only
  // thing making the population trace structure. Gate it on being resolved and
  // an unresolved galaxy keeps its blue-field / red-cluster hue.
  float resolved = smoothstep(2.0, 6.0, vPx);
  vec3 col = mix(vColor, vec3(1.0, 0.95, 0.88), bulge * 0.5 * resolved);
  gl_FragColor = vec4(col * a * uBrightness * vFlux, a * vFade);
}
`;

// --- collapsed nodes ---------------------------------------------------------
//
// The tracers cannot make a cluster read as a cluster. They separate it in
// colour — the density ramp turns a collapsed core gold — but not in luminance,
// because per-tracer brightness has to stay low for the medium to hold together
// (see the note in WEB_FRAG). So the node is drawn as its own object, from a
// catalogue found offline by counting neighbours in Eulerian space, which is
// the one place the crowding actually exists. tools/bake-clusters.mjs has the
// full argument.
//
// Only the anchor is baked. The position is re-derived here from the live
// growth factor, so a cluster tracks its node as the web keeps evolving rather
// than being pinned to wherever it happened to be at bake time.
const CLUSTER_VERT = /* glsl */ `
precision highp float;
${GLSL_LIB}
${ZELDOVICH}

uniform float uScaleFactor;
uniform float uViewportH;
uniform float uBoxHalf;
uniform float uSizeScale;
uniform float uMaxPx;
uniform float uRefPx;

attribute vec3 aLagrangian;
attribute float aRichness;
attribute float aRadius;

varying float vRichness;
varying float vDist;
varying float vEdge;
varying float vFlux;

void main(){
  vRichness = aRichness;
  vec3 q = aLagrangian;

  float rq = length(q) / uBoxHalf;
  // Same spherical horizon as the tracers. A cluster that outlived the medium
  // around it would hang in empty space at the edge of the volume.
  vEdge = 1.0 - smoothstep(0.80, 1.0, rq);
  if (vEdge <= 0.001){
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float lap;
  vec3 psi = zeldovich(q, lap);
  vec3 x = (q + uGrowth * psi) * uScaleFactor;

  vec4 mv = modelViewMatrix * vec4(x, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;

  // Sized from the cluster's measured RMS core radius, carried out to a few
  // core radii so the beta-model wings have somewhere to land.
  float world = aRadius * uSizeScale;
  float px = clamp(world * uViewportH / max(vDist, 0.2), 2.0, uMaxPx);
  gl_PointSize = px;

  // Same 1/px^2 flux convention as the tracers, so a cluster and the medium
  // around it scale with distance identically and their ratio — the thing the
  // rubric actually asks about — does not drift as the camera moves.
  //
  // Normalised against a reference sprite size rather than written as a bare
  // 1/px^2. The two differ only by a constant, but a cluster sprite is ~140px
  // where a tracer splat is ~18, so the bare form buries a factor of sixty in
  // the brightness uniform and leaves a number nobody can sanity-check. This
  // way uBrightness reads as "level at a 32px sprite" and stays O(100).
  vFlux = (uRefPx * uRefPx) / max(px * px, 1.0);
}
`;

const CLUSTER_FRAG = /* glsl */ `
precision highp float;
${GLSL_LIB}

uniform vec3  uCoreColor;
uniform vec3  uHaloColor;
uniform float uBrightness;
uniform float uExtinction;
uniform float uFade;

varying float vRichness;
varying float vDist;
varying float vEdge;
varying float vFlux;

void main(){
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;

  // Beta model, the profile real clusters actually have: projected surface
  // brightness goes as (1 + (r/rc)^2)^(-3*beta + 1/2), and beta comes out near
  // 2/3 from X-ray observations, giving an exponent of -3/2.
  //
  // The shape is the point. A Gaussian falls off far too fast and reads as a
  // soft dot pasted onto the frame; this one has a bright core and heavy wings
  // that grade into the surrounding filament, which is what makes it look like
  // mass that collected there rather than a sprite drawn on top.
  float rc2 = r2 * 26.0;
  float profile = pow(1.0 + rc2, -1.5);
  // Taper the last of the disc to zero so the sprite has no visible rim.
  profile *= 1.0 - smoothstep(0.55, 1.0, r2);

  // Cluster cores are hot gas and old red galaxies; the outskirts are cooler.
  // Grading core to halo across the profile keeps the object from reading as
  // one flat colour and matches the gold the density ramp already gives nodes.
  vec3 col = mix(uHaloColor, uCoreColor, smoothstep(0.15, 0.85, profile));

  float atten = exp(-vDist * uExtinction);
  // Richness spans about 8x across the catalogue; a square root keeps the poor
  // clusters visible without letting the richest few dominate the frame.
  float level = sqrt(vRichness) * uBrightness * atten * vEdge * vFlux;

  // Premultiplied, and the material blends One/One rather than SrcAlpha/One.
  //
  // Coverage and radiance are separate quantities and this layer has to emit
  // them independently. Writing vec4(col * a, a) into a SrcAlpha blend puts the
  // level in both channels and multiplies them back together, so emitted light
  // goes as level SQUARED — a factor of eight in the uniform became a factor of
  // sixty in the frame, which is how this layer went from invisible to bleached
  // white with nothing usable in between. It also squares the profile, quietly
  // turning the beta model's -3/2 exponent into -3 and throwing away the heavy
  // wings that were the reason for choosing it.
  gl_FragColor = vec4(col * level * profile * uFade, profile * uFade);
}
`;

export class CosmicWeb {
  constructor(opts = {}) {
    const count = opts.count ?? settings.cosmicParticles;
    const boxSize = opts.boxSize ?? 30;
    this.boxSize = boxSize;

    const rng = new Rng(opts.seed ?? 424242);

    // Lagrangian grid with a stratified jitter. A perfect lattice produces
    // visible moiré at grazing angles; pure random loses the uniform-density
    // initial condition the approximation assumes.
    const side = Math.max(2, Math.round(Math.cbrt(count)));
    const actual = side * side * side;
    const positions = new Float32Array(actual * 3);
    const lagr = new Float32Array(actual * 3);
    const seeds = new Float32Array(actual);
    const step = boxSize / side;
    let i = 0;
    for (let z = 0; z < side; z++) {
      for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
          const qx = (x + 0.5 + rng.range(-0.45, 0.45)) * step - boxSize * 0.5;
          const qy = (y + 0.5 + rng.range(-0.45, 0.45)) * step - boxSize * 0.5;
          const qz = (z + 0.5 + rng.range(-0.45, 0.45)) * step - boxSize * 0.5;
          lagr[i * 3] = qx; lagr[i * 3 + 1] = qy; lagr[i * 3 + 2] = qz;
          positions[i * 3] = qx; positions[i * 3 + 1] = qy; positions[i * 3 + 2] = qz;
          seeds[i] = rng.next();
          i++;
        }
      }
    }
    this.count = actual;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aLagrangian', new THREE.BufferAttribute(lagr, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), boxSize * 2.5);

    const shared = {
      uGrowth: { value: 0.0 },
      // ~6 structures across the box, matching the ~100 Mpc node spacing of a
      // real survey volume of this size.
      uFieldScale: { value: 6.0 / boxSize },
      // Displacement amplitude, in box units. This is the single most
      // sensitive number in the whole effect and it was not guessed:
      // tools/probe-web.mjs evaluates the same field in Node and projects it
      // to a column-density image, so the value could be swept and looked at
      // directly. Below ~0.002 the field never shell-crosses and you get soft
      // clouds; above ~0.02 every sheet crosses at once and the structure
      // dissolves into fog. 0.006 sits where filaments are sharp, voids are
      // genuinely empty, and nodes have formed but not merged.
      uPsiAmp: { value: 0.006 * boxSize },
      uScaleFactor: { value: 1.0 },
      uViewportH: { value: 900 },
      uBoxHalf: { value: boxSize * 0.5 },
    };
    this._shared = shared;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        uTime: { value: 0 },
        // Each tracer stands for a mass element, so its splat should be as
        // wide as the volume it represents — the mean interparticle spacing.
        // Draw them any smaller and a finite particle count reads as confetti
        // instead of as a medium; this is the same smoothing-length argument
        // SPH makes, and it is why the web looks continuous at 200k particles
        // when a 1px dot needs tens of millions.
        uPointScale: { value: (boxSize / side) * 0.95 },
        // Held at 26. Raising it to 64 — so the cap engages at 4.5 units rather
        // than 11 and the near field keeps its true footprint — was captured
        // side by side against this and changed nothing measurable. See the
        // note on vFlux in WEB_VERT.
        uMaxPointPx: { value: 26.0 },
        uFlowAmp: { value: 0.06 },
        uFade: { value: 1 },
        // Absolute level. Additive blending integrates every splat along the
        // sightline, so this is set from how many tracers a filament crossing
        // actually stacks — a few dozen — such that a filament lands just
        // above the bloom threshold and a void stays near black.
        // Re-levelled for the flattened density weighting above, which raised the
        // mean per-tracer contribution even as it dropped the peak. Set from the
        // captured frames: filaments sit just above the bloom threshold and voids
        // stay near black.
        // Nudged up from 10 after measuring the captured frames, and deliberately
        // NOT pushed to where "filaments clear the bloom threshold" would put it.
        //
        // That target was a mistake. The 99.5th percentile does sit low — 45/255
        // at the old value — but this camera is *inside* the medium, and a frame
        // taken from inside a translucent volume legitimately has a low peak. The
        // rubric asks for empty voids and connected filaments, not for a bright
        // histogram. Chasing 3x intensity lifted the per-tracer floor along with
        // everything else and turned the whole frame into uniform blue haze with
        // no empty space in it, which fails the criterion that actually exists.
        //
        // Measured: this lands the 99.5th around 60 with the median near 11, so
        // voids stay near black and the structure gains a little headroom.
        uIntensity: { value: 14.0 },
        // e-folding length ~14 units, about two structure diameters. That is
        // the depth at which filaments still overlap enough to look like a
        // connected network but not so much that they average out.
        uExtinction: { value: 1.0 / 11.0 },
        // Voids are not black — they are the faintest possible indigo, which
        // on an OLED reads as "space with something in it" rather than as a
        // dead panel. Sheets cool violet, filaments cyan, nodes gold.
        uVoidColor: { value: new THREE.Color(0.07, 0.10, 0.34) },
        uSheetColor: { value: new THREE.Color(0.30, 0.22, 0.86) },
        uFilamentColor: { value: new THREE.Color(0.24, 0.74, 1.00) },
        uNodeColor: { value: new THREE.Color(1.00, 0.72, 0.26) },
      },
      vertexShader: WEB_VERT,
      fragmentShader: WEB_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 1;

    this.group = new THREE.Group();
    this.group.add(this.points);
    this._buildClusters(boxSize, shared);
    this._buildGalaxies(rng, boxSize, opts.galaxies ?? Math.min(26000, Math.round(actual * 0.06)));

    // Cosmic time. Drives D(t) and a(t) together so expansion and collapse
    // stay physically coupled.
    this.cosmicTime = 0.72;
    this.timeScale = 0.010;
    this.paused = false;
  }

  /**
   * The baked cluster catalogue, if it was baked for this volume.
   *
   * The anchors are Lagrangian coordinates in a specific field: change the box
   * size or either field parameter without re-running the bake and every sprite
   * lands somewhere the web no longer has a node. That failure is invisible —
   * the frame still looks like a cosmic web, just with gold blobs in the voids —
   * so the mismatch is checked rather than trusted, and the layer is skipped
   * outright instead of drawing something wrong.
   */
  _buildClusters(boxSize, shared) {
    const bake = CLUSTER_BAKE;
    const matches = bake.boxSize === boxSize
      && Math.abs(bake.fieldScale - shared.uFieldScale.value) < 1e-9
      && Math.abs(bake.psiAmp - shared.uPsiAmp.value) < 1e-9;
    if (!matches || !CLUSTERS.length) {
      if (!matches) {
        console.warn('[CosmicWeb] cluster catalogue was baked for a different field'
          + ` (box ${bake.boxSize} vs ${boxSize}) — skipping the node layer.`
          + ' Re-run: node tools/bake-clusters.mjs');
      }
      this.clusters = null;
      return;
    }

    const n = CLUSTERS.length;
    const lagr = new Float32Array(n * 3);
    const rich = new Float32Array(n);
    const radius = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const c = CLUSTERS[i];
      lagr[i * 3] = c[0]; lagr[i * 3 + 1] = c[1]; lagr[i * 3 + 2] = c[2];
      rich[i] = c[3];
      radius[i] = c[4];
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(lagr.slice(), 3));
    geo.setAttribute('aLagrangian', new THREE.BufferAttribute(lagr, 3));
    geo.setAttribute('aRichness', new THREE.BufferAttribute(rich, 1));
    geo.setAttribute('aRadius', new THREE.BufferAttribute(radius, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), boxSize * 2.5);

    this.clusterMaterial = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        // Sprite half-width, as a multiple of the cluster's measured RMS core
        // radius. The beta core sits at about a fifth of the sprite, so the
        // profile is carried out to roughly five core radii — far enough that
        // the wings fade rather than meeting an edge.
        //
        // Wider was tried and is worse. At 4.2 the sprites cover the filament
        // junctions they are supposed to mark: the frame reads as a field of
        // soft bokeh with a web behind it, rather than as a web with bright
        // knots at its intersections. A node has to leave the structure around
        // it visible or it is not showing you a node.
        uSizeScale: { value: 1.9 },
        uMaxPx: { value: 160.0 },
        uRefPx: { value: 32.0 },
        uFade: { value: 1 },
        uExtinction: { value: 1.0 / 11.0 },
        // Gold, continuous with the node end of the tracers' density ramp, so
        // the object and the medium agree about what a collapsed region looks
        // like. The halo runs slightly cooler and redder toward the wings.
        uCoreColor: { value: new THREE.Color(1.00, 0.80, 0.42) },
        uHaloColor: { value: new THREE.Color(0.92, 0.42, 0.15) },
        // Set against the tracers' uIntensity so a cluster sits clearly above
        // the filament feeding it without reaching the level where AgX starts
        // rolling a saturated colour toward white. Measured from the frames,
        // not guessed — see round-11's verdict.
        uBrightness: { value: 20.0 },
      },
      vertexShader: CLUSTER_VERT,
      fragmentShader: CLUSTER_FRAG,
      transparent: true,
      // Premultiplied additive. THREE.AdditiveBlending is SrcAlpha/One, which
      // would multiply the emitted colour by alpha a second time — see the note
      // at the end of CLUSTER_FRAG for what that cost.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      depthWrite: false,
      depthTest: false,
    });

    this.clusters = new THREE.Points(geo, this.clusterMaterial);
    this.clusters.frustumCulled = false;
    // Above the tracers, below the galaxies: a cluster is made of the medium,
    // and the galaxies in it should still read on top.
    this.clusters.renderOrder = 2;
    this.group.add(this.clusters);
  }

  _buildGalaxies(rng, boxSize, n) {
    const lagr = new Float32Array(n * 3);
    const seeds = new Float32Array(n);
    const sizes = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const dir = rng.onSphere();
      const rr = Math.cbrt(rng.next()) * boxSize * 0.5;
      lagr[i * 3] = dir.x * rr;
      lagr[i * 3 + 1] = dir.y * rr;
      lagr[i * 3 + 2] = dir.z * rr;
      seeds[i] = rng.next();
      // Schechter-like: many faint, few bright.
      sizes[i] = 0.0016 + Math.pow(rng.next(), 3.4) * 0.020;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(lagr.slice(), 3));
    geo.setAttribute('aLagrangian', new THREE.BufferAttribute(lagr, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), boxSize * 2.5);

    this.galaxyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        ...this._shared,
        // Large enough that galaxies close to the eye actually resolve their
        // disc instead of being clamped to a pixel and wasting the morphology.
        uSizeScale: { value: 1.6 },
        // Tighter onto genuinely collapsed regions, so the population traces the
        // filaments rather than dusting the sheets as well.
        uThreshold: { value: 1.75 },
        // Raised because flux conservation now removes most of what this used to
        // emit. The net effect is a steep luminosity function — a few bright
        // galaxies in the nodes, the rest sinking into the medium — rather than
        // 26k identical dots at one brightness.
        uBrightness: { value: 0.15 },
      },
      vertexShader: GAL_VERT,
      fragmentShader: GAL_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    this.galaxies = new THREE.Points(geo, this.galaxyMaterial);
    this.galaxies.frustumCulled = false;
    this.galaxies.renderOrder = 3;
    this.group.add(this.galaxies);
  }

  get object3d() {
    return this.group;
  }

  /** `t` runs from a smooth early universe through the present and beyond. */
  setEpoch(t) {
    this.cosmicTime = t;
  }

  update(dt, time, camera) {
    if (!this.paused) this.cosmicTime += dt * this.timeScale;
    const t = Math.max(0.001, this.cosmicTime);

    this.material.uniforms.uTime.value = time;

    // Matter-dominated growth D ∝ a ∝ t^(2/3), then a late-time Λ plateau —
    // structure formation genuinely does freeze out as expansion accelerates,
    // which is why the web has looked much the same for billions of years.
    const a = Math.pow(t, 2 / 3);
    const D = a / (1 + 0.5 * Math.pow(a, 3));
    this._shared.uGrowth.value = D * 3.4;
    // Proper distance grows with a(t), but the framing is held nearly fixed so
    // the viewer reads collapse rather than a zoom-out.
    this._shared.uScaleFactor.value = 0.90 + a * 0.12;

    // Galaxies light up as their host haloes assemble.
    this.galaxyMaterial.uniforms.uThreshold.value = 1.30 + 0.35 * Math.min(1, a);
  }

  setViewportHeight(h) {
    this._shared.uViewportH.value = h;
  }

  setIntensity(v) {
    this.material.uniforms.uIntensity.value = v;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
    this.galaxies.geometry.dispose();
    this.galaxyMaterial.dispose();
    if (this.clusters) {
      this.clusters.geometry.dispose();
      this.clusterMaterial.dispose();
    }
  }
}
