/**
 * The jetpack.
 *
 * A jetpack is a resource, a verb, and a light source, in that order of
 * importance. The resource is what makes it interesting — infinite flight
 * flattens terrain into a texture, and a two-second budget turns every ridge
 * back into a decision. So the fuel curve is tuned to be *just* short of
 * comfortable: a full tank buys about four seconds of climb or nine seconds of
 * hover, which is enough to cross a ravine and not enough to skip a mountain.
 *
 * Thrust is expressed as a multiple of local gravity rather than as an absolute
 * acceleration. On a 0.4 g moon a fixed 20 m/s^2 would fling you into orbit; as
 * a multiple, the pack always feels like the same machine and the *world* is
 * what changed. The multiplier is 2.05, so net upward acceleration under full
 * burn is a little over one g — brisk, but you can still see where you are going.
 *
 * Three burn modes, because they answer three different questions:
 *   ignition — a short overdriven kick, so tapping the pack does something
 *              decisive instead of mushily bleeding fuel
 *   climb    — sustained full thrust while held
 *   hover    — a PD controller that holds altitude for a third of the fuel,
 *              which is what you actually want when lining up a landing
 *
 * Chaining matters. If the pack lights within a short window after a jump, the
 * ignition kick is larger — sprint into slide into jump into boost is the flow
 * loop the whole player subsystem is built around, and the game should pay you
 * for hitting it rather than merely permitting it.
 */

import * as THREE from 'three';
import { clamp, saturate, damp, lerp } from '../core/Noise.js';
import { Rng } from '../core/Rng.js';

export const JETPACK_PROFILE = {
  maxFuel: 100,
  thrustRatio: 2.05,        // multiples of local gravity at full burn
  ignitionRatio: 3.2,       // overdrive during the ignition window
  ignitionTime: 0.22,       // how long the kick lasts
  chainWindow: 0.45,        // post-jump window that upgrades the kick
  chainBonus: 1.35,         // multiplier on the ignition kick when chained
  hoverRatio: 1.0,          // hover holds you, it does not lift you
  hoverAssist: 2.6,         // PD gain pulling vertical speed to zero in hover

  burnClimb: 24,            // fuel per second at full thrust
  burnHover: 11,
  burnIgnition: 30,
  rechargeRate: 27,         // per second, once the delay has elapsed
  rechargeDelay: 0.9,       // grounded seconds before the tank starts filling
  airRecharge: 0.0,         // deliberately zero: landing is the reload

  minFuelToLight: 6,        // stops the pack sputtering on fumes
  lateralAuthority: 5.4,    // m/s^2 of steering while under thrust
  maxLateralSpeed: 11.5,    // and the speed it steers toward

  spoolUp: 14,              // throttle response, per second
  spoolDown: 9,             // slower off than on, so the plume trails
};

const PLUME_VERT = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uThrottle;
uniform float uSeed;

varying vec2 vUv;
varying float vFlare;

// Cheap value noise. The plume only needs to wobble convincingly, and a full
// simplex here would be paying for detail nobody can resolve at this size.
float wob(float x){
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float a = fract(sin(i * 127.1 + uSeed) * 43758.5453);
  float b = fract(sin((i + 1.0) * 127.1 + uSeed) * 43758.5453);
  return mix(a, b, f) * 2.0 - 1.0;
}

