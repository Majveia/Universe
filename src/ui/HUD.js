/**
 * The HUD: one controller, many nearly-invisible widgets.
 *
 * Everything the player is told goes through here, which is what makes it
 * possible to enforce a single rule globally — *a widget is dark unless it is
 * answering a question you are asking right now*. Gameplay code does not get to
 * reach into the DOM; it calls `setTarget`, `showToast`, `setVitals` and the
 * HUD decides whether that is worth lighting a pixel for.
 *
 * The performance contract this file keeps, because it shares a frame with a
 * renderer that is already spending the whole budget:
 *
 *   Nothing reads layout in `update`. Every measurement comes from a
 *   ResizeObserver or a resize event, cached on the instance. The single
 *   deliberate exception is the animation restart in `showDiscovery`, which
 *   happens at most once every few minutes.
 *
 *   Nothing writes a property it did not change. Every setter compares against
 *   a shadow copy first, so a vitals bar that has not moved costs one float
 *   comparison per frame instead of a style recalculation.
 *
 *   Nothing animates a layout property. Bars scale, panels translate, labels
 *   fade. `width`, `top` and `font-size` never appear in a transition.
 *
 * Panels (Codex, Settings, Photo) mount at the document root rather than inside
 * the HUD tree. They are full-screen fixed overlays that need real pointer
 * events, and inheriting `pointer-events: none` from `#ui` only to punch a hole
 * back through it is a fight not worth having.
 */

import { settings } from '../core/Settings.js';
import { Compass, formatDistance } from './Compass.js';
import { Reticle } from './Reticle.js';
import { TouchControls } from './TouchControls.js';
import { ScanOverlay } from './ScanOverlay.js';
import { Subtitles } from './Subtitles.js';
import { Codex } from './Codex.js';
import { SettingsPanel } from './SettingsPanel.js';
import { PhotoMode } from './PhotoMode.js';

const el = (tag, cls, parent) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
};

/** Realm key -> what the top-left block says. The exponent is the honest one. */
const REALM_LABEL = {
  cosmos: ['COSMOS', '10²⁴ m · filaments and voids'],
  galaxy: ['GALAXY', '10²¹ m · arms and nurseries'],
  system: ['SYSTEM', '10¹² m · keplerian'],
  planet: ['PLANET', '10⁷ m · approach'],
  surface: ['SURFACE', '10³ m · standing'],
};

/**
 * Vitals in the order a suit would report them. Only the keys you actually
 * pass are rendered — a ship has fuel and no oxygen, a body has the reverse,
 * and neither should have to send a zero for the other.
 */
const VITAL_LABEL = {
  integrity: 'INTEG',
  health: 'VITALS',
  shield: 'SHIELD',
  oxygen: 'O₂',
  energy: 'POWER',
  fuel: 'FUEL',
  heat: 'THERM',
  hazard: 'HAZARD',
};
const VITAL_ORDER = ['health', 'integrity', 'shield', 'oxygen', 'energy', 'fuel', 'heat', 'hazard'];
/** Rising values that are bad news get warm/danger tinting instead of falling ones. */
const INVERTED_VITALS = new Set(['heat', 'hazard']);

const TOAST_SECONDS = 2.9;
const TOAST_FADE = 0.46;
const DISCOVERY_SECONDS = 5.2;

