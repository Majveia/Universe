/**
 * A galaxy.
 *
 * Three things separate a rendered galaxy that reads as real from one that
 * reads as a swirl filter, and none of them is resolution.
 *
 *  DENSITY WAVE, NOT PINWHEEL. Spiral arms are not made of stars that stay in
 *  them. They are a standing compression pattern that the disc rotates
 *  *through* — Lin and Shu's density wave. Material entering an arm is
 *  shocked, collapses, and forms stars; the hot blue ones burn out before they
 *  leave, so the arm's leading edge is blue and studded with HII regions while
 *  the trailing side is older and redder. Painting arms as a colour ramp gives
 *  you a symmetric swirl; deriving colour from where a star sits *across* the
 *  arm gives you the asymmetry every real photograph has.
 *
 *  DIFFERENTIAL ROTATION. Real discs have a flat rotation curve — v is roughly
 *  constant with radius, so angular velocity falls as 1/r. The inner disc laps
 *  the outer one. Rotate everything rigidly and the galaxy reads as a decal on
 *  a turntable.
 *
 *  DUST. A galaxy is defined by its dust as much as by its light. Dark lanes
 *  hug the inner edge of each arm, where the shock piles material up before it
 *  turns into stars. Additive blending cannot darken, so the dust is a second
 *  pass with a reverse-subtract blend equation — it removes light that the
 *  star pass already deposited, which is exactly what extinction does.
 */

import * as THREE from 'three';
import { GLSL_LIB } from '../shaders/common.js';
import { Rng } from '../core/Rng.js';
import { settings } from '../core/Settings.js';
import { clamp } from '../core/Noise.js';

export const GalaxyType = { SPIRAL: 0, BARRED: 1, ELLIPTICAL: 2, IRREGULAR: 3 };

/**
 * Shared disc kinematics. Both the star and dust passes include this so the
 * dust stays locked to the arms it belongs to as the disc turns.
 */
const DISC = /* glsl */ `
uniform float uTime;
uniform float uArms;
uniform float uPitch;        // cot of the pitch angle; larger = tighter winding
uniform float uBarLength;
uniform float uSpin;

// Flat rotation curve: v ~ const, so omega ~ 1/r. The softening at small r
// keeps the nucleus from shearing itself apart on the first frame.
float angularRate(float r){
  return uSpin / max(r, 0.10);
}

// Phase across the nearest arm, in [-1, 1]. Zero is the arm ridge, negative is
// the leading (inner) side where the shock and the dust live.
float armPhase(float r, float theta){
  float spiral = theta - log(max(r, 0.02)) * uPitch;
  float a = spiral * uArms;
  // Wrap into a signed distance from the nearest arm crest.
  float f = fract(a / TAU + 0.5) - 0.5;
  return f * 2.0;
}
`;

const STAR_VERT = /* glsl */ `
precision highp float;
${GLSL_LIB}
${DISC}

uniform float uViewportH;
uniform float uSizeScale;
uniform float uArmStrength;

attribute vec4 aDisc;   // radius, theta0, height, jitter
attribute vec3 aStar;   // temperature (K), luminosity, populationBias

varying vec3 vColor;
varying float vBright;
varying float vSize;

void main(){
  float r = aDisc.x;
  float theta = aDisc.y + angularRate(r) * uTime;

  float phase = armPhase(r, theta);

  // Compress positions toward the arm ridge. This is the density wave: the
  // stars are not bound to the arm, they are being squeezed as they pass
  // through it, and the squeeze is what you see.
  float pull = uArmStrength * (1.0 - smoothstep(0.0, 1.0, r * 0.55));
  theta -= phase * pull * 0.35;

  vec3 pos = vec3(cos(theta) * r, aDisc.z, sin(theta) * r);

  // Colour by stellar temperature, but bias it by where the star sits across
  // the arm. Just inside the ridge is a starburst — hot, short-lived, blue.
  // Behind it the population ages and reddens.
  float youth = smoothstep(0.55, -0.15, phase) * (1.0 - smoothstep(0.0, 1.2, r * 0.5));
  float temp = mix(aStar.x, 22000.0, youth * aStar.z * 0.85);
  vColor = blackbody(temp);

  // Luminosity-weighted brightness. O and B stars are vanishingly rare but
  // hundreds of thousands of times brighter, which is why the arms are picked
  // out in blue despite being mostly red dwarfs by count.
  vBright = aStar.y * (1.0 + youth * 7.0);

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  float d = max(-mv.z, 1e-4);
  gl_Position = projectionMatrix * mv;

  float px = clamp(uSizeScale * uViewportH / d * (0.6 + aStar.y * 0.9), 0.8, 9.0);
  gl_PointSize = px;
  vSize = px;
}
`;

