/**
 * Nebulae — a raymarched emitting, absorbing, scattering medium.
 *
 * Everything else in this realm is points. A nebula is not: it is gas, and gas
 * has to be integrated along the line of sight or it never stops looking like a
 * decal. So each nebula is a bounded volume that a fragment shader walks
 * through, accumulating radiance and losing it to extinction:
 *
 *     dI/ds = -sigma_t(s) I + sigma_s(s) * p(theta) * E(s) + j(s)
 *
 * Three physical commitments do almost all of the visual work here, and none of
 * them are style choices:
 *
 *  1. EMISSION IS LINE EMISSION, NOT A GRADIENT. Interstellar gas does not glow
 *     like a blackbody; it glows in recombination lines at fixed wavelengths.
 *     Hydrogen alpha at 656 nm is crimson, doubly-ionised oxygen at 500.7 nm is
 *     teal, singly-ionised sulphur at 672 nm is deeper red still. Which line
 *     dominates depends on the ionisation parameter U ~ flux / density: right up
 *     against a hot O star the gas is stripped hard enough to show [OIII] and
 *     reads blue-green, further out and denser it recombines and reads red.
 *     That single ratio is why every Hubble image of a star-forming region has
 *     a teal throat and crimson walls, and getting it from the physics means it
 *     lands in the right places automatically.
 *
 *  2. LIGHT HAS TO TRAVEL THROUGH THE MEDIUM TO GET HERE. A short secondary
 *     march from each sample toward each embedded star, attenuated by
 *     Beer-Lambert, is what produces shafts, rim-lit cavity walls and the
 *     darkness inside a pillar. Without it a nebula is uniformly lit and looks
 *     like coloured smoke. With it, a hot star that has blown a bubble in the
 *     cloud lights the inside of that bubble and nothing beyond it — which is
 *     the entire composition of the Pillars of Creation.
 *
 *  3. EXTINCTION IS CHROMATIC. Dust grains are comparable in size to blue
 *     light, so blue is scattered out of the beam far more than red. Light
 *     leaving the far side of the cloud arrives reddened. This is the reason
 *     the interior of a dusty nebula goes amber rather than grey.
 *
 * On banding, which is the failure mode that matters on an OLED
 * ------------------------------------------------------------
 * A raymarch with N steps is a quadrature rule, and any quadrature rule with a
 * fixed step lattice writes its lattice into the image as concentric shells.
 * At 8 bits, in near-black, those shells are brutally visible. Four defences,
 * all of them here:
 *
 *   - The first sample is offset by an interleaved-gradient-noise fraction of a
 *     step, so neighbouring pixels sit at different phases of the lattice and
 *     the banding becomes high-frequency noise instead of contours.
 *   - That offset is advanced every frame by the golden ratio, so even the
 *     residual noise decorrelates over time and the eye integrates it away.
 *   - Emission is integrated ANALYTICALLY across each step rather than by a
 *     rectangle rule: for constant source and extinction the integral is
 *     (L/sigma)(1 - exp(-sigma ds)), which is exact and therefore has no
 *     step-count-dependent bias to quantise. This alone removes most of the
 *     shelling that naive marching produces at low step counts.
 *   - The density field is C1 everywhere. No hard iso-surfaces, no narrow
 *     smoothstep: a sharp threshold crossed by a coarse lattice IS a contour
 *     band. The thresholds here are deliberately wide.
 *
 * A final +-0.5 LSB dither goes out with the fragment, on top of the one the
 * post chain applies, because this shader writes the darkest gradients in the
 * project.
 */

import * as THREE from 'three';
import { GLSL_LIB } from '../shaders/common.js';
import { Rng } from '../core/Rng.js';
import { settings } from '../core/Settings.js';

/** Numeric so the shader can branch on it directly. */
export const NebulaType = {
  EMISSION: 0,
  REFLECTION: 1,
  DARK: 2,
  PLANETARY: 3,
  REMNANT: 4,
};

export const NEBULA_TYPE_NAMES = ['emission', 'reflection', 'dark', 'planetary', 'remnant'];

const MAX_LIGHTS = 3;

const NEB_VERT = /* glsl */ `
precision highp float;
varying vec3 vWorld;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const NEB_FRAG = /* glsl */ `
precision highp float;
${GLSL_LIB}

#define MAX_STEPS 96
#define MAX_LIGHT_STEPS 8
#define MAX_LIGHTS ${MAX_LIGHTS}

