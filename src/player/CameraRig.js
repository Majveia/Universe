/**
 * The camera.
 *
 * Of everything in the player subsystem this is the file the hands actually
 * feel. The motor decides where the body goes; the camera decides whether that
 * motion reads as a person, a vehicle, or a floating tripod. So it is written as
 * a small pile of second-order systems rather than as a transform copy.
 *
 * The rules it follows:
 *
 *   Nothing is driven by wall-clock time that could be driven by the body.
 *   Head bob comes from `locomotion.stridePhase`, which is integrated from
 *   distance travelled, so the bob is locked to the feet: walk into a wall and
 *   the bob stops, because the feet stopped. A sine on `time` is the single
 *   most common way a first-person camera announces that it is fake.
 *
 *   Every impulse is a spring, never a lerp to a pose. Landing pokes a damped
 *   spring whose kick is proportional to the impact speed the motor measured, so
 *   a two-metre hop and a twenty-metre drop are visibly different events rather
 *   than the same animation at two amplitudes.
 *
 *   The camera lags the aim, and only the aim. On a hard flick the rendered yaw
 *   trails the input by a few degrees and catches up over ~110 ms. That is
 *   enough to give a whip its weight and short enough that it never registers as
 *   latency — the reticle is always exactly where the input says, because the
 *   lag is applied to the *render* transform and not to the aim vector that
 *   gameplay reads.
 *
 *   Third person is a spring arm, not an orbit. The boom retracts instantly when
 *   terrain intrudes and returns slowly when it clears, because the failure mode
 *   people notice is the camera being *inside* a rock, not the camera being a
 *   little close for half a second.
 *
 *   The view swap is a blend of two fully-evaluated poses, never a teleport.
 *   Both the first-person pose and the boom pose are computed every frame and
 *   the output is the eased interpolation between them, so the transition is
 *   correct at every instant instead of being a scripted flight between two
 *   states that may have moved while it played.
 *
 * The rig also owns the aim. That looks like a layering violation and is not:
 * where you are looking and where the camera is are the same question, and
 * putting them in one place is what lets aim smoothing, auto-levelling and the
 * turn lag share a single source of truth.
 */

import * as THREE from 'three';
import { clamp, saturate, damp, lerp, smoothstep, smootherstep } from '../core/Noise.js';
import { Rng } from '../core/Rng.js';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const Y_UP = new THREE.Vector3(0, 1, 0);

/**
 * The feel budget. As with the motor, every number is a decision and the comment
 * is the reason — a designer should never have to read the code below to know
 * what to change.
 */
export const CAMERA_PROFILE = {
  // --- lens ---------------------------------------------------------------
  fov: 70,                  // overridden by settings.fov when one is supplied
  fovSprintGain: 7,         // degrees added at full sprint. More than ~9 is nausea.
  fovBoostGain: 15,         // jetpack / vehicle boost, on top of the sprint gain
  fovRate: 4.0,             // slow enough to read as acceleration, not as a zoom
  fovVehicleScale: 1.0,

  // --- aim ----------------------------------------------------------------
  pitchMin: -82 * DEG,
  pitchMax: 78 * DEG,
  // Input already de-jitters the pointer; this second stage exists for the
  // devices where a *little* lag buys a lot of steadiness. On mouse it is set
  // high enough to be inaudible.
  aimSmoothKbm: 90,
  aimSmoothPad: 32,
  aimSmoothTouch: 24,
  // Auto-levelling: when you are running forward and not touching the look
  // control, the pitch drifts back to the horizon. Invisible on a mouse (you are
  // always touching it), essential on a thumbstick.
  autoLevelRate: 0.85,
  autoLevelDelay: 0.55,     // seconds of no look input before it engages
  autoLevelSpeed: 2.2,      // and you must actually be moving

  // --- head bob (first person) --------------------------------------------
  // Two dips per stride cycle, at the foot plants. Amplitudes are metres at full
  // sprint and scale down with speed; a walk is nearly flat on purpose.
  bobVertical: 0.042,
  bobLateral: 0.031,
  bobRoll: 1.15 * DEG,
  bobPitch: 0.55 * DEG,
  bobRate: 12,              // how fast the amplitude follows the gait
  breathAmp: 0.0075,        // idle only; the body is never perfectly still
  breathRate: 0.72,

  // --- reaction springs ---------------------------------------------------
  landStiffness: 58,        // rad/s^2 per metre; ~1.2 Hz, a knee not a shock
  landDamping: 0.62,        // under 1 so it rebounds once, which reads as recovery
  landKick: 0.052,          // metres of dip per m/s of impact
  landMaxDip: 0.46,
  stepLead: 0.55,           // how much of the motor's step-up the eye absorbs

  // --- turn lag & lean ----------------------------------------------------
  turnLagGain: 0.055,       // seconds of yaw the render transform trails by
  turnLagRate: 9.5,         // catch-up, per second — ~110 ms to settle
  turnLagMax: 3.2 * DEG,
  strafeRoll: 1.5 * DEG,    // roll into a strafe, per unit of input
  velocityRoll: 0.9 * DEG,  // extra roll from actual lateral velocity
  rollRate: 6.0,

  // --- handheld -----------------------------------------------------------
  // A real head is never still. Amplitude is deliberately below the threshold
  // where you can point at it and say "the camera is wobbling".
  handheldAmp: 0.16 * DEG,
  handheldPos: 0.0035,
  handheldRate: 0.85,

  // --- third person -------------------------------------------------------
  tpDistance: 3.35,         // metres at a walk
  tpDistanceSprint: 4.55,   // pulled back at speed, which reads as urgency
  tpDistanceRate: 2.6,
  tpHeight: 1.42,           // boom pivot above the feet — chest height, not eye
  tpShoulder: 0.62,         // over-the-shoulder offset, +x = right
  tpShoulderSpeedFade: 0.45,// centred up at speed so the road is symmetric
  // Looking up puts the character in the lower third rather than the middle.
  // Implemented as a camera *rise* at constant aim, which is what a real
  // operator does when they want headroom for the sky.
  tpLookUpLift: 0.85,
  tpLookDownDrop: 0.28,
  tpPivotRate: 13,          // horizontal follow
  tpPivotRateVertical: 7.5, // softer vertically: stairs should not pump the frame
  tpPivotRateAir: 15,
  tpCollisionRadius: 0.34,
  tpRetractRate: 60,        // effectively instant — being inside a rock is worse
  tpReturnRate: 3.2,        // and slow coming back, so it does not pump
  tpMinDistance: 0.55,

  // --- view swap ----------------------------------------------------------
  // 4.6/s reaches 99% in about a second. Fast enough to feel like a decision,
  // slow enough that the parallax between the two poses actually reads.
  viewBlendRate: 4.6,

  // --- focus (depth of field) ---------------------------------------------
  focusRate: 3.4,
  focusMax: 900,
  focusSamples: 12,
};

