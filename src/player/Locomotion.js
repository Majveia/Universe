/**
 * The character motor.
 *
 * This is the file that decides whether the game feels good, so it is written
 * as a physics model rather than as a pile of if-statements. Everything runs on
 * a fixed timestep supplied by the caller (PlayerController drives it at 120 Hz)
 * because control feel that changes with frame rate is the single most common
 * way a browser game gives itself away.
 *
 * The model:
 *
 *   The body is a capsule standing on a heightfield. Velocity is decomposed
 *   every tick into a component along the local up vector and a tangential
 *   component in the surface plane. Gravity acts on the first; player intent
 *   acts on the second. Because "up" comes from `world.up(pos)` rather than
 *   being hardcoded to +Y, the same code walks around the outside of a sphere.
 *
 *   Tangential control is an exponential approach toward a target velocity
 *   rather than a constant acceleration. Exponential approach has the property
 *   that a *rate* (per second) is frame-rate independent under `damp()`, and it
 *   produces the snappy-start / soft-settle curve that reads as weight. Constant
 *   acceleration reads as a vehicle; exponential reads as legs.
 *
 *   Air control is deliberately a different animal: a small additive
 *   acceleration capped by a projected speed limit, which preserves whatever
 *   momentum you carried off the ledge instead of letting you rewrite your
 *   trajectory mid-flight. That asymmetry is what makes a jump feel committed.
 *
 * Gravity scaling matters more than it looks. A fixed jump *impulse* means low
 * gravity multiplies your jump height by 1/g, which on a 1.6 m/s^2 moon is a
 * six-second hang time nobody enjoys. A fixed jump *height* means gravity has
 * no felt consequence at all. So the impulse scales as g^0.35, which leaves
 * apex height going as roughly g^-0.3: a low-gravity world jumps meaningfully
 * higher and floats longer, but you can still play it.
 *
 * The motor deliberately knows nothing about cameras, meshes, or input devices.
 * It consumes a `Command` struct of pure intent and produces a state you can
 * render, interpolate, or run headless in a test.
 */

import * as THREE from 'three';
import { clamp, damp, saturate, smoothstep, lerp } from '../core/Noise.js';

const DEG = Math.PI / 180;

/**
 * Tunables. Every number here has a reason; the reasons are the comments. Treat
 * this object as the feel budget — it is the only place a designer should have
 * to look.
 */
export const PROFILE = {
  // --- body ---------------------------------------------------------------
  radius: 0.34,             // shoulder-ish. Wide enough not to slip into cracks.
  standHeight: 1.8,
  crouchHeight: 1.08,
  eyeRatio: 0.925,          // eyes just below the crown, not on top of the skull
  mass: 82,                 // suit included; only used for impulse exchange

  // --- speeds -------------------------------------------------------------
  // 4.2 is a brisk walk; 7.6 is a hard run. The 1.8x ratio is the point where
  // sprint reads as a different gait rather than as "walk, but nudged".
  walkSpeed: 4.2,
  runSpeed: 7.6,
  crouchSpeed: 1.9,
  backpedalScale: 0.72,     // walking backwards should feel deliberately worse
  strafeScale: 0.9,

  // --- ground response ----------------------------------------------------
  // 14/s reaches 63% of target in 71 ms and 95% in 214 ms. Below about 10 the
  // character feels like it is on ice; above about 20 it feels weightless.
  groundAccel: 14.0,
  groundBrake: 10.5,        // slightly slower than accel so stops have follow-through
  counterBoost: 1.15,       // extra authority when input opposes current velocity
  sprintRamp: 3.4,          // how fast the sprint multiplier engages, per second

  // Air is an order of magnitude weaker, and capped, so momentum survives.
  airAccel: 3.6,
  airBrake: 0.5,
  airWishCap: 1.05,         // you may steer up to 105% of your ground speed in air

  // --- gravity & jumping --------------------------------------------------
  refGravity: 9.81,
  jumpSpeed: 5.55,          // ~1.57 m apex at 1 g, i.e. slightly superhuman
  gravityJumpExp: 0.35,     // impulse ∝ g^0.35, see the header
  holdGravityScale: 0.5,    // gravity while rising with jump held
  maxJumpHold: 0.32,        // ceiling on the hold bonus, so it cannot be abused
  releaseCut: 0.45,         // upward velocity retained on early release
  coyote: 0.12,             // 120 ms of grace after walking off a ledge
  jumpBuffer: 0.15,         // 150 ms of grace before landing
  terminalVelocity: 62,     // at 1 g; scales with sqrt(g/gRef)
  fallDamageSpeed: 22,      // informational; the motor only reports it

  // --- terrain interaction ------------------------------------------------
  slopeLimit: 48 * DEG,     // steeper than this and you slide instead of walk
  slideSlopeMin: 12 * DEG,  // below this a slide does not accelerate downhill
  stepHeight: 0.55,         // knee height. Anything shorter is a stair, not a wall.
  stepAssistBonus: 0.22,    // extra step height on touch, where precision is worse
  snapDistance: 0.45,       // ground stickiness over crests, so you do not launch
  uphillPenalty: 0.5,       // fraction of speed lost climbing at the slope limit
  downhillGain: 0.16,

  // --- slide --------------------------------------------------------------
  slideEntrySpeed: 5.0,     // must be moving properly to commit to a slide
  slideMinTime: 0.28,       // commit window, so a slide is never a stutter
  slideFriction: 0.85,      // per-second exponential rate. Very low: it glides.
  slideSteer: 2.4,          // how much you can carve, in rad/s of velocity turn
  slideBoost: 1.14,         // entry impulse — a slide should *gain* speed
  slideJumpBonus: 1.08,     // preserving momentum out of a slide is the flow loop

  // --- friction -----------------------------------------------------------
  defaultFriction: 1.0,
};

