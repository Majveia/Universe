/**
 * Settings.
 *
 * Deliberately one column and nine rows. Every entry here changes something you
 * can see or feel within one frame of moving it, and anything that does not meet
 * that bar was left out — there is no "advanced" section, no sub-menu, and no
 * option whose effect can only be described in words.
 *
 * The controls are drawn from the same vocabulary as the rest of the HUD: a
 * range is a hairline with a 9px pip and no track fill; a segmented control is
 * text with a rule under the active item; a toggle is a 26x14 capsule whose pip
 * translates. None of them have a filled background, because a filled background
 * on an OLED is a lit rectangle and this panel is meant to sit over the universe
 * rather than replace it.
 *
 * Two wiring details worth knowing:
 *
 *   The store is the truth, not the widget. Every control writes through
 *   `settings.set` and reads back through `settings.onChange`, so a value changed
 *   from the console, restored from localStorage, or pushed by the adaptive
 *   quality watchdog moves the pip. Widgets that own their own state are how
 *   settings screens end up lying to people.
 *
 *   Some settings are polled by their consumer and some are not. PostFX reads
 *   `filmGrain` and `chromaticAberration` out of the store every frame, so those
 *   only need `settings.set`. `exposure` is a plain uniform nothing re-reads, so
 *   it is also pushed into the composite directly. FOV belongs to the camera, so
 *   it is pushed there. Getting this wrong is the difference between a slider
 *   that works and one that works after a reload.
 */

import { settings as globalSettings, Tier } from '../core/Settings.js';

const el = (tag, cls, parent) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
};

const TIER_LABELS = ['Potato', 'Low', 'Medium', 'High', 'Ultra'];

export class SettingsPanel {
  constructor(ctx) {
    this.ctx = ctx || {};
    this.s = this.ctx.settings || globalSettings;
    this.isOpen = false;
    this._rows = [];

    this.root = el('div', 'panel settings-panel', document.body);
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', 'Settings');
    this.root.setAttribute('aria-hidden', 'true');

    const inner = el('div', 'panel-inner', this.root);
    const head = el('div', 'panel-head', inner);
    const title = el('div', 'panel-title', head);
    title.textContent = 'SETTINGS';
    const headRight = el('div', 'panel-head-right', head);
    const hint = el('div', 'panel-hint', headRight);
    hint.textContent = 'ESC — CLOSE';

    const body = el('div', 'panel-body', inner);
    this.list = el('div', 'set-list scroll', body);

    this._build();

    this._unsub = this.s.onChange(() => this.sync());
    this.sync();
  }

  _build() {
    this._group('Display');

    this._seg('Quality', 'Auto-detected at boot; the watchdog can step it down.', {
      options: ['Auto', ...TIER_LABELS],
      get: () => (this.s.autoTier ? 'Auto' : TIER_LABELS[this.s.tier]),
      set: (v) => {
        if (v === 'Auto') {
          this.s.autoTier = true;
          this.s.apply(guessBack(this.s));
          this.s._emit?.();
        } else {
          this.s.setTier(TIER_LABELS.indexOf(v));
        }
      },
    });

    this._range('Field of view', null, {
      min: 55, max: 110, step: 1,
      get: () => this.s.fov,
      set: (v) => {
        this.s.set('fov', v);
        const cam = this.ctx.camera;
        if (cam) { cam.fov = v; cam.updateProjectionMatrix(); }
      },
      format: (v) => `${Math.round(v)}°`,
    });

    this._range('Exposure', 'Stops above and below the metered scene.', {
      min: 0.35, max: 2.2, step: 0.05,
      get: () => this.s.exposure,
      set: (v) => {
        this.s.set('exposure', v);
        // Nothing re-reads this uniform per frame, so it is pushed on change.
        this.ctx.engine?.postfx?.set('exposure', v);
      },
      format: (v) => `${v >= 1 ? '+' : '−'}${Math.abs(Math.log2(v)).toFixed(1)}`,
    });

    this._range('Film grain', null, {
      min: 0, max: 2, step: 0.05,
      get: () => this.s.filmGrain,
      set: (v) => this.s.set('filmGrain', v),
      format: pct,
    });

    this._range('Chromatic aberration', null, {
      min: 0, max: 2, step: 0.05,
      get: () => this.s.chromaticAberration,
      set: (v) => this.s.set('chromaticAberration', v),
      format: pct,
    });

    this._group('Control');

    this._range('Look sensitivity', null, {
      min: 0.2, max: 3, step: 0.05,
      get: () => this.s.sensitivity,
      set: (v) => this.s.set('sensitivity', v),
      format: (v) => v.toFixed(2),
    });

    this._toggle('Invert vertical look', null, {
      get: () => this.s.invertY,
      set: (v) => this.s.set('invertY', v),
    });

    this._group('Sound');

    this._range('Volume', null, {
      min: 0, max: 1, step: 0.02,
      get: () => this.s.audioVolume,
      set: (v) => {
        this.s.set('audioVolume', v);
        this.ctx.audio?.setVolume?.(v);
      },
      format: pct,
    });

    this._group('Comfort');

    this._toggle('Reduced motion', 'Stills every animation in the interface. The universe keeps moving.', {
      get: () => this.s.reduceMotion,
      set: (v) => this.s.set('reduceMotion', v),
    });

    const note = el('div', 'set-note', this.list);
    note.textContent =
      'Quality is detected from your GPU at boot and stepped down automatically if frames start ' +
      'costing more than they are worth. Everything on this page is stored locally and nowhere else.';
  }