export class HUD {
  /**
   * @param {object} ctx shared context: `{engine, input, camera, director,
   *   settings, save, audio?}`. Everything is optional except that the pieces
   *   you use must exist — the demo harness passes fakes for all of it.
   */
  constructor(ctx) {
    this.ctx = ctx;
    ctx.hud = this;

    const mount = ctx.uiRoot || document.getElementById('ui') || document.body;
    this.root = el('div', 'hud', mount);

    // --- world-space layers ------------------------------------------------
    this.compass = new Compass(this.root);
    this.reticle = new Reticle(this.root);
    this.scan = new ScanOverlay(this.root);
    this.subtitles = new Subtitles(this.root);
    this.touch = ctx.input ? new TouchControls(this.root, ctx) : null;

    // --- corner blocks -----------------------------------------------------
    this.tl = el('div', 'hud-tl hud-chrome', this.root);
    this.realmName = el('div', 'realm-name', this.tl);
    this.realmSub = el('div', 'realm-sub', this.tl);

    this.diag = el('div', 'hud-diag hud-chrome', this.root);
    this.diag.setAttribute('aria-hidden', 'true');
    this.diagCells = {};
    for (const k of ['fps', 'calls', 'tris', 'tier']) {
      const cell = el('div', null, this.diag);
      this.diagCells[k] = el('b', null, cell);
      cell.appendChild(document.createTextNode(` ${k.toUpperCase()}`));
    }

    this.tr = el('div', 'hud-tr hud-chrome', this.root);
    this.tgtName = el('div', 'tgt-name', this.tr);
    this.tgtClass = el('div', 'tgt-class', this.tr);
    el('div', 'tgt-rule', this.tr);
    this.tgtRows = el('div', 'tgt-rows', this.tr);
    this._tgtRowPool = [];

    this.vitals = el('div', 'vitals hud-chrome', this.root);
    this._vitalSlots = new Map();

    this.actions = el('div', 'actions hud-chrome', this.root);
    this._actionPool = [];

    // Toasts are the one region assistive tech should hear about unprompted;
    // `polite` so they queue behind whatever the user is doing rather than
    // interrupting it.
    this.toasts = el('div', 'toasts hud-chrome', this.root);
    this.toasts.setAttribute('aria-live', 'polite');
    this.toasts.setAttribute('aria-atomic', 'false');
    this._toasts = [];

    this.discovery = el('div', 'discovery hud-chrome', this.root);
    this.discovery.setAttribute('role', 'status');
    this.discKind = el('div', 'disc-kind', this.discovery);
    el('div', 'disc-rule', this.discovery);
    this.discName = el('div', 'disc-name', this.discovery);
    this.discSub = el('div', 'disc-sub', this.discovery);
    this._discTimer = 0;

    // --- panels ------------------------------------------------------------
    this.codex = new Codex(ctx);
    this.settingsPanel = new SettingsPanel(ctx);
    this.photo = new PhotoMode(ctx, this);
    this._panels = [this.codex, this.settingsPanel];

    // --- shadow state ------------------------------------------------------
    this._scale = null;
    this._target = null;
    this._targetSig = '';
    this._actionSig = '';
    this._chrome = true;
    this._hudOn = true;
    this._touchMode = null;
    this._diagOn = false;
    this._diagClock = 0;
    this._inputWasEnabled = true;
    this._panelDepth = 0;
    this._time = 0;

    this._applySettings();
    this._unsubSettings = settings.onChange(() => this._applySettings());

    this._bindKeys();
    this._bindGesture();

    this.setScale(ctx.director?.currentKey || ctx.scale || 'cosmos');
    this.setVitals(null);
    this.setTarget(null);
    this.setContextActions([]);
  }

  // ------------------------------------------------------------------ state --

  /**
   * Which realm we are in. Drives the top-left block, and decides which
   * instruments are even meaningful: a compass needs a horizon, so it is dead
   * weight in deep space and the HUD simply removes it.
   */
  setScale(name) {
    const key = String(name || '').toLowerCase();
    if (key === this._scale) return;
    this._scale = key;
    const [label, sub] = REALM_LABEL[key] || [key.toUpperCase(), ''];
    this.realmName.textContent = label;
    this.realmSub.textContent = sub;
    this.tl.classList.add('on');

    const grounded = key === 'surface' || key === 'planet';
    this.compass.setVisible(grounded);
    this._scanUseful = key !== 'cosmos';
  }

