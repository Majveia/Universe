/**
 * The largest scale. You are outside everything, looking at the scaffolding.
 *
 * The camera drifts on a slow orbital rail unless the user takes hold of it.
 * Nothing here is interactive in the twitch sense — this scale is meant to be
 * contemplative, a held wide shot before the descent.
 */

import * as THREE from 'three';
import { Realm } from '../core/Director.js';
import { CosmicWeb } from './CosmicWeb.js';
import { Rng } from '../core/Rng.js';
import { settings } from '../core/Settings.js';
import { damp, clamp } from '../core/Noise.js';
import { GLSL_LIB } from '../shaders/common.js';

const GALAXY_VERT = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uScale;
attribute float aSize;
attribute vec3 aColor;
attribute float aSpin;
varying vec3 vColor;
varying float vFade;
void main(){
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = -mv.z;
  vFade = smoothstep(0.5, 6.0, d) * (1.0 - smoothstep(120.0, 300.0, d));
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / max(d, 0.5) * 300.0, 2.0, 90.0);
}
`;

const GALAXY_FRAG = /* glsl */ `
precision highp float;
${GLSL_LIB}
uniform float uTime;
uniform float uBrightness;
varying vec3 vColor;
varying float vFade;
void main(){
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r = length(uv);
  if (r > 1.0) discard;
  float ang = atan(uv.y, uv.x);
  // Two-armed logarithmic spiral, faded into a bulge. Cheap, but at this
  // distance it is exactly the amount of structure the eye needs to read
  // "galaxy" rather than "dot".
  float spiral = 0.5 + 0.5 * cos(2.0 * (ang - log(max(r, 0.04)) * 3.2));
  float disc = exp(-r * r * 3.4) * (0.35 + 0.65 * spiral);
  float bulge = exp(-r * r * 26.0) * 1.8;
  float a = disc + bulge;
  vec3 col = mix(vColor, vec3(1.0, 0.94, 0.86), bulge * 0.55);
  gl_FragColor = vec4(col * a * uBrightness, a * vFade);
}
`;

export class CosmosRealm extends Realm {
  constructor(ctx) {
    super(ctx);
    this.near = 0.05;
    this.far = 4000;
    this.ambience = 'cosmos';
    this.orbit = { theta: 0.6, phi: 1.15, radius: 44, target: new THREE.Vector3() };
    this.autoRotate = true;
    this._idle = 0;
  }

  async build() {
    const scene = this.scene;
    scene.background = new THREE.Color(0x000000);

    this.web = new CosmicWeb({ seed: 20260728, boxSize: 34, count: settings.cosmicParticles });
    this.web.setViewportHeight(this.ctx.engine.renderer.getDrawingBufferSize(new THREE.Vector2()).y);
    this.ctx.engine.onResize(() => {
      this.web.setViewportHeight(this.ctx.engine.renderer.getDrawingBufferSize(new THREE.Vector2()).y);
    });
    scene.add(this.web.object3d);

    // Galaxies live where the web is densest. We do not have the density field
    // on the CPU, so we sample the same potential the shader uses via a coarse
    // proxy: cluster galaxies around randomised filament seeds.
    this._buildGalaxies();

    // A very faint far-field of unresolved galaxies so the void is never empty.
    this._buildDeepField();

    return this;
  }

  _buildGalaxies() {
    const rng = new Rng(777);
    const count = Math.round(2400 * (settings.tier >= 3 ? 1 : 0.5));
    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const color = new Float32Array(count * 3);
    const spin = new Float32Array(count);

    // Place clusters, then scatter members with a power-law radius so groups
    // look gravitationally bound rather than uniformly sprinkled.
    const clusters = [];
    for (let i = 0; i < 46; i++) {
      clusters.push({
        x: rng.range(-15, 15), y: rng.range(-12, 12), z: rng.range(-15, 15),
        r: rng.range(0.7, 4.0), n: rng.int(8, 90),
      });
    }
    const c = new THREE.Color();
    let i = 0;
    while (i < count) {
      const cl = rng.pick(clusters);
      const d = Math.pow(rng.next(), 2.2) * cl.r;
      const dir = rng.onSphere();
      pos[i * 3] = cl.x + dir.x * d;
      pos[i * 3 + 1] = cl.y + dir.y * d * 0.75;
      pos[i * 3 + 2] = cl.z + dir.z * d;
      size[i] = rng.range(0.006, 0.05) * (d < cl.r * 0.25 ? 1.9 : 1.0);
      spin[i] = rng.range(0, Math.PI * 2);
      // Redder toward cluster cores (old ellipticals), bluer in the field
      // (star-forming spirals). That colour-density relation is real.
      const core = 1 - clamp(d / cl.r, 0, 1);
      c.setHSL(0.58 - core * 0.5 + rng.range(-0.05, 0.05), 0.55, 0.62);
      color[i * 3] = c.r;
      color[i * 3 + 1] = c.g;
      color[i * 3 + 2] = c.b;
      i++;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    geo.setAttribute('aSpin', new THREE.BufferAttribute(spin, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60);

    this.galaxyMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uScale: { value: 1 }, uBrightness: { value: 0.85 } },
      vertexShader: GALAXY_VERT,
      fragmentShader: GALAXY_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.galaxies = new THREE.Points(geo, this.galaxyMat);
    this.galaxies.frustumCulled = false;
    this.galaxies.renderOrder = 2;
    this.scene.add(this.galaxies);
  }

  _buildDeepField() {
    const rng = new Rng(31415);
    const n = 9000;
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const color = new Float32Array(n * 3);
    const spin = new Float32Array(n);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const d = rng.onSphere();
      const r = 150 + Math.pow(rng.next(), 0.4) * 900;
      pos[i * 3] = d.x * r;
      pos[i * 3 + 1] = d.y * r;
      pos[i * 3 + 2] = d.z * r;
      size[i] = rng.range(0.6, 3.5);
      spin[i] = 0;
      // Everything this far away is cosmologically redshifted.
      c.setHSL(rng.range(0.02, 0.12), 0.5, rng.range(0.35, 0.6));
      color[i * 3] = c.r;
      color[i * 3 + 1] = c.g;
      color[i * 3 + 2] = c.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    geo.setAttribute('aSpin', new THREE.BufferAttribute(spin, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1100);
    const mat = this.galaxyMat.clone();
    mat.uniforms.uScale.value = 0.22;
    mat.uniforms.uBrightness.value = 0.18;
    this.deepField = new THREE.Points(geo, mat);
    this.deepField.frustumCulled = false;
    this.scene.add(this.deepField);
  }

  enter() {
    const cam = this.ctx.camera;
    cam.position.set(0, 8, 44);
    cam.lookAt(0, 0, 0);
  }

  update(dt, time) {
    const { input, camera } = this.ctx;
    this.web.update(dt, time, camera);
    this.galaxyMat.uniforms.uTime.value = time;

    // Orbit control. Any input takes over; releasing hands it back to the rail
    // after a beat, so the shot never sits dead but never fights the user.
    const dragging = input.down('primary') || input.usingTouch;
    if (Math.abs(input.look.x) > 0.0001 || Math.abs(input.look.y) > 0.0001) {
      if (dragging || input.pointerLocked) {
        this.orbit.theta -= input.look.x * 1.4;
        this.orbit.phi = clamp(this.orbit.phi + input.look.y * 1.4, 0.12, Math.PI - 0.12);
        this._idle = 0;
      }
    }
    this._idle += dt;
    if (this._idle > 3.5) this.orbit.theta += dt * 0.014;

    const zoom = input.scroll * 3 - input.pinch * 8 - input.move.y * dt * 14;
    this.orbit.radius = clamp(this.orbit.radius + zoom, 5, 220);

    const r = this.orbit.radius;
    const st = Math.sin(this.orbit.phi);
    camera.position.set(
      Math.sin(this.orbit.theta) * st * r,
      Math.cos(this.orbit.phi) * r,
      Math.cos(this.orbit.theta) * st * r
    );
    camera.lookAt(this.orbit.target);
  }

  dispose() {
    this.web.dispose();
    this.galaxies.geometry.dispose();
    this.galaxyMat.dispose();
    this.deepField.geometry.dispose();
  }
}
