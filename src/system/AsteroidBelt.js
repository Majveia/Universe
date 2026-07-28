/**
 * Asteroid belts.
 *
 * The thing that makes a belt read as a belt rather than as a ring of confetti
 * is *differential rotation*. Every asteroid is on its own Keplerian orbit, so
 * inner ones lap outer ones continuously — a clump shears into an arc, and an
 * arc stretches until it wraps. Give them all the same angular rate and the
 * belt turns like a solid wheel, which is instantly, unmistakably wrong.
 *
 * So each asteroid carries its own semi-major axis and the shader advances its
 * mean anomaly at n = sqrt(GM/a³). That is one line, and it is the difference
 * between a belt and a hula hoop.
 *
 * Kirkwood gaps are the other half. Resonances with the system's largest body
 * clear narrow annuli at simple period ratios, and those gaps are why the real
 * belt has visible structure instead of being a uniform smear. They are carved
 * at construction, because an asteroid removed by a resonance over a million
 * years does not need to be simulated leaving.
 *
 * Rendering is a single InstancedMesh: a few thousand deformed icosahedra with
 * per-instance orbital elements, so the whole belt is one draw call.
 */

import * as THREE from 'three';
import { Rng } from '../core/Rng.js';
import { settings } from '../core/Settings.js';
import { G } from '../universe/Catalog.js';
import { clamp } from '../core/Noise.js';

/** Mean-motion resonances that clear gaps, as ratios of the perturber period. */
const KIRKWOOD = [1 / 3, 2 / 5, 3 / 7, 1 / 2, 3 / 5, 2 / 3];