// --- scratch -----------------------------------------------------------------
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _upv = new THREE.Vector3();
const _near = new THREE.Vector3();
const _far = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();

export class CameraRig {
  /**
   * @param {THREE.PerspectiveCamera} camera the director's camera; the rig
   *        writes its transform and fov but never replaces it
   * @param {object} opts { profile, settings, seed, controlFov }
   */
  constructor(camera, opts = {}) {
    this.camera = camera || new THREE.PerspectiveCamera(70, 1.6, 0.08, 20000);
    this.p = { ...CAMERA_PROFILE, ...(opts.profile || {}) };
    this.settings = opts.settings || null;
    this.controlFov = opts.controlFov !== false;
    this.rng = new Rng(opts.seed ?? 0xca3e7a);

    if (this.settings?.fov) this.p.fov = this.settings.fov;

    // --- aim ----------------------------------------------------------------
    /** Yaw/pitch in the local surface frame. Gameplay reads these. */
    this.yaw = 0;
    this.pitch = 0;
    this._yawTarget = 0;
    this._pitchTarget = 0;
    this._lookIdle = 99;      // seconds since the look control last moved
    this.lookScale = 1;

    // Free-look inside a vehicle: an offset from the vehicle's own frame that
    // recentres itself, so glancing at a wing never leaves you flying sideways.
    this.freeYaw = 0;
    this.freePitch = 0;
    this._freeIdle = 99;
    this.freeRecentre = 1.4;
    /** A bias the ship pushes in so the camera leans into its own turn. */
    this.biasYaw = 0;
    this.biasPitch = 0;
    this.biasRoll = 0;

    // --- view ---------------------------------------------------------------
    this.view = 'first';      // 'first' | 'third'
    /** 0 = fully first person, 1 = fully third. Never snaps. */
    this.viewT = 0;
    this.eased = 0;

    // --- springs ------------------------------------------------------------
    this.dip = 0;             // metres, positive is down
    this.dipV = 0;
    this.bobAmp = 0;
    this.roll = 0;
    this.yawLag = 0;
    this.pitchLag = 0;
    this.stepAbsorb = 0;
    this.shakeAmp = 0;
    this.shakeFreq = 22;
    this._shakeT = 0;

    // --- lens ---------------------------------------------------------------
    this.fov = this.p.fov;
    this._fovApplied = -1;
    this.focusDistance = 12;
    this.focusPoint = new THREE.Vector3();

    // --- boom ---------------------------------------------------------------
    this.boomDistance = this.p.tpDistance;
    this.boomAllowed = 1;     // 0..1 fraction of the boom that is unobstructed
    this.pivotSmoothed = new THREE.Vector3();
    this._pivotValid = false;

    /** Where the camera actually ended up, for anyone who needs it. */
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.forwardVec = new THREE.Vector3(0, 0, -1);
    this.rightVec = new THREE.Vector3(1, 0, 0);
    this.upVec = new THREE.Vector3(0, 1, 0);

    // Deterministic phases for the handheld wander. Three incommensurate sines
    // per axis is indistinguishable from noise at this amplitude and costs
    // nothing — and unlike Math.random it replays identically in a capture.
    this._ph = [];
    for (let i = 0; i < 6; i++) this._ph.push(this.rng.range(0, TAU));
    this._t = 0;

    this._alignUp = new THREE.Vector3(0, 1, 0);
    this._qAlign = new THREE.Quaternion();
  }