/** Intent, produced by PlayerController and consumed by the motor. */
export function createCommand() {
  return {
    /** World-space horizontal wish direction, already projected and scaled 0..1. */
    wish: new THREE.Vector3(),
    forward: 0,             // -1..1, for gait and camera lean only
    strafe: 0,
    jump: false,            // edge: pressed this frame
    jumpHeld: false,
    sprint: false,
    crouch: false,
    jetting: false,         // jetpack is supplying thrust; suppresses ground snap
    jetThrust: new THREE.Vector3(),
    stepAssist: false,      // touch/gamepad forgiveness
    externalImpulse: new THREE.Vector3(),
  };
}

/** Dependency-free event emitter — the motor fires, other systems listen. */
export class Emitter {
  constructor() {
    this._h = new Map();
  }
  on(key, fn) {
    let s = this._h.get(key);
    if (!s) this._h.set(key, (s = new Set()));
    s.add(fn);
    return () => s.delete(fn);
  }
  off(key, fn) {
    this._h.get(key)?.delete(fn);
  }
  emit(key, a, b, c) {
    const s = this._h.get(key);
    if (!s) return;
    for (const fn of s) fn(a, b, c);
  }
}

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _target = new THREE.Vector3();
const _grad = new THREE.Vector3();

export class Locomotion extends Emitter {
  constructor(world, opts = {}) {
    super();
    this.world = world;
    this.p = { ...PROFILE, ...(opts.profile || {}) };

    /** Feet position. Everything else derives from this. */
    this.position = new THREE.Vector3(0, 0, 0);
    /** Previous tick's feet position, so the renderer can interpolate. */
    this.prevPosition = new THREE.Vector3();
    this.velocity = new THREE.Vector3();

    this.up = new THREE.Vector3(0, 1, 0);
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.groundHeight = 0;
    this.heightAboveGround = 0;
    this.surface = { material: 'regolith', friction: 1, dust: 0.6 };

    this.grounded = false;
    this.wasGrounded = false;
    this.onSteepSlope = false;
    this.slopeAngle = 0;
    this.blocked = false;
    this.wallNormal = new THREE.Vector3();

    this.state = 'idle';    // idle | walk | run | crouch | slide | air | land
    this.crouching = false;
    this.sliding = false;
    this.sprinting = false;
    this.sprintBlend = 0;   // smoothed 0..1, drives the camera FOV kick
    this.capsuleHeight = this.p.standHeight;
    this.eyeHeight = this.p.standHeight * this.p.eyeRatio;

    // Timers, all in seconds.
    this.timeSinceGrounded = 999;
    this.timeSinceJump = 999;
    this.timeAirborne = 0;
    this.jumpBufferTimer = -1;
    this.jumpHoldTimer = 0;
    this.slideTimer = 0;
    this.timeMoving = 0;

    this.jumping = false;
    this.releasedSinceJump = true;

    /** Distance-driven gait phase in [0,1). Two foot plants per cycle. */
    this.stridePhase = 0;
    this.strideLength = 1.35;
    this.distanceTravelled = 0;
    this._lastFootIndex = -1;

    /** Reported on the landing tick so the camera can dip proportionally. */
    this.landImpact = 0;
    /** Accumulated vertical step-ups, for the camera to smooth out. */
    this.stepOffset = 0;

    this.speed = 0;
    this.tangentSpeed = 0;
    this.verticalSpeed = 0;

    this._probeCache = { x: NaN, z: NaN };
    this.enabled = true;
  }