uniform mat3  uInvRot;       // world -> volume-local rotation
uniform vec3  uCenter;       // world-space centre
uniform vec3  uExtent;       // local half-extents, world units
uniform float uTime;
uniform float uFrame;
uniform int   uSteps;
uniform int   uLightSteps;
uniform int   uOctaves;
uniform int   uType;

uniform float uSigma;        // extinction coefficient per world unit at density 1
uniform vec3  uExtinctRGB;   // wavelength dependence of extinction (blue > red)
uniform float uEmission;
uniform float uScatterAmt;
uniform float uNoiseScale;
uniform float uWarp;
uniform float uPillar;
uniform float uCellMix;
uniform float uThreshold;
uniform float uContrast;
uniform float uAniso;
uniform float uSeed;
uniform float uFade;
uniform float uBackdrop;     // mean radiance of whatever sits behind this volume
uniform float uFlow;         // internal turbulent drift

uniform vec3  uLightPos[MAX_LIGHTS];
uniform vec3  uLightColor[MAX_LIGHTS];
uniform float uLightRadius[MAX_LIGHTS];
uniform int   uLightCount;

uniform vec3  uEmitA;        // low-ionisation line colour  (H-alpha + [NII])
uniform vec3  uEmitB;        // high-ionisation line colour ([OIII])
uniform vec3  uEmitC;        // shock line colour           ([SII])
uniform vec3  uScatterAlbedo;
uniform float uIonLo;
uniform float uIonHi;

uniform vec3  uEchoPos;      // supernova light echo, world space
uniform vec3  uEchoColor;
uniform float uEchoRadius;
uniform float uEchoWidth;

varying vec3 vWorld;

// --- shape --------------------------------------------------------------------
// The envelope is what makes a nebula a *kind* of object rather than a blob of
// noise. Each of these is the geometry the physics actually produces.
float envelope(vec3 p){
  float r = length(p);

  if (uType == 3){
    // Planetary nebula. An AGB star sheds a slow, dense equatorial torus, then
    // the exposed core's fast wind escapes along the poles and inflates two
    // lobes. Bipolarity is not decoration — it is the torus doing the
    // collimating, which is why so few planetaries are actually round.
    float rho = length(p.xz);
    float lat = abs(p.y) / max(r, 1e-3);
    float shell = exp(-sqr((r - 0.58) / 0.16));
    float waist = exp(-sqr((rho - 0.34) / 0.14)) * exp(-sqr(p.y / 0.12));
    float lobe  = exp(-sqr((r - 0.50 - 0.34 * lat * lat) / 0.20)) * (lat * lat);
    return (shell * 0.50 + waist * 1.30 + lobe * 1.15) * (1.0 - smoothstep(0.86, 1.20, r));
  }

  if (uType == 4){
    // Supernova remnant. A thin blast shell, corrugated by the Rayleigh-Taylor
    // instability at the contact discontinuity between ejecta and swept-up ISM.
    // That instability is why Cas A and the Veil are filaments and not a bubble.
    float shell = exp(-sqr((r - 0.76) / 0.115));
    return shell * (1.0 - smoothstep(0.90, 1.12, r));
  }

  if (uType == 2){
    // Bok globule / elephant trunk. A dense head that survived photoevaporation
    // because it was thick enough to shield itself, trailing a tail of material
    // it protected. The head is offset toward the ionising source.
    vec3 q = p - vec3(0.0, 0.0, -0.22);
    float head = exp(-dot(q, q) * 3.2);
    float tail = exp(-sqr((p.z - 0.42) / 0.52)) * exp(-(p.x * p.x + p.y * p.y) * 6.5);
    return (head + tail * 0.60) * (1.0 - smoothstep(0.80, 1.15, r));
  }

  // Emission / reflection: a giant molecular cloud, centrally condensed and
  // fading into the intercloud medium rather than ending at a surface.
  return exp(-r * r * 1.45) * (1.0 - smoothstep(0.70, 1.22, r));
}

// The cavity an embedded OB association has blown. Ionising flux destroys
// molecular gas, so the densest material is a shell at the wall of the bubble —
// exactly where the light is strongest. Rim-lit walls come out of this for free.
float cavity(vec3 pw){
  float c = 1.0;
  for (int i = 0; i < MAX_LIGHTS; i++){
    if (i >= uLightCount) break;
    float d = length(pw - uLightPos[i]);
    c *= smoothstep(uLightRadius[i] * 0.30, uLightRadius[i] * 1.05, d);
  }
  return c;
}

