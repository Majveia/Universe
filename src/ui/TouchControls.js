/**
 * Touch controls.
 *
 * The design brief for this file is one sentence: you should be able to play
 * with your thumbs without ever looking at your thumbs.
 *
 * The stick is *drawn, not placed*. Input already implements a floating stick —
 * it materialises wherever the left thumb lands — and it publishes that
 * geometry on `input.stick`. This class does nothing but render that value.
 * That is the whole trick: a control that is a visualisation of the real input
 * state can never disagree with it, never drift, and never need to be dragged
 * back to a home position. A fixed rosette, by contrast, is a thing you have to
 * find, and finding it means looking down.
 *
 * The button cluster sits on a quarter arc swept around the bottom-right corner
 * because that is the arc a thumb actually travels. Each button is a 44px
 * target — the platform minimum, and non-negotiable — containing a 28px ring.
 * The finger gets the area; the eye gets the restraint.
 *
 * Two geometric invariants this file guarantees, and which `__demo.js` asserts:
 *
 *   1. No control's hit box ever intersects the centre 60% of the viewport
 *      (x ∈ [20%,80%], y ∈ [20%,80%]). That box is the picture.
 *   2. Every interactive element honours `env(safe-area-inset-*)`, so nothing
 *      lands under a home indicator or a rounded corner.
 *
 * Verified at 390×844 (iPhone portrait) and 1024×768 (tablet landscape); the
 * second is the tight one, because the cluster and the centre band are only
 * about forty pixels apart there. That is why the arc radius is 62 and not 80.
 */

const el = (tag, cls, parent) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
};

/**
 * Default glyphs. Deliberately restricted to geometric shapes that every
 * platform font ships — no emoji, no icon font, no SVG sprite sheet. A missing
 * glyph on a phone is a tofu box in the corner of an otherwise perfect frame.
 */
const GLYPHS = {
  primary: '●',
  interact: '◇',
  jump: '△',
  crouch: '▽',
  sprint: '≫',
  boost: '≫',
  scan: '◎',
  flashlight: '☀',
  land: '⤓',
  takeoff: '⤒',
  toggleView: '⧉',
  vehicle: '⬡',
  map: '◈',
  codex: '▤',
  photo: '▣',
  timeWarp: '≡',
  jetpack: '⌁',
  zoom: '⊕',
};

/** Arc angles (degrees, maths convention: 0 = right, CCW) by button count. */
const ARCS = {
  1: [150],
  2: [168, 118],
  3: [176, 137, 98],
  4: [178, 149, 121, 92],
};

const ARC_RADIUS = 62;      // thumb sweep; see the invariant note in the header
const ANCHOR_INSET = 30;    // centre of the primary button from the safe edge
const LABEL_HOLD = 2.8;     // seconds a changed action set announces itself

export class TouchControls {
  constructor(root, ctx) {
    this.ctx = ctx;
    this.input = ctx.input;
    this.audio = ctx.audio || null;

    this.root = el('div', 'touch-root', root);

    // --- floating stick ---------------------------------------------------
    this.stick = el('div', 'stick hud-chrome', this.root);
    this.stickRing = el('div', 'stick-ring', this.stick);
    this.stickKnob = el('div', 'stick-knob', this.stick);
    this._stickOn = false;
    this._stickRadius = -1;

    // --- button cluster ---------------------------------------------------
    this.pad = el('div', 'pad hud-chrome interactive', this.root);
    this.pad.setAttribute('role', 'group');
    this.pad.setAttribute('aria-label', 'Context actions');
    this.buttons = [];
    this._signature = '';
    this._labelTimer = 0;
    this._visible = false;
    this._enabled = true;

    this._onResize = () => this._placePad();
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);
    this._placePad();

