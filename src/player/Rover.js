/**
 * The rover.
 *
 * Six wheels, six independent raycast struts, one rigid body, and no fudging.
 * That last part is the whole design: nothing in this file animates a chassis.
 * The body pitches under braking because the brake force is applied at the
 * contact patch, a metre below the centre of mass, which produces a torque,
 * which compresses the front springs, which raises the front tyre load, which is
 * why the front wheels then have more grip than the rear. Every one of those
 * steps is a real term in the loop below. If you fake the first one you have to
 * fake all of them, and what you end up with is a camera effect.
 *
 * The suspension model is the classic raycast strut, which is the right answer
 * for a vehicle on a heightfield:
 *
 *   Each strut casts along the *chassis* down axis rather than along world down,
 *   because that is the direction the physical damper actually travels. Tilt the
 *   rover and the struts tilt with it.
 *
 *   Spring force is `k * compression`, damper force is `c * strutSpeed`, and the
 *   sum is clamped at zero from below — a suspension pushes, it never pulls. Get
 *   that clamp wrong and a wheel in the air sucks the corner down and the whole
 *   machine crabs sideways over a rock.
 *
 *   Stiffness is derived from the local gravity rather than authored, so the
 *   ride height is the same on a 1.6 m/s² moon as it is on a 9.8 m/s² world. A
 *   fixed spring rate would leave the moon rover sitting on its bump stops with
 *   the suspension fully extended and no travel left to absorb anything.
 *
 * Steering is six-wheel: the front pair leads, the rear pair counter-steers at
 * low speed and stops doing so above walking pace. That is what real six-wheel
 * platforms do, it halves the turning circle in a canyon, and it would be
 * actively dangerous at speed — hence the fade.
 *
 * Grip is a friction circle. Lateral force comes from slip velocity through a
 * saturating curve, longitudinal from drive and brake, and the two share one
 * budget scaled by the tyre's current vertical load. Exceed the budget and the
 * excess is dropped, which is a slide. This is a two-line Pacejka substitute and
 * at the speeds a rover travels it is indistinguishable from the real thing.
 */

import * as THREE from 'three';
import { clamp, saturate, damp, lerp, smoothstep } from '../core/Noise.js';
import {
  Vehicle,
  RigidBody,
  castGround,
  registerVehicle,
  hullMaterial,
  rubberMaterial,
  glowMaterial,
  glassMaterial,
} from './Vehicles.js';

const DEG = Math.PI / 180;
const Y_UP = new THREE.Vector3(0, 1, 0);

export const ROVER_PROFILE = {
  mass: 1480,                 // kerb plus a full cargo deck
  size: new THREE.Vector3(2.35, 1.15, 4.55),
  inertiaScale: 1.35,         // the deck carries its mass high and wide

  wheelRadius: 0.52,
  wheelWidth: 0.34,
  trackHalf: 1.06,            // half the axle width
  wheelbase: 1.68,            // front/rear rows, measured from the middle row

  // Strut geometry, in metres. Travel is generous on purpose: this thing is
  // supposed to walk over boulders, and a short-travel rover is a go-kart.
  strutTop: -0.14,            // attachment height in body space
  restLength: 0.62,
  travel: 0.46,
  /** Static sag as a fraction of travel. 0.34 leaves room to droop and to bump. */
  sag: 0.34,
  dampingRide: 0.42,          // ratio on compression — soft, so rocks vanish
  dampingRebound: 0.78,       // and firm on the way back, so it does not pogo
  antiRoll: 0.32,             // fraction of the axle's load difference to cancel

  // Grip. `mu` is the friction coefficient; the lateral stiffness is how many
  // newtons of side force each m/s of slip generates before saturation. 3200
  // puts full saturation at roughly 1 m/s of slide, which is a couple of degrees
  // of slip angle at cruise — firm enough to steer, loose enough to drift.
  mu: 1.28,
  latStiffness: 3200,
  rollingResistance: 0.028,   // coefficient on vertical load, as in the real term

  driveForce: 10500,          // total, split across the wheels that have grip
  reverseScale: 0.55,
  brakeForce: 15000,
  handbrakeForce: 22000,
  boostScale: 1.85,
  boostDrain: 26,             // per second of held boost
  boostRecharge: 13,

  maxSpeed: 26,               // m/s; the drive force tapers to zero here
  steerAngle: 31 * DEG,
  steerRate: 3.4,             // how fast the rack follows the stick, per second
  steerSpeedFade: 0.62,       // how much of the angle survives at max speed
  rearSteer: 0.55,            // counter-steer share at a crawl
  rearSteerFade: 5.5,         // m/s at which the rear rack centres itself

  airPitchAuthority: 2.6,     // rad/s² of attitude control off a jump
  airRollAuthority: 3.4,
  levelAssist: 1.15,          // gentle torque toward flat while airborne
};