float densityAt(vec3 pw){
  vec3 pn = pw / uExtent;
  float env = envelope(pn);
  if (env <= 0.0025) return 0.0;

  vec3 q = pn * uNoiseScale + vec3(uSeed, uSeed * 1.7, uSeed * 2.3);

  // Radial stretch away from the dominant illuminator. Dense clumps shadow the
  // gas behind them, so molecular material survives in columns that point back
  // at the star while everything beside them is evaporated. Compressing the
  // noise domain along that axis stretches structure along it, which is a very
  // cheap stand-in for the radiation hydrodynamics and lands the pillars
  // pointing the right way every time.
  if (uLightCount > 0 && uPillar > 0.001){
    vec3 rel = pn - uLightPos[0] / uExtent;
    float rl = length(rel);
    if (rl > 1e-4){
      vec3 dn = rel / rl;
      q -= dn * dot(q, dn) * uPillar;
    }
  }

  // Slow internal drift. Molecular clouds are turbulent and the eye reads even
  // imperceptible motion as "this is a fluid" rather than "this is a texture".
  q += vec3(0.0, uTime * uFlow, uTime * uFlow * 0.6);

  // Domain warp. Straight fbm reads as noise; warped fbm reads as gas that has
  // been sheared by something.
  vec3 w = vec3(snoise(q * 0.55 + 13.1), snoise(q * 0.55 + 27.7), snoise(q * 0.55 + 41.3));
  q += w * uWarp;

  float f = fbm(q, uOctaves) * 0.5 + 0.5;

  // Worley F1 supplies the voids. Supersonic turbulence is full of cavities
  // blown by protostellar outflows, and it is those bubbles — not the fine
  // grain — that give a cloud its sense of scale.
  float cell = clamp(worley(q * 0.62).x * 1.35, 0.0, 1.0);
  float d = f * mix(1.0, cell, uCellMix);

  // Deliberately WIDE. A narrow threshold is a hard iso-surface, and a hard
  // iso-surface crossed by a coarse step lattice is a contour band.
  d = smoothstep(uThreshold, uThreshold + 0.55, d);
  d = pow(d, uContrast);

  return d * env * cavity(pw);
}

// --- lighting -----------------------------------------------------------------

vec3 shadowTrans(vec3 pw, vec3 L, float maxD, float dither){
  float ds = maxD / float(uLightSteps);
  float tau = 0.0;
  // The shadow ray gets its own jitter. Otherwise the shadow bands even when
  // the primary march does not, and shadow bands are worse: they are shaped
  // like the light and read as geometry.
  float t = ds * (0.25 + 0.5 * dither);
  for (int i = 0; i < MAX_LIGHT_STEPS; i++){
    if (i >= uLightSteps) break;
    tau += densityAt(pw + L * t);
    t += ds;
  }
  return exp(-tau * ds * uSigma * uExtinctRGB);
}

/**
 * Radiance emitted toward the camera from one sample of the medium.
 * `dens` is the local density, `rd` the view direction.
 */