void main(){
  vUv = uv;
  vec3 p = position;

  // The cone is authored pointing down -Y with its tip at the nozzle, so uv.y
  // runs from the throat (0) to the tail (1).
  float along = clamp(-p.y / 1.0, 0.0, 1.0);

  // Length tracks throttle; a plume that only changed brightness reads as a
  // light, not as a rocket.
  p.y *= mix(0.18, 1.0, uThrottle);

  // Lateral wander grows along the plume: coherent at the throat where the gas
  // is still confined, chaotic at the tail where it has expanded.
  float t = uTime * 11.0;
  float amp = along * along * 0.14 * (0.4 + uThrottle);
  p.x += wob(t + along * 5.0) * amp;
  p.z += wob(t * 1.13 + along * 5.0 + 17.0) * amp;
  p.xz *= mix(1.0, 1.9, along * uThrottle);

  vFlare = uThrottle;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const PLUME_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uCore;
uniform vec3 uEdge;
uniform float uThrottle;

varying vec2 vUv;
varying float vFlare;

void main(){
  float along = vUv.y;
  // Radial coordinate across the cone's circumference is not available from a
  // cone's uv, so brightness is shaped along the length only and the geometry
  // provides the cross-section. Additive blending does the rest.
  float head = smoothstep(0.0, 0.12, along);
  float tail = 1.0 - smoothstep(0.35, 1.0, along);
  float body = head * tail;

  // Colour marches from a hot near-white throat out to a cool edge — the
  // temperature gradient of an actual under-expanded plume.
  vec3 c = mix(uCore, uEdge, smoothstep(0.05, 0.7, along));
  float a = body * vFlare;

  // Written well above 1.0 on purpose: the bloom chain in PostFX is what turns
  // this into a glow, and it can only bloom what overflows.
  gl_FragColor = vec4(c * (1.4 + uThrottle * 2.6), a * 0.85);
}
`;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export class Jetpack {
  constructor(opts = {}) {
    this.p = { ...JETPACK_PROFILE, ...(opts.profile || {}) };
    this.rng = new Rng(opts.seed ?? 0x5e7f1e);

    this.fuel = this.p.maxFuel;
    this.active = false;
    this.hovering = false;
    this.throttle = 0;        // smoothed 0..1, drives audio and the plume
    this.rawThrottle = 0;
    this.igniting = 0;        // remaining ignition-window seconds
    this.chained = false;     // did this ignition come out of a jump
    this.timeSinceUse = 99;
    this.groundedTime = 0;
    this.overheat = 0;        // 0..1, purely cosmetic: the nozzles glow hotter

    /** World-space acceleration the motor should apply this tick. */
    this.thrust = new THREE.Vector3();
    /** Set when the tank runs dry mid-burn, so the HUD can flash once. */
    this.justEmptied = false;
    this.justLit = false;

    this.group = null;
    this._nozzles = [];
    this._light = null;
    this._time = 0;
  }

  get fuelFraction() {
    return saturate(this.fuel / this.p.maxFuel);
  }

  get available() {
    return this.fuel >= this.p.minFuelToLight;
  }

  // ---------------------------------------------------------------------------
  // Simulation. Runs on the motor's fixed timestep.
  // ---------------------------------------------------------------------------

  /**
   * @param {number} dt fixed step
   * @param {object} s  {
   *   want: boolean, hoverHold: boolean, grounded: boolean, gravity: number,
   *   up: Vector3, velocity: Vector3, wish: Vector3, timeSinceJump: number
   * }
   * @returns {THREE.Vector3} world-space acceleration to hand to the motor
   */
  update(dt, s) {
    const p = this.p;
    this.thrust.set(0, 0, 0);
    this.justEmptied = false;
    this.justLit = false;
    this._time += dt;

    if (s.grounded) this.groundedTime += dt;
    else this.groundedTime = 0;
    this.timeSinceUse += dt;

    // --- can we light? --------------------------------------------------------
    // Refusing to light on the ground is deliberate: a jetpack that can be used
    // as a walking assist stops being a traversal tool and becomes a speed hack.
    const wantLight = !!s.want && !s.grounded;
    const canBurn = this.fuel > 0.01 && (this.active ? true : this.fuel >= p.minFuelToLight);

    if (wantLight && canBurn) {
      if (!this.active) {
        this.active = true;
        this.igniting = p.ignitionTime;
        // Chained if the pack lights shortly after leaving the ground under
        // your own power. That is the sprint-slide-jump-boost payoff.
        this.chained = (s.timeSinceJump ?? 99) < p.chainWindow;
        this.justLit = true;
      }
    } else if (this.active) {
      this.active = false;
      this.igniting = 0;
      this.chained = false;
    }

    this.hovering = this.active && !!s.hoverHold;

    // --- thrust ---------------------------------------------------------------
    if (this.active) {
      const g = s.gravity;
      let ratio;
      let burn;

      if (this.igniting > 0) {
        // Ease the kick out over its window rather than cutting it, so the
        // transition into sustained climb has no step in it.
        const k = this.igniting / p.ignitionTime;
        const boost = this.chained ? p.chainBonus : 1;
        ratio = lerp(p.thrustRatio, p.ignitionRatio * boost, k * k);
        burn = p.burnIgnition;
        this.igniting = Math.max(0, this.igniting - dt);
      } else if (this.hovering) {
        ratio = p.hoverRatio;
        burn = p.burnHover;
      } else {
        ratio = p.thrustRatio;
        burn = p.burnClimb;
      }

      // Vertical component, along the world's own up so this works on a sphere.
      let a = g * ratio;
      if (this.hovering) {
        // Hover is a controller, not a constant: cancel gravity, then null out
        // whatever vertical speed remains. Without the damping term you drift.
        const vUp = s.velocity ? s.velocity.dot(s.up) : 0;
        a = g - vUp * p.hoverAssist;
        a = clamp(a, 0, g * p.thrustRatio);
      }
      this.thrust.addScaledVector(s.up, a);

      // Lateral authority. Under thrust you steer far better than in free fall,
      // which is the whole reason to light the pack over a gap.
      if (s.wish && s.wish.lengthSq() > 1e-6) {
        _v.copy(s.wish);
        _v.addScaledVector(s.up, -_v.dot(s.up));
        const l = _v.length();
        if (l > 1e-5) {
          _v.multiplyScalar(1 / l);
          const vUp = s.velocity ? s.velocity.dot(s.up) : 0;
          _v2.copy(s.velocity || _v2.set(0, 0, 0)).addScaledVector(s.up, -vUp);
          const along = _v2.dot(_v);
          const room = p.maxLateralSpeed - along;
          if (room > 0) {
            this.thrust.addScaledVector(_v, Math.min(p.lateralAuthority, room / Math.max(dt, 1e-4)));
          }
        }
      }

      const spent = burn * dt;
      this.fuel -= spent;
      this.timeSinceUse = 0;
      if (this.fuel <= 0) {
        this.fuel = 0;
        this.active = false;
        this.igniting = 0;
        this.justEmptied = true;
        // Cut the thrust on the tick it runs out rather than the next one; a
        // flameout you can feel is better than one you only see in a bar.
        this.thrust.multiplyScalar(0.35);
      }
      this.rawThrottle = this.hovering ? 0.55 : 1;
    } else {
      this.rawThrottle = 0;
      // Refuel only with both boots down and a beat of stillness. The delay is
      // what stops a rhythmic tap-tap-tap from being free flight.
      if (s.grounded && this.groundedTime > p.rechargeDelay) {
        this.fuel = Math.min(p.maxFuel, this.fuel + p.rechargeRate * dt);
      } else if (p.airRecharge > 0) {
        this.fuel = Math.min(p.maxFuel, this.fuel + p.airRecharge * dt);
      }
    }

    // Asymmetric spool: fast to light, slow to die. That asymmetry is most of
    // why a plume looks like combustion instead of like a toggled sprite.
    const rate = this.rawThrottle > this.throttle ? p.spoolUp : p.spoolDown;
    this.throttle = damp(this.throttle, this.rawThrottle, rate, dt);
    this.overheat = damp(this.overheat, this.active ? saturate(1 - this.fuelFraction * 1.3) : 0, 2.2, dt);

    return this.thrust;
  }

  /** Fuel top-up from a pickup or a vehicle dock. */
  refuel(amount = Infinity) {
    this.fuel = Math.min(this.p.maxFuel, this.fuel + amount);
  }

  // ---------------------------------------------------------------------------
  // Visuals.
  // ---------------------------------------------------------------------------

  /**
   * Build the pack's exhaust. `mount` is the backpack node on the character rig;
   * the nozzles are positioned in its local space.
   */
  buildFX(mount, opts = {}) {
    if (this.group) return this.group;
    const scale = opts.scale ?? 1;
    this.group = new THREE.Group();
    this.group.name = 'jetpack-fx';

    // A cone with its tip at the origin pointing down -Y. `openEnded` because
    // the cap would be a visible disc through the additive blend.
    const geo = new THREE.ConeGeometry(0.085 * scale, 1, 10, 6, true);
    geo.translate(0, -0.5, 0);
    geo.rotateX(Math.PI); // tip up at the nozzle, body hanging below

    const offsets = opts.nozzles || [
      new THREE.Vector3(-0.15 * scale, -0.05 * scale, 0.16 * scale),
      new THREE.Vector3(0.15 * scale, -0.05 * scale, 0.16 * scale),
    ];

    for (let i = 0; i < offsets.length; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uThrottle: { value: 0 },
          uSeed: { value: this.rng.range(0, 100) },
          uCore: { value: new THREE.Color(0.85, 0.95, 1.0) },
          uEdge: { value: new THREE.Color(0.25, 0.5, 1.0) },
        },
        vertexShader: PLUME_VERT,
        fragmentShader: PLUME_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(offsets[i]);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 7;
      this.group.add(mesh);

      // A physical nozzle so the pack reads as hardware when it is cold.
      const bellGeo = new THREE.CylinderGeometry(0.055 * scale, 0.075 * scale, 0.12 * scale, 10, 1, true);
      const bellMat = new THREE.MeshStandardMaterial({
        color: 0x2a2d33,
        metalness: 0.85,
        roughness: 0.42,
        emissive: new THREE.Color(0xff5a1e),
        emissiveIntensity: 0,
        side: THREE.DoubleSide,
      });
      const bell = new THREE.Mesh(bellGeo, bellMat);
      bell.position.copy(offsets[i]).y += 0.05 * scale;
      this.group.add(bell);

      this._nozzles.push({ mesh, mat, bellMat });
    }

    if (opts.light !== false) {
      // One light, not two. The second adds nothing at this scale and doubles
      // the per-fragment lighting cost on every surface near the player.
      this._light = new THREE.PointLight(0x6fa8ff, 0, 9, 2);
      this._light.position.set(0, -0.25 * scale, 0.16 * scale);
      this.group.add(this._light);
    }

    if (mount) mount.add(this.group);
    return this.group;
  }

  /**
   * Per-frame visual step. Runs on wall-clock dt, not the fixed step, because
   * the plume is presentation and should be as smooth as the display allows.
   */
  updateFX(dt, time) {
    if (!this.group) return;
    const t = this.throttle;
    const visible = t > 0.015;
    for (const n of this._nozzles) {
      n.mesh.visible = visible;
      n.mat.uniforms.uTime.value = time;
      n.mat.uniforms.uThrottle.value = t;
      // Hover burns cooler and bluer; a climb runs hot and washes toward white.
      const heat = this.hovering ? 0.25 : 1;
      n.mat.uniforms.uCore.value.setRGB(0.7 + 0.3 * heat, 0.88 + 0.1 * heat, 1.0);
      n.mat.uniforms.uEdge.value.setRGB(0.2 + 0.45 * heat * this.overheat, 0.42, 1.0);
      n.bellMat.emissiveIntensity = t * 2.4 + this.overheat * 0.8;
    }
    if (this._light) {
      this._light.intensity = t * 14;
      this._light.distance = 6 + t * 8;
    }
  }

  /** Ground wash — call while low and burning so the pack disturbs the surface. */
  washInto(fx, groundPoint, normal, surface, gravity, up, dt) {
    if (!fx || this.throttle < 0.15) return;
    fx.scuff(groundPoint, normal, dt, {
      surface,
      gravity,
      up,
      intensity: this.throttle * 1.6,
    });
  }

  dispose() {
    if (!this.group) return;
    this.group.parent?.remove(this.group);
    for (const n of this._nozzles) {
      n.mat.dispose();
      n.bellMat.dispose();
      n.mesh.geometry.dispose();
    }
    this._nozzles.length = 0;
    this.group = null;
  }
}
