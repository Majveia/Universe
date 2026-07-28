/**
 * Vehicles: the shared chassis, and the registry that hands them out.
 *
 * Three very different machines live on top of this file — a six-wheeled rover
 * that crawls, a hoverbike that slides, and a starship that flies in two
 * different physics regimes — and what they have in common is worth naming:
 *
 *   A rigid body. Not a kinematic transform with a velocity bolted on. Every
 *   vehicle here accumulates forces at *points* and integrates a real inertia
 *   tensor, because that is the only way load transfer, body roll and the way a
 *   machine settles on its springs come out for free instead of being animated.
 *   The moment you fake those you are writing a camera effect, and the hands can
 *   tell.
 *
 *   A ground query that works on a bare heightfield. The dependency contract
 *   promises `sampleHeight` and `sampleNormal` and nothing else, so the ray cast
 *   used by suspension and hover probes is a two-step Newton solve against the
 *   field rather than a scene raycast. Four iterations converge to under a
 *   millimetre on anything smooth enough to drive on, and if the realm does
 *   offer a real `raycast` we use that instead.
 *
 *   Mount and dismount as a momentum handoff. Getting out of a moving rover
 *   should put you on the ground with the rover's velocity, not stop the world.
 *
 * The registry is populated by the vehicle modules themselves rather than being
 * imported by this one. That is not fashion: `Rover.js` needs `Vehicle` from
 * here, so if this file imported `Rover.js` the cycle would evaluate the
 * subclass before its own base class existed. Registration inverts the edge and
 * the graph stays acyclic.
 */

import * as THREE from 'three';
import { clamp, saturate, damp, lerp } from '../core/Noise.js';
import { Emitter } from './Locomotion.js';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _m0 = new THREE.Matrix4();

const Y_UP = new THREE.Vector3(0, 1, 0);

// -----------------------------------------------------------------------------
// Rigid body.
// -----------------------------------------------------------------------------

/**
 * A six-degree-of-freedom rigid body with a diagonal inertia tensor.
 *
 * Diagonal is a real simplification and a defensible one: every chassis here is
 * close enough to a box that the off-diagonal terms are small, and a diagonal
 * tensor makes the body-frame angular update three multiplies instead of a
 * matrix inversion per tick. Angular velocity is *stored* in world space because
 * that is what every caller wants for contact-point velocities, and converted
 * into the body frame only for the integration itself.
 */
export class RigidBody {
  constructor(opts = {}) {
    this.mass = opts.mass ?? 1000;
    this.invMass = this.mass > 0 ? 1 / this.mass : 0;

    this.inertia = new THREE.Vector3(1, 1, 1);
    this.invInertia = new THREE.Vector3(1, 1, 1);
    if (opts.size) this.setBoxInertia(opts.size.x, opts.size.y, opts.size.z, opts.inertiaScale ?? 1);

    this.position = new THREE.Vector3().copy(opts.position || _v0.set(0, 0, 0));
    this.prevPosition = this.position.clone();
    this.velocity = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.prevQuaternion = new THREE.Quaternion();
    /** World-space angular velocity, rad/s. */
    this.angularVelocity = new THREE.Vector3();

    this.force = new THREE.Vector3();
    this.torque = new THREE.Vector3();

    // Damping is not air resistance — the vehicles model that themselves. It is
    // the numerical floor that stops a stiff spring network from ringing
    // forever, and it is deliberately small.
    this.linearDamping = opts.linearDamping ?? 0.0;
    this.angularDamping = opts.angularDamping ?? 0.35;
    this.maxAngularSpeed = opts.maxAngularSpeed ?? 12;
  }

  setBoxInertia(sx, sy, sz, scale = 1) {
    const m = this.mass / 12;
    this.inertia.set(
      m * (sy * sy + sz * sz) * scale,
      m * (sx * sx + sz * sz) * scale,
      m * (sx * sx + sy * sy) * scale
    );
    this.invInertia.set(1 / this.inertia.x, 1 / this.inertia.y, 1 / this.inertia.z);
  }

  addForce(f) {
    this.force.add(f);
  }

  /** Force at a world point — this is where all the interesting torque comes from. */
  addForceAtPoint(f, worldPoint) {
    this.force.add(f);
    _v0.subVectors(worldPoint, this.position);
    _v1.crossVectors(_v0, f);
    this.torque.add(_v1);
  }

  addTorque(t) {
    this.torque.add(t);
  }

