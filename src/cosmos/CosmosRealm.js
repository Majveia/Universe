/**
 * The largest scale. You are outside everything, looking at the scaffolding.
 *
 * This scale is deliberately contemplative — a held wide shot before the
 * descent. The camera drifts on a slow rail unless the user takes hold of it,
 * and hands control back a few seconds after they let go, so the shot is never
 * dead but never fights them either.
 */

import * as THREE from 'three';
import { Realm } from '../core/Director.js';
import { CosmicWeb } from './CosmicWeb.js';
import { Rng } from '../core/Rng.js';
import { settings } from '../core/Settings.js';
import { damp, clamp } from '../core/Noise.js';
import { GLSL_LIB } from '../shaders/common.js';

/**
 * The cosmic microwave background, rendered on the inside of a very large
 * sphere. It is the oldest light there is and it is genuinely everywhere, so
 * having it as the literal backdrop is both accurate and the right way to keep
 * the void from reading as an empty buffer. Amplitude is exaggerated far beyond
 * the real 1-part-in-10^5 anisotropy, or it would be invisible.
 */
const CMB_FRAG = /* glsl */ `
precision highp float;
${GLSL_LIB}
uniform float uTime;
uniform float uStrength;
varying vec3 vDir;

void main(){
  vec3 d = normalize(vDir);
  // A few octaves standing in for the acoustic peaks — the characteristic
  // angular scale of the first peak is about a degree, which at this radius is
  // roughly the frequency of the second term.
  float t = fbm(d * 3.1, 3) * 0.6 + fbm(d * 9.4, 3) * 0.3 + fbm(d * 24.0, 2) * 0.1;
  // Map fluctuation to a cold/hot dipole around the 2.725 K mean.
  vec3 cold = vec3(0.02, 0.05, 0.16);
  vec3 hot  = vec3(0.20, 0.06, 0.10);
  vec3 col = mix(cold, hot, smoothstep(-0.35, 0.35, t));
  col *= uStrength;
  // Dither hard — this is a near-black gradient covering the whole sphere,
  // exactly the case where 8-bit output bands catastrophically on an OLED.
  col += (ign(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

const CMB_VERT = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export class CosmosRealm extends Realm {
  constructor(ctx) {
    super(ctx);
    this.near = 0.05;
    this.far = 6000;
    this.ambience = 'cosmos';
    // Sit just inside the visible volume rather than outside it. The web is
    // ~14 units of visible radius; from 26 away the whole thing fits on screen
    // with black all round it and reads as a ball floating in a void — which is
    // the one thing every survey render avoids. From 16 the structure runs off
    // all four edges and the frame is filled by filaments instead of by its own
    // silhouette.
    this.orbit = { theta: 0.6, phi: 1.05, radius: 16, target: new THREE.Vector3() };
    this._idle = 10;
    this._radiusTarget = 16;
  }

  async build() {
    const scene = this.scene;
    scene.background = new THREE.Color(0x000000);

    const buf = this.ctx.engine.renderer.getDrawingBufferSize(new THREE.Vector2());

    this.web = new CosmicWeb({
      seed: 20260728,
      boxSize: 36,
      count: settings.cosmicParticles,
      galaxies: Math.round(settings.cosmicParticles * 0.05),
    });
    this.web.setViewportHeight(buf.y);
    scene.add(this.web.object3d);

    this._offResize = this.ctx.engine.onResize(() => {
      const b = this.ctx.engine.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.web.setViewportHeight(b.y);
    });

    this._buildCMB();

    return this;
  }

  _buildCMB() {
    const geo = new THREE.SphereGeometry(2600, 48, 32);
    this.cmbMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uStrength: { value: 0.055 } },
      vertexShader: CMB_VERT,
      fragmentShader: CMB_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });
    this.cmb = new THREE.Mesh(geo, this.cmbMat);
    this.cmb.frustumCulled = false;
    this.cmb.renderOrder = -1;
    this.scene.add(this.cmb);
  }

  enter() {
    const cam = this.ctx.camera;
    cam.position.set(0, 6, 26);
    cam.lookAt(0, 0, 0);
  }

  update(dt, time) {
    const { input, camera } = this.ctx;
    this.web.update(dt, time, camera);
    this.cmbMat.uniforms.uTime.value = time;

    // Any look input takes the rail over; it resumes after a beat of stillness.
    const engaged = input.down('primary') || input.pointerLocked || input.usingTouch;
    if (engaged && (Math.abs(input.look.x) > 1e-4 || Math.abs(input.look.y) > 1e-4)) {
      this.orbit.theta -= input.look.x * 1.5;
      this.orbit.phi = clamp(this.orbit.phi + input.look.y * 1.5, 0.14, Math.PI - 0.14);
      this._idle = 0;
    }
    this._idle += dt;
    if (this._idle > 3.0) this.orbit.theta += dt * 0.016;

    const zoom = input.scroll * 4 - input.pinch * 10 - input.move.y * dt * 18;
    if (Math.abs(zoom) > 1e-5) this._idle = 0;
    // Clamped to stay inside the simulation volume — from outside it, the box
    // reads as a box, and the illusion of an unbounded universe dies.
    this._radiusTarget = clamp(this._radiusTarget + zoom, 4, 70);
    // Damped so a scroll wheel glides instead of stepping.
    this.orbit.radius = damp(this.orbit.radius, this._radiusTarget, 8, dt);

    const r = this.orbit.radius;
    const st = Math.sin(this.orbit.phi);
    camera.position.set(
      Math.sin(this.orbit.theta) * st * r,
      Math.cos(this.orbit.phi) * r,
      Math.cos(this.orbit.theta) * st * r
    );
    camera.lookAt(this.orbit.target);
    this.cmb.position.copy(camera.position);
  }

  dispose() {
    this._offResize?.();
    this.web.dispose();
    this.cmb.geometry.dispose();
    this.cmbMat.dispose();
  }
}