  setWorld(world) {
    this.world = world;
  }

  teleport(pos, keepVelocity = false) {
    this.position.copy(pos);
    this.prevPosition.copy(pos);
    if (!keepVelocity) this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.timeSinceGrounded = 999;
    this.snapToGround();
  }

  /** Drop the feet onto the terrain without any of the motion bookkeeping. */
  snapToGround() {
    const h = this.world.sampleHeight(this.position.x, this.position.z);
    this.position.y = h;
    this.prevPosition.copy(this.position);
    this.groundHeight = h;
    this.grounded = true;
    this.timeSinceGrounded = 0;
  }

  /** Eye position for the current tick, in world space. */
  eyePosition(out = new THREE.Vector3()) {
    return out.copy(this.position).addScaledVector(this.up, this.eyeHeight);
  }

  // ---------------------------------------------------------------------------
  // The tick.
  // ---------------------------------------------------------------------------

  /**
   * Advance one fixed step. `dt` must be constant; the whole point of this file
   * is that the answer does not depend on how long the last frame took.
   */
  step(dt, cmd) {
    if (!this.enabled) return;
    const p = this.p;
    const world = this.world;

    this.prevPosition.copy(this.position);
    this.wasGrounded = this.grounded;

    // The local frame. On a sphere this rotates as you walk; on a plane it is
    // constant and every dot product below degenerates to a y-component.
    const wup = world.up(this.position);
    this.up.set(wup.x, wup.y, wup.z).normalize();

    const g = world.gravity;
    const gScale = g / p.refGravity;

    // --- ground probe -------------------------------------------------------
    this._probeGround();

    // --- posture ------------------------------------------------------------
    const wantsCrouch = cmd.crouch;
    // Never stand up into terrain: a real controller would sweep the capsule,
    // but on a heightfield the only ceiling is the sky, so crouch is free to
    // release. Kept as a hook for when the realm adds overhangs.
    this.crouching = wantsCrouch || (this.sliding && this.grounded);
    const targetHeight = this.crouching ? p.crouchHeight : p.standHeight;
    // 16/s: fast enough that crouch feels instant to the hands, slow enough that
    // the camera does not teleport 0.7 m down your body.
    this.capsuleHeight = damp(this.capsuleHeight, targetHeight, 16, dt);
    this.eyeHeight = this.capsuleHeight * p.eyeRatio;

    // --- timers -------------------------------------------------------------
    this.timeSinceJump += dt;
    if (this.grounded) {
      this.timeSinceGrounded = 0;
      this.timeAirborne = 0;
    } else {
      this.timeSinceGrounded += dt;
      this.timeAirborne += dt;
    }
    if (cmd.jump) this.jumpBufferTimer = p.jumpBuffer;
    else if (this.jumpBufferTimer >= 0) this.jumpBufferTimer -= dt;
    if (!cmd.jumpHeld) this.releasedSinceJump = true;

    // --- decompose velocity into the local frame ----------------------------
    let vUp = this.velocity.dot(this.up);
    _tan.copy(this.velocity).addScaledVector(this.up, -vUp);

    // --- wish direction, projected into the surface plane --------------------
    _v0.copy(cmd.wish);
    const wishMag = clamp(_v0.length(), 0, 1);
    if (wishMag > 1e-5) {
      _v0.multiplyScalar(1 / wishMag);
      // Project onto the tangent plane so walking into a slope does not try to
      // drive you into the rock, and walking down one does not launch you.
      _v0.addScaledVector(this.up, -_v0.dot(this.up));
      const l = _v0.length();
      if (l > 1e-5) _v0.multiplyScalar(1 / l);
      else _v0.set(0, 0, 0);
    } else {
      _v0.set(0, 0, 0);
    }
    const wishDir = _v0;

    // --- sprint -------------------------------------------------------------
    // Sprint only engages when you are actually pushing forward; sprint-strafing
    // sideways at full speed is the classic tell of a controller with no gait.
    const wantSprint = cmd.sprint && wishMag > 0.5 && cmd.forward > 0.25 && !this.crouching;
    this.sprinting = wantSprint && this.grounded;
    this.sprintBlend = damp(this.sprintBlend, wantSprint ? 1 : 0, p.sprintRamp, dt);

    // --- slide state --------------------------------------------------------
    this._updateSlide(dt, cmd, wishMag);

    // --- target speed -------------------------------------------------------
    let targetSpeed;
    if (this.crouching && !this.sliding) targetSpeed = p.crouchSpeed;
    else targetSpeed = lerp(p.walkSpeed, p.runSpeed, this.sprintBlend);

    // Directional shaping. Backpedalling and strafing are slower, which reads
    // as a body that has a front.
    if (cmd.forward < -0.1) targetSpeed *= lerp(1, p.backpedalScale, -cmd.forward);
    else if (Math.abs(cmd.strafe) > 0.5 && Math.abs(cmd.forward) < 0.4) targetSpeed *= p.strafeScale;

    // Slope shaping: climbing is expensive, descending is slightly free.
    if (this.grounded && wishMag > 0.01) {
      const climb = -wishDir.dot(this.groundNormal); // >0 when heading uphill
      const t = clamp(climb / Math.max(Math.sin(p.slopeLimit), 0.01), -1, 1);
      targetSpeed *= t > 0 ? 1 - p.uphillPenalty * t : 1 + p.downhillGain * -t;
    }
    targetSpeed *= wishMag;

    // --- tangential integration ---------------------------------------------
    const friction = this.surface.friction ?? p.defaultFriction;
    if (this.grounded && !this.sliding && !this.onSteepSlope) {
      _target.copy(wishDir).multiplyScalar(targetSpeed);
      // Rate depends on which way the input points relative to current motion.
      // Reversing gets extra authority so counter-strafes snap; that single
      // detail is most of what "responsive" means in a shooter-grade controller.
      const speedNow = _tan.length();
      let rate;
      if (targetSpeed < 0.01) {
        rate = p.groundBrake;
      } else {
        const align = speedNow > 0.05 ? _tan.dot(wishDir) / speedNow : 1;
        rate = p.groundAccel * lerp(p.counterBoost, 1, saturate(align * 0.5 + 0.5));
      }
      rate *= clamp(friction, 0.08, 2);
      _tan.x = damp(_tan.x, _target.x, rate, dt);
      _tan.y = damp(_tan.y, _target.y, rate, dt);
      _tan.z = damp(_tan.z, _target.z, rate, dt);
    } else if (this.grounded && this.sliding) {
      this._integrateSlide(dt, wishDir, wishMag, g, friction);
    } else if (this.grounded && this.onSteepSlope) {
      // Standing on rock too steep to hold: gravity wins along the downhill
      // tangent, and you keep about a fifth of your usual steering.
      this._downhill(_grad);
      const accel = g * Math.sin(this.slopeAngle) * 0.92;
      _tan.addScaledVector(_grad, accel * dt);
      _tan.addScaledVector(wishDir, p.groundAccel * 0.18 * wishMag * dt);
      _tan.multiplyScalar(Math.exp(-1.1 * dt));
    } else {
      // Airborne. Additive, capped, and never braking against your own momentum
      // unless you ask for the opposite direction.
      const cap = lerp(p.walkSpeed, p.runSpeed, this.sprintBlend) * p.airWishCap;
      const gravityAuthority = clamp(Math.pow(gScale, 0.25), 0.55, 1.35);
      if (wishMag > 0.01) {
        const along = _tan.dot(wishDir);
        const room = cap * wishMag - along;
        if (room > 0) {
          const add = Math.min(room, p.airAccel * gravityAuthority * wishMag * dt);
          _tan.addScaledVector(wishDir, add);
        }
      }
      // A whisper of drag so an infinite fall does not accumulate lateral speed.
      _tan.multiplyScalar(Math.exp(-p.airBrake * 0.2 * dt));
    }

    // --- vertical integration ----------------------------------------------
    let gravityMul = 1;
    if (this.jumping && vUp > 0 && cmd.jumpHeld && this.jumpHoldTimer < p.maxJumpHold) {
      // Variable jump height: holding reduces gravity while rising, rather than
      // adding thrust. Reduced gravity keeps the arc parabolic, which looks and
      // feels correct; added thrust produces a visible kink at the release.
      gravityMul = p.holdGravityScale;
      this.jumpHoldTimer += dt;
    } else if (this.jumping && vUp > 0 && !cmd.jumpHeld && this.jumpHoldTimer > 0) {
      vUp *= p.releaseCut;
      this.jumpHoldTimer = p.maxJumpHold; // consume, so it cannot re-trigger
    }
    // Falling is heavier than rising. Physically wrong, universally used, and
    // the reason platformer jumps feel crisp instead of floaty at the apex.
    if (vUp < 0) gravityMul *= 1.28;

    if (!this.grounded || vUp > 0) {
      vUp -= g * gravityMul * dt;
    }

    // Jetpack thrust arrives as a world-space acceleration from Jetpack.js.
    if (cmd.jetThrust && cmd.jetThrust.lengthSq() > 1e-8) {
      const jt = cmd.jetThrust;
      const ju = jt.dot(this.up);
      vUp += ju * dt;
      _tan.addScaledVector(_v1.copy(jt).addScaledVector(this.up, -ju), dt);
    }
    if (cmd.externalImpulse && cmd.externalImpulse.lengthSq() > 1e-8) {
      const ei = cmd.externalImpulse;
      const eu = ei.dot(this.up);
      vUp += eu;
      _tan.addScaledVector(_v1.copy(ei).addScaledVector(this.up, -eu), 1);
      cmd.externalImpulse.set(0, 0, 0);
    }

    const terminal = p.terminalVelocity * Math.sqrt(Math.max(gScale, 0.05));
    if (vUp < -terminal) vUp = -terminal;

    // --- jump ---------------------------------------------------------------
    const canJump =
      (this.grounded || this.timeSinceGrounded < p.coyote) &&
      vUp <= 0.6 &&
      this.timeSinceJump > 0.08 &&
      this.releasedSinceJump;
    if (this.jumpBufferTimer >= 0 && canJump) {
      const impulse = p.jumpSpeed * Math.pow(Math.max(gScale, 0.02), p.gravityJumpExp);
      vUp = impulse;
      // Slide-jumping keeps every scrap of horizontal speed and adds a little.
      // This is the hinge of the whole flow loop: sprint -> slide -> jump.
      if (this.sliding) {
        _tan.multiplyScalar(p.slideJumpBonus);
        this._endSlide();
      }
      this.grounded = false;
      this.jumping = true;
      this.jumpHoldTimer = 0;
      this.jumpBufferTimer = -1;
      this.timeSinceJump = 0;
      this.timeSinceGrounded = p.coyote + 1; // consume the coyote window
      this.releasedSinceJump = false;
      this.emit('jump', { position: this.position, speed: _tan.length(), impulse });
    }

    // --- recombine and integrate position -----------------------------------
    this.velocity.copy(_tan).addScaledVector(this.up, vUp);
    _v2.copy(this.velocity).multiplyScalar(dt);
    this._moveAndCollide(_v2, dt, cmd);

    // --- ground resolution --------------------------------------------------
    this._resolveGround(dt, cmd);

    // --- bookkeeping --------------------------------------------------------
    vUp = this.velocity.dot(this.up);
    _tan.copy(this.velocity).addScaledVector(this.up, -vUp);
    this.tangentSpeed = _tan.length();
    this.verticalSpeed = vUp;
    this.speed = this.velocity.length();
    if (this.tangentSpeed > 0.3) this.timeMoving += dt;
    else this.timeMoving = 0;

    this._updateStride(dt);
    this._updateState();
  }