const STAR_FRAG = /* glsl */ `
precision highp float;
${GLSL_LIB}
uniform float uIntensity;
varying vec3 vColor;
varying float vBright;
varying float vSize;

void main(){
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 3.4);
  float halo = exp(-r2 * 1.0) * 0.35;
  float a = core + halo;
  // Flux conservation, so a star does not brighten as it grows on approach.
  gl_FragColor = vec4(vColor * vBright * uIntensity * a / max(vSize * vSize, 1.0) * 40.0, a);
}
`;

const DUST_VERT = /* glsl */ `
precision highp float;
${GLSL_LIB}
${DISC}

uniform float uViewportH;
uniform float uSizeScale;
uniform float uArmStrength;

attribute vec4 aDisc;
attribute float aOpacity;

varying float vOpacity;
varying float vSize;

void main(){
  float r = aDisc.x;
  float theta = aDisc.y + angularRate(r) * uTime;
  float phase = armPhase(r, theta);

  // Dust sits on the *leading* side of the ridge, where material piles up
  // before the shock converts it into stars. That offset is why dust lanes
  // appear on the inner edge of an arm rather than down its middle.
  float band = exp(-pow((phase + 0.30) / 0.24, 2.0));
  vOpacity = aOpacity * band * (1.0 - smoothstep(0.55, 1.25, r));
  if (vOpacity < 0.004){
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float pull = uArmStrength * (1.0 - smoothstep(0.0, 1.0, r * 0.55));
  theta -= phase * pull * 0.35;

  vec3 pos = vec3(cos(theta) * r, aDisc.z * 0.55, sin(theta) * r);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  float d = max(-mv.z, 1e-4);
  gl_Position = projectionMatrix * mv;
  float px = clamp(uSizeScale * uViewportH / d, 2.0, 46.0);
  gl_PointSize = px;
  vSize = px;
}
`;

const DUST_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uExtinction;
varying float vOpacity;
varying float vSize;

