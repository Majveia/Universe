/**
 * Planetary rings.
 *
 * Rings are not a texture on a disc. What makes Saturn look like Saturn is
 * that the ring plane is optically *thin*, so almost everything about its
 * appearance is a transport problem rather than a shading one:
 *
 *  - Looking at the lit face you see reflected light, and denser annuli are
 *    brighter because more particles are catching the sun.
 *  - Looking at the unlit face, through the plane, you see *transmitted*
 *    light — and now the relationship inverts. The dense annuli become the
 *    dark ones because they block, and the sparse gaps glow. This inversion
 *    is the single most recognisable thing about backlit rings, and it is
 *    also the detail nearly every real-time implementation drops.
 *  - Forward scattering is strong. Ring particles are dust-to-boulder sized,
 *    so at small phase angles they throw light forward hard. That is why
 *    Cassini's backlit portraits have that luminous, smoke-like quality.
 *
 * Structure comes from resonances with the shepherd moons: sharp-edged gaps
 * (Cassini, Encke) with density waves piled against them. Noise alone gives
 * a fuzzy gradient, so the gaps are placed explicitly and the noise only
 * modulates between them.
 *
 * Geometry is built in units of the planet's radius and parented to the
 * planet's tilted frame, so the rings inherit axial tilt for free and sit in
 * the equatorial plane the way real ones do.
 */

import * as THREE from 'three';
import { GLSL_LIB } from '../shaders/common.js';
import { Rng } from '../core/Rng.js';
import { clamp } from '../core/Noise.js';

const RING_VERT = /* glsl */ `
varying vec3 vLocal;
varying vec3 vWorldDir;
void main(){
  vLocal = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vWorldDir = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const RING_FRAG = /* glsl */ `
precision highp float;
${GLSL_LIB}

uniform float uInner;
uniform float uOuter;
uniform vec3  uSunLocal;      // unit, planet -> star, in ring-local space
uniform vec3  uCamLocal;
uniform vec3  uTint;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform float uOpacity;
uniform float uSeed;
uniform float uGapCount;
uniform vec4  uGapA;          // normalised radii of up to 8 resonance gaps
uniform vec4  uGapB;
uniform vec4  uGapWidthA;
uniform vec4  uGapWidthB;

varying vec3 vLocal;
varying vec3 vWorldDir;

// Optical depth across the ring plane. Everything downstream is a function of
// this one number, which is what makes the lit/unlit inversion fall out
// automatically instead of needing two separate looks.
float opticalDepth(float t){
  // Broad envelope: dense in the middle annuli, thinning at both edges the way
  // an accretion-limited disc does.
  float env = smoothstep(0.0, 0.10, t) * (1.0 - smoothstep(0.82, 1.0, t));

  // Banding across three scales. Real rings have structure from tens of
  // kilometres up to thousands, and hitting several octaves is what stops
  // them reading as a gradient.
  float b = 0.55
    + 0.30 * snoise(vec3(t * 42.0, uSeed, 0.0))
    + 0.18 * snoise(vec3(t * 138.0, uSeed * 1.7, 0.0))
    + 0.10 * snoise(vec3(t * 390.0, uSeed * 2.3, 0.0));

  float tau = env * max(b, 0.0) * 3.4;

  // Resonance gaps, cut with a hard rim. A density wave piles material up on
  // the outside of each gap, so the edge is bright immediately before it
  // clears — the Encke gap's shepherd signature.
  for (int i = 0; i < 8; i++){
    float g = i < 4 ? uGapA[i] : uGapB[i - 4];
    float w = i < 4 ? uGapWidthA[i] : uGapWidthB[i - 4];
    if (float(i) >= uGapCount) break;
    float d = abs(t - g);
    // Clear only the very centre of the resonance and feather hard. A gap
    // that is wide relative to its feather turns the disc into concentric
    // wires; Saturn's real gaps are thin lines in a continuous sheet.
    float clear = smoothstep(w * 0.12, w, d);
    float wave = exp(-pow((t - g - w * 1.4) / (w * 0.9), 2.0)) * 0.7;
    tau = tau * clear + wave * env;
  }
  return max(tau, 0.0);
}