  // ---------------------------------------------------------------------------
  // Terrain queries.
  // ---------------------------------------------------------------------------

  _probeGround() {
    const world = this.world;
    const x = this.position.x;
    const z = this.position.z;
    this.groundHeight = world.sampleHeight(x, z);
    const n = world.sampleNormal(x, z);
    this.groundNormal.set(n.x, n.y, n.z).normalize();
    this.slopeAngle = Math.acos(clamp(this.groundNormal.dot(this.up), -1, 1));

    // Signed height above the surface, measured along local up. On a plane this
    // is exactly (y - h); on a sphere it stays correct as the frame rotates.
    _v3.set(x, this.groundHeight, z);
    this.heightAboveGround = _v3.subVectors(this.position, _v3).dot(this.up);

    const s = world.surfaceAt?.(x, z);
    if (s) this.surface = s;
  }

  /** Unit downhill direction in the tangent plane. */
  _downhill(out) {
    out.copy(this.groundNormal).addScaledVector(this.up, -this.groundNormal.dot(this.up));
    const l = out.length();
    if (l > 1e-5) out.multiplyScalar(-1 / l);
    else out.set(0, 0, 0);
    // groundNormal's tangential part points *uphill*, so the negation above
    // gives downhill. Guard against the perfectly flat case.
    if (out.lengthSq() < 1e-8) out.set(0, 0, 0);
    else out.multiplyScalar(-1);
    return out;
  }