    this.setActions([]);
  }

  /** Anchor the cluster inside the safe area. Read once per resize, not per frame. */
  _placePad() {
    const cs = getComputedStyle(document.documentElement);
    const safe = (name) => parseFloat(cs.getPropertyValue(name)) || 0;
    const r = safe('--safe-r');
    const b = safe('--safe-b');
    this.pad.style.transform =
      `translate3d(${-(r + ANCHOR_INSET)}px, ${-(b + ANCHOR_INSET)}px, 0)`;
  }

  /**
   * `actions` is `[{id, label, icon, enabled}]`. The first entry is treated as
   * primary and gets the larger ring at the thumb's rest position; the rest
   * fan out along the arc. More than five is a design failure, so the tail is
   * dropped rather than crammed.
   */
  setActions(actions) {
    const list = (actions || []).filter(Boolean).slice(0, 5);
    const sig = list.map((a) => `${a.id}:${a.label || ''}:${a.enabled === false ? 0 : 1}`).join('|');
    if (sig === this._signature) return;
    const structureChanged =
      list.length !== this.buttons.length ||
      list.some((a, i) => this.buttons[i]?.id !== a.id);
    this._signature = sig;

    if (!structureChanged) {
      // Only enablement or wording moved — patch in place so a button that is
      // mid-press does not get torn out from under the finger.
      list.forEach((a, i) => this._paint(this.buttons[i], a));
      return;
    }

    for (const b of this.buttons) b.node.remove();
    this.buttons = [];

    const arc = ARCS[Math.max(0, list.length - 1)] || ARCS[4];
    list.forEach((a, i) => {
      const node = el('button', 'pad-btn', this.pad);
      node.type = 'button';
      const face = el('div', 'pad-face', node);
      const glyph = el('div', 'pad-glyph', face);
      const label = el('div', 'pad-label', node);

      let x = 0;
      let y = 0;
      if (i === 0) {
        node.classList.add('primary');
      } else {
        const deg = arc[i - 1] ?? 150;
        const rad = (deg * Math.PI) / 180;
        x = Math.cos(rad) * ARC_RADIUS;
        y = -Math.sin(rad) * ARC_RADIUS; // screen y grows downward
      }
      node.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;

      const btn = { id: a.id, node, face, glyph, label, x, y, held: false, shown: '' };
      this._paint(btn, a);
      this._bind(btn);
      this.buttons.push(btn);
    });

    // Announce the new set, then get out of the way.
    this._labelTimer = LABEL_HOLD;
    if (this._visible) this._reveal();
  }

  _paint(btn, a) {
    if (!btn) return;
    const glyph = a.icon || GLYPHS[a.id] || (a.label || '?').charAt(0).toUpperCase();
    if (btn.glyph.textContent !== glyph) btn.glyph.textContent = glyph;
    const text = a.label || a.id;
    if (btn.label.textContent !== text) btn.label.textContent = text;
    btn.node.setAttribute('aria-label', text);
    const off = a.enabled === false;
    btn.node.classList.toggle('disabled', off);
    btn.node.disabled = off;
  }

  _bind(btn) {
    const press = (e) => {
      if (btn.node.disabled || !this._enabled) return;
      e.preventDefault();
      // Pointer capture keeps the release ours even if the thumb rolls off the
      // 44px box mid-press, which on a curved screen it constantly does.
      try { btn.node.setPointerCapture(e.pointerId); } catch (_) { /* not captured */ }
      btn.held = true;
      btn.node.classList.add('held');
      this.input.virtualPress(btn.id);
      this._feedback(btn.id);
    };
    const release = (e) => {
      if (!btn.held) return;
      e?.preventDefault();
      btn.held = false;
      btn.node.classList.remove('held');
      this.input.virtualRelease(btn.id);
    };
    btn.node.addEventListener('pointerdown', press);
    btn.node.addEventListener('pointerup', release);
    btn.node.addEventListener('pointercancel', release);
    // Keyboard and assistive tech reach the same action through `click`, which
    // pointerdown/up never fire for. A tap is a press+release in one frame.
    btn.node.addEventListener('click', (e) => {
      e.preventDefault();
      if (e.detail !== 0 || btn.node.disabled) return; // detail 0 = synthesised
      this.input.virtualTap(btn.id);
      this._feedback(btn.id);
    });
  }

  _feedback(id) {
    // 8ms is below the threshold where a vibration reads as a buzz; it reads as
    // a click. Longer is worse, not better.
    if (navigator.vibrate) { try { navigator.vibrate(8); } catch (_) { /* blocked */ } }
    this.audio?.playSfx?.('tap', { action: id });
  }

  _reveal() {
    const on = this._visible;
    for (const b of this.buttons) b.node.classList.toggle('on', on);
  }

  setVisible(v) {
    if (v === this._visible) return;
    this._visible = v;
    this._reveal();
    if (v) this._labelTimer = LABEL_HOLD;
    if (!v) {
      for (const b of this.buttons) {
        if (b.held) { b.held = false; b.node.classList.remove('held'); this.input.virtualRelease(b.id); }
        b.node.classList.remove('labelled');
      }
    }
  }

  /** Disables presses without hiding — used while a panel is open. */
  setEnabled(v) {
    this._enabled = v;
    this.pad.style.opacity = v ? '' : '0';
    this.pad.style.pointerEvents = v ? '' : 'none';
  }

  update(dt) {
    const s = this.input?.stick;

    // --- stick ------------------------------------------------------------
    if (s && s.active && this._visible) {
      if (!this._stickOn) { this._stickOn = true; this.stick.classList.add('on'); }
      // Ring size changes only when Input recomputes the radius (orientation
      // change, essentially), so this write is effectively once per session.
      if (s.radius !== this._stickRadius) {
        this._stickRadius = s.radius;
        const d = Math.round(s.radius * 2);
        this.stickRing.style.width = `${d}px`;
        this.stickRing.style.height = `${d}px`;
      }
      this.stick.style.transform = `translate3d(${s.ox.toFixed(1)}px, ${s.oy.toFixed(1)}px, 0)`;
      // Input reports y as up-positive; the screen is down-positive.
      this.stickKnob.style.transform =
        `translate3d(${(s.x * s.radius).toFixed(1)}px, ${(-s.y * s.radius).toFixed(1)}px, 0)`;
    } else if (this._stickOn) {
      this._stickOn = false;
      this.stick.classList.remove('on');
    }

    // --- transient labels --------------------------------------------------
    if (this._labelTimer > 0) {
      this._labelTimer -= dt;
      const show = this._labelTimer > 0 && this._visible;
      for (const b of this.buttons) b.node.classList.toggle('labelled', show);
    }
  }

  /**
   * Bounding boxes of every touch target, in viewport pixels. Exists so the
   * demo harness can assert the centre-of-frame invariant rather than trusting
   * a comment about it.
   */
  hitBoxes() {
    const cs = getComputedStyle(document.documentElement);
    const safe = (n) => parseFloat(cs.getPropertyValue(n)) || 0;
    const ax = window.innerWidth - safe('--safe-r') - ANCHOR_INSET;
    const ay = window.innerHeight - safe('--safe-b') - ANCHOR_INSET;
    const h = 44;
    return this.buttons.map((b) => ({
      id: b.id,
      x: ax + b.x - h / 2,
      y: ay + b.y - h / 2,
      w: h,
      h,
    }));
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    this.root.remove();
  }
}