  /** Velocity of a world point rigidly attached to the body. */
  pointVelocity(worldPoint, out = new THREE.Vector3()) {
    _v0.subVectors(worldPoint, this.position);
    out.crossVectors(this.angularVelocity, _v0).add(this.velocity);
    return out;
  }

  localDir(v, out = new THREE.Vector3()) {
    return out.copy(v).applyQuaternion(this.quaternion);
  }

  localPoint(v, out = new THREE.Vector3()) {
    return out.copy(v).applyQuaternion(this.quaternion).add(this.position);
  }

  worldToLocalDir(v, out = new THREE.Vector3()) {
    _q0.copy(this.quaternion).invert();
    return out.copy(v).applyQuaternion(_q0);
  }

  /** Semi-implicit Euler. Stable at 120 Hz for every spring rate in this file. */
  integrate(dt) {
    this.prevPosition.copy(this.position);
    this.prevQuaternion.copy(this.quaternion);

    this.velocity.addScaledVector(this.force, this.invMass * dt);
    if (this.linearDamping > 0) this.velocity.multiplyScalar(Math.exp(-this.linearDamping * dt));
    this.position.addScaledVector(this.velocity, dt);

    // Angular: into the body frame, apply Euler's equation, come back out.
    _q0.copy(this.quaternion).invert();
    _v0.copy(this.torque).applyQuaternion(_q0);
    _v1.copy(this.angularVelocity).applyQuaternion(_q0);
    // w x (I w) — the gyroscopic term. Small here, but it is what makes a
    // tumbling ship in vacuum precess instead of spinning like a turntable.
    _v2.set(this.inertia.x * _v1.x, this.inertia.y * _v1.y, this.inertia.z * _v1.z);
    _v2.crossVectors(_v1, _v2);
    _v0.sub(_v2);
    _v1.x += _v0.x * this.invInertia.x * dt;
    _v1.y += _v0.y * this.invInertia.y * dt;
    _v1.z += _v0.z * this.invInertia.z * dt;
    if (this.angularDamping > 0) _v1.multiplyScalar(Math.exp(-this.angularDamping * dt));
    _v1.applyQuaternion(this.quaternion);
    const w = _v1.length();
    if (w > this.maxAngularSpeed) _v1.multiplyScalar(this.maxAngularSpeed / w);
    this.angularVelocity.copy(_v1);

    // q' = 0.5 * omega * q, integrated and renormalised. At 120 Hz the error in
    // this first-order form is far below anything visible.
    _q0.set(this.angularVelocity.x, this.angularVelocity.y, this.angularVelocity.z, 0);
    _q0.multiply(this.quaternion);
    this.quaternion.x += _q0.x * 0.5 * dt;
    this.quaternion.y += _q0.y * 0.5 * dt;
    this.quaternion.z += _q0.z * 0.5 * dt;
    this.quaternion.w += _q0.w * 0.5 * dt;
    this.quaternion.normalize();

    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
  }

  teleport(position, quaternion) {
    this.position.copy(position);
    this.prevPosition.copy(position);
    if (quaternion) {
      this.quaternion.copy(quaternion);
      this.prevQuaternion.copy(quaternion);
    }
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
  }
}

// -----------------------------------------------------------------------------
// Ground queries.
// -----------------------------------------------------------------------------

/**
 * Cast a mostly-downward ray at the heightfield.
 *
 * Newton on `f(t) = p(t).y - h(p(t).xz)`. The derivative is dominated by the ray
 * direction, so we use `-dir.y` as the slope and let the iteration mop up the
 * terrain gradient. Four passes is plenty; the fifth never moves the answer by
 * enough to matter to a suspension spring.
 *
 * Returns null on a miss, otherwise a reused struct — callers must consume it
 * before the next call, which they all do.
 */
const _hit = {
  distance: 0,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
  surface: null,
  penetration: 0,
};