  /**
   * Horizontal move with a wall test.
   *
   * On a heightfield there is no separate collision geometry, so a "wall" is a
   * place where the terrain rises faster than a knee can clear. The test probes
   * one body radius ahead of where we are about to be; if the rise there is
   * above the step height, or the surface there is too steep to stand on, the
   * component of velocity heading into the gradient is removed. What is left is
   * the along-wall component, which is exactly the slide you want.
   */
  _moveAndCollide(delta, dt, cmd) {
    const p = this.p;
    const world = this.world;
    this.blocked = false;

    const stepHeight = p.stepHeight + (cmd.stepAssist ? p.stepAssistBonus : 0);

    // Tangential part of the intended motion, in the horizontal plane.
    const dx = delta.x;
    const dz = delta.z;
    const horiz = Math.hypot(dx, dz);

    if (horiz > 1e-6) {
      const ix = dx / horiz;
      const iz = dz / horiz;
      const hHere = this.groundHeight;

      // Probe far enough ahead that we stop before the body intersects, but not
      // so far that we refuse to enter a valley one radius wide.
      const reach = this.p.radius + Math.min(horiz, 0.4);
      const px = this.position.x + ix * reach;
      const pz = this.position.z + iz * reach;
      const hAhead = world.sampleHeight(px, pz);
      const rise = hAhead - hHere;

      let block = false;
      if (rise > stepHeight) {
        block = true;
      } else if (rise > 0.04) {
        // Rising but climbable in principle — only allow it if the surface we
        // would end up standing on is actually walkable.
        const nAhead = world.sampleNormal(px, pz);
        const ang = Math.acos(clamp(_v1.set(nAhead.x, nAhead.y, nAhead.z).normalize().dot(this.up), -1, 1));
        if (ang > p.slopeLimit && rise > 0.12) block = true;
      }

      if (block && this.grounded) {
        // Wall normal from the horizontal gradient of the heightfield. Sampled
        // with a wide epsilon so a noisy field does not produce a jittery normal
        // that makes you stutter along a cliff.
        const e = 0.6;
        const gx = world.sampleHeight(px + e, pz) - world.sampleHeight(px - e, pz);
        const gz = world.sampleHeight(px, pz + e) - world.sampleHeight(px, pz - e);
        let nx = -gx;
        let nz = -gz;
        const nl = Math.hypot(nx, nz);
        if (nl > 1e-5) {
          nx /= nl;
          nz /= nl;
          this.wallNormal.set(nx, 0, nz);
          const into = delta.x * nx + delta.z * nz;
          if (into < 0) {
            delta.x -= nx * into;
            delta.z -= nz * into;
            const vinto = this.velocity.x * nx + this.velocity.z * nz;
            if (vinto < 0) {
              this.velocity.x -= nx * vinto;
              this.velocity.z -= nz * vinto;
            }
            this.blocked = true;
            this.emit('wall', this.wallNormal);
          }
        }
      } else if (block) {
        // Airborne into a wall: kill the inbound component but keep the fall,
        // so you scrape down a cliff face instead of sticking to it.
        const e = 0.6;
        const gx = world.sampleHeight(px + e, pz) - world.sampleHeight(px - e, pz);
        const gz = world.sampleHeight(px, pz + e) - world.sampleHeight(px, pz - e);
        let nx = -gx;
        let nz = -gz;
        const nl = Math.hypot(nx, nz);
        if (nl > 1e-5) {
          nx /= nl;
          nz /= nl;
          const into = delta.x * nx + delta.z * nz;
          if (into < 0) {
            delta.x -= nx * into * 0.9;
            delta.z -= nz * into * 0.9;
            const vinto = this.velocity.x * nx + this.velocity.z * nz;
            if (vinto < 0) {
              this.velocity.x -= nx * vinto * 0.9;
              this.velocity.z -= nz * vinto * 0.9;
            }
            this.blocked = true;
          }
        }
      }
    }

    this.position.add(delta);

    // Hard floor. Even if every heuristic above failed, the body never ends a
    // tick below the terrain — this is the guarantee that makes tunnelling
    // impossible regardless of speed or timestep.
    const hNow = world.sampleHeight(this.position.x, this.position.z);
    _v3.set(this.position.x, hNow, this.position.z);
    const gap = _v1.subVectors(this.position, _v3).dot(this.up);
    if (gap < 0) {
      this.position.addScaledVector(this.up, -gap);
      const vUp = this.velocity.dot(this.up);
      if (vUp < 0) this.velocity.addScaledVector(this.up, -vUp);
      if (gap < -0.02) this.stepOffset += Math.min(-gap, this.p.stepHeight);
    }
  }

