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
 * a fixed field ψ = -∇φ, scaled by the linear growth factor D(t). Because ψ is
 * a gradient field, trajectories converge — and where they cross, you get
 * caustics. Those caustics *are* the filaments, sheets, and nodes of the real
 * cosmic web. Turn D up and you watch a smooth early universe fracture into
 * the honeycomb structure that surveys like SDSS actually measured.
 *
 * ψ is evaluated analytically in the vertex shader as the gradient of an fbm
 * potential, so a million particles collapse in real time with zero CPU cost
 * and zero memory beyond the initial grid.
 *
 * Colour is not decorative: it encodes the local Jacobian. Where the flow is
 * expanding (voids) particles are cold and dim; where it is compressing
 * (filaments, nodes) they are hot and bright. You are looking at density.
 */

import * as THREE from 'three';
import { GLSL_LIB } from '../shaders/common.js';
import { Rng } from '../core/Rng.js';
import { settings } from '../core/Settings.js';

const WEB_VERT = /* glsl */ `
precision highp float;
${GLSL_LIB}

uniform float uTime;
uniform float uGrowth;        // linear growth factor D(t)
uniform float uScaleFactor;   // a(t) — Hubble expansion of the box
uniform float uBoxSize;
uniform float uPointScale;
uniform float uFieldScale;    // comoving wavenumber of the primordial potential
uniform float uPsiAmp;        // displacement amplitude, in box units
uniform vec3  uCameraPos;
uniform float uFlowAmp;
uniform float uViewportH;

attribute vec3 aLagrangian;   // q, the unperturbed grid position
attribute float aSeed;

varying float vDensity;
varying float vSeed;
varying float vDist;
varying float vShear;

/**
 * ψ(q) = -∇φ(q), plus the two invariants of the deformation tensor we need
 * for shading.
 *
 * The potential is sampled in a rescaled coordinate p = q * uFieldScale, so
 * uFieldScale directly sets how many structures span the box — roughly one
 * node per 1/uFieldScale units. Keeping that explicit matters: get it wrong and
 * you either get uniform mush or a handful of blobs, and no amount of colour
 * grading rescues either.
 */
vec3 displacement(vec3 q, out float divergence, out float shear){
  vec3 p = q * uFieldScale;
  // Epsilon in *potential* space, sized to about a quarter of the smallest
  // structure so the gradient is well-conditioned but not noise-dominated.
  const float e = 0.09;
  float f0  = warpedFbm(p, 5, 0.7);
  float fx1 = warpedFbm(p + vec3(e,0,0), 5, 0.7);
  float fx0 = warpedFbm(p - vec3(e,0,0), 5, 0.7);
  float fy1 = warpedFbm(p + vec3(0,e,0), 5, 0.7);
  float fy0 = warpedFbm(p - vec3(0,e,0), 5, 0.7);
  float fz1 = warpedFbm(p + vec3(0,0,e), 5, 0.7);
  float fz0 = warpedFbm(p - vec3(0,0,e), 5, 0.7);

  vec3 grad = vec3(fx1 - fx0, fy1 - fy0, fz1 - fz0) / (2.0 * e);

  // ∇²φ. In linear theory this is proportional to the density contrast δ, so
  // this single number is (up to a constant) the thing the colour ramp shows.
  float lap = (fx1 + fx0 + fy1 + fy0 + fz1 + fz0 - 6.0 * f0) / (e * e);
  divergence = lap * 0.06;

  // |∇φ| is large on the *walls* between voids — the sheets — which is what
  // separates a pancake from a knot in the shading.
  shear = length(grad);

  return -grad * uPsiAmp;
}

void main(){
  vSeed = aSeed;
  vec3 q = aLagrangian;

  float div, shear;
  vec3 psi = displacement(q, div, shear);

  // Peculiar velocity: a slow divergence-free drift on top of the Hubble flow,
  // so the web breathes instead of sitting frozen.
  vec3 drift = curlNoise(q * 0.18 + vec3(0.0, uTime * 0.02, 0.0)) * uFlowAmp;

  vec3 x = q + uGrowth * psi + drift;

  // Comoving -> proper coordinates.
  x *= uScaleFactor;

  // Density proxy. Compression (negative divergence) means matter is piling up.
  float compression = clamp(-div, -1.0, 4.0);
  vDensity = clamp(compression * 0.42 + shear * 0.26 + 0.08, 0.0, 1.6);
  vShear = shear;

  vec4 mv = modelViewMatrix * vec4(x, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;

  // Sized in world units and projected, so a particle keeps a constant
  // apparent size as you fly through — no popping, no resolution dependence.
  float size = uPointScale * (0.7 + vDensity * 0.9);
  gl_PointSize = clamp(size * uViewportH / max(vDist, 0.25), 0.7, 7.0);
}
`;

