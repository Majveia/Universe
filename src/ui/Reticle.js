/**
 * The centre reticle.
 *
 * At rest it is a single dot at a third opacity — enough that your eye knows
 * where the camera is pointing, not enough to notice. It only becomes a
 * *reticle* when there is something in front of it worth aiming at, at which
 * point four corner brackets open outward from the dot. That expansion is the
 * entire interaction language: nothing appeared, something you already had
 * simply opened.
 *
 * Two details that matter more than they look:
 *
 *   Whole-pixel placement. The obvious way to centre something is
 *   `left:50%; transform:translate(-50%,-50%)`. On a 1439px-wide viewport that
 *   puts the dot's centre on x=719.5, and a 2px dot straddling a half pixel is
 *   rendered as a 4px grey smudge by every compositor. So the root is at the
 *   origin and translated by a *rounded* pixel count instead, and all the
 *   geometry inside the SVG sits on half-integer coordinates so that 1px
 *   strokes land exactly on a device pixel column.
 *
 *   The reticle is not a cursor. It has no state of its own worth persisting;
 *   HUD.js tells it what the world is doing each frame and it renders that.
 *   Third person and photo mode simply hide it, because in both of those the
 *   camera is not the weapon.
 */

const el = (tag, cls, parent) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Circumference of the r=16 charge circle; the dash animation is driven off it. */
const CHARGE_CIRCUMFERENCE = 2 * Math.PI * 16;

export class Reticle {
  constructor(root) {
    this.root = el('div', 'reticle hud-chrome', root);
    this.root.setAttribute('aria-hidden', 'true');

    // Built as raw markup because it is static: one parse beats twelve
    // createElementNS calls and there is nothing here to data-bind.
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 80 80');
    svg.innerHTML =
      '<circle class="r-dot" cx="40" cy="40" r="1.3"/>' +
      '<path class="r-brk" d="M26.5 32.5V26.5H32.5"/>' +
      '<path class="r-brk" d="M47.5 26.5H53.5V32.5"/>' +
      '<path class="r-brk" d="M53.5 47.5V53.5H47.5"/>' +
      '<path class="r-brk" d="M32.5 53.5H26.5V47.5"/>' +
      '<circle class="r-ring" cx="40" cy="40" r="15.5"/>' +
      `<circle class="r-charge" cx="40" cy="40" r="16" stroke-dasharray="${CHARGE_CIRCUMFERENCE.toFixed(2)}" stroke-dashoffset="${CHARGE_CIRCUMFERENCE.toFixed(2)}"/>`;
    this.root.appendChild(svg);
    this.charge = svg.querySelector('.r-charge');

    this._visible = false;
    this._aim = null;        // null | 'interact' | 'hostile' | 'scanned'
    this._charge = -1;
    this._hitTimer = 0;
    this._cx = -1;
    this._cy = -1;

    this._onResize = () => this._place();
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);
    this._place();
  }

  _place() {
    // Rounded so the dot lands on a device pixel rather than between two.
    const cx = Math.round(window.innerWidth / 2);
    const cy = Math.round(window.innerHeight / 2);
    if (cx === this._cx && cy === this._cy) return;
    this._cx = cx;
    this._cy = cy;
    this.root.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;
  }

  /** Visible at all? False in third person, photo mode, and open panels. */
  setVisible(v) {
    if (v === this._visible) return;
    this._visible = v;
    this.root.classList.toggle('on', v);
  }

  /**
   * `kind` is null when nothing is under the crosshair, otherwise one of
   * 'interact' | 'hostile' | 'scanned'. Colour carries the meaning; the shape
   * stays identical so the transition never re-flows.
   */
  setAim(kind) {
    if (kind === this._aim) return;
    this._aim = kind;
    const c = this.root.classList;
    c.toggle('aim', !!kind);
    c.toggle('hostile', kind === 'hostile');
    c.toggle('scanned', kind === 'scanned');
  }

  /** 0..1 hold progress, or <0 to clear. Drawn as a dash sweep, no layout. */
  setCharge(t) {
    const v = t > 0 ? Math.min(1, t) : -1;
    if (Math.abs(v - this._charge) < 0.005) return;
    this._charge = v;
    this.charge.style.strokeDashoffset =
      v < 0 ? CHARGE_CIRCUMFERENCE : (CHARGE_CIRCUMFERENCE * (1 - v)).toFixed(2);
    this.charge.style.opacity = v < 0 ? '0' : '0.75';
  }

  /** Hit confirm. Retriggering restarts the animation rather than queueing. */
  hit() {
    const c = this.root.classList;
    c.remove('hit');
    // Reading offsetWidth is the standard way to force the class removal to
    // take effect before it is re-added. It is one forced layout on a
    // zero-size element, at most a few times a second, and there is no
    // alternative that restarts a CSS animation reliably.
    void this.root.offsetWidth;
    c.add('hit');
    this._hitTimer = 0.42;
  }

  update(dt) {
    this._place();
    if (this._hitTimer > 0) {
      this._hitTimer -= dt;
      if (this._hitTimer <= 0) this.root.classList.remove('hit');
    }
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    this.root.remove();
  }
}