  /**
   * `record` is a Catalog star or planet, or a plain `{name, class, rows}`.
   * Passing null retracts the block entirely — an empty target panel is worse
   * than no target panel, because it implies you lost something.
   */
  setTarget(record) {
    this._target = record || null;
    if (!record) {
      if (this._targetSig !== '') {
        this._targetSig = '';
        this.tr.classList.remove('on');
      }
      return;
    }

    const view = describeTarget(record);
    const sig = view.name + '|' + view.kind + '|' + view.rows.map((r) => r.join(':')).join(',');
    if (sig === this._targetSig) return;
    this._targetSig = sig;

    if (this.tgtName.textContent !== view.name) this.tgtName.textContent = view.name;
    if (this.tgtClass.textContent !== view.kind) this.tgtClass.textContent = view.kind;

    // Rows are pooled: the block redraws several times a second while flying
    // past a body and rebuilding four nodes each time is four allocations and
    // a style recalculation we do not need.
    while (this._tgtRowPool.length < view.rows.length) {
      const row = el('div', 'tgt-row', this.tgtRows);
      const k = el('div', 'k', row);
      const v = el('div', 'v', row);
      this._tgtRowPool.push({ row, k, v, kt: '', vt: '' });
    }
    this._tgtRowPool.forEach((slot, i) => {
      const r = view.rows[i];
      if (!r) { slot.row.style.display = 'none'; return; }
      if (slot.row.style.display) slot.row.style.display = '';
      if (slot.kt !== r[0]) { slot.k.textContent = r[0]; slot.kt = r[0]; }
      if (slot.vt !== r[1]) { slot.v.textContent = r[1]; slot.vt = r[1]; }
    });

    this.tr.classList.add('on');
  }

  /**
   * `{key: 0..1}`. A bar is a `scaleX` on a one-pixel rule, so a suit draining
   * over four minutes costs exactly one transform write per meaningful change
   * and never touches layout.
   */
  setVitals(map) {
    if (!map) {
      this.vitals.classList.remove('on');
      return;
    }
    for (const key of VITAL_ORDER) {
      const raw = map[key];
      if (raw === undefined || raw === null) {
        const dead = this._vitalSlots.get(key);
        if (dead) { dead.node.remove(); this._vitalSlots.delete(key); }
        continue;
      }
      const value = Math.max(0, Math.min(1, +raw || 0));
      let slot = this._vitalSlots.get(key);
      if (!slot) {
        const node = el('div', 'vital ok', this.vitals);
        const head = el('div', 'vital-head', node);
        const k = el('div', 'k', head);
        k.textContent = VITAL_LABEL[key] || key.toUpperCase();
        const v = el('div', 'v', head);
        const bar = el('div', 'vital-bar', node);
        const fill = el('i', null, bar);
        node.setAttribute('role', 'meter');
        node.setAttribute('aria-label', VITAL_LABEL[key] || key);
        slot = { node, v, fill, value: -1, tone: '' };
        this._vitalSlots.set(key, slot);
        // Order is fixed by the enum, not by arrival, so a shield coming online
        // mid-flight does not shuffle the stack under the player's eye.
        this._orderVitals();
      }
      if (Math.abs(value - slot.value) > 0.004) {
        slot.value = value;
        slot.fill.style.transform = `scaleX(${value.toFixed(3)})`;
        const pct = `${Math.round(value * 100)}`;
        if (slot.v.textContent !== pct) slot.v.textContent = pct;
        slot.node.setAttribute('aria-valuenow', pct);
        const bad = INVERTED_VITALS.has(key) ? value > 0.78 : value < 0.22;
        const warn = INVERTED_VITALS.has(key) ? value > 0.55 : value < 0.45;
        const tone = bad ? 'low' : warn ? 'warm' : 'ok';
        if (tone !== slot.tone) {
          slot.node.className = `vital ${tone}`;
          slot.tone = tone;
        }
      }
    }
    this.vitals.classList.toggle('on', this._vitalSlots.size > 0);
  }

  _orderVitals() {
    for (const key of VITAL_ORDER) {
      const slot = this._vitalSlots.get(key);
      if (slot) this.vitals.appendChild(slot.node);
    }
  }