  // --- row builders ----------------------------------------------------------

  _group(label) {
    const g = el('div', 'set-group', this.list);
    g.textContent = label;
  }

  _row(label, sub) {
    const row = el('div', 'set-row', this.list);
    const l = el('div', 'set-label', row);
    l.appendChild(document.createTextNode(label));
    if (sub) {
      const small = el('small', null, l);
      small.textContent = sub;
    }
    const ctl = el('div', 'set-ctl', row);
    return { row, label: l, ctl };
  }

  _range(label, sub, opts) {
    const { ctl } = this._row(label, sub);
    const input = el('input', 'set-range interactive', ctl);
    input.type = 'range';
    input.min = String(opts.min);
    input.max = String(opts.max);
    input.step = String(opts.step);
    input.setAttribute('aria-label', label);
    const val = el('div', 'set-val', ctl);

    const write = () => {
      const v = parseFloat(input.value);
      opts.set(v);
      val.textContent = (opts.format || String)(v);
      input.setAttribute('aria-valuetext', val.textContent);
    };
    // `input` rather than `change`: exposure and FOV must move under the thumb,
    // not when it lifts. Both are cheap enough to write every pixel of drag.
    input.addEventListener('input', write);

    this._rows.push(() => {
      const v = opts.get();
      if (document.activeElement !== input) input.value = String(v);
      val.textContent = (opts.format || String)(v);
    });
  }

  _toggle(label, sub, opts) {
    const { ctl } = this._row(label, sub);
    const btn = el('button', 'tog interactive', ctl);
    btn.type = 'button';
    btn.setAttribute('aria-label', label);
    el('i', null, btn);
    btn.addEventListener('click', () => {
      opts.set(!opts.get());
      this.sync();
    });
    this._rows.push(() => btn.setAttribute('aria-pressed', String(!!opts.get())));
  }

  _seg(label, sub, opts) {
    const { ctl } = this._row(label, sub);
    const seg = el('div', 'seg interactive', ctl);
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', label);
    const buttons = opts.options.map((o) => {
      const b = el('button', null, seg);
      b.type = 'button';
      b.textContent = o;
      b.addEventListener('click', () => { opts.set(o); this.sync(); });
      return b;
    });
    this._rows.push(() => {
      const cur = opts.get();
      buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(opts.options[i] === cur)));
    });
  }

  /** Pull every control back into agreement with the store. */
  sync() {
    for (const fn of this._rows) fn();
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this._returnFocus = document.activeElement;
    this.sync();
    this.root.classList.add('open');
    this.root.setAttribute('aria-hidden', 'false');
    this.list.querySelector('button, input')?.focus({ preventScroll: true });
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.classList.remove('open');
    this.root.setAttribute('aria-hidden', 'true');
    const back = this._returnFocus;
    this._returnFocus = null;
    if (back && back.isConnected && back !== document.body) back.focus({ preventScroll: true });
  }

  dispose() {
    this._unsub?.();
    this.root.remove();
  }
}

function pct(v) {
  return `${Math.round(v * 100)}%`;
}

/**
 * Returning to Auto has to re-derive a tier from somewhere. The detector runs
 * once at boot and is not worth re-running (it burns a WebGL context), so the
 * tier we came in with is the honest answer: it is what the machine was judged
 * capable of before anyone started overriding it.
 */
function guessBack(s) {
  return s._bootTier ?? s.tier ?? Tier.MEDIUM;
}
