/**
 * The player.
 *
 * Everything below this file is a mechanism — a motor, a camera, a skeleton, a
 * pack, a particle pool, a vehicle. This file is the *person*: it reads intent
 * off the input layer, decides what that intent means given where you are
 * standing and what you are looking at, and hands each mechanism the one struct
 * it understands. It owns no physics of its own, which is deliberate. The moment
 * an orchestrator starts integrating velocity is the moment the motor stops
 * being the source of truth and the feel starts depending on call order.
 *
 * Three ideas structure the whole file.
 *
 *   **The clock is fixed and the picture is not.** Physics runs at exactly
 *   120 Hz through an accumulator; presentation runs at whatever the display
 *   offers and interpolates between the last two ticks. A jump has the same apex
 *   on a 30 Hz laptop and a 144 Hz monitor, which is not a nicety — it is the
 *   difference between tuning a feel and tuning a feel *for one machine*. Edge
 *   events (a jump press, a view toggle) are latched during the frame and
 *   consumed by the first tick that runs, so a frame that happens to contain
 *   three ticks never triple-fires a button.
 *
 *   **Flow is a state, not a side effect.** Sprint into slide into jump into
 *   jetpack is the traversal loop the entire subsystem is built around. Each
 *   link is already generous in isolation — the motor boosts a slide entry, pays
 *   a bonus on a slide jump; the pack pays an ignition bonus if it lights inside
 *   the post-jump window — but nothing was *watching* the chain. This file
 *   watches it, keeps the link count, and spends it on the things that make a
 *   chain feel like an achievement: a wider lens, a longer boom, a little extra
 *   speed out of the last transition. Crucially, no transition ever writes
 *   velocity down. Momentum is the currency; the chain only ever adds.
 *
 *   **Assists are invisible or they are insulting.** Step assist, ledge snap,
 *   aim slow-down near a target and pitch auto-levelling all exist, all scale
 *   with how imprecise the current input device is, and all are off on a mouse.
 *   A player on a phone should feel like the terrain is forgiving; a player on a
 *   mouse should feel like nothing is helping them, because nothing is.
 *
 * The public surface is small on purpose: `position`, `velocity`, `camera`,
 * `mode`, `contextActions`. Everything else a caller might want hangs off the
 * sub-objects, which are all public and all safe to read.
 */

import * as THREE from 'three';
import { clamp, saturate, damp, lerp, smootherstep } from '../core/Noise.js';
import { Locomotion, createCommand, Emitter } from './Locomotion.js';
import { CameraRig } from './CameraRig.js';
import { CharacterRig } from './CharacterRig.js';
import { Jetpack } from './Jetpack.js';
import { FootstepFX } from './FootstepFX.js';
import { VehicleRegistry, createVehicleCommand } from './Vehicles.js';
// Concrete vehicles register themselves with the registry as a side effect of
// being loaded, and Vehicles.js deliberately does not import them — it owns the
// base class they extend, so importing them back would make the cycle evaluate
// the subclass before its own base exists. Something on the main path therefore
// has to pull them in, and this is that place. Without this line VEHICLE_SPECS
// still advertises a rover while the registry has no constructor for it, so the
// UI offers a vehicle that cannot be mounted.
import './Rover.js';

const DEG = Math.PI / 180;
const Y_UP = new THREE.Vector3(0, 1, 0);

/**
 * 120 Hz. Fast enough that a 7.6 m/s sprint moves 6 cm per tick — well under the
 * body radius, so the terrain probe can never be outrun — and cheap enough that
 * a phone rendering at 30 fps runs four ticks a frame without noticing.
 */
const FIXED = 1 / 120;
/**
 * Ceiling on catch-up ticks. A tab that was backgrounded for a minute must not
 * try to simulate a minute; it must lose the minute. Eight ticks is 67 ms, which
 * covers a genuine 15 fps stall and refuses anything worse.
 */
const MAX_STEPS = 8;

export const PLAYER_PROFILE = {
  /** How far you can reach to press something. */
  interactRange: 3.4,
  /** And how far off the reticle it may sit, in radians of half-angle. */
  interactCone: 26 * DEG,
  /** Boarding is more forgiving than pressing: vehicles are big. */
  boardRange: 6.5,

  /** Scan ping. The wavefront is cosmetic; the results are gathered at t=0. */
  scanRange: 140,
  scanDuration: 2.4,
  scanCooldown: 0.9,

  /** How long the camera takes to fly into or out of a cockpit. */
  mountFade: 0.62,

  /** Aim slow-down near a target, and the angle it starts at. */
  stickyAim: 0.62,
  stickyAngle: 5.5 * DEG,

  /** Ledge snap: the tallest lip a falling body will be helped over. */
  ledgeReach: 0.95,
  ledgeCooldown: 0.5,

  /** Chain windows, in seconds, for the flow tracker. */
  flowWindow: 1.1,
  /** Speed the last link of a full chain hands back, as a fraction. */
  flowPayout: 0.07,
};

// --- scratch -----------------------------------------------------------------
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _feet = new THREE.Vector3();
const _q0 = new THREE.Quaternion();