  /**
   * `[{id, label, key, icon, enabled}]`. The same list feeds two renderers: a
   * key-cap column on desktop and the thumb cluster on touch. Which one is lit
   * follows the *last* input the player used, not what the device supports —
   * a tablet with a keyboard should show whichever one they just touched.
   */
  setContextActions(actions) {
    const list = (actions || []).filter(Boolean);
    this._actions = list;
    const sig = list.map((a) => `${a.id}:${a.key || ''}:${a.label || ''}:${a.enabled === false ? 0 : 1}`).join('|');
    if (sig === this._actionSig) return;
    this._actionSig = sig;

    while (this._actionPool.length < list.length) {
      const node = el('div', 'act', this.actions);
      const kbd = el('kbd', null, node);
      const span = el('span', null, node);
      this._actionPool.push({ node, kbd, span, kt: '', st: '' });
    }
    this._actionPool.forEach((slot, i) => {
      const a = list[i];
      if (!a) { slot.node.style.display = 'none'; return; }
      if (slot.node.style.display) slot.node.style.display = '';
      const k = a.key || DEFAULT_KEYS[a.id] || '•';
      if (slot.kt !== k) { slot.kbd.textContent = k; slot.kt = k; }
      const label = a.label || a.id;
      if (slot.st !== label) { slot.span.textContent = label; slot.st = label; }
      slot.node.classList.toggle('disabled', a.enabled === false);
    });

    this.touch?.setActions(list);
    this._syncInputMode(true);
  }

  // ------------------------------------------------------------ transients --

  /**
   * A line of uppercase mono, top centre, gone in three seconds. Toasts are for
   * things that happened, never for things you must do — anything requiring a
   * decision gets a context action instead.
   *
   * @param {string} text
   * @param {{tone?: 'warn'|'bad', seconds?: number}} [opts]
   */
  showToast(text, opts = {}) {
    const msg = String(text ?? '').trim();
    if (!msg) return;

    // Repeating the same message resets its clock rather than stacking a
    // second identical line — a suit warning that fires every frame should
    // look like one persistent warning, not a wall of them.
    const same = this._toasts.find((t) => t.text === msg && !t.out);
    if (same) { same.life = opts.seconds ?? TOAST_SECONDS; return; }

    const node = el('div', `toast${opts.tone ? ` ${opts.tone}` : ''}`, this.toasts);
    node.textContent = msg;
    this._toasts.push({ node, text: msg, life: opts.seconds ?? TOAST_SECONDS, out: false });

    // Four is the point at which a stack stops being readable at a glance.
    while (this._toasts.length > 4) {
      const old = this._toasts.shift();
      old.node.remove();
    }
    this.ctx.audio?.playSfx?.('tick');
  }

  /**
   * The one moment the interface is allowed to be loud. Five seconds of title
   * card, then it is gone forever and lives only in the Codex.
   *
   * @param {{name: string, type?: string, subtitle?: string, record?: object}} d
   */
  showDiscovery(d) {
    if (!d || !d.name) return;
    const kind = (d.type || 'discovery').toUpperCase();
    this.discKind.textContent = kind;
    this.discName.textContent = d.name;
    this.discSub.textContent = d.subtitle || '';

    // Restarting a CSS animation requires the class to be gone for a layout
    // boundary. This is the file's one forced reflow, on an element that
    // changes at most once every few minutes.
    this.discovery.classList.remove('on');
    void this.discovery.offsetWidth;
    this.discovery.classList.add('on');
    this._discTimer = DISCOVERY_SECONDS;

    if (d.record) this.codex.add(d.record);
    this.ctx.audio?.playSfx?.('discovery');
    this.ctx.audio?.duckFor?.(2.6);
  }

  /** Record a find without the title card — used for the quiet ones. */
  addDiscovery(record) {
    return this.codex.add(record);
  }

  /** Narration. See Subtitles for the queueing rules. */
  say(text, opts) {
    this.subtitles.say(text, opts);
  }

