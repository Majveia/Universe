/**
 * Photo mode.
 *
 * The argument for building this at all: a procedural universe is only as good
 * as the frames people take out of it, and the difference between a screenshot
 * and a photograph is entirely in the controls you were given. So this is a
 * camera, not a screenshot button — it detaches from the player, stops the
 * simulation so the frame holds still, and gives you the four things that
 * actually change a picture: where you stand, how wide you see, how much light
 * you let in, and how the film responds to it.
 *
 * Aperture and focal length are honest rather than decorative. Focal length
 * drives the real camera FOV through the standard 35mm relation, so a 24mm frame
 * has 24mm perspective distortion and an 85mm frame compresses depth the way it
 * should. Aperture drives three things at once, because in a real camera it
 * does: exposure moves by the square of the f-stop ratio, vignetting opens up
 * wide and closes down stopped, and the depth-of-field uniform gets the blur
 * circle. You cannot open up two stops without the picture getting brighter,
 * which is exactly the constraint that makes the controls teach you something.
 *
 * Film stocks are grades, not filters. Each one is a small set of values pushed
 * into the composite pass — saturation, contrast, lift, and separate tints for
 * shadows and highlights — which is roughly what a film stock *is*: a set of
 * dye curves that respond differently at each end of the exposure range. The
 * names are descriptions rather than brands, because a fake Kodachrome is worse
 * than an honest one.
 *
 * The whole dock is one strip along the bottom edge, and it is the only place in
 * this project where a translucent black plate is allowed — you are grading a
 * picture, and grading against a transparent control surface is impossible.
 */

const el = (tag, cls, parent) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
};

/**
 * Grades. Every field is a composite uniform except `grain` and `ab`, which live
 * in the settings store because PostFX re-reads those every frame.
 */
const STOCKS = [
  {
    id: 'neutral', name: 'Neutral',
    saturation: 1.06, contrast: 1.02, lift: 0.0,
    shadowTint: [0.94, 0.98, 1.10], highlightTint: [1.04, 1.005, 0.965],
    grain: 0.55, ab: 0.4, vignette: 0.5,
  },
  {
    id: 'daylight', name: 'Daylight',
    saturation: 1.22, contrast: 1.12, lift: -0.008,
    shadowTint: [0.90, 0.97, 1.16], highlightTint: [1.08, 1.01, 0.94],
    grain: 0.7, ab: 0.55, vignette: 0.6,
  },
  {
    id: 'tungsten', name: 'Tungsten',
    saturation: 0.96, contrast: 1.06, lift: 0.012,
    shadowTint: [0.86, 0.94, 1.22], highlightTint: [1.14, 1.02, 0.86],
    grain: 0.9, ab: 0.7, vignette: 0.68,
  },
  {
    id: 'cyanotype', name: 'Cyanotype',
    saturation: 0.42, contrast: 1.18, lift: 0.02,
    shadowTint: [0.72, 0.92, 1.38], highlightTint: [0.90, 1.02, 1.20],
    grain: 1.1, ab: 0.3, vignette: 0.74,
  },
  {
    id: 'monolith', name: 'Monolith',
    saturation: 0.0, contrast: 1.24, lift: 0.0,
    shadowTint: [1.0, 1.0, 1.0], highlightTint: [1.0, 1.0, 1.0],
    grain: 1.35, ab: 0.0, vignette: 0.8,
  },
  {
    id: 'infrared', name: 'Infrared',
    saturation: 1.35, contrast: 1.15, lift: 0.005,
    shadowTint: [1.18, 0.88, 1.06], highlightTint: [1.16, 0.92, 1.06],
    grain: 0.95, ab: 1.1, vignette: 0.62,
  },
];

/** Frame ratios. `null` means whatever the window is. */
const FRAMES = [
  { id: 'full', label: 'Full', ratio: null },
  { id: 'wide', label: '16:9', ratio: 16 / 9 },
  { id: 'scope', label: '2.39', ratio: 2.39 },
  { id: 'square', label: '1:1', ratio: 1 },
];