export class PlayerController extends Emitter {
  /**
   * @param {object} ctx  { input, camera, settings, hud, audio, engine, scene }
   * @param {object} world the realm, implementing the dependency contract
   * @param {object} opts  { scene, seed, quality, spawn, profile, cameraProfile,
   *                         jetpackProfile, flashlight, driveHud, vehicles }
   */
  constructor(ctx, world, opts = {}) {
    super();
    this.ctx = ctx || {};
    this.world = world;
    this.input = this.ctx.input || null;
    this.settings = opts.settings || this.ctx.settings || null;
    this.hud = this.ctx.hud || null;
    this.audio = this.ctx.audio || null;
    this.p = { ...PLAYER_PROFILE, ...(opts.profile || {}) };
    this.seed = opts.seed ?? 0x9152f;
    this.quality = opts.quality ?? this.settings?.vegetationDensity ?? 1;
    this.driveHud = opts.driveHud !== false;

    /** Scene node. Add this to the realm; everything the player owns is inside. */
    this.group = new THREE.Group();
    this.group.name = 'player';

    // --- mechanisms ---------------------------------------------------------
    this.locomotion = new Locomotion(world, { profile: opts.profile?.locomotion || opts.locomotion });
    this.camera = this.ctx.camera || new THREE.PerspectiveCamera(70, 1.6, 0.06, 1e6);
    this.cameraRig = new CameraRig(this.camera, {
      profile: opts.cameraProfile,
      settings: this.settings,
      seed: this.seed ^ 0x51de,
      controlFov: opts.controlFov !== false,
    });
    this.rig = new CharacterRig({
      seed: this.seed ^ 0xb0d1,
      height: this.locomotion.p.standHeight,
      quality: this.quality,
    });
    this.group.add(this.rig.group);

    this.jetpack = new Jetpack({ profile: opts.jetpackProfile, seed: this.seed ^ 0x1e7 });
    this.jetpack.buildFX(this.rig.jetpackMount, { scale: this.rig.scale });

    this.fx = new FootstepFX(opts.scene || this.group, {
      seed: this.seed ^ 0xf007,
      quality: this.quality,
    });

    this.vehicles = opts.vehicles || new VehicleRegistry(world, { fx: this.fx });
    if (!opts.vehicles) this.group.add(this.vehicles.group);

    // --- state --------------------------------------------------------------
    /** 'foot' | 'vehicle'. Read it; do not write it. */
    this.mode = 'foot';
    this.view = 'first';
    this.vehicle = null;
    this.enabled = true;

    this.cmd = createCommand();
    this.vcmd = createVehicleCommand();

    /** Live references into the motor, so a caller never reads a stale copy. */
    this.position = this.locomotion.position;
    this.velocity = this.locomotion.velocity;
    /** Interpolated render-frame feet and eye, written every presented frame. */
    this.renderPosition = new THREE.Vector3();
    this.eye = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);

    /** `[{id,label,key,icon,enabled}]` for the HUD and the touch pad. */
    this.contextActions = [];
    this._actionSig = '';

    /** What the reticle is on, if anything. */
    this.focus = null;
    /** Things in the realm the player may press. Push and splice freely. */
    this.interactables = opts.interactables || [];

    this.scan = { active: false, t: 0, duration: this.p.scanDuration, radius: 0, origin: new THREE.Vector3(), results: [] };
    this._scanCooldown = 0;

    /** sprint -> slide -> jump -> boost. `links` is how deep the current chain is. */
    this.flow = { links: 0, label: 'idle', timer: 0, best: 0, since: 99 };

    this.vitals = { fuel: 1 };
    this.flashlightOn = false;

    // --- assists ------------------------------------------------------------
    /**
     * 0 on a mouse, 1 on a thumb. Everything forgiving is multiplied by this, so
     * the assists are literally not running for a player who does not need them.
     */
    this.assist = 0;
    this._ledgeCooldown = 0;

    // --- frame bookkeeping --------------------------------------------------
    this._acc = 0;
    this._alpha = 0;
    this.time = 0;
    this._latched = { jump: false, toggleView: false, interact: false, scan: false, vehicle: false, flashlight: false };
    this._poseFade = { t: 0, dur: 0, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 70 };
    this._zoom = 0;

    this._bindMotor();
    this._buildFlashlight(opts);