void main(){
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 1.8);
  // Reverse-subtract blending means this value is removed from the frame.
  // Extinction is wavelength dependent — blue is scattered away hardest,
  // which is why dust lanes are not merely dark but distinctly reddened.
  gl_FragColor = vec4(uExtinction * a * vOpacity / max(vSize, 1.0) * 9.0, 1.0);
}
`;

export class Galaxy {
  constructor(opts = {}) {
    const rng = new Rng(opts.seed ?? 7);
    this.seed = opts.seed ?? 7;

    this.type = opts.type ?? rng.weighted(
      [GalaxyType.SPIRAL, GalaxyType.BARRED, GalaxyType.ELLIPTICAL, GalaxyType.IRREGULAR],
      [0.46, 0.28, 0.18, 0.08]
    );

    const budget = opts.count ?? Math.min(420000, Math.round(settings.cosmicParticles * 0.28));
    this.group = new THREE.Group();

    const arms = this.type === GalaxyType.BARRED ? 2 : rng.int(2, 5);
    // Pitch angle sets the Hubble stage: tightly wound Sa through open Sc.
    const pitchAngle = rng.range(0.14, 0.42);
    this.pitch = 1 / Math.tan(pitchAngle);
    this.arms = arms;
    this.barLength = this.type === GalaxyType.BARRED ? rng.range(0.22, 0.42) : 0;

    this._shared = {
      uTime: { value: 0 },
      uArms: { value: arms },
      uPitch: { value: this.pitch },
      uBarLength: { value: this.barLength },
      uSpin: { value: rng.range(0.020, 0.045) },
      uViewportH: { value: 900 },
      uArmStrength: { value: this.type === GalaxyType.ELLIPTICAL ? 0 : rng.range(0.5, 1.0) },
    };

    this._buildStars(rng, budget);
    if (this.type !== GalaxyType.ELLIPTICAL) this._buildDust(rng, Math.round(budget * 0.16));
  }

  _buildStars(rng, n) {
    const disc = new Float32Array(n * 4);
    const star = new Float32Array(n * 3);

    // Fraction of the mass in the bulge. Ellipticals are all bulge; late-type
    // spirals barely have one.
    const bulgeFrac = this.type === GalaxyType.ELLIPTICAL ? 1.0
      : this.type === GalaxyType.IRREGULAR ? 0.05
      : rng.range(0.10, 0.30);
    const scaleLength = 0.30;
    const scaleHeight = 0.028;

    for (let i = 0; i < n; i++) {
      const inBulge = rng.next() < bulgeFrac;
      let r, y;
      if (inBulge) {
        // Sérsic-like: steeply concentrated, roughly spherical.
        r = Math.pow(rng.next(), 2.6) * 0.34;
        const dir = rng.onSphere();
        y = dir.y * r * 0.75;
        r = Math.abs(r * Math.hypot(dir.x, dir.z)) + 0.004;
      } else {
        // Exponential disc: -ln(u) gives the right radial profile directly.
        r = -Math.log(Math.max(rng.next(), 1e-6)) * scaleLength;
        if (r > 1.35) { r = rng.range(0.2, 1.35); }
        // sech^2 vertical profile, thinner in the inner disc.
        const u = rng.next() * 2 - 1;
        y = Math.atanh(clamp(u, -0.999, 0.999)) * scaleHeight * (0.5 + r);
      }

      // Irregulars have no coherent disc; scatter them.
      if (this.type === GalaxyType.IRREGULAR) {
        y += rng.normal(0, 0.09);
        r *= rng.range(0.6, 1.5);
      }

      disc[i * 4] = r;
      disc[i * 4 + 1] = rng.range(0, Math.PI * 2);
      disc[i * 4 + 2] = y;
      disc[i * 4 + 3] = rng.next();

      // Real initial mass function: overwhelmingly red dwarfs, and that is
      // exactly what makes the handful of blue giants read as special.
      const u = rng.next();
      const temp = u < 0.76 ? rng.range(2400, 3700)
        : u < 0.88 ? rng.range(3700, 5200)
        : u < 0.95 ? rng.range(5200, 6000)
        : u < 0.985 ? rng.range(6000, 7500)
        : rng.range(7500, 26000);
      star[i * 3] = temp;
      // Luminosity from a rough mass-luminosity relation, normalised.
      star[i * 3 + 1] = clamp(Math.pow(temp / 5772, 2.4) * 0.5, 0.02, 6);
      // How readily this star is replaced by a young one in an arm. Bulge
      // stars are old and gas-poor; disc stars are still forming.
      star[i * 3 + 2] = inBulge ? 0.04 : rng.range(0.5, 1);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aDisc', new THREE.BufferAttribute(disc, 4));
    geo.setAttribute('aStar', new THREE.BufferAttribute(star, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3);

    this.starMat = new THREE.ShaderMaterial({
      uniforms: {
        ...this._shared,
        uSizeScale: { value: 0.0016 },
        uIntensity: { value: 1.0 },
      },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    this.stars = new THREE.Points(geo, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = 1;
    this.group.add(this.stars);
  }

  _buildDust(rng, n) {
    const disc = new Float32Array(n * 4);
    const opacity = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = -Math.log(Math.max(rng.next(), 1e-6)) * 0.30;
      disc[i * 4] = clamp(r, 0.06, 1.3);
      disc[i * 4 + 1] = rng.range(0, Math.PI * 2);
      disc[i * 4 + 2] = rng.normal(0, 0.012);
      disc[i * 4 + 3] = rng.next();
      opacity[i] = Math.pow(rng.next(), 1.4);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aDisc', new THREE.BufferAttribute(disc, 4));
    geo.setAttribute('aOpacity', new THREE.BufferAttribute(opacity, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3);

    this.dustMat = new THREE.ShaderMaterial({
      uniforms: {
        ...this._shared,
        uSizeScale: { value: 0.012 },
        // Interstellar reddening: blue is removed about twice as efficiently
        // as red, so what survives a dust lane is warmer than what entered it.
        uExtinction: { value: new THREE.Vector3(0.55, 0.78, 1.0) },
      },
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      // Reverse subtract: dst - src. This is the only way to darken a frame
      // that additive star light has already written into.
      blending: THREE.CustomBlending,
      blendEquation: THREE.ReverseSubtractEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      depthWrite: false,
      depthTest: false,
    });
    this.dust = new THREE.Points(geo, this.dustMat);
    this.dust.frustumCulled = false;
    // After the stars, so there is light present to remove.
    this.dust.renderOrder = 2;
    this.group.add(this.dust);
  }

  get object3d() {
    return this.group;
  }

  setViewportHeight(h) {
    this._shared.uViewportH.value = h;
  }

  update(dt, time) {
    this._shared.uTime.value = time;
  }

  dispose() {
    this.stars.geometry.dispose();
    this.starMat.dispose();
    if (this.dust) {
      this.dust.geometry.dispose();
      this.dustMat.dispose();
    }
  }
}