// --- scratch -----------------------------------------------------------------
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _down = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _contact = new THREE.Vector3();
const _force = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _e0 = new THREE.Euler();

export class Rover extends Vehicle {
  constructor(world, opts = {}) {
    const p = { ...ROVER_PROFILE, ...(opts.profile || {}) };
    super(world, {
      name: 'rover',
      body: {
        mass: p.mass,
        size: p.size,
        inertiaScale: p.inertiaScale,
        // Almost no blanket angular damping: the damping that matters comes out
        // of six struts fighting each other, and a global term would eat exactly
        // the body motion this vehicle exists to show.
        angularDamping: 0.22,
        linearDamping: 0,
        maxAngularSpeed: 7,
      },
      ...opts,
    });

    this.p = p;
    this.kind = 'rover';
    this.label = 'Rover';
    this.icon = '⬡';
    this.seats = 2;
    this.boardRadius = 2.6;
    this.restHeight = p.restLength + p.wheelRadius * 0.4;
    this.exitOffset.set(1.85, 0.2, 0.4);

    this.chase = {
      distance: 9.5,
      height: 2.2,
      lift: 0.7,
      lookAhead: 8,
      refSpeed: p.maxSpeed,
      follow: 7.5,
      collide: true,
      worldUp: true,
    };

    // --- drivetrain state ---------------------------------------------------
    this.steer = 0;             // smoothed rack position, -1..1
    this.throttle = 0;
    this.brakeLevel = 0;
    this.boostFuel = 100;
    this._boostBlend = 0;
    this.integrity = 1;
    this.wheelsOnGround = 0;
    this.slipAmount = 0;        // 0..1, how far past the grip budget we are
    this.drivetrainLoad = 0;    // 0..1, for the hub glow and the audio

    this.wheels = this._makeWheels();
    this._buildGeometry();
    this._tuneSprings();
  }

  get fuelFraction() {
    return saturate(this.boostFuel / 100);
  }

  /**
   * Stiffness and damping from the world's gravity, so the rover sits at the
   * same ride height everywhere. Recomputed whenever the world changes, which is
   * what makes driving the same machine on two planets feel like two planets and
   * not like two different vehicles.
   */
  _tuneSprings() {
    const p = this.p;
    const g = Math.max(this.world?.gravity ?? 9.81, 0.05);
    const perWheel = (p.mass * g) / this.wheels.length;
    const sagMetres = Math.max(p.travel * p.sag, 0.02);
    this.springK = perWheel / sagMetres;
    // Critical damping for the sprung mass this corner carries.
    const mEff = p.mass / this.wheels.length;
    this.dampCritical = 2 * Math.sqrt(this.springK * mEff);
    this._tunedGravity = g;
  }