  /**
   * Decide grounded-ness after the move, and snap onto the surface.
   *
   * The snap is what stops you leaving the ground every time you run over a
   * crest at speed. It only applies when you were already grounded and are not
   * deliberately airborne, so it never eats a jump.
   */
  _resolveGround(dt, cmd) {
    const p = this.p;
    const world = this.world;
    const h = world.sampleHeight(this.position.x, this.position.z);
    _v3.set(this.position.x, h, this.position.z);
    const gap = _v1.subVectors(this.position, _v3).dot(this.up);
    const vUp = this.velocity.dot(this.up);

    const n = world.sampleNormal(this.position.x, this.position.z);
    this.groundNormal.set(n.x, n.y, n.z).normalize();
    this.slopeAngle = Math.acos(clamp(this.groundNormal.dot(this.up), -1, 1));
    this.groundHeight = h;
    this.heightAboveGround = gap;

    const contactEps = 0.035;
    let nowGrounded = false;

    if (gap <= contactEps && vUp <= 0.6) {
      nowGrounded = true;
      if (gap < 0) this.position.addScaledVector(this.up, -gap);
    } else if (
      this.wasGrounded &&
      !this.jumping &&
      !cmd.jetting &&
      vUp <= 0.2 &&
      gap < p.snapDistance + this.tangentSpeed * 0.02
    ) {
      // Crest snap. The allowance grows with speed because the faster you are
      // moving the further you travel per tick and the bigger the gap you open.
      this.position.addScaledVector(this.up, -gap);
      nowGrounded = true;
    }

    if (nowGrounded) {
      const newUp = this.velocity.dot(this.up);
      if (newUp < 0) this.velocity.addScaledVector(this.up, -newUp);
      // Re-project the remaining velocity onto the surface plane, so running
      // downhill actually accelerates you along the slope rather than making
      // you bounce down it in a series of tiny free-falls.
      const intoSurface = this.velocity.dot(this.groundNormal);
      if (intoSurface < 0) this.velocity.addScaledVector(this.groundNormal, -intoSurface);

      this.onSteepSlope = this.slopeAngle > p.slopeLimit;

      if (!this.wasGrounded) {
        // Landing. Impact is the vertical speed we had *before* this tick's
        // clamp, which is why _preLandVUp is stashed by the caller path below.
        const impact = Math.max(0, -(this._preLandVUp ?? vUp));
        this.landImpact = impact;
        this.jumping = false;
        this.jumpHoldTimer = 0;
        this.emit('land', {
          impact,
          position: this.position,
          normal: this.groundNormal,
          surface: this.surface,
          hard: impact > 9,
        });
      }
    } else {
      this.onSteepSlope = false;
      if (this.wasGrounded && !this.jumping) {
        // Walked off an edge. Coyote time starts now.
        this.emit('airborne', { position: this.position });
      }
    }

    this._preLandVUp = this.velocity.dot(this.up);
    this.grounded = nowGrounded;
    if (this.grounded) this.jumping = false;

    // Bleed the accumulated step offset; the camera reads it while it decays,
    // which is how a 0.4 m stair becomes a smooth rise instead of a jolt.
    this.stepOffset = damp(this.stepOffset, 0, 11, dt);
  }