  // ---------------------------------------------------------------------------
  // Aim.
  // ---------------------------------------------------------------------------

  /**
   * Feed a look delta, in radians. `kind` selects the smoothing bracket and
   * comes straight from `input.lastInputKind`.
   */
  addLook(dx, dy, kind = 'kbm') {
    if (dx === 0 && dy === 0) return;
    this._lookKind = kind;
    this._lookIdle = 0;
    this._freeIdle = 0;
    if (this._vehicleMode) {
      this.freeYaw = clamp(this.freeYaw - dx * this.lookScale, -125 * DEG, 125 * DEG);
      this.freePitch = clamp(this.freePitch - dy * this.lookScale, -72 * DEG, 72 * DEG);
      return;
    }
    this._yawTarget -= dx * this.lookScale;
    this._pitchTarget = clamp(this._pitchTarget - dy * this.lookScale, this.p.pitchMin, this.p.pitchMax);
  }

  /** Point the aim at a world direction, expressed in the local up frame. */
  setAim(yaw, pitch) {
    this.yaw = this._yawTarget = yaw;
    this.pitch = this._pitchTarget = clamp(pitch, this.p.pitchMin, this.p.pitchMax);
  }

  /**
   * The camera's own lean into a turn, pushed in by a vehicle that steers with
   * the look axis (a starship, where look *is* the flight control and there is
   * no free-look to spare).
   */
  setLookBias(yaw, pitch, roll = 0) {
    this.biasYaw = yaw;
    this.biasPitch = pitch;
    this.biasRoll = roll;
  }

  /** Local-frame basis for the current aim. Gameplay builds its wish from these. */
  basis(up, outForward = _fwd, outRight = _right) {
    if (up && (up.x !== this._alignUp.x || up.y !== this._alignUp.y || up.z !== this._alignUp.z)) {
      this._alignUp.copy(up);
      this._qAlign.setFromUnitVectors(Y_UP, this._alignUp);
    }
    // Forward is yaw about local up, then pitch about local right. Built by
    // hand rather than from an Euler so the order is unambiguous on a sphere.
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    outForward.set(-sy * cp, sp, -cy * cp).applyQuaternion(this._qAlign);
    outRight.set(cy, 0, -sy).applyQuaternion(this._qAlign);
    return outForward;
  }

  /** Horizontal forward, i.e. the aim with the pitch removed. */
  groundForward(up, out = _v1) {
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    if (up && (up.x !== this._alignUp.x || up.y !== this._alignUp.y || up.z !== this._alignUp.z)) {
      this._alignUp.copy(up);
      this._qAlign.setFromUnitVectors(Y_UP, this._alignUp);
    }
    return out.set(-sy, 0, -cy).applyQuaternion(this._qAlign);
  }

  // ---------------------------------------------------------------------------
  // View.
  // ---------------------------------------------------------------------------

  setView(view, animate = true) {
    if (view === this.view) return;
    this.view = view;
    if (!animate) this.viewT = view === 'third' ? 1 : 0;
  }

  toggleView() {
    this.setView(this.view === 'first' ? 'third' : 'first');
    return this.view;
  }

  /** True once the blend has committed far enough to hide or show the body. */
  get bodyVisible() {
    return this.viewT > 0.22;
  }

  // ---------------------------------------------------------------------------
  // Impulses.
  // ---------------------------------------------------------------------------

  /** Landing. `impact` is the motor's measured downward speed in m/s. */
  land(impact) {
    const p = this.p;
    // Linear in impact and then clamped: a fall from orbit should not fold the
    // camera through the floor, but every landing below the cap must differ.
    const kick = clamp(impact * p.landKick, 0, p.landMaxDip);
    this.dipV += kick * 9.5;
    if (impact > 9) this.shake(saturate((impact - 9) / 16) * 0.35, 0.28);
  }

  /** Launch. A jump extends before it rises — the inverse of the landing dip. */
  jump(impulse) {
    this.dipV -= clamp(impulse * 0.012, 0, 0.09) * 9.5;
  }

