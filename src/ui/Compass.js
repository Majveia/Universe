/**
 * The compass: a strip of horizon, not a rose.
 *
 * A rose asks you to translate a rotating needle into a direction. A linear
 * strip is already the thing you are looking at — the ticks slide the same way
 * the world slides — so reading it costs nothing. It lives hard against the top
 * edge, where a glance does not require leaving the centre of the frame.
 *
 * Cost control. The tick marks are built once and never touched again: three
 * identical copies of a 360° track, offset by -360/0/+360 degrees, so the strip
 * wraps seamlessly by moving three parent transforms per frame instead of
 * repositioning a hundred children. Only waypoints and the sun mark — of which
 * there are a handful — get per-frame writes, and each of those is a single
 * `transform`.
 *
 * Relevance. Heading is only a question while you are turning. So opacity is
 * driven by angular velocity: it blooms when the view swings and decays to a
 * near-invisible resting alpha when it settles. A waypoint entering the strip
 * also counts as a reason to be visible, because that *is* new information.
 */

const el = (tag, cls, parent) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
};

const CARDINALS = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
const ORDINALS = { 45: 'NE', 135: 'SE', 225: 'SW', 315: 'NW' };

/** Signed shortest angular difference a-b, in degrees, in (-180, 180]. */
function angDelta(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Distances span metres to megaparsecs, so the unit has to move with them. */
export function formatDistance(m) {
  if (!isFinite(m) || m <= 0) return '—';
  if (m < 1000) return `${m.toFixed(0)}m`;
  if (m < 1e6) return `${(m / 1000).toFixed(m < 1e4 ? 1 : 0)}km`;
  if (m < 1.5e11) return `${(m / 1e6).toFixed(0)}Mm`;
  if (m < 9.4e15) return `${(m / 1.495978707e11).toFixed(2)}au`;
  if (m < 3.09e22) return `${(m / 9.4607e15).toFixed(1)}ly`;
  return `${(m / 3.0857e22).toFixed(1)}Mpc`;
}

export class Compass {
  constructor(root) {
    this.root = el('div', 'compass hud-chrome', root);
    this.root.setAttribute('aria-hidden', 'true');

    el('div', 'compass-line', this.root);

    // One authored track, then two clones. The clones are pure decoration for
    // wraparound; nothing ever addresses their children.
    const track = el('div', 'compass-track');
    for (let d = 0; d < 360; d += 10) {
      const major = d % 30 === 0;
      const t = el('div', major ? 'c-tick major' : 'c-tick', track);
      t.dataset.deg = String(d);
    }
    for (const [deg, label] of Object.entries(CARDINALS)) {
      const c = el('div', 'c-card', track);
      c.textContent = label;
      c.dataset.deg = deg;
    }
    for (const [deg, label] of Object.entries(ORDINALS)) {
      const c = el('div', 'c-card ord', track);
      c.textContent = label;
      c.dataset.deg = deg;
    }

    this.tracks = [];
    for (let i = 0; i < 3; i++) {
      const clone = i === 0 ? track : track.cloneNode(true);
      this.root.appendChild(clone);
      this.tracks.push(clone);
    }

    this.caret = el('div', 'c-caret', this.root);
    this.readout = el('div', 'c-read', this.root);
    this.readout.textContent = '000';

    this.sun = el('div', 'c-sun', this.root);
    this.sun.style.opacity = '0';

    this.wayPool = [];
    this.wayLayer = el('div', 'compass-track', this.root);
    this.wayLayer.style.width = '100%';

    this.heading = 0;
    this.waypoints = [];
    this.sunBearing = null;

    this._activity = 0;
    this._prevHeading = 0;
    this._opacity = -1;
    this._width = 0;
    this._pxPerDeg = 4;
    this._span = 60;       // degrees visible either side of centre
    this._readShown = '';

    // ResizeObserver rather than a resize listener: the strip is a percentage
    // of the viewport and we want the measurement the browser already made,
    // not one we force by reading offsetWidth in the frame loop.
    this._ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width || 0;
      if (w > 0 && Math.abs(w - this._width) > 0.5) {
        this._width = w;
        this._layout();
      }
    });
    this._ro.observe(this.root);
  }

  _layout() {
    // Fit ±span degrees across the strip. On a phone the strip is half as wide,
    // so the same span would compress the ticks into a comb — narrow the span
    // instead and keep the tick density legible.
    this._span = this._width < 360 ? 42 : 60;
    this._pxPerDeg = this._width / (this._span * 2);
    for (const track of this.tracks) {
      for (const child of track.children) {
        const d = parseFloat(child.dataset.deg);
        // Cardinal labels centre themselves on their own width; ticks are
        // centred by a negative margin and need no second term.
        const centre = child.classList.contains('c-card') ? ' translateX(-50%)' : '';
        child.style.transform = `translate3d(${(d * this._pxPerDeg).toFixed(2)}px,0,0)${centre}`;
      }
    }
  }

  /**
   * @param {object} d
   * @param {number} d.heading   degrees, 0 = north, clockwise
   * @param {Array}  [d.waypoints] `[{bearing, distance, label}]`
   * @param {number} [d.sunBearing] degrees, or null/undefined for no sun
   */
  set(d) {
    if (typeof d.heading === 'number') this.heading = ((d.heading % 360) + 360) % 360;
    if (d.waypoints) this.waypoints = d.waypoints;
    if ('sunBearing' in d) this.sunBearing = d.sunBearing;
  }

  update(dt) {
    if (this._width <= 0) return;

    // --- relevance -----------------------------------------------------
    const turn = Math.abs(angDelta(this.heading, this._prevHeading)) / Math.max(dt, 1e-4);
    this._prevHeading = this.heading;
    // 45 deg/s is a deliberate turn; below that you are drifting and do not
    // need an instrument.
    const excite = Math.min(1, turn / 45);
    this._activity = Math.max(excite, this._activity - dt * 0.85);

    let nearWaypoint = 0;
    const half = this._width / 2;
    const ppd = this._pxPerDeg;

    // --- waypoints -----------------------------------------------------
    const n = this.waypoints.length;
    while (this.wayPool.length < n) {
      const w = el('div', 'c-way', this.wayLayer);
      el('i', null, w);
      el('b', null, w);
      this.wayPool.push({ node: w, dist: w.lastChild, shownDist: '', vis: false });
    }
    for (let i = 0; i < this.wayPool.length; i++) {
      const slot = this.wayPool[i];
      const wp = this.waypoints[i];
      if (!wp) {
        if (slot.vis) { slot.node.style.opacity = '0'; slot.vis = false; }
        continue;
      }
      const delta = angDelta(wp.bearing, this.heading);
      const inside = Math.abs(delta) <= this._span * 0.94;
      if (!inside) {
        if (slot.vis) { slot.node.style.opacity = '0'; slot.vis = false; }
        continue;
      }
      // Proximity to the centre of the strip is itself a reason to be lit.
      nearWaypoint = Math.max(nearWaypoint, 1 - Math.abs(delta) / this._span);
      slot.node.style.transform = `translate3d(${(half + delta * ppd).toFixed(2)}px,0,0) translateX(-50%)`;
      const text = wp.label
        ? `${wp.label} ${formatDistance(wp.distance)}`
        : formatDistance(wp.distance);
      if (text !== slot.shownDist) { slot.dist.textContent = text; slot.shownDist = text; }
      if (!slot.vis) { slot.node.style.opacity = '1'; slot.vis = true; }
    }

    // --- sun -----------------------------------------------------------
    if (typeof this.sunBearing === 'number') {
      const delta = angDelta(this.sunBearing, this.heading);
      if (Math.abs(delta) <= this._span) {
        this.sun.style.transform = `translate3d(${(half + delta * ppd).toFixed(2)}px,0,0)`;
        this.sun.style.opacity = '0.5';
      } else {
        this.sun.style.opacity = '0';
      }
    } else if (this.sun.style.opacity !== '0') {
      this.sun.style.opacity = '0';
    }

    // --- the strip itself ----------------------------------------------
    const base = half - this.heading * ppd;
    const cycle = 360 * ppd;
    for (let i = 0; i < 3; i++) {
      this.tracks[i].style.transform = `translate3d(${(base + (i - 1) * cycle).toFixed(2)}px,0,0)`;
    }

    const deg = Math.round(this.heading) % 360;
    // Within a couple of degrees of a named direction, name it — that is the
    // moment the letter is worth more than the number.
    const snap = Math.round(deg / 45) * 45 % 360;
    const named = Math.abs(angDelta(deg, snap)) <= 2 ? (CARDINALS[snap] || ORDINALS[snap]) : '';
    const label = named ? `${String(deg).padStart(3, '0')} ${named}` : String(deg).padStart(3, '0');
    if (label !== this._readShown) {
      this._readShown = label;
      this.readout.textContent = label;
    }

    // Resting alpha of 0.11 is visible on an OLED only if you go looking.
    const target = 0.11 + 0.89 * Math.max(this._activity, nearWaypoint * 0.55);
    if (Math.abs(target - this._opacity) > 0.008) {
      this._opacity = target;
      this.root.style.opacity = target.toFixed(3);
    }
  }

  setVisible(v) {
    this.root.style.display = v ? '' : 'none';
  }

  dispose() {
    this._ro.disconnect();
    this.root.remove();
  }
}
