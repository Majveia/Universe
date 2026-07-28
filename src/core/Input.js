/**
 * Unified input: keyboard + mouse, touch, and gamepad, funnelled into a small
 * set of named actions and axes.
 *
 * Gameplay code never asks "was W pressed" — it asks for the `move` axis. That
 * is what lets the same controller code drive a phone with two thumbs, a
 * desktop with pointer lock, and a gamepad without branching everywhere.
 *
 * Touch model (the part that has to feel invisible):
 *   - Left ~45% of the screen is a *floating* stick. It materialises where the
 *     thumb lands rather than at a fixed rosette, so you never have to look
 *     down to find it.
 *   - Right side is look. Drag to aim; a quick tap (< 220ms, < 12px) is the
 *     primary action, so shooting/interacting costs no extra UI.
 *   - Pinch is zoom/throttle depending on context.
 */

import { settings } from './Settings.js';
import { clamp, damp } from './Noise.js';

const KEY_ACTIONS = {
  KeyW: 'fwd', ArrowUp: 'fwd',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
  ControlLeft: 'crouch', ControlRight: 'crouch', KeyC: 'crouch',
  KeyE: 'interact',
  KeyF: 'flashlight',
  KeyQ: 'rollLeft',
  KeyR: 'rollRight',
  KeyV: 'toggleView',
  KeyM: 'map',
  KeyJ: 'journal',
  Tab: 'codex',
  KeyG: 'scan',
  KeyH: 'hud',
  KeyP: 'photo',
  KeyZ: 'zoom',
  KeyX: 'boost',
  KeyT: 'timeWarp',
  Escape: 'pause',
  Enter: 'confirm',
  Backquote: 'debug',
  KeyL: 'land',
  KeyB: 'vehicle',
  Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3', Digit4: 'slot4', Digit5: 'slot5',
};

class Axis2 {
  constructor() { this.x = 0; this.y = 0; }
  set(x, y) { this.x = x; this.y = y; return this; }
  zero() { this.x = 0; this.y = 0; return this; }
  get length() { return Math.hypot(this.x, this.y); }
  clampUnit() {
    const l = this.length;
    if (l > 1) { this.x /= l; this.y /= l; }
    return this;
  }
}

export class Input {
  constructor(domElement) {
    this.dom = domElement;
    this.enabled = true;

    this.move = new Axis2();       // -1..1, y forward
    this.look = new Axis2();       // per-frame delta in radians-ish
    this.lookRaw = new Axis2();    // accumulator drained each frame
    this.scroll = 0;
    this.pinch = 0;

    this._down = new Set();
    this._pressedThisFrame = new Set();
    this._releasedThisFrame = new Set();
    this._analog = new Map();      // action -> 0..1 (gamepad triggers, touch buttons)

    this.pointerLocked = false;
    this.usingTouch = false;
    this.usingGamepad = false;
    this.lastInputKind = settings.isTouch ? 'touch' : 'kbm';

    this._touches = new Map();
    this._moveTouch = null;
    this._lookTouch = null;
    this._pinchIds = null;
    this._pinchStart = 0;
    this._tapCandidate = null;

    // Exposed so the HUD can draw the floating stick exactly where the thumb is.
    this.stick = { active: false, ox: 0, oy: 0, x: 0, y: 0, radius: 64 };
    this.lookSwipe = { active: false, x: 0, y: 0 };

    this._smoothedLook = new Axis2();
    this._bind();
  }

  // --- queries --------------------------------------------------------------

  down(action) { return this._down.has(action); }
  pressed(action) { return this._pressedThisFrame.has(action); }
  released(action) { return this._releasedThisFrame.has(action); }
  analog(action) { return this._analog.get(action) ?? (this._down.has(action) ? 1 : 0); }

  /** Programmatic press — used by on-screen buttons. */
  virtualPress(action) {
    if (!this._down.has(action)) this._pressedThisFrame.add(action);
    this._down.add(action);
  }
  virtualRelease(action) {
    if (this._down.has(action)) this._releasedThisFrame.add(action);
    this._down.delete(action);
  }
  virtualTap(action) {
    this._pressedThisFrame.add(action);
    this._releasedThisFrame.add(action);
  }

  // --- frame lifecycle ------------------------------------------------------