  // ---------------------------------------------------------------------------
  // Slide.
  // ---------------------------------------------------------------------------

  _updateSlide(dt, cmd, wishMag) {
    const p = this.p;
    if (this.sliding) {
      this.slideTimer += dt;
      const speed = _v1
        .copy(this.velocity)
        .addScaledVector(this.up, -this.velocity.dot(this.up))
        .length();
      const wantsOut = !cmd.crouch && this.slideTimer > p.slideMinTime;
      const tooSlow = speed < p.walkSpeed * 0.72 && this.slideTimer > p.slideMinTime;
      if (!this.grounded || wantsOut || tooSlow) this._endSlide();
    } else {
      const speed = _v1
        .copy(this.velocity)
        .addScaledVector(this.up, -this.velocity.dot(this.up))
        .length();
      const canSlide =
        this.grounded && cmd.crouch && cmd.sprint && speed > p.slideEntrySpeed && this.timeSinceJump > 0.15;
      if (canSlide) {
        this.sliding = true;
        this.slideTimer = 0;
        // Entry impulse. A slide that starts by slowing you down is a crouch;
        // a slide that starts by speeding you up is a move.
        const vUp = this.velocity.dot(this.up);
        _v1.copy(this.velocity).addScaledVector(this.up, -vUp).multiplyScalar(p.slideBoost);
        this.velocity.copy(_v1).addScaledVector(this.up, vUp);
        this.emit('slideStart', { position: this.position, speed, surface: this.surface });
      }
    }
  }