  /** Additive shake, for impacts, thrusters and warp. */
  shake(amount, duration = 0.4, freq = 22) {
    this.shakeAmp = Math.max(this.shakeAmp, amount);
    this._shakeT = Math.max(this._shakeT, duration);
    this.shakeFreq = freq;
  }

  // ---------------------------------------------------------------------------
  // The frame.
  // ---------------------------------------------------------------------------

  /**
   * @param {number} dt render dt — this is presentation and may vary
   * @param {object} s {
   *   up, eye, position, velocity, speed, maxSpeed, grounded, stridePhase,
   *   strafe, forward, crouch, slide, boost, stepOffset, world, settings,
   *   vehicle: null | { group, cockpit, chase, quaternion, position, speed, boost },
   *   lookKind
   * }
   */
  update(dt, s) {
    const p = this.p;
    this._t += dt;
    this._vehicleMode = !!s.vehicle;

    const up = s.up || Y_UP;
    if (up.x !== this._alignUp.x || up.y !== this._alignUp.y || up.z !== this._alignUp.z) {
      this._alignUp.copy(up);
      this._qAlign.setFromUnitVectors(Y_UP, this._alignUp);
    }

    this._integrateAim(dt, s);
    this._integrateSprings(dt, s);

    // Blend toward the requested view. An exponential approach can never
    // overshoot and never snaps, which is exactly the guarantee a view swap
    // needs — there is no frame in which the camera is nowhere.
    this.viewT = damp(this.viewT, this.view === 'third' ? 1 : 0, p.viewBlendRate, dt);
    if (this.viewT < 1e-4) this.viewT = 0;
    if (this.viewT > 1 - 1e-4) this.viewT = 1;
    // Ease the *use* of the blend rather than the blend itself, so the two ends
    // are flat and the middle moves: a linear cut between two poses reads as a
    // slide, an eased one reads as a camera move.
    this.eased = smootherstep(0, 1, this.viewT);

    if (s.vehicle) this._vehiclePoses(dt, s);
    else this._footPoses(dt, s);

    this._composite(dt, s);
    this._lens(dt, s);
    this._focus(dt, s);
  }

  // --- aim -------------------------------------------------------------------

  _integrateAim(dt, s) {
    const p = this.p;
    const kind = s.lookKind || this._lookKind || 'kbm';
    this._lookIdle += dt;
    this._freeIdle += dt;

    // Auto-level. Only with the look control at rest and the body actually
    // travelling, so it can never fight you — it only tidies up after you.
    if (
      !this._vehicleMode &&
      this._lookIdle > p.autoLevelDelay &&
      (s.speed ?? 0) > p.autoLevelSpeed &&
      (s.forward ?? 0) > 0.3 &&
      (s.assist ?? 0) > 0
    ) {
      this._pitchTarget = damp(this._pitchTarget, 0, p.autoLevelRate * (s.assist ?? 1), dt);
    }

    const rate =
      kind === 'touch' ? p.aimSmoothTouch : kind === 'gamepad' ? p.aimSmoothPad : p.aimSmoothKbm;
    const prevYaw = this.yaw;
    this.yaw = damp(this.yaw, this._yawTarget, rate, dt);
    this.pitch = damp(this.pitch, this._pitchTarget, rate, dt);
    this.pitch = clamp(this.pitch, p.pitchMin, p.pitchMax);

    // Turn lag. Fed by how far the aim moved this frame, decayed toward zero.
    // The lag lives on the render transform only; `this.yaw` — the number the
    // weapon and the wish direction use — is never delayed.
    let d = this.yaw - prevYaw;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    this.yawLag = clamp(this.yawLag + d * p.turnLagGain, -p.turnLagMax, p.turnLagMax);
    this.yawLag = damp(this.yawLag, 0, p.turnLagRate, dt);

    if (this._vehicleMode) {
      // Free-look recentres itself once you stop asking for it.
      if (this._freeIdle > this.freeRecentre) {
        this.freeYaw = damp(this.freeYaw, 0, 3.2, dt);
        this.freePitch = damp(this.freePitch, 0, 3.2, dt);
      }
    }
  }

  // --- springs ---------------------------------------------------------------