const WEB_FRAG = /* glsl */ `
precision highp float;
${GLSL_LIB}

uniform float uTime;
uniform float uFade;
uniform vec3  uVoidColor;
uniform vec3  uFilamentColor;
uniform vec3  uNodeColor;
uniform float uIntensity;

varying float vDensity;
varying float vSeed;
varying float vDist;
varying float vShear;

void main(){
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;

  // Gaussian core with a wide, very faint halo. The halo is what makes a
  // million points read as continuous gas rather than confetti.
  float core = exp(-r2 * 5.0);
  float halo = exp(-r2 * 1.3) * 0.22;
  float alpha = core + halo;

  // Three-stop ramp keyed to density. Deep indigo voids, cyan-to-violet
  // filaments, and gold only at true knots — so the eye reads mass directly.
  float d = vDensity;
  vec3 col = mix(uVoidColor, uFilamentColor, smoothstep(0.10, 0.52, d));
  col = mix(col, uNodeColor, smoothstep(0.62, 1.15, d));

  // Per-particle temperature jitter keeps large uniform regions from banding.
  col *= 0.80 + 0.40 * fract(vSeed * 91.7);

  // Additive blending sums along the line of sight, so per-particle energy has
  // to stay low or dense regions clip instantly. Almost all of the apparent
  // brightness of a node should come from *how many* particles overlap there,
  // not from any one of them — that is what makes density legible.
  float atten = 1.0 / (1.0 + vDist * vDist * 1.2e-4);
  float brightness = (0.010 + pow(d, 2.4) * 0.16) * atten * uIntensity;

  gl_FragColor = vec4(col * brightness * alpha, alpha * uFade);
}
`;

export class CosmicWeb {
  constructor(opts = {}) {
    const count = opts.count ?? settings.cosmicParticles;
    const boxSize = opts.boxSize ?? 30;
    this.boxSize = boxSize;
    this.count = count;

    const rng = new Rng(opts.seed ?? 424242);

    // Lagrangian grid with a small stratified jitter. A perfect lattice
    // produces visible moiré at grazing angles; pure random loses the
    // uniform-density initial condition the approximation assumes.
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
          const qx = (x + 0.5 + rng.range(-0.42, 0.42)) * step - boxSize * 0.5;
          const qy = (y + 0.5 + rng.range(-0.42, 0.42)) * step - boxSize * 0.5;
          const qz = (z + 0.5 + rng.range(-0.42, 0.42)) * step - boxSize * 0.5;
          lagr[i * 3] = qx;
          lagr[i * 3 + 1] = qy;
          lagr[i * 3 + 2] = qz;
          positions[i * 3] = qx;
          positions[i * 3 + 1] = qy;
          positions[i * 3 + 2] = qz;
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
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), boxSize * 2);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uGrowth: { value: 0.0 },
        uScaleFactor: { value: 1.0 },
        uBoxSize: { value: boxSize },
        // ~2px at the default framing. Small points, many of them: the web
        // should resolve into individual tracers when you get close.
        uPointScale: { value: 0.0055 * boxSize },
        // ~7 structures across the box — matches the node spacing in a real
        // survey volume of a few hundred Mpc.
        uFieldScale: { value: 7.0 / boxSize },
        uPsiAmp: { value: 0.05 * boxSize },
        uViewportH: { value: 900 },
        uCameraPos: { value: new THREE.Vector3() },
        uFlowAmp: { value: 0.05 },
        uFade: { value: 1 },
        uIntensity: { value: 1 },
        // Deep-space palette. Voids are not black — they are the faintest
        // possible indigo, which on an OLED reads as "space with something in
        // it" rather than a dead panel.
        uVoidColor: { value: new THREE.Color(0.055, 0.075, 0.20) },
        uFilamentColor: { value: new THREE.Color(0.30, 0.62, 1.0) },
        uNodeColor: { value: new THREE.Color(1.0, 0.80, 0.45) },
      },
      vertexShader: WEB_VERT,
      fragmentShader: WEB_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 1;

    // Cosmic time in the simulation. Drives D(t) and a(t) together so the
    // expansion and the collapse stay physically coupled.
    this.cosmicTime = 0.55;
    this.timeScale = 0.012;
    this.paused = false;
  }

  get object3d() {
    return this.points;
  }

  /**
   * `t` in [0,1] maps to roughly z=20 (smooth) through z=0 (present day)
   * and on into the far future where structure is maximally clumped.
   */
  setEpoch(t) {
    this.cosmicTime = t;
  }

  update(dt, time, camera) {
    if (!this.paused) this.cosmicTime += dt * this.timeScale;
    const t = Math.max(0.001, this.cosmicTime);

    const u = this.material.uniforms;
    u.uTime.value = time;

    // Matter-dominated growth D ∝ a ∝ t^(2/3), then a late-time Λ plateau —
    // structure formation genuinely does freeze out as expansion accelerates.
    const a = Math.pow(t, 2 / 3);
    const D = a / (1 + 0.55 * Math.pow(a, 3));
    u.uGrowth.value = D * 3.2;
    // Proper distance grows with a(t), but we hold the framing mostly fixed so
    // the viewer reads collapse rather than a zoom-out.
    u.uScaleFactor.value = 0.88 + a * 0.16;

    if (camera) u.uCameraPos.value.copy(camera.position);
  }

  /** Projected point size needs the viewport height in device pixels. */
  setViewportHeight(h) {
    this.material.uniforms.uViewportH.value = h;
  }

  setIntensity(v) {
    this.material.uniforms.uIntensity.value = v;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