    const spawn = opts.spawn;
    this.teleport(spawn || _v0.set(0, 0, 0));
  }

  // ---------------------------------------------------------------------------
  // Wiring.
  // ---------------------------------------------------------------------------

  /**
   * The motor is the only thing that knows a foot actually touched something, so
   * every consequence of contact hangs off its events rather than off a poll.
   * Dust that is spawned by a timer is dust that keeps falling while you stand
   * still, and everybody has seen that game.
   */
  _bindMotor() {
    const loco = this.locomotion;

    loco.on('footstep', (e) => {
      // Use the rig's own planted foot when the body is visible: the IK solver
      // put it somewhere specific and the dust belongs at that exact spot, not
      // under the capsule's centreline.
      const foot = this.rig && this.cameraRig.bodyVisible ? this.rig.footWorld(e.foot, _v0) : _v0.copy(e.position);
      this.fx.footstep(foot, e.normal, {
        speed: e.speed,
        surface: e.surface,
        gravity: this.world.gravity,
        up: this.up,
        velocity: loco.velocity,
        yaw: this.cameraRig.yaw,
      });
      this.audio?.playSfx?.('footstep', { surface: e.surface?.material, speed: e.speed, foot: e.foot });
      this.emit('footstep', e);
    });

    loco.on('land', (e) => {
      this.cameraRig.land(e.impact);
      this.rig.land(e.impact);
      this.fx.impact(e.position, e.normal, e.impact, {
        surface: e.surface,
        gravity: this.world.gravity,
        up: this.up,
      });
      this.audio?.playSfx?.('land', { impact: e.impact, surface: e.surface?.material });
      // A landing ends whatever chain was running unless you immediately keep
      // going, which `_updateFlow` decides on the next tick.
      this.emit('land', e);
    });

    loco.on('jump', (e) => {
      this.cameraRig.jump(e.impulse);
      this.rig.jump(e.impulse);
      this._flowLink('jump');
      this.audio?.playSfx?.('jump', { impulse: e.impulse });
      this.emit('jump', e);
    });

    loco.on('slideStart', (e) => {
      this._flowLink('slide');
      this.audio?.playSfx?.('slide', { speed: e.speed, surface: e.surface?.material });
      this.emit('slideStart', e);
    });
    loco.on('slideEnd', (e) => this.emit('slideEnd', e));
    loco.on('state', (now, prev) => this.emit('state', now, prev));
  }

  /**
   * A helmet lamp, parented to the head so it looks where you look. One spot,
   * not two: a second light doubles the per-fragment cost of every surface in
   * front of the player and buys a highlight nobody notices.
   */
  _buildFlashlight(opts) {
    if (opts.flashlight === false) {
      this.flashlight = null;
      return;
    }
    const light = new THREE.SpotLight(0xf2f6ff, 0, 46, 0.46, 0.42, 1.6);
    light.castShadow = false; // a shadow-casting torch is a whole extra pass
    light.position.set(0, 0, 0.06);
    const target = new THREE.Object3D();
    target.position.set(0, 0, 6);
    this.rig.lampNode.add(light, target);
    light.target = target;
    this.flashlight = light;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle.
  // ---------------------------------------------------------------------------

  setWorld(world) {
    this.world = world;
    this.locomotion.setWorld(world);
    this.vehicles.setWorld(world);
  }

  /** Put the body somewhere. Drops it onto the terrain and resets the camera. */
  teleport(pos, keepVelocity = false) {
    this.locomotion.teleport(pos, keepVelocity);
    this.up.copy(this.world.up(this.locomotion.position)).normalize();
    this.renderPosition.copy(this.locomotion.position);
    this.locomotion.eyePosition(this.eye);
    this.cameraRig.reset(this._cameraState(FIXED));
    this.rig.update(FIXED, this._rigState(FIXED));
    return this;
  }

  /** Face a direction, in radians of yaw about the local up. */
  setAim(yaw, pitch = 0) {
    this.cameraRig.setAim(yaw, pitch);
    return this;
  }

  setView(view, animate = true) {
    this.cameraRig.setView(view, animate);
    this.view = this.cameraRig.view;
    return this;
  }

  toggleView() {
    this.view = this.cameraRig.toggleView();
    this.emit('view', this.view);
    return this.view;
  }

  // ---------------------------------------------------------------------------
  // The frame.
  // ---------------------------------------------------------------------------

  /**
   * @param {number} dt wall-clock seconds since the last presented frame
   * @param {number} time wall-clock seconds since boot, for shader phases
   */
  update(dt, time = this.time + dt) {
    if (!this.enabled) return;
    this.time = time;

    this._readInput(dt);

    // Fixed-step catch-up. `dt` is clamped before it enters the accumulator so a
    // pathological frame cannot produce a hundred ticks and a visible lurch.
    this._acc += clamp(dt, 0, MAX_STEPS * FIXED);
    let steps = 0;
    while (this._acc >= FIXED && steps < MAX_STEPS) {
      this._fixedStep(FIXED);
      this._acc -= FIXED;
      steps++;
    }
    if (steps === MAX_STEPS) this._acc = 0; // drop the backlog rather than chase it
    this._alpha = clamp(this._acc / FIXED, 0, 1);

    this._present(dt, this._alpha, time);
    this._updateContextActions();
  }

  // --- input -----------------------------------------------------------------

  /**
   * Drain the input layer exactly once per presented frame.
   *
   * Edges are latched rather than read inside the fixed loop: a frame that runs
   * four ticks must not see `jump` pressed four times, and a frame that runs
   * zero ticks must not lose it. The latch is cleared by whichever tick consumes
   * it, and survives a zero-tick frame untouched.
   */
  _readInput(dt) {
    const input = this.input;
    if (!input) return;

    const kind = input.lastInputKind || 'kbm';
    this.lookKind = kind;
    // The assist strength is the device, not a setting. A thumb on glass has
    // roughly a tenth of the angular precision of a mouse; a stick has a third.
    const wantAssist = kind === 'touch' ? 1 : kind === 'gamepad' ? 0.62 : 0;
    this.assist = damp(this.assist, wantAssist, 6, dt);

    // Sticky aim. Only ever a *slow-down* near something you are already close
    // to pointing at — never a pull, because a camera that moves on its own is
    // a camera the player is fighting.
    let lookScale = 1;
    if (this.assist > 0.01 && this.focus && this.focus.angle !== undefined) {
      const near = 1 - saturate(this.focus.angle / this.p.stickyAngle);
      lookScale = lerp(1, this.p.stickyAim, near * this.assist);
    }
    this.cameraRig.lookScale = lookScale;

    if (input.look && (input.look.x || input.look.y)) {
      this.cameraRig.addLook(input.look.x, input.look.y, kind);
    }

    // Zoom is a hold, and it is a lens change rather than a magic scope, so it
    // lives on the camera and slows the aim in proportion.
    const zooming = input.down('zoom') || (this.mode === 'foot' && input.down('secondary'));
    this._zoom = damp(this._zoom, zooming ? 1 : 0, 8, dt);

    const L = this._latched;
    if (input.pressed('jump')) L.jump = true;
    if (input.pressed('toggleView')) L.toggleView = true;
    if (input.pressed('interact')) L.interact = true;
    if (input.pressed('scan')) L.scan = true;
    if (input.pressed('vehicle')) L.vehicle = true;
    if (input.pressed('flashlight')) L.flashlight = true;

    // Frame-scoped verbs — nothing about them wants to be inside the physics
    // loop, so they are handled here where they happen exactly once.
    if (L.toggleView) { L.toggleView = false; this.toggleView(); }
    if (L.flashlight) { L.flashlight = false; this.setFlashlight(!this.flashlightOn); }
    if (L.scan) { L.scan = false; this.doScan(); }
    if (L.interact) { L.interact = false; this.doInteract(); }
    if (L.vehicle) { L.vehicle = false; this.mode === 'vehicle' ? this.exitVehicle() : this.enterVehicle(); }
  }

  // --- fixed step ------------------------------------------------------------

  _fixedStep(dt) {
    this._scanCooldown = Math.max(0, this._scanCooldown - dt);
    this._ledgeCooldown = Math.max(0, this._ledgeCooldown - dt);
    this.flow.since += dt;

    if (this.mode === 'vehicle') this._stepVehicle(dt);
    else this._stepFoot(dt);

    this.vehicles.step(dt, this.locomotion.position, this.vehicle, this.vcmd);
    this._updateFlow(dt);
  }

  _stepFoot(dt) {
    const input = this.input;
    const loco = this.locomotion;
    const cmd = this.cmd;

    this.up.copy(this.world.up(loco.position)).normalize();

    // --- intent -------------------------------------------------------------
    const mx = input?.move?.x ?? 0;
    const my = input?.move?.y ?? 0;
    this.cameraRig.groundForward(this.up, _fwd);
    this.cameraRig.basis(this.up, _v1, _right);
    cmd.wish.copy(_fwd).multiplyScalar(my).addScaledVector(_right, mx);
    // The stick already lives in a disc, but a keyboard diagonal is length
    // sqrt(2) and would sprint faster than a keyboard straight line.
    const wl = cmd.wish.length();
    if (wl > 1) cmd.wish.multiplyScalar(1 / wl);
    cmd.forward = my;
    cmd.strafe = mx;

    cmd.sprint = !!input?.down('sprint') || (input?.analog('sprint') ?? 0) > 0.5;
    cmd.crouch = !!input?.down('crouch');
    cmd.stepAssist = this.assist > 0.35;

    // Jump. The latch is consumed by the first tick after the press, which is
    // what makes the buffer window in the motor mean what it says.
    cmd.jump = this._latched.jump;
    this._latched.jump = false;
    cmd.jumpHeld = !!input?.down('jump');

    // --- jetpack ------------------------------------------------------------
    // Two ways to light it, both reachable without leaving the movement hand:
    // the dedicated boost key, or re-pressing jump once you are already in the
    // air. The second is what makes the flow chain playable with one thumb, and
    // requiring the release is what stops a held jump from lighting it at
    // take-off and eating the whole tank on a hop.
    const rejump = !loco.grounded && cmd.jumpHeld && loco.releasedSinceJump && loco.timeSinceJump > 0.12;
    const wantJet =
      (!!input?.down('boost') || !!input?.down('jetpack') || rejump) && !loco.grounded;
    const jet = this.jetpack.update(dt, {
      want: wantJet,
      hoverHold: !!input?.down('crouch'),
      grounded: loco.grounded,
      gravity: this.world.gravity,
      up: this.up,
      velocity: loco.velocity,
      wish: cmd.wish,
      timeSinceJump: loco.timeSinceJump,
    });
    cmd.jetThrust.copy(jet);
    cmd.jetting = this.jetpack.active;
    if (this.jetpack.justLit) this._flowLink('boost');
    if (this.jetpack.justEmptied) this.emit('fuelEmpty');

    // --- assists ------------------------------------------------------------
    this._ledgeAssist(dt, cmd);

    // --- integrate ----------------------------------------------------------
    loco.step(dt, cmd);

    this.vitals.fuel = this.jetpack.fuelFraction;
  }

  /**
   * Ledge snap.
   *
   * The failure this fixes is specific: you jump at a shelf, you clear it by a
   * hand's width in your head and by minus five centimetres in the simulation,
   * and the body slides back down the face. On a mouse that is your mistake and
   * you take it. On a thumbstick it is the control scheme's mistake, so a body
   * that is falling *toward* a walkable lip within a knee's reach gets exactly
   * enough impulse to arrive on top of it — never more, so it can never read as
   * a launch, and once per landing, so it can never be pumped.
   */
  _ledgeAssist(dt, cmd) {
    const loco = this.locomotion;
    if (this.assist <= 0.05 || loco.grounded || this._ledgeCooldown > 0) return;

    const vUp = loco.velocity.dot(this.up);
    if (vUp > 0.4 || vUp < -11) return; // only near the apex and on a soft fall

    _v0.copy(loco.velocity).addScaledVector(this.up, -vUp);
    const speed = _v0.length();
    if (speed < 1.2) return; // you must be going somewhere for this to be a save
    _v0.multiplyScalar(1 / speed);

    const reach = loco.p.radius + 0.42;
    const px = loco.position.x + _v0.x * reach;
    const pz = loco.position.z + _v0.z * reach;
    const lip = this.world.sampleHeight(px, pz);
    _v1.set(px, lip, pz);
    const rise = _v2.subVectors(_v1, loco.position).dot(this.up);
    if (rise < 0.06 || rise > this.p.ledgeReach * (0.5 + 0.5 * this.assist)) return;

    // Only help onto ground you could have stood on anyway.
    const n = this.world.sampleNormal(px, pz);
    if (_v2.set(n.x, n.y, n.z).normalize().dot(this.up) < Math.cos(loco.p.slopeLimit)) return;

    // Exactly the vertical speed that reaches the lip plus a two-centimetre
    // margin, minus whatever you already had. Solved, not guessed.
    const g = this.world.gravity;
    const need = Math.sqrt(2 * g * (rise + 0.02));
    if (need > vUp) cmd.externalImpulse.addScaledVector(this.up, need - vUp);
    this._ledgeCooldown = this.p.ledgeCooldown;
    this.emit('ledgeAssist', rise);
  }

  // --- flow ------------------------------------------------------------------

  /**
   * Record a link in the traversal chain.
   *
   * The order is fixed — sprint, slide, jump, boost — because that is the loop
   * the motor and the pack were tuned around. A link only counts if it follows
   * its predecessor inside the window, so a jump out of a standing start is a
   * jump and a jump out of a slide is the third beat of something.
   */
  _flowLink(kind) {
    const f = this.flow;
    const fresh = f.since <= this.p.flowWindow;
    const order = { sprint: 1, slide: 2, jump: 3, boost: 4 };
    const want = order[kind] || 0;

    if (fresh && want === f.links + 1) f.links = want;
    else if (want === 1) f.links = 1;
    else f.links = Math.max(1, want === 3 && f.links >= 1 ? f.links + 1 : 1);

    f.label = kind;
    f.since = 0;
    f.best = Math.max(f.best, f.links);

    // Pay the chain out on its final link, as speed rather than as a number on
    // the screen. Seven per cent is under the threshold where it reads as a
    // boost and over the threshold where the hands notice the exit is faster.
    if (f.links >= 4) {
      const vUp = this.locomotion.velocity.dot(this.up);
      _v0.copy(this.locomotion.velocity).addScaledVector(this.up, -vUp);
      this.locomotion.velocity.copy(_v0.multiplyScalar(1 + this.p.flowPayout)).addScaledVector(this.up, vUp);
      this.cameraRig.shake(0.06, 0.22, 26);
    }
    if (f.links > 1) this.emit('flow', f.links, kind);
  }

  _updateFlow(dt) {
    const f = this.flow;
    const loco = this.locomotion;
    // Sprinting on the ground is the entry condition, and it re-arms every tick
    // it is true so you never have to time the first link.
    if (this.mode === 'foot' && loco.grounded && loco.sprinting && f.links === 0) {
      f.links = 1;
      f.label = 'sprint';
      f.since = 0;
    }
    // The chain dies when you stop, land flat, or simply wait too long.
    const stalled = f.since > this.p.flowWindow * 1.6;
    const stopped = this.mode === 'foot' && loco.grounded && !loco.sliding && loco.tangentSpeed < loco.p.walkSpeed * 0.6;
    if (f.links > 0 && (stalled || stopped)) {
      f.links = 0;
      f.label = 'idle';
    }
    f.timer = f.links > 0 ? f.timer + dt : 0;
  }

  // --- vehicles --------------------------------------------------------------

  _stepVehicle(dt) {
    const input = this.input;
    const v = this.vehicle;
    const c = this.vcmd;
    if (!v) return;

    c.dt = dt;
    c.throttle = input?.move?.y ?? 0;
    c.steer = input?.move?.x ?? 0;
    c.brake = clamp(input?.analog('brake') ?? (input?.down('crouch') ? 1 : 0), 0, 1);
    c.handbrake = !!input?.down('jump') && v.kind !== 'starship';
    c.boost = !!input?.down('boost');
    c.lift = (input?.down('jump') ? 1 : 0) - (input?.down('crouch') ? 1 : 0);
    c.strafe = 0;
    c.roll = (input?.down('rollLeft') ? 1 : 0) - (input?.down('rollRight') ? 1 : 0);

    // The ship flies on the look axis, so it reads pitch and yaw off how far the
    // aim has been pushed from centre rather than off a second stick nobody has.
    if (v.flightControls) {
      const rig = this.cameraRig;
      c.pitch = clamp(rig.freePitch / (45 * DEG), -1, 1);
      c.yaw = clamp(rig.freeYaw / (45 * DEG), -1, 1);
      c.strafe = input?.move?.x ?? 0;
      c.steer = 0;
    } else {
      c.pitch = 0;
      c.yaw = 0;
    }

    c.gear = !!input?.pressed('slot1');
    c.damping = !!input?.pressed('slot2');
    c.land = !!input?.pressed('land');
    c.lights = !!input?.pressed('flashlight');

    // The body rides along. Keeping the motor's position glued to the vehicle
    // means dismounting anywhere is just a teleport, and anything that reads
    // `player.position` keeps working while you drive.
    this.locomotion.position.copy(v.position);
    this.locomotion.prevPosition.copy(v.body.prevPosition);
    this.locomotion.velocity.copy(v.velocity);
    this.up.copy(this.world.up(v.position)).normalize();
  }

  /**
   * Board the nearest vehicle, or a specific one.
   *
   * Momentum is handed over rather than zeroed in both directions: you can jump
   * onto a rolling rover, and stepping out of a moving one puts you on the
   * ground still moving. Stopping the world to play an animation is the single
   * most common way a vehicle system announces that it is a menu.
   */
  enterVehicle(target = null) {
    if (this.mode === 'vehicle') return false;
    const v = target || this.vehicles.nearest(this.locomotion.position, this.p.boardRange, this.cameraRig.forwardVec);
    if (!v || !v.mount(this)) return false;

    this._captureCameraPose();
    this.vehicle = v;
    this.mode = 'vehicle';
    this.rig.setVisible(false);
    this.rig.setFirstPerson(false);
    this.jetpack.throttle = 0;
    this.cameraRig.freeYaw = 0;
    this.cameraRig.freePitch = 0;
    this.cameraRig._pivotValid = false;
    this.flow.links = 0;
    this.emit('mount', v);
    this.audio?.playSfx?.('vehicleEnter', { kind: v.kind });
    return true;
  }

  exitVehicle() {
    if (this.mode !== 'vehicle' || !this.vehicle) return false;
    const v = this.vehicle;
    // Refuse to eject at speed rather than dropping a body at 40 m/s and calling
    // it physics — the answer to "can I get out now" should be legible.
    if (v.canDismount && !v.canDismount()) {
      this.emit('dismountRefused', v);
      return false;
    }

    this._captureCameraPose();
    v.exitPoint(_v0);
    v.dismount();
    this.vehicle = null;
    this.mode = 'foot';

    this.locomotion.teleport(_v0, false);
    // Keep the horizontal share of the vehicle's motion; drop the vertical, so
    // stepping off a hovering bike is a step and not a fall with extra speed.
    _v1.copy(v.velocity);
    const vUp = _v1.dot(this.up);
    _v1.addScaledVector(this.up, -vUp);
    this.locomotion.velocity.copy(_v1.multiplyScalar(0.65));

    this.rig.setVisible(true);
    this.cameraRig._pivotValid = false;
    this.emit('dismount', v);
    this.audio?.playSfx?.('vehicleExit', { kind: v.kind });
    return true;
  }

  /**
   * Remember where the lens was, so the swap into or out of a cockpit is a move
   * rather than a cut. The stored pose is static in world space while the target
   * pose keeps living, which is exactly the shape of a camera flying to a seat.
   */
  _captureCameraPose() {
    const f = this._poseFade;
    f.pos.copy(this.camera.position);
    f.quat.copy(this.camera.quaternion);
    f.fov = this.camera.fov;
    f.dur = this.p.mountFade;
    f.t = 0;
  }

  // --- interaction -----------------------------------------------------------

  /**
   * What the reticle is on.
   *
   * Scored by angle first and distance second, because a player aiming at a
   * console two metres away past a crate one metre away means the console. The
   * cone is generous on touch for the same reason the aim is sticky there.
   */
  _updateFocus() {
    const origin = this.eye;
    const dir = this.cameraRig.forwardVec;
    const cone = this.p.interactCone * (1 + this.assist * 0.6);
    let best = null;
    let bestScore = Infinity;

    const consider = (obj, position, range, kind) => {
      _v0.subVectors(position, origin);
      const dist = _v0.length();
      if (dist > range) return;
      if (dist > 1e-4) _v0.multiplyScalar(1 / dist);
      const cos = clamp(_v0.dot(dir), -1, 1);
      const angle = Math.acos(cos);
      const radius = obj.radius ?? 0.6;
      // Big things forgive a wider miss without needing a bigger cone.
      const slack = Math.atan2(radius, Math.max(dist, 0.25));
      if (angle - slack > cone) return;
      const score = Math.max(0, angle - slack) * 4 + dist * 0.12;
      if (score < bestScore) {
        bestScore = score;
        best = { kind, object: obj, distance: dist, angle: Math.max(0, angle - slack), position };
      }
    };

    for (const it of this.interactables) {
      if (it.enabled === false) continue;
      consider(it, it.position, it.range ?? this.p.interactRange, 'object');
    }
    if (this.mode === 'foot') {
      for (const v of this.vehicles.list) {
        if (v.mounted) continue;
        consider(
          { radius: v.boardRadius ?? 2.2, label: v.label, icon: v.icon, id: 'vehicle' },
          v.position,
          this.p.boardRange,
          'vehicle'
        );
        if (best && best.kind === 'vehicle') best.vehicle = v;
      }
    }

    // Only re-point the vehicle reference when the winner really is a vehicle.
    if (best && best.kind === 'vehicle' && !best.vehicle) {
      best.vehicle = this.vehicles.nearest(this.locomotion.position, this.p.boardRange, dir);
    }
    this.focus = best;
    return best;
  }

  /** Press whatever the reticle is on. Returns true if anything happened. */
  doInteract() {
    const f = this.focus;
    if (!f) return false;
    if (f.kind === 'vehicle') return this.enterVehicle(f.vehicle);
    const obj = f.object;
    obj.onInteract?.(this, obj);
    this.emit('interact', obj);
    this.audio?.playSfx?.('interact', { id: obj.id });
    return true;
  }

  /**
   * The scan ping.
   *
   * The wavefront is presentation — a radius that grows and a shader uniform
   * anyone can read. The *results* are gathered on the frame the ping is fired,
   * so what the pulse reveals is what was there when you pressed it rather than
   * whatever happened to be in range when the ring arrived.
   */
  doScan() {
    if (this._scanCooldown > 0) return false;
    this._scanCooldown = this.p.scanCooldown;
    const s = this.scan;
    s.active = true;
    s.t = 0;
    s.radius = 0;
    s.origin.copy(this.eye);
    s.results.length = 0;

    const r2 = this.p.scanRange * this.p.scanRange;
    for (const it of this.interactables) {
      if (it.position.distanceToSquared(s.origin) < r2) s.results.push(it);
    }
    for (const v of this.vehicles.list) {
      if (v.position.distanceToSquared(s.origin) < r2) s.results.push(v);
    }
    this.cameraRig.shake(0.04, 0.18, 30);
    this.emit('scan', s);
    this.audio?.playSfx?.('scan', { count: s.results.length });
    return true;
  }

  setFlashlight(on) {
    this.flashlightOn = !!on;
    this.emit('flashlight', this.flashlightOn);
    return this.flashlightOn;
  }

  // --- presentation ----------------------------------------------------------

  /**
   * Everything downstream of the physics, on wall-clock dt.
   *
   * The order matters and is not arbitrary: interpolate the body, then focus off
   * the previous frame's aim, then camera (which needs the body), then the
   * skeleton (which needs the aim), then effects (which need the skeleton).
   */
  _present(dt, alpha, time) {
    const loco = this.locomotion;

    if (this.mode === 'vehicle' && this.vehicle) {
      this.renderPosition.copy(this.vehicle.group.position);
      this.eye.copy(this.renderPosition);
    } else {
      this.renderPosition.lerpVectors(loco.prevPosition, loco.position, alpha);
      _feet.copy(this.renderPosition);
      this.eye.copy(_feet).addScaledVector(this.up, loco.eyeHeight);
    }

    this._updateFocus();

    const state = this._cameraState(dt);
    this.cameraRig.update(dt, state);
    this.view = this.cameraRig.view;
    this._applyPoseFade(dt);

    // The body is hidden in first person but not deleted: the rig still solves,
    // because the moment you toggle the view it has to already be somewhere
    // sensible, and because the arms and boots are visible looking down.
    const showBody = this.mode === 'foot';
    this.rig.setVisible(showBody);
    if (showBody) {
      this.rig.setFirstPerson(!this.cameraRig.bodyVisible);
      this.rig.update(dt, this._rigState(dt));
    }

    this._presentJetpack(dt, time);
    this._presentScan(dt);
    this._presentFlashlight(dt);

    this.vehicles.interpolate(alpha);
    this.vehicles.updateFX(dt, time);
    this.fx.update(dt, this.ctx.engine?.height);
  }

  _presentJetpack(dt, time) {
    this.jetpack.updateFX(dt, time);
    if (this.mode !== 'foot') return;
    // Ground wash: only when the plume can actually reach the surface. Two body
    // heights is where the effect stops being visible anyway, so the check is
    // free realism rather than a limit.
    const loco = this.locomotion;
    if (this.jetpack.throttle > 0.15 && loco.heightAboveGround < 3.5) {
      _v0.set(loco.position.x, this.world.sampleHeight(loco.position.x, loco.position.z), loco.position.z);
      this.jetpack.washInto(this.fx, _v0, loco.groundNormal, loco.surface, this.world.gravity, this.up, dt);
    }
    // A slide is a continuous scrape, so it emits continuously — the only place
    // in the subsystem where an effect is not tied to a discrete event, because
    // the physical thing it represents is not discrete either.
    if (loco.sliding) {
      this.fx.scuff(loco.position, loco.groundNormal, dt, {
        surface: loco.surface,
        gravity: this.world.gravity,
        up: this.up,
        velocity: loco.velocity,
        intensity: saturate(loco.tangentSpeed / loco.p.runSpeed) * 1.5,
      });
    }
  }

  _presentScan(dt) {
    const s = this.scan;
    if (!s.active) return;
    s.t += dt;
    // Constant wavefront speed, so distance on screen is distance in the world
    // and the ping doubles as a rangefinder.
    s.radius = (s.t / s.duration) * this.p.scanRange;
    if (s.t >= s.duration) {
      s.active = false;
      s.radius = 0;
    }
  }

  _presentFlashlight(dt) {
    if (!this.flashlight) return;
    const want = this.flashlightOn && this.mode === 'foot' ? 26 : 0;
    // Ramped rather than switched: a lamp that reaches full output instantly
    // reads as a UI element, and the ramp costs nothing.
    this.flashlight.intensity = damp(this.flashlight.intensity, want, 12, dt);
    this.flashlight.visible = this.flashlight.intensity > 0.02;
  }

  /**
   * Blend out of the pose captured at a mount or dismount.
   *
   * Applied *after* the rig has written the camera, so the rig never has to know
   * this exists and the eased result is always converging on a live pose rather
   * than on a scripted destination that may have moved.
   */
  _applyPoseFade(dt) {
    const f = this._poseFade;
    if (f.dur <= 0) return;
    f.t += dt;
    const k = f.t / f.dur;
    if (k >= 1) {
      f.dur = 0;
      return;
    }
    const e = smootherstep(0, 1, k);
    this.camera.position.lerpVectors(f.pos, this.camera.position, e);
    _q0.copy(f.quat).slerp(this.camera.quaternion, e);
    this.camera.quaternion.copy(_q0);
    if (this.cameraRig.controlFov) {
      this.camera.fov = lerp(f.fov, this.camera.fov, e);
      this.camera.updateProjectionMatrix();
    }
    this.cameraRig.position.copy(this.camera.position);
    this.cameraRig.quaternion.copy(this.camera.quaternion);
    this.cameraRig.forwardVec.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
  }

  // --- state structs ---------------------------------------------------------

  _cameraState(dt) {
    const loco = this.locomotion;
    const v = this.vehicle;
    const s = this._camState || (this._camState = {});
    s.up = this.up;
    s.eye = this.eye;
    s.position = this.renderPosition;
    s.velocity = loco.velocity;
    s.speed = this.mode === 'vehicle' && v ? v.speed : loco.tangentSpeed;
    s.maxSpeed = loco.p.runSpeed;
    s.grounded = loco.grounded;
    s.stridePhase = loco.stridePhase;
    s.strafe = this.cmd.strafe;
    s.forward = this.cmd.forward;
    s.crouch = saturate((loco.p.standHeight - loco.capsuleHeight) / (loco.p.standHeight - loco.p.crouchHeight));
    s.slide = loco.sliding ? 1 : 0;
    s.boost = this.mode === 'vehicle' && v ? v.boostLevel : this.jetpack.throttle;
    s.stepOffset = loco.stepOffset;
    s.world = this.world;
    s.settings = this.settings;
    s.lookKind = this.lookKind;
    s.assist = this.assist;
    s.zoom = this._zoom;
    s.focusOverride = this.focus ? this.focus.distance : 0;
    s.vehicle = this.mode === 'vehicle' ? v : null;
    return s;
  }

  _rigState(dt) {
    const s = this._rigStateObj || (this._rigStateObj = {});
    s.position = this.renderPosition;
    s.up = this.up;
    s.aimYaw = this.cameraRig.yaw;
    s.aimPitch = this.cameraRig.pitch;
    s.velocity = this.locomotion.velocity;
    s.world = this.world;
    s.locomotion = this.locomotion;
    s.jetting = this.jetpack.active;
    return s;
  }

  // --- context actions -------------------------------------------------------

  /**
   * The verbs currently available, in priority order.
   *
   * The same array drives the desktop key-cap column and the touch thumb pad, so
   * it is capped at five: more than five buttons under a thumb is a menu, and a
   * menu is not a control scheme. The list is only rebuilt when its signature
   * changes, because the HUD diffs it and an array that is new every frame makes
   * that diff pointless.
   */
  _updateContextActions() {
    const out = this._actionScratch || (this._actionScratch = []);
    out.length = 0;

    if (this.mode === 'vehicle' && this.vehicle) {
      const list = this.vehicle.contextActions();
      for (const a of list) out.push(a);
    } else {
      const f = this.focus;
      if (f && f.kind === 'object') {
        out.push({
          id: 'interact',
          label: f.object.label || 'Use',
          key: 'E',
          icon: f.object.icon || '◇',
          enabled: f.object.enabled !== false,
        });
      } else if (f && f.kind === 'vehicle' && f.vehicle) {
        out.push({
          id: 'vehicle',
          label: `Board ${f.vehicle.label}`,
          key: 'B',
          icon: f.vehicle.icon || '⬡',
          enabled: true,
        });
      }
      out.push({ id: 'jump', label: 'Jump', key: '␣', icon: '△', enabled: true });
      out.push({
        id: 'jetpack',
        label: this.jetpack.active ? 'Boosting' : 'Jetpack',
        key: 'X',
        icon: '⌁',
        enabled: this.jetpack.available && !this.locomotion.grounded,
      });
      out.push({ id: 'scan', label: 'Scan', key: 'G', icon: '◎', enabled: this._scanCooldown <= 0 });
      out.push({ id: 'toggleView', label: this.view === 'first' ? 'Third person' : 'First person', key: 'V', icon: '⧉', enabled: true });
    }

    if (out.length > 5) out.length = 5;

    let sig = '';
    for (const a of out) sig += `${a.id}:${a.label}:${a.enabled === false ? 0 : 1}|`;
    if (sig === this._actionSig) return;
    this._actionSig = sig;
    this.contextActions = out.slice();
    if (this.driveHud) this.hud?.setContextActions?.(this.contextActions);
    this.emit('actions', this.contextActions);
  }

  // ---------------------------------------------------------------------------

  /** Hand the HUD its bars. Kept here so the caller has one thing to call. */
  hudVitals() {
    const v = this.vitals;
    if (this.mode === 'vehicle' && this.vehicle) {
      v.fuel = this.vehicle.fuelFraction ?? 1;
      v.integrity = this.vehicle.integrity ?? 1;
    } else {
      v.fuel = this.jetpack.fuelFraction;
      v.integrity = undefined;
    }
    return v;
  }

  dispose() {
    this.fx.dispose();
    this.jetpack.dispose();
    this.rig.dispose();
    this.vehicles.dispose();
    this.group.parent?.remove(this.group);
  }
}

export default PlayerController;