  _integrateSprings(dt, s) {
    const p = this.p;

    // Landing dip: a damped harmonic oscillator, integrated semi-implicitly so
    // it is stable at any frame rate the browser can produce.
    const k = p.landStiffness;
    const c = 2 * Math.sqrt(k) * p.landDamping;
    this.dipV += (-k * this.dip - c * this.dipV) * dt;
    this.dip += this.dipV * dt;
    this.dip = clamp(this.dip, -p.landMaxDip * 0.5, p.landMaxDip);

    // The motor accumulates step-ups and bleeds them; the eye absorbs part of
    // that so a 40 cm stair is a rise rather than a jolt.
    this.stepAbsorb = damp(this.stepAbsorb, (s.stepOffset ?? 0) * p.stepLead, 14, dt);

    // Bob amplitude follows the gait, not the instant speed, so a stumble does
    // not make the head jump.
    const maxSpeed = s.maxSpeed || 7.6;
    const gait = saturate((s.speed ?? 0) / maxSpeed);
    const target = s.grounded ? gait * (1 - 0.55 * (s.crouch ?? 0)) * (1 - (s.slide ?? 0)) : 0;
    this.bobAmp = damp(this.bobAmp, target, p.bobRate, dt);

    // Roll: input strafe plus the lateral component of actual velocity. The
    // first is intent and arrives instantly; the second is consequence and
    // arrives when the body does. Both together is what reads as a body.
    let lateral = 0;
    if (s.velocity && s.up) {
      this.basis(s.up, _fwd, _right);
      _v0.copy(s.velocity).addScaledVector(s.up, -s.velocity.dot(s.up));
      lateral = saturate(Math.abs(_v0.dot(_right)) / maxSpeed) * Math.sign(_v0.dot(_right));
    }
    const rollTarget =
      -(s.strafe ?? 0) * p.strafeRoll - lateral * p.velocityRoll + (s.slide ?? 0) * 2.2 * DEG;
    this.roll = damp(this.roll, rollTarget, p.rollRate, dt);

    if (this._shakeT > 0) {
      this._shakeT -= dt;
      this.shakeAmp = damp(this.shakeAmp, 0, 6, dt);
      if (this._shakeT <= 0) this.shakeAmp = 0;
    }
  }

  // --- poses -----------------------------------------------------------------

  /**
   * First-person pose and the boom pose for a character on foot.
   *
   * Both are evaluated every frame regardless of which one is showing, because
   * the blend between them has to be correct at every value of `viewT` and
   * because a pose that is only computed while visible arrives cold.
   */
  _footPoses(dt, s) {
    const p = this.p;
    const up = s.up || Y_UP;
    this.basis(up, _fwd, _right);

    // --- first person -------------------------------------------------------
    const cyc = (s.stridePhase ?? 0) * TAU;
    const amp = this.bobAmp;
    const reduce = this.settings?.reduceMotion || s.settings?.reduceMotion ? 0.25 : 1;

    // Two dips per cycle, deepest at the foot plants (phase 0 and 0.5), and a
    // single lateral sway per cycle toward the stance leg. That asymmetry — 2:1
    // vertical to lateral — is the signature of a walk.
    const bobY = -Math.abs(Math.cos(cyc)) * p.bobVertical * amp * reduce;
    const bobX = Math.sin(cyc) * p.bobLateral * amp * reduce;
    const bobRoll = Math.sin(cyc) * p.bobRoll * amp * reduce;
    const bobPitch = -Math.abs(Math.cos(cyc)) * p.bobPitch * amp * reduce;

    // Breathing, only readable when nearly still — which is exactly when its
    // absence would read as a paused game.
    const rest = 1 - saturate(amp * 2.2);
    const breath = Math.sin(this._t * p.breathRate * TAU * 0.25) * p.breathAmp * rest * reduce;

    _near.copy(s.eye);
    _near.addScaledVector(up, bobY + breath - this.dip - this.stepAbsorb);
    _near.addScaledVector(_right, bobX);
    // A few centimetres forward of the skull centre, so leaning over a ledge
    // shows you the ledge instead of your own forehead.
    _near.addScaledVector(_fwd, 0.055);

    this._nearPos = this._nearPos || new THREE.Vector3();
    this._nearPos.copy(_near);
    this._nearRoll = this.roll + bobRoll;
    this._nearPitch = bobPitch;

    // --- third person -------------------------------------------------------
    // Pivot follows the body with separate horizontal and vertical rates: a
    // stair-step should not pump the frame, but a jump must stay in it.
    _pivot.copy(s.position).addScaledVector(up, p.tpHeight * (1 - 0.3 * (s.crouch ?? 0)));
    if (!this._pivotValid) {
      this.pivotSmoothed.copy(_pivot);
      this._pivotValid = true;
    } else {
      const vertRate = s.grounded ? p.tpPivotRateVertical : p.tpPivotRateAir;
      // Split the follow into the up axis and the plane, then recombine.
      _v0.subVectors(_pivot, this.pivotSmoothed);
      const alongUp = _v0.dot(up);
      _v1.copy(_v0).addScaledVector(up, -alongUp);
      this.pivotSmoothed.addScaledVector(_v1, 1 - Math.exp(-p.tpPivotRate * dt));
      this.pivotSmoothed.addScaledVector(up, alongUp * (1 - Math.exp(-vertRate * dt)));
    }

    const speedN = saturate((s.speed ?? 0) / (s.maxSpeed || 7.6));
    const want = lerp(p.tpDistance, p.tpDistanceSprint, speedN);
    this.boomDistance = damp(this.boomDistance, want, p.tpDistanceRate, dt);

    // Looking up lifts the camera at constant aim, which pushes the character
    // into the lower third and gives the sky the frame. Looking down does the
    // mild opposite so you can see your own feet on a ledge.
    const pitchN = this.pitch >= 0 ? saturate(this.pitch / p.pitchMax) : -saturate(this.pitch / p.pitchMin);
    const lift = pitchN > 0 ? pitchN * p.tpLookUpLift : pitchN * p.tpLookDownDrop;
    const shoulder = p.tpShoulder * (1 - p.tpShoulderSpeedFade * speedN);

    _far.copy(this.pivotSmoothed)
      .addScaledVector(_fwd, -this.boomDistance)
      .addScaledVector(_right, shoulder)
      .addScaledVector(up, lift + this.dip * -0.35);

    this._boomCollide(dt, s, this.pivotSmoothed, _far, up);

    this._farPos = this._farPos || new THREE.Vector3();
    this._farPos.copy(_far);
    this._farRoll = this.roll * 0.55;
    this._farPitch = 0;
  }