vec3 mediumRadiance(vec3 pw, vec3 rd, float dens, float dither, float shell){
  vec3 scattered = vec3(0.0);
  float ionisation = 0.0;
  float irradiance = 0.0;

  for (int i = 0; i < MAX_LIGHTS; i++){
    if (i >= uLightCount) break;
    vec3 rel = uLightPos[i] - pw;
    float dist = length(rel) + 1e-6;
    vec3 L = rel / dist;

    vec3 tr = shadowTrans(pw, L, min(dist, length(uExtent) * 1.1), dither);
    // Inverse square, softened inside the star's own radius so the singularity
    // never blows the tonemapper out.
    float geo = 1.0 / (1.0 + dist * dist / max(uLightRadius[i] * uLightRadius[i], 1e-8) * 0.35);
    vec3 E = uLightColor[i] * geo * tr;

    // Henyey-Greenstein. Dust is strongly forward scattering (g ~ 0.6), which
    // is why a reflection nebula flares when the illuminating star is nearly
    // behind it and why the shafts have direction rather than being a haze.
    float ph = hgPhase(dot(L, rd), uAniso) * 4.0 * PI;
    scattered += E * ph;

    // Ionisation parameter, U ~ flux / number density. This ratio, not any
    // colour ramp, is what decides whether a parcel of gas glows teal or red.
    irradiance += lum(E);
    ionisation += lum(E) / (dens + 0.06);
  }

  // Supernova light echo: a shell of illumination expanding at c through the
  // cloud. It lights whatever it is currently passing through and nothing else,
  // which is why real light echoes appear to move faster than any physical
  // object could.
  if (uEchoRadius > 0.0){
    float de = abs(length(pw - uEchoPos) - uEchoRadius);
    float e = exp(-sqr(de / max(uEchoWidth, 1e-4)));
    scattered += uEchoColor * e * 4.0;
    irradiance += lum(uEchoColor) * e;
    ionisation += lum(uEchoColor) * e / (dens + 0.06);
  }

  vec3 emit = vec3(0.0);

  if (uType == 4){
    // Remnant emission is collisional, not photoionised: the blast wave is
    // doing the exciting. Fast shocks show [OIII] and read teal, slow shocks
    // radiate in [SII]/H-alpha and read crimson, and both live side by side in
    // the same filament bundle. The Veil is the reference.
    float fast = fbm(pw / uExtent * 3.1 + uSeed, 3) * 0.5 + 0.5;
    vec3 lineCol = mix(uEmitC, uEmitB, smoothstep(0.42, 0.78, fast));
    lineCol = mix(lineCol, uEmitA, 0.28);
    emit = lineCol * pow(dens, 1.55) * (0.55 + 1.6 * shell);
  } else if (uType == 0 || uType == 3){
    // Recombination lines only exist where the gas is ionised, so the line
    // emissivity tracks the irradiance, not the density. Then the hardness of
    // the radiation field picks the colour.
    float u = ionisation;
    vec3 lineCol = mix(uEmitA, uEmitB, smoothstep(uIonLo, uIonHi, u));
    // Deep in the neutral interior the only thing that survives is [SII], and
    // it is what gives the shadowed walls their bruised red rather than black.
    lineCol = mix(uEmitC, lineCol, smoothstep(0.0, uIonLo * 0.6, u));
    emit = lineCol * irradiance * dens;
  } else if (uType == 2){
    // Dark nebula: essentially no emission of its own, only a thin ionised skin
    // where the outside radiation field is eating into it. The bright rim on a
    // black silhouette is the whole reason these read as three-dimensional.
    emit = uEmitA * irradiance * dens * 0.22;
  }

  return emit * uEmission + scattered * uScatterAlbedo * uScatterAmt * dens;
}

// --- march --------------------------------------------------------------------