  _makeWheels() {
    const p = this.p;
    const rows = [-p.wheelbase, 0, p.wheelbase];
    const out = [];
    for (let r = 0; r < 3; r++) {
      for (let s = 0; s < 2; s++) {
        const side = s === 0 ? -1 : 1;
        out.push({
          index: out.length,
          row: r,                       // 0 front, 1 middle, 2 rear
          side,
          anchor: new THREE.Vector3(side * p.trackHalf, p.strutTop, rows[r]),
          steerShare: r === 0 ? 1 : r === 2 ? -p.rearSteer : 0,
          driven: true,
          compression: 0,
          prevCompression: 0,
          load: 0,
          grounded: false,
          spin: 0,
          spinRate: 0,
          slip: 0,
          normal: new THREE.Vector3(0, 1, 0),
          contact: new THREE.Vector3(),
          surface: null,
          node: null,
          hub: null,
          arm: null,
          steerAngle: 0,
        });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Geometry.
  // ---------------------------------------------------------------------------

  _buildGeometry() {
    const p = this.p;
    const body = hullMaterial(0xc9c3b4, { metalness: 0.35, roughness: 0.58 });
    const dark = hullMaterial(0x3b3f46, { metalness: 0.72, roughness: 0.4 });
    const trim = hullMaterial(0xd2691e, { metalness: 0.3, roughness: 0.62 });
    const rubber = rubberMaterial(0x191b1f);
    const glass = glassMaterial(0x0c1a26);
    const lamp = glowMaterial(0xfff2d0, 3.4);
    const tail = glowMaterial(0xff3a24, 1.6);
    const hubGlow = glowMaterial(0x64d8ff, 0.4);
    this.hubGlowMaterial = hubGlow;
    this.tailMaterial = tail;
    this.lampMaterial = lamp;

    // --- chassis ------------------------------------------------------------
    // A flat-bottomed tub with a canted nose. Built from three boxes rather than
    // one, because the silhouette of a rover is its shoulder line and a single
    // box has no shoulder.
    const tub = this._mesh(new THREE.BoxGeometry(p.size.x * 0.82, 0.42, p.size.z * 0.92), body);
    tub.position.y = 0.05;

    const deck = this._mesh(new THREE.BoxGeometry(p.size.x * 0.94, 0.16, p.size.z * 0.62), dark);
    deck.position.set(0, 0.3, 0.55);

    const nose = this._mesh(new THREE.BoxGeometry(p.size.x * 0.7, 0.34, 0.9), body);
    nose.position.set(0, 0.12, -p.size.z * 0.46);
    nose.rotation.x = -9 * DEG;

    // --- cabin --------------------------------------------------------------
    const cabin = new THREE.Group();
    cabin.position.set(0, 0.28, -0.62);
    this.group.add(cabin);
    const cabShell = this._mesh(new THREE.BoxGeometry(1.62, 0.92, 1.5), body, cabin);
    cabShell.position.y = 0.46;
    // The canopy is a sphere octant, not a box: a rover cabin reads as a bubble
    // and a bubble is the cheapest possible way to say "pressurised".
    const canopy = this._mesh(
      new THREE.SphereGeometry(0.86, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.5),
      glass,
      cabin
    );
    canopy.scale.set(0.94, 0.72, 0.92);
    canopy.position.set(0, 0.86, -0.1);

    const pillar = new THREE.BoxGeometry(0.08, 0.9, 0.08);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const m = this._mesh(pillar, dark, cabin);
        m.position.set(sx * 0.74, 0.9, sz * 0.68);
      }
    }

    /** Eye point for the driver: left seat, sat up, looking over the nose. */
    this.cockpit.position.set(-0.34, 1.18, -0.86);
    cabin.add(this.cockpit);

    // --- roll cage ----------------------------------------------------------
    // Tube geometry from a curve, so the hoop is genuinely round where it bends
    // instead of being four cylinders that meet at visible corners.
    const hoopPts = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const a = Math.PI * t;
      hoopPts.push(new THREE.Vector3(Math.cos(a) * 1.1, Math.sin(a) * 0.78 + 0.42, 0));
    }
    const hoop = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(hoopPts), 20, 0.055, 7, false);
    for (const z of [-0.1, 1.34]) {
      const m = this._mesh(hoop, dark);
      m.position.set(0, 0.28, z);
    }
    const spar = new THREE.CylinderGeometry(0.05, 0.05, 1.5, 7);
    for (const sx of [-1, 1]) {
      const m = this._mesh(spar, dark);
      m.rotation.x = Math.PI / 2;
      m.position.set(sx * 1.02, 1.34, 0.62);
    }