  /**
   * Cockpit and chase poses for a mounted vehicle.
   *
   * The cockpit anchor is a node in the vehicle's own graph, so it inherits
   * every bit of chassis pitch and roll the suspension produced for free — which
   * is the entire reason driving from inside feels like driving.
   */
  _vehiclePoses(dt, s) {
    const p = this.p;
    const v = s.vehicle;
    const up = s.up || Y_UP;
    const chase = v.chase || {};

    // --- cockpit ------------------------------------------------------------
    const anchor = v.cockpit;
    this._nearPos = this._nearPos || new THREE.Vector3();
    this._farPos = this._farPos || new THREE.Vector3();
    if (anchor) {
      anchor.updateWorldMatrix(true, false);
      this._nearPos.setFromMatrixPosition(anchor.matrixWorld);
      _qa.setFromRotationMatrix(_m.extractRotation(anchor.matrixWorld));
    } else {
      this._nearPos.copy(v.position);
      _qa.copy(v.quaternion);
    }
    // Free-look inside the cockpit, applied in the vehicle's frame so it turns
    // with the vehicle rather than sliding off it.
    _e.set(this.freePitch + this.biasPitch * 0.5, this.freeYaw + this.biasYaw, this.biasRoll, 'YXZ');
    _q2.setFromEuler(_e);
    this._nearQuat = this._nearQuat || new THREE.Quaternion();
    this._nearQuat.copy(_qa).multiply(_q2);
    // A shudder proportional to how hard the machine is working.
    this._nearPos.addScaledVector(_v0.set(0, 1, 0).applyQuaternion(_qa), -this.dip * 0.35);

    // --- chase --------------------------------------------------------------
    const dist = (chase.distance ?? 8) * (1 + 0.22 * saturate((v.speed ?? 0) / (chase.refSpeed ?? 30)));
    this.boomDistance = damp(this.boomDistance, dist, 2.2, dt);

    // The boom hangs off the vehicle's own axes but keeps the world's up, so a
    // barrel roll spins the ship inside a stable frame instead of spinning the
    // horizon — the difference between a chase camera and a nausea generator.
    _fwd.set(0, 0, -1).applyQuaternion(v.quaternion);
    const worldUp = chase.worldUp === false ? _v2.set(0, 1, 0).applyQuaternion(v.quaternion) : up;
    _v0.copy(_fwd).addScaledVector(worldUp, -_fwd.dot(worldUp));
    if (_v0.lengthSq() < 1e-6) _v0.copy(_fwd);
    _v0.normalize();
    _right.crossVectors(_v0, worldUp).normalize().multiplyScalar(-1);

    _e.set(this.freePitch, this.freeYaw, 0, 'YXZ');
    _q2.setFromEuler(_e);
    _v1.copy(_v0).applyQuaternion(_q2);

    _pivot.copy(v.position).addScaledVector(worldUp, chase.height ?? 2.2);
    if (!this._pivotValid) {
      this.pivotSmoothed.copy(_pivot);
      this._pivotValid = true;
    } else {
      this.pivotSmoothed.lerp(_pivot, 1 - Math.exp(-(chase.follow ?? 9) * dt));
    }

    _far.copy(this.pivotSmoothed)
      .addScaledVector(_v1, -this.boomDistance)
      .addScaledVector(worldUp, (chase.lift ?? 0.6) + this.freePitch * 2.2);

    if (chase.collide !== false) this._boomCollide(dt, s, this.pivotSmoothed, _far, up);
    this._farPos.copy(_far);

    // Chase aim: look at a point ahead of the vehicle rather than at it, so the
    // machine sits low in frame and you can see where you are going.
    _v2.copy(v.position)
      .addScaledVector(worldUp, (chase.height ?? 2.2) * 0.8)
      .addScaledVector(_fwd, chase.lookAhead ?? 6);
    _m.lookAt(this._farPos, _v2, worldUp);
    this._farQuat = this._farQuat || new THREE.Quaternion();
    this._farQuat.setFromRotationMatrix(_m);
  }