function deformedIcosahedron(rng, detail = 1) {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  // Independent per-axis scaling plus lumpy radial noise. Real small bodies are
  // rubble piles that never pulled themselves round, so the silhouette should
  // be irregular at every scale rather than a dented sphere.
  const ax = rng.range(0.62, 1.0);
  const ay = rng.range(0.55, 1.0);
  const az = rng.range(0.62, 1.0);
  const seed = rng.range(0, 100);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n =
      0.30 * Math.sin(v.x * 3.1 + seed) * Math.sin(v.y * 2.7 + seed * 1.3) +
      0.16 * Math.sin(v.y * 6.2 + seed * 2.1) * Math.sin(v.z * 5.3 + seed) +
      0.09 * Math.sin(v.z * 11.7 + seed * 3.7);
    v.normalize().multiplyScalar(1 + n * 0.55);
    v.x *= ax; v.y *= ay; v.z *= az;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

const BELT_VERT = /* glsl */ `
uniform float uTime;
uniform float uCompA;
uniform float uCompB;
uniform vec3  uViewPos;      // camera position in true system metres
uniform float uSizeBoost;

attribute vec4 aOrbit;       // a (m), e, inclination, phase0
attribute vec4 aSpin;        // axis.xyz (unit), rate
attribute vec2 aScale;       // radius (m), meanMotion (rad/s)

varying vec3 vNormal;
varying vec3 vViewDir;
varying float vShade;

mat3 axisAngle(vec3 ax, float a){
  float s = sin(a), c = cos(a), t = 1.0 - c;
  return mat3(
    t*ax.x*ax.x + c,       t*ax.x*ax.y - s*ax.z, t*ax.x*ax.z + s*ax.y,
    t*ax.x*ax.y + s*ax.z,  t*ax.y*ax.y + c,      t*ax.y*ax.z - s*ax.x,
    t*ax.x*ax.z - s*ax.y,  t*ax.y*ax.z + s*ax.x, t*ax.z*ax.z + c);
}

void main(){
  float a = aOrbit.x;
  float e = aOrbit.y;
  float inc = aOrbit.z;
  // Differential rotation: the mean anomaly advances at this body's own rate.
  float M = aOrbit.w + aSpin.w * 0.0 + aScale.y * uTime;

  // Two Newton steps on Kepler's equation. Belt eccentricities are small
  // (e < 0.25), so this converges to well under a pixel.
  float E = M;
  E -= (E - e * sin(E) - M) / (1.0 - e * cos(E));
  E -= (E - e * sin(E) - M) / (1.0 - e * cos(E));

  float xv = a * (cos(E) - e);
  float zv = a * sqrt(max(1.0 - e * e, 0.0)) * sin(E);
  vec3 truePos = vec3(xv, zv * sin(inc), zv * cos(inc));

  // Floating origin, then the same logarithmic compression the realm uses, so
  // belts sit correctly against planets at any distance.
  vec3 rel = truePos - uViewPos;
  float d = max(length(rel), 1.0);
  float comp = uCompA * log(1.0 + d / uCompB) / d;

  // Tumbling. Small bodies are not tidally locked to anything.
  mat3 rot = axisAngle(normalize(aSpin.xyz), uTime * aSpin.w);
  vec3 local = rot * position;

  // A floor on apparent size: below a pixel an asteroid vanishes into
  // aliasing, and a belt that flickers is worse than one slightly too coarse.
  float radius = aScale.x * uSizeBoost;
  vec3 world = rel * comp + local * radius * comp;

  vNormal = normalize(rot * normal);
  vec4 mv = modelViewMatrix * vec4(world, 1.0);
  vViewDir = -mv.xyz;
  vShade = clamp(1.0 - d / (a * 6.0), 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const BELT_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uSunDir;        // unit, in world (compressed) space
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uAlbedo;

varying vec3 vNormal;
varying vec3 vViewDir;
varying float vShade;

void main(){
  vec3 N = normalize(vNormal);
  float ndl = max(dot(N, uSunDir), 0.0);

  // Lommel-Seeliger rather than Lambert. Airless regolith is strongly
  // backscattering and the surface stays bright almost to the terminator,
  // which is why asteroid and lunar limbs look flat rather than shaded off.
  vec3 V = normalize(vViewDir);
  float ndv = max(dot(N, V), 0.02);
  float ls = ndl / (ndl + ndv);

  vec3 col = uAlbedo * uSunColor * uSunIntensity * (ls * 1.6 + ndl * 0.25);
  // A trace of ambient so the unlit side is a silhouette, not a hole.
  col += uAlbedo * 0.015;
  gl_FragColor = vec4(col, 1.0);
}
`;

export class AsteroidBelt {
  /**
   * `belt` is a Catalog belt record `{inner, outer, density, seed, tilt}`.
   * `starMass` in kg sets the orbital rates.
   */
  constructor(belt, starMass, opts = {}) {
    const rng = new Rng(belt.seed);
    this.belt = belt;

    const budget = Math.round(
      (settings.tier >= 4 ? 5200 : settings.tier >= 3 ? 3400 : settings.tier >= 2 ? 1800 : 700) *
      clamp(belt.density, 0.3, 1)
    );
    this.count = budget;

    const geo = deformedIcosahedron(rng, settings.tier >= 3 ? 1 : 0);
    this.geometry = geo;

    const orbit = new Float32Array(budget * 4);
    const spin = new Float32Array(budget * 4);
    const scale = new Float32Array(budget * 2);

    const GM = G * starMass;
    // Perturber period taken at the belt's outer edge; the gaps then land at
    // the right fractions of the belt's own width.
    const aPert = belt.outer * 1.9;
    const nPert = Math.sqrt(GM / (aPert * aPert * aPert));

    let placed = 0;
    let guard = 0;
    while (placed < budget && guard < budget * 40) {
      guard++;
      // Surface density falls roughly as 1/a in a swept disc, so sample the
      // radius accordingly rather than uniformly.
      const u = rng.next();
      const a = belt.inner * Math.pow(belt.outer / belt.inner, u);

      const n = Math.sqrt(GM / (a * a * a));
      const ratio = n / nPert;
      // Reject anything sitting in a mean-motion resonance.
      let cleared = false;
      for (const k of KIRKWOOD) {
        const w = 0.012 + 0.02 * k;
        if (Math.abs(ratio - 1 / k) < w * (1 / k)) { cleared = true; break; }
      }
      if (cleared && rng.next() < 0.93) continue;

      const i = placed++;
      orbit[i * 4] = a;
      orbit[i * 4 + 1] = Math.abs(rng.normal(0, 0.07));
      orbit[i * 4 + 2] = belt.tilt + rng.normal(0, 0.10);
      orbit[i * 4 + 3] = rng.range(0, Math.PI * 2);

      const ax = rng.onSphere();
      spin[i * 4] = ax.x; spin[i * 4 + 1] = ax.y; spin[i * 4 + 2] = ax.z;
      spin[i * 4 + 3] = rng.range(0.02, 0.5);

      // Size distribution is a steep power law — collisional cascades produce
      // vastly more small bodies than large, and the few big ones are what you
      // actually notice.
      scale[i * 2] = Math.pow(rng.next(), 4.2) * 9e5 + 8e3;
      scale[i * 2 + 1] = n;
    }
    this.count = placed;

    geo.setAttribute('aOrbit', new THREE.InstancedBufferAttribute(orbit.subarray(0, placed * 4), 4));
    geo.setAttribute('aSpin', new THREE.InstancedBufferAttribute(spin.subarray(0, placed * 4), 4));
    geo.setAttribute('aScale', new THREE.InstancedBufferAttribute(scale.subarray(0, placed * 2), 2));

    this.uniforms = {
      uTime: { value: 0 },
      uCompA: { value: opts.compA ?? 900 },
      uCompB: { value: opts.compB ?? 2.2e7 },
      uViewPos: { value: new THREE.Vector3() },
      uSizeBoost: { value: opts.sizeBoost ?? 90 },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSunIntensity: { value: 1 },
      uAlbedo: { value: new THREE.Color(0.20, 0.18, 0.16) },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: BELT_VERT,
      fragmentShader: BELT_FRAG,
      side: THREE.FrontSide,
    });

    this.mesh = new THREE.InstancedMesh(geo, this.material, placed);
    // Placement happens entirely in the vertex shader, so the per-instance
    // matrices stay identity and three's frustum test cannot see the real
    // extent. Culling is disabled deliberately.
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  }

  get object3d() {
    return this.mesh;
  }

  update(simTime, viewPos, light) {
    this.uniforms.uTime.value = simTime;
    this.uniforms.uViewPos.value.copy(viewPos);
    if (light) {
      this.uniforms.uSunDir.value.copy(light.dirWorld);
      this.uniforms.uSunColor.value.copy(light.color);
      this.uniforms.uSunIntensity.value = light.intensity;
    }
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose?.();
  }
}