  // ------------------------------------------------------------ pass-through --

  /** `{heading, waypoints, sunBearing}` — see Compass. */
  setCompass(d) { this.compass.set(d); }

  /** `null | 'interact' | 'hostile' | 'scanned'`. */
  setAim(kind) { this.reticle.setAim(kind); }

  /** 0..1 hold progress on the reticle, or <0 to clear. */
  setCharge(t) { this.reticle.setCharge(t); }

  /** Hit confirmation flash. */
  hit() { this.reticle.hit(); }

  /** Fire the scan ring. `origin` defaults to the centre of the frame. */
  pulseScan(origin) {
    this.scan.pulse(origin);
    this.ctx.audio?.playSfx?.('scan');
  }

  /** `[{id, screenX, screenY, label, sub, distance}]` — see ScanOverlay. */
  setCallouts(list) { this.scan.setCallouts(list); }

  // ------------------------------------------------------------- visibility --

  /**
   * Total blackout of chrome without tearing down the DOM, so panels keep
   * their scroll position and focus ring and coming back is instant.
   */
  setChromeVisible(v) {
    if (v === this._chrome) return;
    this._chrome = v;
    this.root.classList.toggle('chrome-off', !v);
    this.reticle.setVisible(v && this._hudOn && this._aimable !== false);
  }

  /** The player's own HUD toggle, distinct from photo mode's blackout. */
  toggleHud() {
    this._hudOn = !this._hudOn;
    this.root.style.display = this._hudOn ? '' : 'none';
    this.showToast(this._hudOn ? 'hud on' : '');
  }

  get isPanelOpen() {
    return this.codex.isOpen || this.settingsPanel.isOpen || this.photo.isOpen;
  }

  openCodex() { this._openPanel(this.codex); }
  openSettings() { this._openPanel(this.settingsPanel); }
  toggleCodex() { this.codex.isOpen ? this.closePanels() : this._openPanel(this.codex); }
  toggleSettings() { this.settingsPanel.isOpen ? this.closePanels() : this._openPanel(this.settingsPanel); }
  togglePhoto() { this.photo.isOpen ? this.photo.close() : this.photo.open(); }

  _openPanel(panel) {
    for (const p of this._panels) if (p !== panel && p.isOpen) p.close();
    if (this.photo.isOpen) this.photo.close();
    this._suspendWorldInput(true);
    panel.open();
    this.ctx.audio?.playSfx?.('open');
  }

  closePanels() {
    let closed = false;
    for (const p of this._panels) if (p.isOpen) { p.close(); closed = true; }
    if (closed) {
      this._suspendWorldInput(false);
      this.ctx.audio?.playSfx?.('close');
    }
    return closed;
  }

  /**
   * While a panel is open the world must not hear the keyboard, or reading the
   * Codex walks you off a cliff. Pointer lock goes too, because a cursor you
   * cannot see cannot click a setting.
   */
  _suspendWorldInput(suspend) {
    const input = this.ctx.input;
    if (!input) return;
    if (suspend) {
      this._inputWasEnabled = input.enabled;
      input.enabled = false;
      input.move?.zero?.();
      if (input.stick) input.stick.active = false;
      input.exitPointerLock?.();
      this.touch?.setEnabled(false);
    } else {
      input.enabled = this._inputWasEnabled;
      this.touch?.setEnabled(true);
    }
  }

  // ------------------------------------------------------------------ frame --

  update(dt) {
    this._time += dt;
    const panelOpen = this.isPanelOpen;

    if (!panelOpen) this._pollActions();
    this._syncInputMode(false);

    this.compass.update(dt);
    this.reticle.update(dt);
    this.touch?.update(dt);
    this.scan.update(dt);
    this.subtitles.update(dt);
    this.photo.update(dt);

    this._tickToasts(dt);

    if (this._discTimer > 0) {
      this._discTimer -= dt;
      if (this._discTimer <= 0) this.discovery.classList.remove('on');
    }

    if (this._diagOn) {
      this._diagClock -= dt;
      if (this._diagClock <= 0) { this._diagClock = 0.25; this._writeDiag(); }
    }
  }