  _endSlide() {
    if (!this.sliding) return;
    this.sliding = false;
    this.emit('slideEnd', { position: this.position });
  }

  _integrateSlide(dt, wishDir, wishMag, g, friction) {
    const p = this.p;
    // Downhill acceleration, gated so a flat slide does not accelerate forever.
    if (this.slopeAngle > p.slideSlopeMin) {
      this._downhill(_grad);
      _tan.addScaledVector(_grad, g * Math.sin(this.slopeAngle) * 0.85 * dt);
    }
    // Carving: rotate the velocity toward the wish direction instead of adding
    // to it. Rotation keeps the speed, which is what makes a slide feel like a
    // slide rather than a walk with a different animation.
    if (wishMag > 0.1) {
      const speed = _tan.length();
      if (speed > 0.2) {
        _v1.copy(_tan).multiplyScalar(1 / speed);
        const turn = p.slideSteer * wishMag * dt;
        _v1.addScaledVector(wishDir, turn).normalize();
        _tan.copy(_v1).multiplyScalar(speed);
      }
    }
    // Very low friction, modulated by the surface: ice slides forever, sand
    // grabs. Squared so a low-friction surface is dramatically slipperier.
    const f = p.slideFriction * clamp(friction * friction, 0.05, 2.2);
    _tan.multiplyScalar(Math.exp(-f * dt));
  }

  // ---------------------------------------------------------------------------
  // Gait.
  // ---------------------------------------------------------------------------

  /**
   * Stride phase is driven by distance travelled, never by wall-clock time.
   * That is the difference between a head bob that is glued to the feet and one
   * that visibly slips when you change speed or run into a wall.
   */
  _updateStride(dt) {
    const speed = this.tangentSpeed;
    // Stride lengthens with speed the way a real gait does — a sprint is longer
    // strides, not just faster ones — which keeps cadence in a plausible band.
    this.strideLength = clamp(0.95 + speed * 0.115, 0.95, 2.35);

    if (this.grounded && !this.sliding && speed > 0.25) {
      const advance = (speed * dt) / this.strideLength;
      const before = this.stridePhase;
      this.stridePhase = (this.stridePhase + advance) % 1;
      this.distanceTravelled += speed * dt;

      // Two plants per cycle, at phase 0 and 0.5.
      const crossed = (a, b, mark) => (a < mark && b >= mark) || (b < a && (a < mark || b >= mark));
      if (crossed(before, this.stridePhase, 0.5) && this._lastFootIndex !== 1) this._plant(1, speed);
      else if (before > this.stridePhase && this._lastFootIndex !== 0) this._plant(0, speed);
    } else if (!this.grounded || speed <= 0.25) {
      // Ease the phase back to a neutral stance so stopping does not freeze the
      // legs mid-swing.
      const target = this.stridePhase < 0.25 || this.stridePhase > 0.75 ? 0 : 0.5;
      this.stridePhase = damp(this.stridePhase, target, 6, dt);
      if (!this.grounded) this._lastFootIndex = -1;
    }
  }

  _plant(foot, speed) {
    this._lastFootIndex = foot;
    this.emit('footstep', {
      foot,
      position: this.position,
      normal: this.groundNormal,
      speed,
      surface: this.surface,
      running: this.sprintBlend > 0.4,
    });
  }

  _updateState() {
    const prev = this.state;
    if (!this.grounded) this.state = this.verticalSpeed > 0.4 ? 'jump' : 'air';
    else if (this.sliding) this.state = 'slide';
    else if (this.crouching) this.state = 'crouch';
    else if (this.tangentSpeed > this.p.walkSpeed * 1.12) this.state = 'run';
    else if (this.tangentSpeed > 0.35) this.state = 'walk';
    else this.state = 'idle';
    if (prev !== this.state) this.emit('state', this.state, prev);
  }
}