const F_STOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16];
const FOCALS = [14, 18, 24, 28, 35, 50, 85, 135, 200];

export class PhotoMode {
  constructor(ctx, hud) {
    this.ctx = ctx || {};
    this.hud = hud || null;
    this.isOpen = false;

    this.root = el('div', 'photo', document.body);
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Photo mode');
    this.root.setAttribute('aria-hidden', 'true');

    this.thirds = el('div', 'photo-thirds', this.root);
    for (let i = 0; i < 4; i++) el('i', null, this.thirds);
    const frame = el('div', 'photo-frame', this.root);
    for (let i = 0; i < 4; i++) el('i', null, frame);
    this.bars = el('div', 'photo-bars', this.root);
    this.barTop = el('i', null, this.bars);
    this.barBottom = el('i', null, this.bars);

    this.flash = el('div', 'photo-flash', document.body);

    this._buildDock();

    // --- camera state ------------------------------------------------------
    this.aperture = 2.8;
    this.focal = 35;
    this.exposure = 1.0;
    this.grain = 0.55;
    this.stock = STOCKS[0];
    this.frameId = 'full';
    this.thirdsOn = false;

    this._yaw = 0;
    this._pitch = 0;
    this._speed = 12;
    this._keys = new Set();
    this._dragging = false;
    this._saved = null;

    this._bind();
    this._applyStock(this.stock);
    this._applyOptics();
  }

  // ------------------------------------------------------------------- dock --