void main(){
  vec3 ro = cameraPosition;
  vec3 rdW = normalize(vWorld - ro);

  // Into the volume's own frame. uInvRot is the transpose of a pure rotation,
  // supplied from the CPU because GLSL cannot see the object's inverse matrix.
  vec3 lo = uInvRot * (ro - uCenter);
  vec3 ld = uInvRot * rdW;

  // Analytic slab intersection against the local box.
  vec3 inv = 1.0 / (ld + vec3(equal(ld, vec3(0.0))) * 1e-9);
  vec3 t0v = (-uExtent - lo) * inv;
  vec3 t1v = ( uExtent - lo) * inv;
  vec3 tmin = min(t0v, t1v);
  vec3 tmax = max(t0v, t1v);
  float tn = max(max(tmin.x, tmin.y), tmin.z);
  float tf = min(min(tmax.x, tmax.y), tmax.z);
  if (tf <= max(tn, 0.0)) discard;
  tn = max(tn, 0.0);

  float span = tf - tn;
  float ds = span / float(uSteps);

  // Interleaved gradient noise, advanced by the golden ratio each frame. The
  // first breaks the step lattice spatially, the second breaks it temporally;
  // together they turn what would be concentric shells into noise that the eye
  // integrates to smooth.
  float dither = fract(ign(gl_FragCoord.xy) + uFrame * 0.6180339887);

  float t = tn + ds * dither;

  vec3 acc = vec3(0.0);
  vec3 trans = vec3(1.0);

  for (int i = 0; i < MAX_STEPS; i++){
    if (i >= uSteps) break;
    vec3 p = lo + ld * t;
    float d = densityAt(p);

    if (d > 0.0015){
      // Distance to the shell surface, used by the remnant to brighten the
      // limb the way an optically thin shell genuinely does.
      float shell = d;
      vec3 L = mediumRadiance(p, ld, d, dither, shell);
      vec3 sigmaT = max(d * uSigma * uExtinctRGB, vec3(1e-6));

      // Analytic integration of emission across the step. Exact for constant
      // source and extinction, so it carries no step-count bias to quantise
      // into shells — this is the single most effective anti-banding measure
      // in the shader.
      vec3 stepT = exp(-sigmaT * ds);
      vec3 integ = (L - L * stepT) / sigmaT;

      acc += trans * integ;
      trans *= stepT;

      if (max(trans.r, max(trans.g, trans.b)) < 0.004) break;
    }
    t += ds;
  }

  // Compositing uses a scalar alpha (the framebuffer cannot give us a
  // per-channel multiply and an add in the same pass), so the background is
  // attenuated by the luminance-weighted transmittance. The chromatic part of
  // the extinction is fully modelled INSIDE the volume, where it matters most:
  // the far side of the cloud reaches us reddened. What the grey alpha loses is
  // the reddening of whatever sits behind the cloud, so we add that back as a
  // first-order correction against an estimate of the backdrop — this is what
  // makes stars seen through a dark globule go amber instead of just dim.
  float tGrey = clamp(lum(trans), 0.0, 1.0);
  vec3 redden = max(trans - vec3(tGrey), 0.0) * uBackdrop;
  acc += redden;

  vec3 col = acc * uFade;
  float alpha = (1.0 - tGrey) * uFade;

  // Dither before the half-float write. Cheap insurance: the post chain dithers
  // again at 8-bit, but this shader writes the darkest gradients in the project
  // and it is worth breaking them up twice.
  col += (ign(gl_FragCoord.xy + uFrame * 7.0) - 0.5) * 1.5e-3 * alpha;

  gl_FragColor = vec4(max(col, 0.0), clamp(alpha, 0.0, 1.0));
}
`;

// --- the class ----------------------------------------------------------------

/** Line colours, in linear sRGB. These are the real wavelengths, not a palette. */
const HALPHA = new THREE.Vector3(1.00, 0.115, 0.150); // 656.3 nm + [NII] 658.4
const OIII = new THREE.Vector3(0.085, 1.00, 0.640);   // 500.7 nm
const SII = new THREE.Vector3(0.90, 0.055, 0.075);    // 671.6 / 673.1 nm
const DUST_BLUE = new THREE.Vector3(0.36, 0.55, 1.00); // Rayleigh-ish grain scattering

export class Nebula {
  /**
   * @param {object} opts
   *   seed      deterministic identity
   *   type      NebulaType.*  (omit to derive from the seed)
   *   size      half-extent in world units (a molecular cloud complex is ~0.05 kpc)
   *   position  THREE.Vector3, world
   *   lights    [{pos:Vector3 local, color:Vector3 HDR, radius:number}]
   *   quality   0..1 multiplier on the step budget
   */
  constructor(opts = {}) {
    const seed = opts.seed ?? 1;
    const rng = new Rng(seed);
    this.seed = seed;

    this.type = opts.type ?? this._rollType(rng);
    this.typeName = NEBULA_TYPE_NAMES[this.type];

    const size = opts.size ?? 0.06;
    // Nebulae are never spherical. Give each one an aspect ratio and a random
    // orientation so a field of them never reads as a row of identical balls.
    this.extent = new THREE.Vector3(
      size * rng.range(0.75, 1.35),
      size * rng.range(0.55, 1.05),
      size * rng.range(0.75, 1.35)
    );
    if (this.type === NebulaType.REMNANT || this.type === NebulaType.PLANETARY) {
      // Shells are much closer to round; the asymmetry lives in the envelope.
      this.extent.set(size * rng.range(0.92, 1.1), size * rng.range(0.88, 1.14), size * rng.range(0.92, 1.1));
    }

    this.group = new THREE.Group();
    if (opts.position) this.group.position.copy(opts.position);
    this.group.quaternion.setFromEuler(
      new THREE.Euler(rng.range(0, Math.PI * 2), rng.range(0, Math.PI * 2), rng.range(0, Math.PI * 2))
    );

    this._lights = [];
    this._buildLights(rng, opts.lights);

    this.quality = opts.quality ?? 1;
    this._buildVolume(rng);
    this._buildStars();

    this._frame = rng.next() * 64;
    this._invRot = new THREE.Matrix3();
    this._q = new THREE.Quaternion();
    this._m4 = new THREE.Matrix4();
    this._distance = 0;
    this.visibleRange = opts.visibleRange ?? size * 900;
  }

  _rollType(rng) {
    // Weighted by what actually populates a spiral disc: star-forming complexes
    // and their attendant dark clouds vastly outnumber the exotica.
    return rng.weighted(
      [NebulaType.EMISSION, NebulaType.REFLECTION, NebulaType.DARK, NebulaType.PLANETARY, NebulaType.REMNANT],
      [0.46, 0.16, 0.20, 0.10, 0.08]
    );
  }

  _buildLights(rng, override) {
    if (override && override.length) {
      this._lights = override.slice(0, MAX_LIGHTS).map((l) => ({
        pos: l.pos.clone(),
        color: l.color.clone(),
        radius: l.radius,
        temp: l.temp ?? 30000,
      }));
      return;
    }

    const e = this.extent;
    let n = 1;
    let tempRange = [22000, 44000];
    let power = 1.0;

    if (this.type === NebulaType.EMISSION) {
      // An OB association, not a single star. Trapezium-like multiples are the
      // rule, and multiple sources are what give the cavity walls their
      // crossing shadows.
      n = rng.int(1, 3);
      tempRange = [26000, 46000];
      power = rng.range(1.6, 3.4);
    } else if (this.type === NebulaType.REFLECTION) {
      n = 1;
      tempRange = [9000, 17000]; // B stars: too cool to ionise, hot enough to reflect
      power = rng.range(0.7, 1.5);
    } else if (this.type === NebulaType.DARK) {
      // Illuminated from outside — the source sits beyond the globule and is
      // what is eating it.
      n = 1;
      tempRange = [30000, 44000];
      power = rng.range(0.5, 1.1);
    } else if (this.type === NebulaType.PLANETARY) {
      // The exposed degenerate core. Extremely hot, tiny, and the reason
      // planetaries are the most strongly [OIII]-dominated objects in the sky.
      n = 1;
      tempRange = [70000, 140000];
      power = rng.range(1.2, 2.2);
    } else {
      // Remnant: the neutron star, if it is still there. Contributes little
      // photoionisation; the shell is shock-excited.
      n = rng.bool(0.6) ? 1 : 0;
      tempRange = [200000, 900000];
      power = rng.range(0.2, 0.6);
    }

    for (let i = 0; i < n; i++) {
      const temp = rng.range(tempRange[0], tempRange[1]);
      const col = blackbodyLinear(temp);
      // Luminosity scales steeply with temperature on the upper main sequence.
      const scale = power * Math.pow(temp / 30000, 1.4) * 0.85;
      let pos;
      if (this.type === NebulaType.DARK) {
        // Outside the globule, on the far side from the tail.
        pos = new THREE.Vector3(rng.range(-0.3, 0.3), rng.range(-0.3, 0.3), -1.9).multiply(e);
      } else if (this.type === NebulaType.PLANETARY || this.type === NebulaType.REMNANT) {
        pos = new THREE.Vector3(0, 0, 0);
      } else {
        pos = new THREE.Vector3(rng.range(-0.42, 0.42), rng.range(-0.3, 0.3), rng.range(-0.42, 0.42)).multiply(e);
      }
      this._lights.push({
        pos,
        color: new THREE.Vector3(col.x * scale, col.y * scale, col.z * scale),
        radius: (this.type === NebulaType.PLANETARY ? 0.06 : 0.28) * Math.min(e.x, e.z),
        temp,
      });
    }
  }

  _buildVolume(rng) {
    const vol = settings.volumetrics;
    // Budget from the tier, floored so the lowest tier still marches rather
    // than falling back to a sprite. 16 steps with the analytic integrator and
    // a dithered offset is genuinely usable; 16 steps without them is not.
    const steps = Math.round(THREE.MathUtils.lerp(16, 88, vol) * this.quality);
    const lightSteps = vol < 0.5 ? 3 : vol < 0.9 ? 5 : 6;
    const octaves = vol < 0.45 ? 3 : vol < 0.9 ? 4 : 5;

    const meanExtent = (this.extent.x + this.extent.y + this.extent.z) / 3;

    const t = this.type;
    const emissive = t === NebulaType.EMISSION || t === NebulaType.PLANETARY || t === NebulaType.REMNANT;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uInvRot: { value: new THREE.Matrix3() },
        uCenter: { value: this.group.position.clone() },
        uExtent: { value: this.extent.clone() },
        uTime: { value: 0 },
        uFrame: { value: 0 },
        uSteps: { value: steps },
        uLightSteps: { value: lightSteps },
        uOctaves: { value: octaves },
        uType: { value: t },

        // Optical depth across the whole volume should land near unity for a
        // translucent cloud and well above it for a dark one. Dividing by the
        // extent keeps that true whatever size the nebula is.
        uSigma: {
          value:
            (t === NebulaType.DARK ? rng.range(7.0, 12.0)
              : t === NebulaType.REMNANT ? rng.range(0.8, 1.5)
              : t === NebulaType.PLANETARY ? rng.range(0.9, 1.6)
              : rng.range(2.4, 4.6)) / (meanExtent * 2),
        },
        // Extinction rises toward the blue roughly as 1/lambda for interstellar
        // grains, which is why everything seen through dust reddens.
        uExtinctRGB: { value: new THREE.Vector3(0.72, 0.95, 1.34) },
        uEmission: { value: emissive ? rng.range(0.55, 1.15) : t === NebulaType.DARK ? 0.35 : 0.10 },
        uScatterAmt: { value: t === NebulaType.REFLECTION ? rng.range(1.6, 2.8) : rng.range(0.30, 0.60) },

        uNoiseScale: { value: rng.range(2.3, 4.1) },
        uWarp: { value: rng.range(0.45, 1.05) },
        uPillar: { value: t === NebulaType.EMISSION ? rng.range(0.30, 0.62) : t === NebulaType.DARK ? 0.45 : 0.0 },
        uCellMix: { value: t === NebulaType.REMNANT ? 0.72 : rng.range(0.35, 0.7) },
        uThreshold: { value: t === NebulaType.DARK ? 0.30 : rng.range(0.36, 0.50) },
        uContrast: { value: t === NebulaType.REMNANT ? 1.9 : rng.range(1.1, 1.7) },
        uAniso: { value: t === NebulaType.REFLECTION ? 0.72 : 0.52 },
        uSeed: { value: rng.range(0, 40) },
        uFade: { value: 1 },
        // A rough estimate of the surface brightness behind the volume, used
        // only for the reddening correction. Set by the realm if it knows better.
        uBackdrop: { value: 0.05 },
        uFlow: { value: rng.range(0.004, 0.016) },

        uLightPos: { value: padVec3(this._lights.map((l) => l.pos), MAX_LIGHTS) },
        uLightColor: { value: padVec3(this._lights.map((l) => l.color), MAX_LIGHTS) },
        uLightRadius: { value: padNum(this._lights.map((l) => l.radius), MAX_LIGHTS, 0.01) },
        uLightCount: { value: this._lights.length },

        uEmitA: { value: HALPHA.clone() },
        uEmitB: { value: OIII.clone() },
        uEmitC: { value: SII.clone() },
        uScatterAlbedo: {
          value:
            t === NebulaType.REFLECTION
              ? DUST_BLUE.clone()
              : new THREE.Vector3(0.55, 0.60, 0.80),
        },
        // Where the [OIII]/H-alpha transition sits. Planetaries are ionised
        // vastly harder than HII regions, so their whole body is above it.
        uIonLo: { value: t === NebulaType.PLANETARY ? 0.03 : 0.35 },
        uIonHi: { value: t === NebulaType.PLANETARY ? 0.30 : 3.2 },

        uEchoPos: { value: new THREE.Vector3() },
        uEchoColor: { value: new THREE.Vector3() },
        uEchoRadius: { value: 0 },
        uEchoWidth: { value: meanExtent * 0.08 },
      },
      vertexShader: NEB_VERT,
      fragmentShader: NEB_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.BackSide,
      // Premultiplied emission-over-transmittance: dst = src + dst*(1-alpha).
      // This is the compositing law the radiative transfer equation actually
      // produces, and it is what lets a dark nebula subtract light with the
      // same shader that lets an emission nebula add it.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
    });

    const geo = new THREE.BoxGeometry(2, 2, 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.scale.copy(this.extent);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 40;
    this.group.add(this.mesh);
  }

  /**
   * The illuminating stars themselves, as HDR points. Without them the light
   * has no visible source and the shafts read as fog rather than as a beam
   * coming from something.
   */
  _buildStars() {
    if (!this._lights.length) return;
    const n = this._lights.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const siz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const l = this._lights[i];
      pos[i * 3] = l.pos.x; pos[i * 3 + 1] = l.pos.y; pos[i * 3 + 2] = l.pos.z;
      const b = Math.cbrt(Math.max(l.color.x, l.color.y, l.color.z)) * 2.4;
      col[i * 3] = l.color.x / b; col[i * 3 + 1] = l.color.y / b; col[i * 3 + 2] = l.color.z / b;
      siz[i] = l.radius * 0.9;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), this.extent.length() * 2);

    this.starMaterial = new THREE.ShaderMaterial({
      uniforms: { uViewportH: { value: 900 }, uFade: { value: 1 }, uGain: { value: 26 } },
      vertexShader: /* glsl */ `
        precision highp float;
        attribute vec3 aColor;
        attribute float aSize;
        uniform float uViewportH;
        varying vec3 vCol;
        void main(){
          vCol = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(aSize * uViewportH / max(-mv.z, 1e-5), 2.0, 90.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${GLSL_LIB}
        uniform float uFade;
        uniform float uGain;
        varying vec3 vCol;
        void main(){
          vec2 uv = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(uv, uv);
          if (r2 > 1.0) discard;
          // Tight core plus a wide skirt. The skirt is the seeing disc; the post
          // chain turns it into the bloom, so nothing is baked in here.
          float core = exp(-r2 * 22.0);
          float halo = exp(-r2 * 2.4) * 0.16;
          float a = core + halo;
          gl_FragColor = vec4(vCol * a * uGain * uFade, a * uFade);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    this.stars = new THREE.Points(geo, this.starMaterial);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = 41;
    this.group.add(this.stars);
  }

  get object3d() {
    return this.group;
  }

  /** World-space centre. */
  get position() {
    return this.group.position;
  }

  setViewportHeight(h) {
    if (this.starMaterial) this.starMaterial.uniforms.uViewportH.value = h;
  }

  /** Radiance of whatever the volume is silhouetted against. Drives reddening. */
  setBackdrop(v) {
    this.material.uniforms.uBackdrop.value = v;
  }

  /**
   * A supernova echo passing through. `radius` is the distance light has
   * travelled since the explosion; pass 0 to switch it off.
   */
  setEcho(worldPos, color, radius, width) {
    const u = this.material.uniforms;
    if (radius <= 0) { u.uEchoRadius.value = 0; return; }
    this._m4.copy(this.group.matrixWorld).invert();
    u.uEchoPos.value.copy(worldPos).applyMatrix4(this._m4);
    u.uEchoColor.value.set(color.x ?? color.r, color.y ?? color.g, color.z ?? color.b);
    u.uEchoRadius.value = radius;
    if (width) u.uEchoWidth.value = width;
  }

  /**
   * `distance` lets the caller spend steps where they are visible. A nebula
   * covering four pixels does not need 88 samples; one filling the screen does.
   */
  update(dt, time, camera) {
    const u = this.material.uniforms;
    u.uTime.value = time;
    this._frame += 1;
    u.uFrame.value = this._frame;

    this.group.updateMatrixWorld();
    // The inverse of a pure rotation is its transpose; extracting it from the
    // quaternion avoids inverting the scaled matrix.
    this._q.copy(this.group.quaternion).invert();
    this._m4.makeRotationFromQuaternion(this._q);
    u.uInvRot.value.setFromMatrix4(this._m4);
    u.uCenter.value.copy(this.group.position);
    u.uExtent.value.copy(this.extent);

    if (camera) {
      const d = camera.position.distanceTo(this.group.position);
      this._distance = d;
      const r = Math.max(this.extent.x, Math.max(this.extent.y, this.extent.z));
      // Angular size, in radians-ish. Step budget follows it directly.
      const ang = r / Math.max(d, r * 0.25);
      const q = THREE.MathUtils.clamp(ang * 5.5, 0.16, 1.0) * this.quality;
      const vol = settings.volumetrics;
      u.uSteps.value = Math.max(10, Math.round(THREE.MathUtils.lerp(16, 88, vol) * q));
      // Fade out rather than pop out, and stop marching entirely once the
      // contribution is below the dither floor.
      const fade = 1 - THREE.MathUtils.smoothstep(d, this.visibleRange * 0.75, this.visibleRange);
      u.uFade.value = fade;
      this.mesh.visible = fade > 0.004;
      if (this.stars) {
        this.stars.visible = fade > 0.004;
        this.starMaterial.uniforms.uFade.value = fade;
      }
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    if (this.stars) {
      this.stars.geometry.dispose();
      this.starMaterial.dispose();
    }
  }
}

// --- helpers ------------------------------------------------------------------

function padVec3(arr, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[i] ? arr[i].clone() : new THREE.Vector3());
  return out;
}
function padNum(arr, n, def) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = arr[i] ?? def;
  return out;
}

/**
 * CPU-side twin of the GLSL `blackbody()`. Same fit, so a star's colour agrees
 * whether it was computed for a uniform or inside a shader.
 */
export function blackbodyLinear(K, out = new THREE.Vector3()) {
  const k = Math.min(40000, Math.max(1000, K));
  const t = k / 100;
  let r, g, b;
  if (t <= 66) {
    r = 1;
    g = clamp01(0.39008157876 * Math.log(t) - 0.63184144378);
    b = t <= 19 ? 0 : clamp01(0.54320678911 * Math.log(t - 10) - 1.19625408914);
  } else {
    r = clamp01(1.29293618606 * Math.pow(t - 60, -0.1332047592));
    g = clamp01(1.12989086089 * Math.pow(t - 60, -0.0755148492));
    b = 1;
  }
  return out.set(Math.pow(r, 2.2), Math.pow(g, 2.2), Math.pow(b, 2.2));
}
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