  /**
   * Panel toggles are polled off the action layer rather than bound to key
   * codes, so a gamepad's start button and the touch cluster's codex icon go
   * through exactly the same path a keyboard does.
   */
  _pollActions() {
    const input = this.ctx.input;
    if (!input?.pressed) return;
    if (input.pressed('codex') || input.pressed('journal')) this.toggleCodex();
    else if (input.pressed('pause')) this.toggleSettings();
    else if (input.pressed('photo')) this.togglePhoto();
    else if (input.pressed('hud')) this.toggleHud();
    else if (input.pressed('debug')) this._toggleDiag();
  }

  /**
   * Desktop key hints and the thumb cluster are mutually exclusive, and the
   * switch is driven by the last input actually used. Picking up the mouse
   * after an hour of touch should retire the buttons without a settings trip.
   */
  _syncInputMode(force) {
    const input = this.ctx.input;
    const touch = input ? input.lastInputKind === 'touch' : settings.isTouch;
    if (!force && touch === this._touchMode) return;
    this._touchMode = touch;
    this.touch?.setVisible(touch);
    this.actions.classList.toggle('on', !touch && (this._actions?.length ?? 0) > 0);
    // A crosshair is a mouse idea. On touch the finger is the cursor and the
    // dot in the middle of the frame is just a smudge on the glass.
    this.reticle.setVisible(!touch && this._chrome && this._hudOn);
  }

  _tickToasts(dt) {
    for (let i = this._toasts.length - 1; i >= 0; i--) {
      const t = this._toasts[i];
      t.life -= dt;
      if (t.life <= 0 && !t.out) {
        t.out = true;
        t.node.classList.add('out');
        t.life = -TOAST_FADE;
      } else if (t.out && t.life <= -TOAST_FADE) {
        t.node.remove();
        this._toasts.splice(i, 1);
      }
    }
  }

  _toggleDiag() {
    this._diagOn = !this._diagOn;
    this.diag.classList.toggle('on', this._diagOn);
    this._diagClock = 0;
  }

  _writeDiag() {
    const e = this.ctx.engine;
    if (!e) return;
    const set = (k, v) => { if (this.diagCells[k].textContent !== v) this.diagCells[k].textContent = v; };
    set('fps', String(Math.round(e.fps ?? 0)));
    set('calls', String(e.drawCalls ?? 0));
    set('tris', formatCount(e.triangles ?? 0));
    set('tier', (this.ctx.settings || settings).tierName || '—');
  }

  // ------------------------------------------------------------------ wiring --

  _bindKeys() {
    // Only two keys are handled here, and only while a panel has the screen:
    // Escape unwinds one level, and that is it. Tab is deliberately left to the
    // browser inside a panel so focus traversal still works — Tab opens the
    // Codex from the world, Escape closes it, and in between it means Tab.
    this._onKey = (e) => {
      if (e.code === 'Escape') {
        if (this.photo.isOpen) { this.photo.close(); e.preventDefault(); return; }
        if (this.closePanels()) { e.preventDefault(); return; }
      }
      // With world input suspended the action layer is deaf, so the panel
      // shortcuts need a direct line back.
      if (!this.isPanelOpen) return;
      if (e.code === 'KeyP' && !e.metaKey && !e.ctrlKey) { this.togglePhoto(); e.preventDefault(); }
    };
    window.addEventListener('keydown', this._onKey);
  }

  /**
   * Browsers will not start an AudioContext without a gesture, and asking the
   * player to press a "enable sound" button is exactly the kind of chrome this
   * project refuses to draw. So the first touch, click or key press the page
   * ever sees quietly starts the audio engine and the listener retires.
   */
  _bindGesture() {
    const kinds = ['pointerdown', 'keydown', 'touchstart'];
    this._onGesture = () => {
      for (const k of kinds) window.removeEventListener(k, this._onGesture, true);
      this._onGesture = null;
      this.ctx.audio?.resume?.();
    };
    for (const k of kinds) window.addEventListener(k, this._onGesture, true);
  }