  update(dt) {
    this._pollGamepad();

    // Keyboard -> move axis.
    if (!this.usingTouch || this._down.has('fwd') || this._down.has('back')) {
      let mx = 0, my = 0;
      if (this._down.has('fwd')) my += 1;
      if (this._down.has('back')) my -= 1;
      if (this._down.has('right')) mx += 1;
      if (this._down.has('left')) mx -= 1;
      if (mx || my || !this.usingTouch) {
        if (!this._padMove || (this._padMove.x === 0 && this._padMove.y === 0)) {
          if (!(this.usingTouch && this.stick.active)) this.move.set(mx, my).clampUnit();
        }
      }
    }
    if (this._padMove && (this._padMove.x !== 0 || this._padMove.y !== 0)) {
      this.move.set(this._padMove.x, this._padMove.y).clampUnit();
    }
    if (this.usingTouch && this.stick.active) {
      this.move.set(this.stick.x, this.stick.y).clampUnit();
    }

    // Look: mouse/touch deltas are impulses; gamepad is a rate.
    const sens = settings.sensitivity;
    let lx = this.lookRaw.x * sens;
    let ly = this.lookRaw.y * sens * (settings.invertY ? -1 : 1);
    if (this._padLook) {
      const padRate = 2.6 * dt * 60 * sens;
      lx += this._padLook.x * padRate;
      ly += this._padLook.y * padRate * (settings.invertY ? -1 : 1);
    }
    // A touch of smoothing removes pointer jitter without adding perceivable lag.
    const k = this.lastInputKind === 'gamepad' ? 28 : 45;
    this._smoothedLook.x = damp(this._smoothedLook.x, lx, k, dt);
    this._smoothedLook.y = damp(this._smoothedLook.y, ly, k, dt);
    this.look.set(this._smoothedLook.x, this._smoothedLook.y);
    this.lookRaw.zero();
  }

  /** Call after all consumers have read this frame. */
  endFrame() {
    this._pressedThisFrame.clear();
    this._releasedThisFrame.clear();
    this.scroll = 0;
    this.pinch = 0;
  }

  requestPointerLock() {
    if (settings.isTouch) return;
    this.dom.requestPointerLock?.();
  }
  exitPointerLock() {
    document.exitPointerLock?.();
  }

  // --- wiring ---------------------------------------------------------------

  _bind() {
    const dom = this.dom;

    this._onKeyDown = (e) => {
      if (!this.enabled) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const a = KEY_ACTIONS[e.code];
      if (!a) return;
      if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      this.lastInputKind = 'kbm';
      this.usingTouch = false;
      if (!this._down.has(a)) this._pressedThisFrame.add(a);
      this._down.add(a);
    };
    this._onKeyUp = (e) => {
      const a = KEY_ACTIONS[e.code];
      if (!a) return;
      if (this._down.has(a)) this._releasedThisFrame.add(a);
      this._down.delete(a);
    };
    this._onBlur = () => {
      for (const a of this._down) this._releasedThisFrame.add(a);
      this._down.clear();
      this.move.zero();
      this.stick.active = false;
    };

    this._onMouseMove = (e) => {
      if (!this.enabled) return;
      this.lastInputKind = 'kbm';
      if (this.pointerLocked) {
        this.lookRaw.x += e.movementX * 0.0022;
        this.lookRaw.y += e.movementY * 0.0022;
      } else if (this._dragging) {
        this.lookRaw.x += e.movementX * 0.0022;
        this.lookRaw.y += e.movementY * 0.0022;
      }
    };
    this._onMouseDown = (e) => {
      if (!this.enabled) return;
      if (e.button === 0) { this.virtualPress('primary'); this._dragging = !this.pointerLocked; }
      if (e.button === 2) this.virtualPress('secondary');
      if (e.button === 1) this.virtualPress('middle');
    };
    this._onMouseUp = (e) => {
      if (e.button === 0) { this.virtualRelease('primary'); this._dragging = false; }
      if (e.button === 2) this.virtualRelease('secondary');
      if (e.button === 1) this.virtualRelease('middle');
    };
    this._onWheel = (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.scroll += clamp(e.deltaY, -100, 100) * 0.01;
    };
    this._onContext = (e) => e.preventDefault();
    this._onLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.dom;
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('mousemove', this._onMouseMove);
    dom.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    dom.addEventListener('wheel', this._onWheel, { passive: false });
    dom.addEventListener('contextmenu', this._onContext);
    document.addEventListener('pointerlockchange', this._onLockChange);

    this._bindTouch();
  }