  _buildDock() {
    const dock = el('div', 'photo-dock interactive', this.root);
    this.dock = dock;

    const head = el('div', 'photo-head', dock);
    const name = el('div', 'photo-name', head);
    name.textContent = 'PHOTO';
    this.readout = el('div', 'photo-read', head);

    this.stockRow = el('div', 'seg photo-stocks', dock);
    this.stockRow.setAttribute('role', 'group');
    this.stockRow.setAttribute('aria-label', 'Film stock');
    this._stockNodes = STOCKS.map((s) => {
      const b = el('button', null, this.stockRow);
      b.type = 'button';
      b.textContent = s.name;
      b.addEventListener('click', () => this.setStock(s.id));
      return b;
    });

    const sliders = el('div', 'photo-sliders', dock);
    this._aperture = this._slider(sliders, 'Aperture', 0, F_STOPS.length - 1, 1, 2, (i) => {
      this.aperture = F_STOPS[i];
      this._applyOptics();
    }, () => `ƒ${F_STOPS[this._apertureIndex()]}`);
    this._focal = this._slider(sliders, 'Focal', 0, FOCALS.length - 1, 1, 4, (i) => {
      this.focal = FOCALS[i];
      this._applyOptics();
    }, () => `${this.focal}mm`);
    this._exposure = this._slider(sliders, 'Exposure', -2, 2, 0.1, 0, (v) => {
      this.exposure = Math.pow(2, v);
      this._applyOptics();
    }, (v) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)}`);
    this._grain = this._slider(sliders, 'Grain', 0, 2, 0.05, 0.55, (v) => {
      this.grain = v;
      const s = this.ctx.settings;
      if (s) s.filmGrain = v;
    }, (v) => `${Math.round(v * 100)}%`);

    const actions = el('div', 'photo-actions', dock);
    const left = el('div', null, actions);
    left.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap';

    this.frameRow = el('div', 'seg', left);
    this.frameRow.setAttribute('role', 'group');
    this.frameRow.setAttribute('aria-label', 'Frame');
    this._frameNodes = FRAMES.map((f) => {
      const b = el('button', null, this.frameRow);
      b.type = 'button';
      b.textContent = f.label;
      b.addEventListener('click', () => this.setFrame(f.id));
      return b;
    });

    this.thirdsBtn = el('button', 'btn-ghost', left);
    this.thirdsBtn.type = 'button';
    this.thirdsBtn.textContent = 'Thirds';
    this.thirdsBtn.addEventListener('click', () => this.setThirds(!this.thirdsOn));

    const right = el('div', null, actions);
    right.style.cssText = 'display:flex;gap:8px';
    const save = el('button', 'btn-ghost', right);
    save.type = 'button';
    save.textContent = 'Save PNG';
    save.addEventListener('click', () => this.capture());
    const exit = el('button', 'btn-ghost', right);
    exit.type = 'button';
    exit.textContent = 'Exit';
    exit.addEventListener('click', () => this.close());
  }

  _slider(parent, label, min, max, step, value, onInput, format) {
    const row = el('div', 'photo-slider', parent);
    const k = el('div', 'k', row);
    k.textContent = label;
    const input = el('input', 'set-range', row);
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.setAttribute('aria-label', label);
    const val = el('div', 'set-val', row);
    const paint = () => {
      const v = parseFloat(input.value);
      onInput(v);
      val.textContent = format(v);
      input.setAttribute('aria-valuetext', val.textContent);
      this._writeReadout();
    };
    input.addEventListener('input', paint);
    // Called once now so the readout is correct before the panel is ever opened.
    queueMicrotask(paint);
    return { input, val, paint };
  }

  _apertureIndex() {
    return Math.max(0, F_STOPS.indexOf(this.aperture));
  }

  // ------------------------------------------------------------------ optics --

  /**
   * The one place the numbers become a picture.
   *
   * Focal length to FOV is the standard 35mm-equivalent relation. Aperture to
   * exposure is the inverse square of the f-number ratio against a ƒ/2.8
   * reference, which is what makes stopping down actually cost you light, and
   * the same ratio drives vignetting and the blur circle — a wide-open lens
   * vignettes and has shallow depth, a stopped-down one does neither.
   */
  _applyOptics() {
    const post = this.ctx.engine?.postfx;
    const cam = this.ctx.camera;

    const fov = 2 * Math.atan(24 / (2 * this.focal)) * (180 / Math.PI);
    if (cam) {
      cam.fov = fov;
      cam.updateProjectionMatrix?.();
    }

    const stopsFromRef = Math.log2((2.8 / this.aperture) ** 2);
    const ev = this.exposure * Math.pow(2, stopsFromRef * 0.55);

    if (post) {
      post.set('exposure', ev);
      // Wide open: heavier corner falloff and a shallower plane of focus.
      const open = 1 - Math.min(1, Math.log2(this.aperture / 1.4) / 3.5);
      post.set('vignette', this.stock.vignette + open * 0.28);
      // Named for the uniform PostFX will grow; `set` ignores what it does not
      // have, so this is forward-compatible rather than dead.
      post.set('dofAmount', open);
      post.set('focusDistance', this._focusDistance ?? 0);
    }
    const s = this.ctx.settings;
    if (s) s.filmGrain = this.grain;
    this._writeReadout();
  }

  _writeReadout() {
    if (!this.readout) return;
    const fov = 2 * Math.atan(24 / (2 * this.focal)) * (180 / Math.PI);
    const text = `ƒ${this.aperture}  ·  ${this.focal}mm  ·  ${Math.round(fov)}°  ·  ${this.stock.name}`;
    if (this.readout.textContent !== text) this.readout.textContent = text;
  }

  setStock(id) {
    const s = STOCKS.find((x) => x.id === id) || STOCKS[0];
    this.stock = s;
    this._applyStock(s);
    this._applyOptics();
    this.ctx.audio?.playSfx?.('tick');
  }

  _applyStock(s) {
    const post = this.ctx.engine?.postfx;
    if (post) {
      post.set('saturation', s.saturation);
      post.set('contrast', s.contrast);
      post.set('lift', s.lift);
      post.set('shadowTint', s.shadowTint);
      post.set('highlightTint', s.highlightTint);
    }
    const st = this.ctx.settings;
    if (st) st.chromaticAberration = s.ab;
    if (this._grain) {
      this._grain.input.value = String(s.grain);
      this._grain.paint();
    }
    this._stockNodes.forEach((b, i) => b.setAttribute('aria-pressed', String(STOCKS[i].id === s.id)));
  }

  setFrame(id) {
    this.frameId = id;
    const f = FRAMES.find((x) => x.id === id) || FRAMES[0];
    this._frameNodes.forEach((b, i) => b.setAttribute('aria-pressed', String(FRAMES[i].id === id)));
    // Bar height is a single write per change, not per frame. A letterbox is one
    // of the very few places where animating a box's height is the honest
    // implementation: the bar *is* its height.
    let h = 0;
    if (f.ratio) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const target = vw / f.ratio;
      h = Math.max(0, Math.round((vh - target) / 2));
    }
    this.barTop.style.height = `${h}px`;
    this.barBottom.style.height = `${h}px`;
  }

  setThirds(v) {
    this.thirdsOn = v;
    this.thirds.classList.toggle('on', v);
    this.thirdsBtn.setAttribute('aria-pressed', String(v));
  }

  // -------------------------------------------------------------- open/close --

  open() {
    if (this.isOpen) return;
    this.isOpen = true;

    // Snapshot everything we are about to take over, so leaving restores the
    // player's own camera and grade exactly rather than approximately.
    const cam = this.ctx.camera;
    const s = this.ctx.settings;
    this._saved = {
      fov: cam?.fov,
      grain: s?.filmGrain,
      ab: s?.chromaticAberration,
      exposure: s?.exposure,
      rotation: cam?.rotation ? { x: cam.rotation.x, y: cam.rotation.y, z: cam.rotation.z, order: cam.rotation.order } : null,
      paused: this.ctx.paused,
      inputEnabled: this.ctx.input?.enabled,
    };
    if (cam?.rotation) {
      this._yaw = cam.rotation.y;
      this._pitch = cam.rotation.x;
    }

    // The simulation stops so the frame holds still. `paused` is a flag the
    // frame loop honours; nothing here reaches into the engine's private state.
    this.ctx.paused = true;
    this.ctx.timeScale = 0;
    if (this.ctx.input) this.ctx.input.enabled = false;
    this.ctx.input?.exitPointerLock?.();

    this.hud?.setChromeVisible(false);
    this.root.classList.add('open');
    this.root.setAttribute('aria-hidden', 'false');
    this.setFrame(this.frameId);
    this._applyStock(this.stock);
    this._applyOptics();
    this.ctx.audio?.playSfx?.('open');
    this.ctx.audio?.duckFor?.(0.6);
    this.dock.querySelector('button')?.focus({ preventScroll: true });
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;

    const cam = this.ctx.camera;
    const s = this.ctx.settings;
    const v = this._saved || {};
    if (cam && v.fov !== undefined) { cam.fov = v.fov; cam.updateProjectionMatrix?.(); }
    if (cam?.rotation && v.rotation) cam.rotation.set(v.rotation.x, v.rotation.y, v.rotation.z, v.rotation.order);
    if (s) {
      if (v.grain !== undefined) s.filmGrain = v.grain;
      if (v.ab !== undefined) s.chromaticAberration = v.ab;
    }
    const post = this.ctx.engine?.postfx;
    if (post) {
      const n = STOCKS[0];
      post.set('saturation', n.saturation);
      post.set('contrast', n.contrast);
      post.set('lift', n.lift);
      post.set('shadowTint', n.shadowTint);
      post.set('highlightTint', n.highlightTint);
      post.set('vignette', 0.55);
      post.set('dofAmount', 0);
      post.set('exposure', v.exposure ?? 1);
    }

    this.ctx.paused = v.paused ?? false;
    this.ctx.timeScale = 1;
    if (this.ctx.input && v.inputEnabled !== undefined) this.ctx.input.enabled = v.inputEnabled;

    this.hud?.setChromeVisible(true);
    this.root.classList.remove('open');
    this.root.setAttribute('aria-hidden', 'true');
    this.ctx.audio?.playSfx?.('close');
    this._keys.clear();
  }

  // ----------------------------------------------------------------- capture --

  /**
   * The renderer is created with `preserveDrawingBuffer`, so the back buffer is
   * still readable after the frame — but only reliably right after a draw. So a
   * frame is forced first, then read. The UI is DOM and never in the buffer,
   * which is why hiding it is a courtesy to the photographer rather than a
   * requirement of the capture.
   */
  async capture() {
    const canvas = this.ctx.engine?.renderer?.domElement || document.getElementById('viewport');
    if (!canvas || !canvas.toBlob) return;

    this.dock.style.opacity = '0';
    try {
      this.ctx.director?.render?.();
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `universe-${stamp()}.png`;
        a.click();
        // Revoked on the next turn of the loop: the click has already handed
        // the URL to the download manager by then.
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      }
    } catch (err) {
      this.hud?.showToast?.('capture failed', { tone: 'bad' });
    } finally {
      this.dock.style.opacity = '';
    }

    this.flash.classList.remove('go');
    void this.flash.offsetWidth;
    this.flash.classList.add('go');
    this.ctx.audio?.playSfx?.('shutter');
  }

  // ------------------------------------------------------------- free camera --

  _bind() {
    this._onKeyDown = (e) => {
      if (!this.isOpen) return;
      if (e.target instanceof HTMLInputElement) return;
      this._keys.add(e.code);
      if (e.code === 'Enter') { this.capture(); e.preventDefault(); }
      if (e.code === 'KeyG') { this.setThirds(!this.thirdsOn); e.preventDefault(); }
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    };
    this._onKeyUp = (e) => this._keys.delete(e.code);
    this._onDown = (e) => {
      if (!this.isOpen) return;
      // Only a drag started on the picture moves the camera. A drag started on
      // the dock is someone using a slider.
      if (this.dock.contains(e.target)) return;
      this._dragging = true;
      this._lx = e.clientX;
      this._ly = e.clientY;
    };
    this._onMove = (e) => {
      if (!this._dragging) return;
      // Sensitivity scales with focal length, exactly like a real long lens:
      // at 200mm a small hand movement is a large angular one, so the control
      // has to slow down or the frame is unusable.
      const k = 0.0026 * (35 / this.focal);
      this._yaw -= (e.clientX - this._lx) * k;
      this._pitch -= (e.clientY - this._ly) * k;
      this._pitch = Math.max(-1.55, Math.min(1.55, this._pitch));
      this._lx = e.clientX;
      this._ly = e.clientY;
    };
    this._onUp = () => { this._dragging = false; };
    this._onWheel = (e) => {
      if (!this.isOpen || this.dock.contains(e.target)) return;
      this._speed = Math.max(0.2, Math.min(4000, this._speed * (e.deltaY > 0 ? 0.86 : 1.16)));
      e.preventDefault();
    };
    this._onResize = () => { if (this.isOpen) this.setFrame(this.frameId); };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('pointerdown', this._onDown);
    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('wheel', this._onWheel, { passive: false });
    window.addEventListener('resize', this._onResize);
  }

  update(dt) {
    if (!this.isOpen) return;
    const cam = this.ctx.camera;
    if (!cam?.position) return;

    // Euler order YXZ so yaw is applied before pitch and the horizon never
    // rolls — a photographer wants a level frame unless they ask for otherwise.
    cam.rotation?.set?.(this._pitch, this._yaw, 0, 'YXZ');

    const k = this._keys;
    let f = 0, r = 0, u = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) f += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) f -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) r += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) r -= 1;
    if (k.has('Space')) u += 1;
    if (k.has('ControlLeft') || k.has('KeyC')) u -= 1;
    if (!f && !r && !u) return;

    const boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 6 : 1;
    const v = this._speed * boost * dt;
    const cp = Math.cos(this._pitch);
    const sp = Math.sin(this._pitch);
    const cy = Math.cos(this._yaw);
    const sy = Math.sin(this._yaw);

    // Three's camera looks down its local -Z, which is where the signs come from.
    cam.position.x += (-sy * cp * f + cy * r) * v;
    cam.position.y += (sp * f + u) * v;
    cam.position.z += (-cy * cp * f - sy * r) * v;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('pointerdown', this._onDown);
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('resize', this._onResize);
    this.root.remove();
    this.flash.remove();
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