  _applySettings() {
    const s = this.ctx.settings || settings;
    // Reduced motion is a body-level switch because the panels live outside
    // the HUD tree and photo mode's flash lives outside both.
    document.body.classList.toggle('calm', !!s.reduceMotion);
    if (s.showHud === false && this._hudOn) this.toggleHud();
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    if (this._onGesture) {
      for (const k of ['pointerdown', 'keydown', 'touchstart']) {
        window.removeEventListener(k, this._onGesture, true);
      }
    }
    this._unsubSettings?.();
    this.compass.dispose();
    this.reticle.dispose();
    this.touch?.dispose();
    this.scan.dispose();
    this.subtitles.dispose();
    this.codex.dispose();
    this.settingsPanel.dispose();
    this.photo.dispose();
    this.root.remove();
  }
}

// --- target formatting -------------------------------------------------------

const DEFAULT_KEYS = {
  interact: 'E', scan: 'G', jump: '␣', crouch: 'C', sprint: '⇧', land: 'L',
  takeoff: 'L', vehicle: 'B', codex: '⇥', photo: 'P', map: 'M', toggleView: 'V',
  boost: 'X', flashlight: 'F', timeWarp: 'T', zoom: 'Z', primary: 'LMB',
};

const PLANET_KIND = {
  molten: 'MOLTEN', barren: 'BARREN', desert: 'DESERT', temperate: 'TEMPERATE',
  jungle: 'JUNGLE', ocean: 'OCEANIC', frozen: 'FROZEN', toxic: 'TOXIC',
  irradiated: 'IRRADIATED', gasgiant: 'GAS GIANT', icegiant: 'ICE GIANT',
  exotic: 'ANOMALOUS', ringworld: 'RINGWORLD',
};

/** Kelvin is correct and useless. Celsius is what a body understands. */
export function formatTemp(kelvin) {
  if (!isFinite(kelvin)) return '—';
  const c = kelvin - 273.15;
  return `${c >= 0 ? '' : '−'}${Math.abs(c).toFixed(Math.abs(c) < 10 ? 1 : 0)}°C`;
}

export function formatCount(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}G`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(Math.round(n));
}

/**
 * Turns a Catalog record into the four facts worth putting on a corner of the
 * screen. Four, not eight: the target block is a glance, and the Codex is
 * where you go when the glance was interesting.
 */
export function describeTarget(r) {
  if (r.rows) return { name: r.name || '—', kind: r.class || r.kind || '', rows: r.rows };

  const rows = [];
  if (typeof r.distance === 'number') rows.push(['DIST', formatDistance(r.distance)]);

  if (typeof r.massEarth === 'number') {
    rows.push(['GRAV', `${(r.gravity / 9.80665).toFixed(2)}g`]);
    rows.push(['TEMP', formatTemp(r.surfaceTemp)]);
    rows.push(['ATMO', r.atmosphere > 0.05 ? `${r.atmosphere.toFixed(2)} atm` : 'none']);
    return {
      name: r.name || r.designation || '—',
      kind: PLANET_KIND[r.type] || String(r.type || '').toUpperCase(),
      rows,
    };
  }

  if (typeof r.massSolar === 'number') {
    rows.push(['MASS', `${r.massSolar.toFixed(2)} M☉`]);
    rows.push(['TEMP', `${Math.round(r.temp)} K`]);
    rows.push(['LUM', `${r.lumSolar < 0.01 ? r.lumSolar.toExponential(1) : r.lumSolar.toFixed(2)} L☉`]);
    return { name: r.name || '—', kind: r.label || `${r.class}-TYPE`, rows };
  }

  return { name: r.name || '—', kind: (r.kind || r.type || '').toUpperCase(), rows };
}