  /**
   * Spring-arm collision.
   *
   * Uses the realm's raycast when it offers one and falls back to walking the
   * heightfield otherwise, because the fallback still has to work on a world
   * that only implements the five-member contract.
   */
  _boomCollide(dt, s, pivot, camTarget, up) {
    const p = this.p;
    const world = s.world;
    if (!world) return;

    _v0.subVectors(camTarget, pivot);
    const len = _v0.length();
    if (len < 1e-4) return;
    _v0.multiplyScalar(1 / len);

    let allowed = 1;
    if (world.raycast) {
      const hit = world.raycast(pivot, _v0, len + p.tpCollisionRadius);
      if (hit && hit.distance < len + p.tpCollisionRadius) {
        allowed = saturate((hit.distance - p.tpCollisionRadius) / len);
      }
    } else if (world.sampleHeight) {
      // March the boom and stop at the first sample that would put the lens
      // inside the ground. Six samples is enough at these distances and it is
      // six heightfield lookups, which is nothing next to one raycast.
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        _v1.copy(pivot).addScaledVector(_v0, len * t);
        const h = world.sampleHeight(_v1.x, _v1.z);
        _v2.set(_v1.x, h, _v1.z);
        const clearance = _v2.subVectors(_v1, _v2).dot(up);
        if (clearance < p.tpCollisionRadius) {
          allowed = Math.max(p.tpMinDistance / len, (i - 1) / steps);
          break;
        }
      }
    }

    // Retract now, return later. Asymmetric on purpose: a camera that eases into
    // a wall is a camera that spends half a second inside it.
    const rate = allowed < this.boomAllowed ? p.tpRetractRate : p.tpReturnRate;
    this.boomAllowed = damp(this.boomAllowed, allowed, rate, dt);
    camTarget.copy(pivot).addScaledVector(_v0, len * this.boomAllowed);