    // --- cargo deck furniture ------------------------------------------------
    const crate = new THREE.BoxGeometry(0.52, 0.36, 0.62);
    for (const sx of [-1, 1]) {
      const m = this._mesh(crate, trim);
      m.position.set(sx * 0.52, 0.56, 1.1);
    }
    const tank = new THREE.CylinderGeometry(0.2, 0.2, 1.15, 12);
    const t1 = this._mesh(tank, dark);
    t1.rotation.z = Math.PI / 2;
    t1.position.set(0, 0.52, 1.72);

    // A dish and a whip antenna. Both are silhouette, and silhouette is what
    // tells you at 200 m that the shape on the ridge is yours.
    const mast = this._mesh(new THREE.CylinderGeometry(0.028, 0.036, 1.3, 6), dark);
    mast.position.set(0.78, 1.05, 1.5);
    const dish = this._mesh(new THREE.SphereGeometry(0.3, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.42), body);
    dish.rotation.set(Math.PI * 0.75, 0, 0.3);
    dish.position.set(0.78, 1.68, 1.5);

    // --- lights -------------------------------------------------------------
    const lampGeo = new THREE.CylinderGeometry(0.14, 0.16, 0.09, 12);
    for (const sx of [-1, 1]) {
      const m = this._mesh(lampGeo, lamp);
      m.rotation.x = Math.PI / 2;
      m.position.set(sx * 0.7, 0.24, -p.size.z * 0.5 - 0.02);
    }
    const bar = this._mesh(new THREE.BoxGeometry(1.5, 0.09, 0.07), tail);
    bar.position.set(0, 0.42, p.size.z * 0.47);

    // Two spots, aimed by the chassis. Headlights that do not actually light the
    // ground are just decals, and driving at night is most of what a rover does.
    this.headlights = [];
    for (const sx of [-1, 1]) {
      const spot = new THREE.SpotLight(0xfff0d4, 0, 70, 0.5, 0.5, 1.4);
      spot.position.set(sx * 0.7, 0.26, -p.size.z * 0.5);
      const target = new THREE.Object3D();
      target.position.set(sx * 0.7, -1.4, -p.size.z * 0.5 - 12);
      this.group.add(spot, target);
      spot.target = target;
      this.headlights.push(spot);
    }

    // --- wheels -------------------------------------------------------------
    // One geometry, six instances of the mesh. The grousers are separate boxes
    // on the rim: a smooth cylinder reads as a toy, and a tyre with cleats reads
    // as something that was built to climb.
    const tyre = new THREE.CylinderGeometry(p.wheelRadius, p.wheelRadius, p.wheelWidth, 20, 1);
    tyre.rotateZ(Math.PI / 2);
    const rim = new THREE.CylinderGeometry(p.wheelRadius * 0.52, p.wheelRadius * 0.52, p.wheelWidth * 1.06, 12, 1);
    rim.rotateZ(Math.PI / 2);
    const grouser = new THREE.BoxGeometry(p.wheelWidth * 1.04, 0.055, 0.14);
    const armGeo = new THREE.BoxGeometry(0.11, 0.11, 1);
    const hubRing = new THREE.TorusGeometry(p.wheelRadius * 0.3, 0.035, 6, 14);