void main(){
  float r = length(vLocal.xz);
  float t = (r - uInner) / (uOuter - uInner);
  if (t < 0.0 || t > 1.0) discard;

  float tau = opticalDepth(t);
  if (tau < 0.002) discard;

  vec3 V = normalize(vWorldDir);
  // The plane normal is local +Y. Grazing views look through far more
  // material, which is why rings brighten and then vanish as they close up.
  float muV = max(abs(V.y), 0.06);
  float muL = max(abs(uSunLocal.y), 0.06);

  // Slant optical depth along each path.
  float tauV = tau / muV;
  float tauL = tau / muL;

  // Are we on the same side of the plane as the star?
  bool lit = (V.y * uSunLocal.y) > 0.0;

  float cosPhase = dot(V, uSunLocal);
  // Two lobes: strong forward scattering from small grains, a weaker backscatter
  // peak from the larger ones. g is signed so the same call serves both.
  float fwd  = hgPhase(cosPhase, 0.72);
  float back = hgPhase(cosPhase, -0.28);

  float single;
  if (lit) {
    // Reflection: classic single-scattering slab. Denser means brighter,
    // saturating once the slab is optically thick.
    single = (1.0 - exp(-(tauV + tauL))) * (muL / (muL + muV));
    single *= (0.35 + 1.5 * back);
  } else {
    // Transmission: what survives the crossing. Denser now means *darker*,
    // and the forward lobe dominates because you are looking almost straight
    // back down the beam.
    single = exp(-tauL) * (1.0 - exp(-tauV)) * 3.4;
    single *= (0.25 + 5.0 * fwd);
  }

  // Planet shadow: the cylindrical umbra the planet casts across its own ring
  // plane. The bite it takes out of the rings is one of the most recognisable
  // things in a Cassini image, and it has to be computed as an actual
  // shadow volume — a point is eclipsed when it lies behind the planet along
  // the sun direction AND within one planetary radius of that axis.
  //
  // (An earlier version used smoothstep with its edges reversed to express
  // "behind". That is undefined in GLSL and produced hard rectangular
  // artefacts across the ring plane.)
  vec3 P = vLocal;
  float alongSun = dot(P, uSunLocal);
  float perpDist = length(P - uSunLocal * alongSun);
  float behind = smoothstep(0.0, -0.35, alongSun);
  float inCylinder = 1.0 - smoothstep(0.90, 1.08, perpDist);
  float shadow = 1.0 - behind * inCylinder * 0.97;

  // Particle colour: dirty ice. Slightly redder where the ring is thin,
  // because what survives there is the larger, more contaminated debris.
  vec3 col = mix(uTint * vec3(1.06, 0.98, 0.90), uTint, smoothstep(0.2, 1.4, tau));
  col *= uSunColor;

  float alpha = clamp(single * uOpacity * shadow, 0.0, 1.0);
  // Even in the umbra the rings are not black: they catch planetshine.
  vec3 rgb = col * single * uSunIntensity * shadow + uTint * 0.012 * (1.0 - shadow);

  // Dither: a ring is one enormous smooth gradient, the exact case where 8-bit
  // output bands into visible contour lines.
  rgb += (ign(gl_FragCoord.xy) - 0.5) / 255.0;

  gl_FragColor = vec4(max(rgb, 0.0), alpha);
}
`;

export class Rings {
  /**
   * `record` is a Catalog planet. Geometry is in units of the planet radius,
   * so the returned object is meant to be added to `PlanetBody.group` (the
   * tilted frame), not to `spin` — rings do not co-rotate with the surface.
   */
  constructor(record, opts = {}) {
    const rng = new Rng((record.seed ^ 0x21a9) >>> 0);
    this.record = record;

    // The Roche limit is where tidal shear beats self-gravity, and it is why
    // rings exist inside it and moons outside. Placing the outer edge near it
    // is not decoration — it is the reason the system looks plausible.
    const roche = 2.44;
    this.inner = rng.range(1.22, 1.55);
    this.outer = Math.min(roche * rng.range(0.85, 1.05), this.inner + rng.range(0.5, 1.5));

    const segments = opts.segments ?? 256;
    const radial = opts.radial ?? 96;
    const geo = new THREE.RingGeometry(this.inner, this.outer, segments, radial);
    // RingGeometry is built in XY; rings live in the equatorial plane.
    geo.rotateX(-Math.PI / 2);
    this.geometry = geo;

    // Up to eight resonance gaps, biased toward the outer half where the
    // strongest shepherd resonances land.
    const gapCount = rng.int(2, 5);
    const gaps = [];
    const widths = [];
    for (let i = 0; i < 8; i++) {
      if (i < gapCount) {
        gaps.push(clamp(Math.pow(rng.next(), 0.7) * 0.9 + 0.05, 0.04, 0.95));
        widths.push(rng.range(0.006, 0.026));
      } else {
        gaps.push(2);
        widths.push(0.01);
      }
    }

    const tint = new THREE.Color(...record.palette.base).lerp(new THREE.Color(0.82, 0.78, 0.70), 0.65);

    this.uniforms = {
      uInner: { value: this.inner },
      uOuter: { value: this.outer },
      uSunLocal: { value: new THREE.Vector3(1, 0.2, 0) },
      uCamLocal: { value: new THREE.Vector3() },
      uTint: { value: tint },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSunIntensity: { value: 1 },
      uOpacity: { value: rng.range(0.8, 1.25) },
      uSeed: { value: rng.range(0, 100) },
      uGapCount: { value: gapCount },
      uGapA: { value: new THREE.Vector4(gaps[0], gaps[1], gaps[2], gaps[3]) },
      uGapB: { value: new THREE.Vector4(gaps[4], gaps[5], gaps[6], gaps[7]) },
      uGapWidthA: { value: new THREE.Vector4(widths[0], widths[1], widths[2], widths[3]) },
      uGapWidthB: { value: new THREE.Vector4(widths[4], widths[5], widths[6], widths[7]) },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      // Normal blending, not additive: rings genuinely occlude what is behind
      // them, and additive would make the planet visible straight through the
      // densest annuli.
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
    this._inv = new THREE.Matrix4();
  }

  get object3d() {
    return this.mesh;
  }

  /** Same light contract as PlanetBody.sync. */
  sync(light) {
    this.mesh.updateMatrixWorld();
    this._inv.copy(this.mesh.matrixWorld).invert();
    this.uniforms.uCamLocal.value.set(0, 0, 0).applyMatrix4(this._inv);
    this.uniforms.uSunLocal.value.copy(light.dirWorld).transformDirection(this._inv).normalize();
    this.uniforms.uSunColor.value.copy(light.color);
    this.uniforms.uSunIntensity.value = light.intensity;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