export function castGround(world, origin, dir, maxDist) {
  if (world.raycast) {
    const h = world.raycast(origin, dir, maxDist);
    if (!h) return null;
    _hit.distance = h.distance;
    _hit.point.copy(h.point);
    _hit.normal.copy(h.normal);
    _hit.surface = h.surface || world.surfaceAt?.(h.point.x, h.point.z) || null;
    _hit.penetration = 0;
    return _hit;
  }
  if (!world.sampleHeight) return null;

  const down = -dir.y;
  let t = 0;
  let gap = origin.y - world.sampleHeight(origin.x, origin.z);
  if (gap < 0) {
    // Already inside the terrain. Report a zero-distance contact with the depth,
    // which is what a suspension wants to hear when a wheel has been driven
    // into a rock face.
    _hit.distance = 0;
    _hit.point.set(origin.x, origin.y - gap, origin.z);
    const n = world.sampleNormal(origin.x, origin.z);
    _hit.normal.set(n.x, n.y, n.z).normalize();
    _hit.surface = world.surfaceAt?.(origin.x, origin.z) || null;
    _hit.penetration = -gap;
    return _hit;
  }
  if (down <= 1e-4) return null;

  for (let i = 0; i < 4; i++) {
    t += gap / down;
    if (t > maxDist * 1.6) return null;
    const px = origin.x + dir.x * t;
    const py = origin.y + dir.y * t;
    const pz = origin.z + dir.z * t;
    gap = py - world.sampleHeight(px, pz);
    if (Math.abs(gap) < 5e-4) break;
  }
  if (t > maxDist || t < 0) return null;

  _hit.distance = t;
  _hit.point.set(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
  const n = world.sampleNormal(_hit.point.x, _hit.point.z);
  _hit.normal.set(n.x, n.y, n.z).normalize();
  _hit.surface = world.surfaceAt?.(_hit.point.x, _hit.point.z) || null;
  _hit.penetration = 0;
  return _hit;
}

// -----------------------------------------------------------------------------
// Intent.
// -----------------------------------------------------------------------------

/** What a driver asks for. PlayerController fills it; the vehicle interprets it. */
export function createVehicleCommand() {
  return {
    throttle: 0,     // -1..1, forward/reverse or main engine
    steer: 0,        // -1..1, left/right
    brake: 0,        // 0..1
    handbrake: false,
    boost: false,
    lift: 0,         // -1..1, vertical thrust / hop
    strafe: 0,       // -1..1, lateral thrust (ship)
    pitch: 0,        // -1..1
    yaw: 0,
    roll: 0,
    gear: false,     // edge: toggle landing gear
    land: false,     // edge: begin an assisted landing
    damping: false,  // edge: toggle inertial damping
    lights: false,   // edge
    dt: 1 / 120,
  };
}

// -----------------------------------------------------------------------------
// Shared procedural materials and engine glow.
// -----------------------------------------------------------------------------

const FLAME_VERT = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uThrottle;
uniform float uSeed;

varying float vAlong;
varying float vFlare;

// One-dimensional value noise. The flame only needs to breathe; anything more
// expensive is detail nobody resolves at the size an exhaust plume occupies.
float wob(float x){
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float a = fract(sin(i * 91.7 + uSeed) * 43758.5453);
  float b = fract(sin((i + 1.0) * 91.7 + uSeed) * 43758.5453);
  return mix(a, b, f) * 2.0 - 1.0;
}

void main(){
  vec3 p = position;
  // Authored with the throat at the origin and the tail running down +Z.
  float along = clamp(p.z, 0.0, 1.0);
  vAlong = along;

  // Length tracks throttle. A plume that only brightened would read as a lamp.
  p.z *= mix(0.12, 1.0, uThrottle);
  float t = uTime * 9.0;
  float amp = along * along * 0.1 * (0.35 + uThrottle);
  p.x += wob(t + along * 4.0) * amp;
  p.y += wob(t * 1.17 + along * 4.0 + 23.0) * amp;
  // Expansion: an under-expanded nozzle fans out as the pressure drops.
  p.xy *= mix(1.0, 1.75, along * uThrottle);

  vFlare = uThrottle;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const FLAME_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uCore;
uniform vec3 uEdge;
uniform float uThrottle;

varying float vAlong;
varying float vFlare;

void main(){
  float head = smoothstep(0.0, 0.1, vAlong);
  float tail = 1.0 - smoothstep(0.3, 1.0, vAlong);
  float body = head * tail;
  vec3 c = mix(uCore, uEdge, smoothstep(0.04, 0.65, vAlong));
  // Written far above 1.0 so the bloom chain has something to overflow into;
  // an engine that peaks at white is an engine that never looks hot.
  gl_FragColor = vec4(c * (1.6 + uThrottle * 3.4), body * vFlare * 0.9);
}
`;

/**
 * A thruster. Returns a group you parent to the vehicle and a `set(throttle)`
 * that the vehicle calls once per frame.
 */
export function createThruster(opts = {}) {
  const radius = opts.radius ?? 0.22;
  const length = opts.length ?? 2.4;
  const seed = opts.seed ?? 3.7;

  const geo = new THREE.ConeGeometry(radius, 1, 12, 4, true);
  geo.translate(0, -0.5, 0);
  geo.rotateX(-Math.PI / 2); // body now runs down +Z, throat at the origin
  geo.scale(1, 1, length);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uThrottle: { value: 0 },
      uSeed: { value: seed },
      uCore: { value: new THREE.Color(opts.core || 0xdff0ff) },
      uEdge: { value: new THREE.Color(opts.edge || 0x3f7dff) },
    },
    vertexShader: FLAME_VERT,
    fragmentShader: FLAME_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 7;
  mesh.visible = false;

  // The bell itself, so the engine is hardware when it is cold.
  const bellMat = new THREE.MeshStandardMaterial({
    color: 0x1e2128,
    metalness: 0.9,
    roughness: 0.36,
    emissive: new THREE.Color(opts.edge || 0x3f7dff),
    emissiveIntensity: 0,
    side: THREE.DoubleSide,
  });
  const bell = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 1.25, radius * 0.85, radius * 1.5, 12, 1, true),
    bellMat
  );
  bell.rotation.x = Math.PI / 2;
  bell.position.z = -radius * 0.6;

  const group = new THREE.Group();
  group.add(bell, mesh);

  let light = null;
  if (opts.light !== false) {
    light = new THREE.PointLight(new THREE.Color(opts.edge || 0x3f7dff), 0, 14, 2);
    light.position.z = radius * 2;
    group.add(light);
  }

  return {
    group,
    mesh,
    bell,
    set(throttle, time) {
      const t = saturate(throttle);
      mesh.visible = t > 0.02;
      mat.uniforms.uThrottle.value = t;
      mat.uniforms.uTime.value = time;
      bellMat.emissiveIntensity = t * 3.2;
      if (light) {
        light.intensity = t * (opts.lightGain ?? 16);
        light.distance = 5 + t * 14;
      }
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      bell.geometry.dispose();
      bellMat.dispose();
    },
  };
}

/** Hull plate. Slightly rough metal — a mirror finish reads as plastic. */
export function hullMaterial(colour, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color: colour,
    metalness: opts.metalness ?? 0.62,
    roughness: opts.roughness ?? 0.44,
    flatShading: !!opts.flat,
  });
}

/** Rubber, cable, seal — anything that should absorb light rather than throw it. */
export function rubberMaterial(colour = 0x16181c) {
  return new THREE.MeshStandardMaterial({ color: colour, metalness: 0.02, roughness: 0.92 });
}

/** A light strip. Emissive above 1 so the bloom chain finds it. */
export function glowMaterial(colour, intensity = 2.4) {
  return new THREE.MeshStandardMaterial({
    color: 0x05070a,
    metalness: 0.4,
    roughness: 0.3,
    emissive: new THREE.Color(colour),
    emissiveIntensity: intensity,
  });
}

/** Cockpit glass: dark, reflective, and thin enough to see the pilot through. */
export function glassMaterial(tint = 0x0a1420) {
  return new THREE.MeshStandardMaterial({
    color: tint,
    metalness: 1.0,
    roughness: 0.06,
    transparent: true,
    opacity: 0.42,
    side: THREE.DoubleSide,
  });
}

// -----------------------------------------------------------------------------
// The base vehicle.
// -----------------------------------------------------------------------------

export class Vehicle extends Emitter {
  constructor(world, opts = {}) {
    super();
    this.world = world;
    this.kind = 'vehicle';
    this.label = 'Vehicle';
    this.icon = '⬡';
    this.seats = 1;

    this.body = new RigidBody(opts.body || {});
    this.group = new THREE.Group();
    this.group.name = opts.name || 'vehicle';
    this.group.matrixAutoUpdate = true;

    /** Camera anchor for the inside view. Parented into the vehicle graph. */
    this.cockpit = new THREE.Object3D();
    this.cockpit.name = 'cockpit';
    this.group.add(this.cockpit);

    /** Chase-camera shape. CameraRig reads this verbatim. */
    this.chase = {
      distance: 9,
      height: 2.4,
      lift: 0.5,
      lookAhead: 7,
      refSpeed: 24,
      follow: 9,
      collide: true,
      worldUp: true,
    };

    /** Where a driver is put down when they get out, in body-local metres. */
    this.exitOffset = new THREE.Vector3(2.2, 0.4, 0);

    this.driver = null;
    this.mounted = false;
    this.enabled = true;
    this.fx = null;
    this.lightsOn = false;
    this.grounded = false;
    this.time = 0;

    this._geometries = [];
    this._materials = [];
    this._thrusters = [];
  }

  // --- state passthrough -----------------------------------------------------

  get position() {
    return this.body.position;
  }
  get velocity() {
    return this.body.velocity;
  }
  get quaternion() {
    return this.body.quaternion;
  }
  get speed() {
    return this.body.velocity.length();
  }
  /** Signed speed along the nose — negative means reversing. */
  get forwardSpeed() {
    _v0.set(0, 0, -1).applyQuaternion(this.body.quaternion);
    return this.body.velocity.dot(_v0);
  }
  get boostLevel() {
    return this._boostBlend ?? 0;
  }

  // --- lifecycle -------------------------------------------------------------

  /** Drop the vehicle onto the terrain at a world position, facing `heading`. */
  placeOnGround(x, z, heading = 0) {
    const world = this.world;
    const h = world.sampleHeight(x, z);
    this.body.teleport(_v0.set(x, h + (this.restHeight ?? 1.2), z), _q0.setFromAxisAngle(Y_UP, heading));
    this.interpolate(1);
    return this;
  }

  setFX(fx) {
    this.fx = fx;
    return this;
  }

  /** Take the driver. Momentum is *not* reset — you can board a rolling rover. */
  mount(player) {
    if (this.mounted) return false;
    this.driver = player || null;
    this.mounted = true;
    this.emit('mount', this);
    return true;
  }

  dismount() {
    if (!this.mounted) return false;
    const p = this.driver;
    this.driver = null;
    this.mounted = false;
    this.emit('dismount', this, p);
    return true;
  }

  /** World point to place a dismounting driver, dropped onto the terrain. */
  exitPoint(out = new THREE.Vector3()) {
    out.copy(this.exitOffset).applyQuaternion(this.body.quaternion).add(this.body.position);
    const h = this.world.sampleHeight(out.x, out.z);
    out.y = h;
    return out;
  }

  /** Actions the HUD should offer while this vehicle is being driven. */
  contextActions() {
    return [
      { id: 'boost', label: 'Boost', icon: '≫', enabled: true },
      { id: 'toggleView', label: 'View', icon: '⧉', enabled: true },
      { id: 'vehicle', label: 'Exit', icon: '⤓', enabled: true },
    ];
  }

  // --- frame -----------------------------------------------------------------

  /** Fixed step. Subclasses implement the physics; this is the shared bookkeeping. */
  step(dt, cmd) {
    this.time += dt;
    this.body.integrate(dt);
  }

  /**
   * Write the render transform from the fixed-step state.
   *
   * `alpha` is the fraction of the way through the current physics step, so the
   * rendered pose is between the last two ticks rather than snapped to the last
   * one. Without this a 144 Hz display shows 120 Hz stutter.
   */
  interpolate(alpha) {
    const b = this.body;
    this.group.position.lerpVectors(b.prevPosition, b.position, alpha);
    this.group.quaternion.copy(b.prevQuaternion).slerp(b.quaternion, alpha);
  }

  /** Presentation, on wall-clock dt. */
  updateFX(dt, time) {
    for (const t of this._thrusters) t.set(t.level ?? 0, time);
  }

  // --- construction helpers --------------------------------------------------

  _track(obj) {
    if (obj.geometry && !this._geometries.includes(obj.geometry)) this._geometries.push(obj.geometry);
    if (obj.material && !this._materials.includes(obj.material)) this._materials.push(obj.material);
    return obj;
  }

  _mesh(geometry, material, parent) {
    const m = new THREE.Mesh(geometry, material);
    m.castShadow = true;
    m.receiveShadow = true;
    this._geometries.push(geometry);
    if (!this._materials.includes(material)) this._materials.push(material);
    (parent || this.group).add(m);
    return m;
  }

  dispose() {
    this.group.parent?.remove(this.group);
    for (const g of this._geometries) g.dispose();
    for (const m of this._materials) m.dispose();
    for (const t of this._thrusters) t.dispose?.();
    this._geometries.length = 0;
    this._materials.length = 0;
    this._thrusters.length = 0;
  }
}

// -----------------------------------------------------------------------------
// Registry.
// -----------------------------------------------------------------------------

const REGISTRY = new Map();

/**
 * Static description of every kind, available whether or not the implementing
 * module has been loaded. The HUD and the save system want to talk about a
 * starship without paying to construct one.
 */
export const VEHICLE_SPECS = {
  rover: {
    kind: 'rover',
    label: 'Rover',
    icon: '⬡',
    blurb: 'Six-wheel surface crawler. Slow, unstoppable, repairable.',
    domain: 'surface',
    seats: 2,
  },
  hoverbike: {
    kind: 'hoverbike',
    label: 'Hoverbike',
    icon: '⌁',
    blurb: 'Ducted-fan single-seater. Fast, loose, no roll cage.',
    domain: 'surface',
    seats: 1,
  },
  starship: {
    kind: 'starship',
    label: 'Starship',
    icon: '⬟',
    blurb: 'Atmospheric lifting body with vacuum thrusters and a warp coil.',
    domain: 'orbit',
    seats: 4,
  },
};

/** Called by each vehicle module at load. Keeps the import graph acyclic. */
export function registerVehicle(kind, ctor, spec) {
  REGISTRY.set(kind, ctor);
  if (spec) VEHICLE_SPECS[kind] = { ...(VEHICLE_SPECS[kind] || {}), ...spec };
  return ctor;
}

export function vehicleKinds() {
  return [...REGISTRY.keys()];
}

/**
 * Build one. Throws rather than returning null on an unknown kind, because a
 * silent null here surfaces four frames later as a camera pointed at the origin.
 */
export function createVehicle(kind, world, opts = {}) {
  const Ctor = REGISTRY.get(kind);
  if (!Ctor) {
    throw new Error(
      `Unknown vehicle "${kind}". Known: ${vehicleKinds().join(', ') || '(none loaded)'}`
    );
  }
  return new Ctor(world, opts);
}

/**
 * The set of vehicles that exist in a realm.
 *
 * Owns their scene group, steps the ones that need stepping, and answers the one
 * question the player actually asks: what can I get into from here.
 */
export class VehicleRegistry {
  constructor(world, opts = {}) {
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = 'vehicles';
    this.list = [];
    this.fx = opts.fx || null;
    /** Beyond this a vehicle is scenery: it does not simulate. */
    this.simRadius = opts.simRadius ?? 900;
  }

  add(vehicle) {
    this.list.push(vehicle);
    this.group.add(vehicle.group);
    if (this.fx) vehicle.setFX(this.fx);
    return vehicle;
  }

  spawn(kind, opts = {}) {
    const v = createVehicle(kind, this.world, opts);
    if (opts.at) v.placeOnGround(opts.at.x, opts.at.z, opts.heading ?? 0);
    return this.add(v);
  }

  remove(vehicle) {
    const i = this.list.indexOf(vehicle);
    if (i >= 0) this.list.splice(i, 1);
    this.group.remove(vehicle.group);
    return vehicle;
  }

  setWorld(world) {
    this.world = world;
    for (const v of this.list) v.world = world;
  }

  setFX(fx) {
    this.fx = fx;
    for (const v of this.list) v.setFX(fx);
  }

  /**
   * Nearest boardable vehicle, weighted toward the one you are looking at so
   * two parked side by side do not fight over the prompt.
   */
  nearest(position, maxDist = 6, forward = null) {
    let best = null;
    let bestScore = Infinity;
    for (const v of this.list) {
      if (v.mounted) continue;
      const d = v.position.distanceTo(position);
      if (d > maxDist + (v.boardRadius ?? 0)) continue;
      let score = d;
      if (forward) {
        _v0.subVectors(v.position, position);
        const len = _v0.length();
        if (len > 1e-3) {
          _v0.multiplyScalar(1 / len);
          // Facing it is worth about a metre and a half of distance.
          score -= saturate(_v0.dot(forward)) * 1.5;
        }
      }
      if (score < bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best;
  }

  /** Fixed step. Unmounted vehicles still settle on their springs; that is free. */
  step(dt, focus, driven, cmd) {
    for (const v of this.list) {
      if (!v.enabled) continue;
      if (focus && v.position.distanceToSquared(focus) > this.simRadius * this.simRadius) continue;
      v.step(dt, v === driven ? cmd : v.idleCommand || (v.idleCommand = createVehicleCommand()));
    }
  }

  interpolate(alpha) {
    for (const v of this.list) v.interpolate(alpha);
  }

  updateFX(dt, time) {
    for (const v of this.list) v.updateFX(dt, time);
  }

  dispose() {
    for (const v of this.list) v.dispose();
    this.list.length = 0;
    this.group.parent?.remove(this.group);
  }
}