    for (const w of this.wheels) {
      // The strut node carries the vertical travel; the steer node carries the
      // rack angle; the spin node carries the rotation. Three nested transforms
      // means none of them can ever fight over an axis.
      const strut = new THREE.Group();
      strut.position.copy(w.anchor);
      this.group.add(strut);

      const steerNode = new THREE.Group();
      strut.add(steerNode);

      const spin = new THREE.Group();
      steerNode.add(spin);

      const t = this._mesh(tyre, rubber, spin);
      t.position.x = w.side * p.wheelWidth * 0.1;
      const r = this._mesh(rim, dark, spin);
      const ring = this._mesh(hubRing, hubGlow, spin);
      ring.rotation.y = Math.PI / 2;
      ring.position.x = w.side * p.wheelWidth * 0.56;

      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        const g = this._mesh(grouser, rubber, spin);
        g.position.set(0, Math.cos(a) * p.wheelRadius, Math.sin(a) * p.wheelRadius);
        g.rotation.x = -a;
      }

      // A trailing arm from the chassis to the hub. Rotated every frame to point
      // at wherever the wheel ended up, which is the single cheapest thing that
      // makes independent suspension legible from outside the vehicle.
      const arm = this._mesh(armGeo, dark);
      arm.position.copy(w.anchor);