    // Last guarantee: never below the ground, whatever the march concluded.
    if (world.sampleHeight) {
      const h = world.sampleHeight(camTarget.x, camTarget.z);
      _v2.set(camTarget.x, h, camTarget.z);
      const clearance = _v1.subVectors(camTarget, _v2).dot(up);
      if (clearance < p.tpCollisionRadius) {
        camTarget.addScaledVector(up, p.tpCollisionRadius - clearance);
      }
    }
  }

  // --- composite -------------------------------------------------------------

  _composite(dt, s) {
    const p = this.p;
    const up = s.up || Y_UP;
    const t = this.eased;

    // Orientation. On foot both poses share the aim, which is why the swap does
    // not swing the horizon; only the position and a little roll differ.
    if (s.vehicle) {
      _qa.copy(this._nearQuat);
      _qb.copy(this._farQuat);
      _q.copy(_qa).slerp(_qb, t);
    } else {
      _e.set(this.pitch + this._nearPitch * (1 - t) + this.pitchLag, this.yaw + this.yawLag, 0, 'YXZ');
      _q.setFromEuler(_e);
      _q.premultiply(this._qAlign);
      const roll = lerp(this._nearRoll, this._farRoll, t);
      if (Math.abs(roll) > 1e-5) {
        _v0.set(0, 0, -1).applyQuaternion(_q);
        _q2.setFromAxisAngle(_v0, roll);
        _q.premultiply(_q2);
      }
    }

    // Position. A small rise through the middle of the blend keeps the lens out
    // of the character's own shoulders as it passes through them.
    _v0.copy(this._nearPos).lerp(this._farPos, t);
    if (t > 0.001 && t < 0.999) _v0.addScaledVector(up, Math.sin(t * Math.PI) * 0.16);

    // Handheld wander plus any active shake, both as angle first and position
    // second — rotation is what the eye reads as "a person is holding this".
    const reduce = this.settings?.reduceMotion ? 0.2 : 1;
    const hh = p.handheldAmp * reduce * (0.55 + 0.45 * this.bobAmp);
    const n0 = this._wander(0, p.handheldRate);
    const n1 = this._wander(2, p.handheldRate * 1.31);
    const n2 = this._wander(4, p.handheldRate * 0.77);
    const shake = this.shakeAmp;
    if (hh > 0 || shake > 0) {
      const sf = shake > 0 ? Math.sin(this._t * this.shakeFreq * TAU) * shake : 0;
      const sf2 = shake > 0 ? Math.sin(this._t * this.shakeFreq * TAU * 1.37 + 1.1) * shake : 0;
      _e.set(n1 * hh + sf2 * 0.03, n0 * hh + sf * 0.02, n2 * hh * 2 + sf * 0.04, 'YXZ');
      _q2.setFromEuler(_e);
      _q.multiply(_q2);
      _v0.addScaledVector(_v1.set(1, 0, 0).applyQuaternion(_q), n0 * p.handheldPos * reduce + sf * 0.05);
      _v0.addScaledVector(_v1.set(0, 1, 0).applyQuaternion(_q), n1 * p.handheldPos * reduce + sf2 * 0.05);
    }

    this.position.copy(_v0);
    this.quaternion.copy(_q);
    this.camera.position.copy(_v0);
    this.camera.quaternion.copy(_q);
    this.forwardVec.set(0, 0, -1).applyQuaternion(_q);
    this.rightVec.set(1, 0, 0).applyQuaternion(_q);
    this.upVec.set(0, 1, 0).applyQuaternion(_q);
  }

  /** Three incommensurate sines. Smooth, bounded, deterministic, allocation-free. */
  _wander(i, rate) {
    const t = this._t * rate;
    return (
      Math.sin(t * 1.00 + this._ph[i]) * 0.55 +
      Math.sin(t * 2.31 + this._ph[i + 1]) * 0.31 +
      Math.sin(t * 4.77 + this._ph[i] * 1.7) * 0.14
    );
  }

  // --- lens ------------------------------------------------------------------

  _lens(dt, s) {
    const p = this.p;
    const base = this.settings?.fov ?? p.fov;
    const maxSpeed = s.maxSpeed || 7.6;

    let target = base;
    if (s.vehicle) {
      const ref = s.vehicle.chase?.refSpeed ?? 30;
      target += saturate((s.vehicle.speed ?? 0) / ref) * p.fovSprintGain * 1.4;
      target += saturate(s.vehicle.boost ?? 0) * p.fovBoostGain;
    } else {
      // Only speed *above a walk* opens the lens, so strolling looks normal and
      // a sprint feels like something changed.
      target += saturate(((s.speed ?? 0) - maxSpeed * 0.5) / (maxSpeed * 0.5)) * p.fovSprintGain;
      target += saturate(s.boost ?? 0) * p.fovBoostGain;
    }
    if (s.zoom) target = lerp(target, base * 0.42, saturate(s.zoom));

    this.fov = damp(this.fov, target, p.fovRate, dt);
    if (this.controlFov && Math.abs(this.fov - this._fovApplied) > 0.02) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
      this._fovApplied = this.fov;
    }
  }

  /**
   * Where the lens should focus.
   *
   * Depth of field with a fixed focal plane is worse than no depth of field at
   * all, because the thing you are looking at is the one thing guaranteed to be
   * soft. So the focus target is whatever is under the centre of frame — the
   * interaction target if there is one, the ground otherwise, and the far plane
   * when the camera is pointed at the sky.
   */
  _focus(dt, s) {
    const p = this.p;
    let d = p.focusMax;

    if (s.focusOverride && s.focusOverride > 0) {
      d = s.focusOverride;
    } else if (s.world?.raycast) {
      const hit = s.world.raycast(this.position, this.forwardVec, p.focusMax);
      if (hit) d = hit.distance;
    } else if (s.world?.sampleHeight) {
      // Geometrically spaced march: dense where the parallax matters, sparse
      // out where a metre of error is a fraction of a pixel of blur.
      const up = s.up || Y_UP;
      let t = 1.5;
      for (let i = 0; i < p.focusSamples; i++) {
        _v0.copy(this.position).addScaledVector(this.forwardVec, t);
        const h = s.world.sampleHeight(_v0.x, _v0.z);
        _v1.set(_v0.x, h, _v0.z);
        if (_v1.subVectors(_v0, _v1).dot(up) < 0) {
          d = t;
          break;
        }
        t *= 1.85;
        if (t > p.focusMax) break;
      }
    }

    // Focus pulls slowly, the way a lens does. Snapping the plane on every
    // reticle change is a tell that the effect is being driven by a raycast.
    this.focusDistance = damp(this.focusDistance, clamp(d, 0.4, p.focusMax), p.focusRate, dt);
    this.focusPoint.copy(this.position).addScaledVector(this.forwardVec, this.focusDistance);
  }

  /** Drop the follow state so a teleport does not drag the camera across a planet. */
  reset(s) {
    this._pivotValid = false;
    this.dip = 0;
    this.dipV = 0;
    this.yawLag = 0;
    this.boomAllowed = 1;
    if (s) this.update(1 / 60, s);
  }
}