  _bindTouch() {
    const dom = this.dom;
    const stickRadius = () => Math.min(96, Math.max(56, Math.min(window.innerWidth, window.innerHeight) * 0.16));

    const onStart = (e) => {
      if (!this.enabled) return;
      this.usingTouch = true;
      this.lastInputKind = 'touch';
      for (const t of e.changedTouches) {
        const leftHalf = t.clientX < window.innerWidth * 0.45;
        if (leftHalf && this._moveTouch === null) {
          this._moveTouch = t.identifier;
          this.stick.active = true;
          this.stick.radius = stickRadius();
          this.stick.ox = t.clientX;
          this.stick.oy = t.clientY;
          this.stick.x = 0;
          this.stick.y = 0;
        } else if (this._lookTouch === null) {
          this._lookTouch = t.identifier;
          this.lookSwipe.active = true;
          this.lookSwipe.x = t.clientX;
          this.lookSwipe.y = t.clientY;
          this._tapCandidate = { id: t.identifier, t: performance.now(), x: t.clientX, y: t.clientY };
        }
        this._touches.set(t.identifier, { x: t.clientX, y: t.clientY });
      }
      if (this._touches.size === 2) {
        const ids = [...this._touches.keys()];
        this._pinchIds = ids;
        const a = this._touches.get(ids[0]);
        const b = this._touches.get(ids[1]);
        this._pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
      }
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!this.enabled) return;
      for (const t of e.changedTouches) {
        const prev = this._touches.get(t.identifier);
        if (!prev) continue;
        if (t.identifier === this._moveTouch) {
          const r = this.stick.radius;
          let dx = (t.clientX - this.stick.ox) / r;
          let dy = -(t.clientY - this.stick.oy) / r;
          const l = Math.hypot(dx, dy);
          if (l > 1) { dx /= l; dy /= l; }
          // Small dead zone so a resting thumb does not creep.
          const dead = 0.12;
          const mag = Math.hypot(dx, dy);
          if (mag < dead) { dx = 0; dy = 0; }
          else {
            const s = (mag - dead) / (1 - dead) / mag;
            dx *= s; dy *= s;
          }
          this.stick.x = dx;
          this.stick.y = dy;
        } else if (t.identifier === this._lookTouch) {
          this.lookRaw.x += (t.clientX - prev.x) * 0.0042;
          this.lookRaw.y += (t.clientY - prev.y) * 0.0042;
          this.lookSwipe.x = t.clientX;
          this.lookSwipe.y = t.clientY;
          if (this._tapCandidate && this._tapCandidate.id === t.identifier) {
            const d = Math.hypot(t.clientX - this._tapCandidate.x, t.clientY - this._tapCandidate.y);
            if (d > 12) this._tapCandidate = null;
          }
        }
        prev.x = t.clientX;
        prev.y = t.clientY;
      }
      if (this._pinchIds && this._touches.size >= 2) {
        const a = this._touches.get(this._pinchIds[0]);
        const b = this._touches.get(this._pinchIds[1]);
        if (a && b) {
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          this.pinch += (d - this._pinchStart) * 0.004;
          this._pinchStart = d;
        }
      }
      e.preventDefault();
    };

    const onEnd = (e) => {
      for (const t of e.changedTouches) {
        this._touches.delete(t.identifier);
        if (t.identifier === this._moveTouch) {
          this._moveTouch = null;
          this.stick.active = false;
          this.stick.x = 0;
          this.stick.y = 0;
          this.move.zero();
        }
        if (t.identifier === this._lookTouch) {
          this._lookTouch = null;
          this.lookSwipe.active = false;
          if (this._tapCandidate && this._tapCandidate.id === t.identifier) {
            if (performance.now() - this._tapCandidate.t < 220) this.virtualTap('primary');
          }
          this._tapCandidate = null;
        }
      }
      if (this._touches.size < 2) this._pinchIds = null;
      e.preventDefault();
    };

    dom.addEventListener('touchstart', onStart, { passive: false });
    dom.addEventListener('touchmove', onMove, { passive: false });
    dom.addEventListener('touchend', onEnd, { passive: false });
    dom.addEventListener('touchcancel', onEnd, { passive: false });
  }

  _pollGamepad() {
    if (!navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    let pad = null;
    for (const p of pads) if (p && p.connected) { pad = p; break; }
    if (!pad) { this._padMove = null; this._padLook = null; this.usingGamepad = false; return; }

    const dz = (v) => (Math.abs(v) < 0.16 ? 0 : (v - Math.sign(v) * 0.16) / 0.84);
    const lx = dz(pad.axes[0] || 0);
    const ly = dz(pad.axes[1] || 0);
    const rx = dz(pad.axes[2] || 0);
    const ry = dz(pad.axes[3] || 0);

    this._padMove = { x: lx, y: -ly };
    this._padLook = { x: rx, y: ry };
    if (lx || ly || rx || ry) {
      this.usingGamepad = true;
      this.lastInputKind = 'gamepad';
      this.usingTouch = false;
    }

    const btn = (i) => pad.buttons[i]?.pressed ?? false;
    const val = (i) => pad.buttons[i]?.value ?? 0;
    const mapBtn = (i, action) => {
      if (btn(i)) this.virtualPress(action);
      else this.virtualRelease(action);
    };
    mapBtn(0, 'jump');
    mapBtn(1, 'crouch');
    mapBtn(2, 'interact');
    mapBtn(3, 'toggleView');
    mapBtn(4, 'scan');
    mapBtn(5, 'boost');
    mapBtn(9, 'pause');
    mapBtn(8, 'codex');
    mapBtn(10, 'sprint');
    this._analog.set('brake', val(6));
    this._analog.set('throttle', val(7));
    if (val(7) > 0.4) this.virtualPress('primary'); else this.virtualRelease('primary');
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('pointerlockchange', this._onLockChange);
  }
}