      w.node = strut;
      w.steerNode = steerNode;
      w.hub = spin;
      w.arm = arm;
    }
  }

  // ---------------------------------------------------------------------------
  // Simulation.
  // ---------------------------------------------------------------------------

  step(dt, cmd) {
    const p = this.p;
    const b = this.body;
    const world = this.world;
    if (Math.abs((world.gravity ?? 9.81) - this._tunedGravity) > 1e-3) this._tuneSprings();

    this.time += dt;

    // --- driver input -------------------------------------------------------
    // The rack is smoothed rather than snapped. A steering input that arrives
    // instantly is a steering input that flips a tall vehicle, and the rate is
    // the single most important number in how a heavy machine feels.
    this.steer = damp(this.steer, clamp(cmd.steer, -1, 1), p.steerRate, dt);
    this.throttle = damp(this.throttle, clamp(cmd.throttle, -1, 1), 6, dt);
    this.brakeLevel = damp(this.brakeLevel, clamp(cmd.brake, 0, 1), 12, dt);

    const wantBoost = cmd.boost && this.boostFuel > 0.5;
    if (wantBoost) this.boostFuel = Math.max(0, this.boostFuel - p.boostDrain * dt);
    else this.boostFuel = Math.min(100, this.boostFuel + p.boostRecharge * dt);
    this._boostBlend = damp(this._boostBlend, wantBoost ? 1 : 0, wantBoost ? 7 : 3, dt);

    // --- body frame ---------------------------------------------------------
    _fwd.set(0, 0, -1).applyQuaternion(b.quaternion);
    _right.set(1, 0, 0).applyQuaternion(b.quaternion);
    _up.set(0, 1, 0).applyQuaternion(b.quaternion);
    _down.copy(_up).multiplyScalar(-1);

    const worldUp = world.up(b.position);
    const g = world.gravity;
    b.addForce(_v0.copy(worldUp).multiplyScalar(-g * b.mass));

    // Speed-sensitive steering and rear counter-steer, both computed once.
    const speed = b.velocity.length();
    const speedN = saturate(speed / p.maxSpeed);
    const rackFront = this.steer * p.steerAngle * lerp(1, p.steerSpeedFade, speedN);
    const rearBlend = 1 - saturate(speed / p.rearSteerFade);

    // --- suspension and tyres ------------------------------------------------
    let contacts = 0;
    let slipSum = 0;
    let loadSum = 0;
    const maxLen = p.restLength + p.travel;

    for (const w of this.wheels) {
      w.prevCompression = w.compression;
      w.steerAngle = w.steerShare >= 0
        ? rackFront * w.steerShare
        : rackFront * w.steerShare * rearBlend;

      // Strut origin in world space, and the ray down the strut axis.
      b.localPoint(w.anchor, _origin);
      const hit = castGround(world, _origin, _down, maxLen + p.wheelRadius);

      if (!hit || hit.distance > maxLen + p.wheelRadius) {
        // Droop. The wheel falls to full extension and the corner carries no
        // load, which is exactly why an airborne rover noses over.
        w.grounded = false;
        w.compression = damp(w.compression, 0, 9, dt);
        w.load = 0;
        w.slip = 0;
        // Free wheels spin down rather than stopping dead.
        w.spinRate = damp(w.spinRate, 0, 1.4, dt);
        w.spin += w.spinRate * dt;
        continue;
      }

      contacts++;
      w.grounded = true;
      w.normal.copy(hit.normal);
      w.contact.copy(hit.point);
      w.surface = hit.surface;

      // Compression measured along the strut. `distance` is from the anchor to
      // the ground; subtracting the wheel radius gives where the hub sits.
      const hubDrop = clamp(hit.distance - p.wheelRadius, 0, maxLen);
      w.compression = clamp(p.restLength - hubDrop, 0, p.travel);

      // Damper reads the strut's own closing speed, taken from the contact
      // point's velocity rather than from a finite difference of compression —
      // a difference would be one tick stale and would ring at 120 Hz.
      b.pointVelocity(hit.point, _v1);
      const strutSpeed = -_v1.dot(_up);
      const ratio = strutSpeed > 0 ? p.dampingRide : p.dampingRebound;
      let normalForce = this.springK * w.compression + this.dampCritical * ratio * strutSpeed;

      // Bump stop: the last 12% of travel gets progressively brutal, which is
      // what stops a big drop from punching the ray through the terrain.
      const overlap = w.compression - p.travel * 0.88;
      if (overlap > 0) normalForce += overlap * this.springK * 9;

      if (normalForce < 0) normalForce = 0;   // struts push only
      w.load = normalForce;
      loadSum += normalForce;

      _force.copy(_up).multiplyScalar(normalForce);
      b.addForceAtPoint(_force, hit.point);

      // --- tyre ------------------------------------------------------------
      // Contact-patch axes: the steered forward direction, flattened into the
      // plane of the ground so a wheel on a slope drives along the slope.
      _e0.set(0, w.steerAngle, 0);
      _q0.setFromEuler(_e0);
      _v2.set(0, 0, -1).applyQuaternion(_q0).applyQuaternion(b.quaternion);
      _v2.addScaledVector(hit.normal, -_v2.dot(hit.normal));
      if (_v2.lengthSq() < 1e-6) continue;
      _v2.normalize();
      _v3.crossVectors(hit.normal, _v2).normalize();

      const vLong = _v1.dot(_v2);
      const vLat = _v1.dot(_v3);
      w.spinRate = vLong / p.wheelRadius;
      w.spin += w.spinRate * dt;

      // The friction budget for this tyre, right now. It is the load — which is
      // why braking hands the front wheels grip and takes it off the rear.
      const budget = normalForce * p.mu * (w.surface?.friction ?? 1);

      // Lateral: resist slip proportionally, then saturate. The whole cornering
      // character of the vehicle lives in this one clamp.
      let fLat = -vLat * p.latStiffness * dt * 60;
      fLat = clamp(fLat, -budget, budget);

      // Longitudinal: drive, then brake, then rolling resistance.
      let fLong = 0;
      if (this.brakeLevel > 0.01 || cmd.handbrake) {
        // Handbrake locks the rear only, which is what makes it a tool for
        // rotating the vehicle rather than just a second brake pedal.
        const rearOnly = cmd.handbrake && w.row === 2;
        const strength = rearOnly ? p.handbrakeForce : p.brakeForce * this.brakeLevel;
        fLong = -Math.sign(vLong) * Math.min(strength / this.wheels.length, Math.abs(vLong) * b.mass / (dt * this.wheels.length));
      } else if (w.driven && Math.abs(this.throttle) > 0.02) {
        const dir = Math.sign(this.throttle);
        const scale = dir > 0 ? 1 : p.reverseScale;
        // Torque tapers to nothing at the top speed, which is a gearbox rather
        // than a hard velocity clamp — a clamp is felt, a taper is not.
        const headroom = 1 - saturate((vLong * dir) / p.maxSpeed);
        const boost = lerp(1, p.boostScale, this._boostBlend);
        fLong = dir * (p.driveForce / this.wheels.length) * scale * headroom * boost * Math.abs(this.throttle);
      }
      fLong -= vLong * p.rollingResistance * normalForce * 0.5;

      // The friction circle. Anything asked for beyond the budget is simply not
      // delivered, and the shortfall is what the driver feels as a slide.
      const mag = Math.hypot(fLong, fLat);
      if (mag > budget && mag > 1e-4) {
        const k = budget / mag;
        fLong *= k;
        fLat *= k;
        w.slip = saturate((mag / budget - 1) * 0.6);
      } else {
        w.slip = 0;
      }
      slipSum += w.slip;

      _force.copy(_v2).multiplyScalar(fLong).addScaledVector(_v3, fLat);
      b.addForceAtPoint(_force, hit.point);
    }

    this.wheelsOnGround = contacts;
    this.grounded = contacts > 0;
    this.slipAmount = this.wheels.length ? slipSum / this.wheels.length : 0;
    this.drivetrainLoad = saturate(Math.abs(this.throttle) * 0.7 + this._boostBlend * 0.5 + this.slipAmount * 0.6);

    this._antiRoll();
    this._airControl(dt, cmd, contacts, worldUp);

    b.integrate(dt);
    this._settleVisuals(dt);
  }

  /**
   * Anti-roll bars, one per axle row.
   *
   * Without them a tall six-wheeler leans over in a corner until the inside
   * wheels unload and it trips over its own outside tyres. The bar transfers a
   * fraction of the compression difference across the axle as an equal and
   * opposite pair of forces, which is exactly what the real part does — and it
   * costs nothing because both forces are applied at points we already have.
   */
  _antiRoll() {
    const p = this.p;
    if (p.antiRoll <= 0) return;
    for (let row = 0; row < 3; row++) {
      const l = this.wheels[row * 2];
      const r = this.wheels[row * 2 + 1];
      if (!l.grounded && !r.grounded) continue;
      const diff = (l.compression - r.compression) * this.springK * p.antiRoll;
      if (Math.abs(diff) < 1e-3) continue;
      _up.set(0, 1, 0).applyQuaternion(this.body.quaternion);
      if (l.grounded) this.body.addForceAtPoint(_force.copy(_up).multiplyScalar(-diff), l.contact);
      if (r.grounded) this.body.addForceAtPoint(_force.copy(_up).multiplyScalar(diff), r.contact);
    }
  }

  /**
   * Attitude control in the air.
   *
   * A rover that leaves the ground should be steerable and should want to land
   * flat, because the alternative is a vehicle that ends every jump on its roof
   * and a player who stops jumping. The authority is deliberately modest: enough
   * to save a landing, not enough to fly.
   */
  _airControl(dt, cmd, contacts, worldUp) {
    const p = this.p;
    const b = this.body;
    if (contacts >= 3) return;
    const airborne = 1 - contacts / 3;

    _fwd.set(0, 0, -1).applyQuaternion(b.quaternion);
    _right.set(1, 0, 0).applyQuaternion(b.quaternion);
    _up.set(0, 1, 0).applyQuaternion(b.quaternion);

    // Player attitude input, on the same stick that steers on the ground.
    b.addTorque(_v0.copy(_right).multiplyScalar(-cmd.throttle * p.airPitchAuthority * airborne * b.inertia.x));
    b.addTorque(_v0.copy(_fwd).multiplyScalar(-cmd.steer * p.airRollAuthority * airborne * b.inertia.z));

    // Self-levelling: a torque along the axis that would rotate the chassis up
    // onto the world's up, proportional to how far off it is, damped by the
    // current rate so it settles instead of oscillating.
    _v1.crossVectors(_up, worldUp);
    const misalign = _v1.length();
    if (misalign > 1e-4) {
      _v1.multiplyScalar(1 / misalign);
      const angle = Math.asin(clamp(misalign, -1, 1));
      const rate = b.angularVelocity.dot(_v1);
      b.addTorque(
        _v0.copy(_v1).multiplyScalar((angle * p.levelAssist - rate * 0.75) * airborne * b.inertia.y)
      );
    }
  }

  /** Write the visual travel of each strut. Presentation only; no forces here. */
  _settleVisuals(dt) {
    const p = this.p;
    for (const w of this.wheels) {
      const drop = p.restLength - w.compression;
      w.node.position.set(w.anchor.x, w.anchor.y - drop, w.anchor.z);
      w.steerNode.rotation.y = w.steerAngle;
      w.hub.rotation.x = w.spin;

      // Aim the trailing arm at the hub. Length is baked as 1, so scaling the
      // z axis by the distance stretches the same geometry to fit.
      const dx = w.node.position.x - w.arm.position.x;
      const dy = w.node.position.y - (w.anchor.y + 0.12);
      const len = Math.hypot(dy, 0.62);
      w.arm.position.set(w.anchor.x - w.side * 0.16, w.anchor.y + 0.06 + dy * 0.5, w.anchor.z);
      w.arm.rotation.set(Math.atan2(dy, 0.62) * -1, Math.PI / 2, 0);
      w.arm.scale.z = len;
    }

    // The hub rings glow with how hard the motors are working, which is the
    // rover's version of an engine note.
    if (this.hubGlowMaterial) {
      this.hubGlowMaterial.emissiveIntensity = 0.35 + this.drivetrainLoad * 3.2;
    }
    if (this.tailMaterial) {
      this.tailMaterial.emissiveIntensity = 0.7 + this.brakeLevel * 5.5;
    }
  }

  // ---------------------------------------------------------------------------
  // Presentation.
  // ---------------------------------------------------------------------------

  updateFX(dt, time) {
    super.updateFX(dt, time);

    if (this.lampMaterial) this.lampMaterial.emissiveIntensity = this.lightsOn ? 4.2 : 0.05;
    for (const spot of this.headlights) {
      spot.intensity = damp(spot.intensity, this.lightsOn ? 42 : 0, 8, dt);
      spot.visible = spot.intensity > 0.05;
    }

    // Dust from the contact patches. Rate follows slip and speed, so cruising on
    // packed regolith is nearly clean and a wheelspin throws a rooster tail.
    if (!this.fx || !this.mounted) return;
    const speed = this.speed;
    for (const w of this.wheels) {
      if (!w.grounded) continue;
      const intensity = w.slip * 1.6 + saturate(speed / 12) * 0.5;
      if (intensity < 0.06) continue;
      this.fx.scuff(w.contact, w.normal, dt / this.wheels.length, {
        surface: w.surface,
        gravity: this.world.gravity,
        up: this.world.up(this.body.position),
        velocity: this.body.velocity,
        intensity,
      });
    }
  }

  /** Getting out of a rover doing 20 m/s is not a decision, it is an accident. */
  canDismount() {
    return this.speed < 4.5;
  }

  contextActions() {
    return [
      { id: 'vehicle', label: 'Dismount', key: 'B', icon: '⤓', enabled: this.canDismount() },
      { id: 'boost', label: 'Boost', key: 'X', icon: '≫', enabled: this.boostFuel > 4 },
      { id: 'flashlight', label: this.lightsOn ? 'Lights off' : 'Lights', key: 'F', icon: '☀', enabled: true },
      { id: 'jump', label: 'Handbrake', key: '␣', icon: '▽', enabled: true },
      { id: 'toggleView', label: 'View', key: 'V', icon: '⧉', enabled: true },
    ];
  }
}

registerVehicle('rover', Rover, {
  kind: 'rover',
  label: 'Rover',
  icon: '⬡',
  blurb: 'Six-wheel surface crawler. Slow, unstoppable, repairable.',
  domain: 'surface',
  seats: 2,
});

export default Rover;
