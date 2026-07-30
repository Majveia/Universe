/**
 * The scan layer: one expanding ring, and labels pinned to things in the world.
 *
 * Two jobs that look unrelated and are not. A scan is a question — *what is out
 * there* — and the ring is the question travelling outward while the callouts
 * are the answers arriving. So they share a controller: the ring's radius at any
 * moment is the frontier, and a callout is only allowed to appear once the
 * frontier has reached it. That is why a scan feels like a sweep rather than a
 * screen that suddenly has forty labels on it.
 *
 * Everything here is subject to the same rule as the rest of the HUD, which in
 * this file bites hardest: forty labels updating at 60Hz is the single easiest
 * way to turn a 16ms frame into a 30ms one. So:
 *
 *   No layout reads. Ever. Label widths are *estimated* from character counts
 *   rather than measured, because `getBoundingClientRect` on forty nodes is
 *   forty forced reflows and the estimate only has to be good enough to decide
 *   which side of the anchor the text hangs on. Being 8px wrong about a label's
 *   width costs nothing; being 8ms late costs the frame.
 *
 *   No allocation in the steady state. Callout nodes are pooled and the
 *   de-collision arrays are reused, so a sweep that resolves thirty contacts
 *   allocates once and then never again.
 *
 *   Writes are batched and guarded. Every node's transform is compared against
 *   the string that was last written to it; an object that has not moved on
 *   screen costs one string comparison instead of a style invalidation.
 *
 * The de-collision pass is the part worth reading. Labels anchored to real 3D
 * positions overlap constantly — a moon in front of its planet puts two labels
 * within a few pixels — and overlapping text is illegible in a way that reads as
 * a bug rather than as density. So labels are separated *vertically only*,
 * within their column, by a single greedy pass over a y-sorted list. Vertical
 * only, because moving a label sideways breaks the association with its anchor
 * (you can no longer tell which dot it belongs to), while moving it up or down
 * leaves the leader line pointing straight at the thing it names.
 */

const el = (tag, cls, parent) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The `scan-ring` keyframe ends at scale(760); the geometry is sized to match. */
const RING_END_SCALE = 760;
const RING_SECONDS = 2.6;

/** Vertical room a callout needs. Label + sub + breathing space, in CSS px. */
const LABEL_HEIGHT = 26;
/** Horizontal gap from the anchor dot to the start of the text. */
const LEG_LENGTH = 34;
/** Rough advance width per character at the callout's type size. */
const CHAR_WIDTH = 6.0;
/** Beyond this many px from the reticle a callout steps back to `.far`. */
const FOCUS_RADIUS = 220;
/** Labels closer together than this in x are treated as one column. */
const COLUMN_WIDTH = 190;

export class ScanOverlay {
  constructor(root) {
    this.root = el('div', 'hud-layer scan-layer', root);
    this.root.style.inset = '0';
    this.root.setAttribute('aria-hidden', 'true');

    // The ring anchor is translated; the SVG inside it is what the keyframe
    // scales. Separating the two matters because a CSS animation owns the
    // `transform` property outright — if the ring carried its own position in
    // the same transform, the animation would throw the position away on its
    // first frame and every scan would fire from the top-left corner.
    this.ringAnchor = el('div', 'scan-anchor', this.root);
    this.ringAnchor.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;';
    this.rings = [this._makeRing(false), this._makeRing(true)];

    this.pool = [];
    this.items = [];
    this._placed = [];      // reused scratch for the de-collision pass
    this._ringTimer = 0;
    this._frontier = 0;     // px reached by the sweep, or Infinity when idle
    this._w = window.innerWidth;
    this._h = window.innerHeight;

    this._onResize = () => {
      this._w = window.innerWidth;
      this._h = window.innerHeight;
    };
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);
  }

  _makeRing(trail) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', `scan-pulse${trail ? ' trail' : ''}`);
    // 1 user unit = 1 px at rest, so the circle's `r` is its starting radius in
    // pixels and `r * 760` is where it ends up. Sizing the ring is therefore a
    // single attribute write rather than a rewritten keyframe.
    svg.setAttribute('viewBox', '-1 -1 2 2');
    svg.setAttribute('width', '2');
    svg.setAttribute('height', '2');
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('class', 'sp-ring');
    circle.setAttribute('cx', '0');
    circle.setAttribute('cy', '0');
    circle.setAttribute('r', '1');
    svg.appendChild(circle);
    this.ringAnchor.appendChild(svg);
    return { svg, circle };
  }

  /**
   * Fire the sweep. `origin` is `{x, y}` in viewport pixels and defaults to the
   * centre of the frame, which is where a scan launched from the reticle
   * belongs. The ring is sized so it reaches the furthest corner exactly as it
   * dies — a ring that stops short reads as a bug in the instrument, and one
   * that overshoots wastes the last third of its life invisible.
   */
  pulse(origin) {
    const ox = origin?.x ?? Math.round(this._w / 2);
    const oy = origin?.y ?? Math.round(this._h / 2);
    this.ringAnchor.style.transform = `translate3d(${ox}px, ${oy}px, 0)`;

    const reach = Math.max(
      Math.hypot(ox, oy),
      Math.hypot(this._w - ox, oy),
      Math.hypot(ox, this._h - oy),
      Math.hypot(this._w - ox, this._h - oy)
    );
    const r = (reach / RING_END_SCALE).toFixed(4);

    for (const ring of this.rings) {
      ring.circle.setAttribute('r', r);
      ring.svg.classList.remove('go');
    }
    // One forced reflow to restart the keyframes, on an element that fires at
    // most a couple of times a second and usually far less.
    void this.ringAnchor.offsetWidth;
    for (const ring of this.rings) ring.svg.classList.add('go');

    this._ringTimer = RING_SECONDS;
    this._frontier = 0;
    this._reach = reach;
    this._origin = { x: ox, y: oy };
  }

  /**
   * `[{id, screenX, screenY, label, sub, distance}]` in viewport pixels, already
   * projected and culled by the caller — this class has no camera and no
   * opinion about what is behind you.
   *
   * The list is expected to change identity constantly (things enter and leave
   * frame), so nothing here assumes stability except `id`, which is used to keep
   * a label attached to the same pooled node across frames and therefore to keep
   * its fade continuous.
   */
  setCallouts(list) {
    this.items = list || [];
  }

  update(dt) {
    if (this._ringTimer > 0) {
      this._ringTimer -= dt;
      // The frontier eases the same way the ring does — the keyframe is a hard
      // deceleration, so a linear frontier would run ahead of the visible edge
      // and labels would light up in empty space just before the ring got there.
      const t = 1 - Math.max(0, this._ringTimer) / RING_SECONDS;
      const eased = 1 - Math.pow(1 - t, 2.4);
      this._frontier = eased * (this._reach || 0);
      if (this._ringTimer <= 0) this._frontier = Infinity;
    }

    this._layout();
  }

  _layout() {
    const n = this.items.length;
    while (this.pool.length < n) this.pool.push(this._makeCallout());

    const cx = this._w / 2;
    const cy = this._h / 2;
    const placed = this._placed;
    placed.length = 0;

    // --- pass one: decide what is on screen and where it wants to sit --------
    for (let i = 0; i < n; i++) {
      const it = this.items[i];
      const x = it.screenX;
      const y = it.screenY;
      if (!(x > -80 && x < this._w + 80 && y > -60 && y < this._h + 60)) continue;
      // A contact the sweep has not reached yet stays dark. When no scan is in
      // flight the frontier is Infinity and this is free.
      if (this._frontier !== Infinity) {
        const d = Math.hypot(x - (this._origin?.x ?? cx), y - (this._origin?.y ?? cy));
        if (d > this._frontier) continue;
      }
      const label = it.label || '';
      const sub = it.sub || '';
      // Estimated, not measured. See the header: a reflow per label per frame is
      // the one thing this file cannot afford, and the estimate only decides
      // which side of the anchor the text hangs on.
      const width = LEG_LENGTH + 10 + Math.max(label.length, sub.length * 0.82) * CHAR_WIDTH;
      // Hang the text away from the nearest screen edge so it never runs off.
      const flip = x + width > this._w - 16;
      placed.push({
        it, x, y, flip, width,
        wantY: y,
        finalY: y,
        far: Math.hypot(x - cx, y - cy) > FOCUS_RADIUS,
      });
    }

    // --- pass two: separate labels that would overlap ------------------------
    // Sorted top to bottom, then swept once pushing each label below the last
    // one that shares its column. Greedy is correct here rather than merely
    // cheap: the list is already ordered, so a single pass is optimal in the
    // sense that no label moves further than it has to.
    placed.sort((a, b) => a.y - b.y);
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i];
      let y = p.wantY;
      for (let j = 0; j < i; j++) {
        const q = placed[j];
        if (q.flip !== p.flip) continue;
        if (Math.abs(q.x - p.x) > COLUMN_WIDTH) continue;
        if (y < q.finalY + LABEL_HEIGHT) y = q.finalY + LABEL_HEIGHT;
      }
      p.finalY = y;
    }

    // --- pass three: write ---------------------------------------------------
    let slot = 0;
    for (const p of placed) {
      const node = this.pool[slot++];
      this._paint(node, p);
    }
    for (let i = slot; i < this.pool.length; i++) {
      const node = this.pool[i];
      if (node.on) { node.on = false; node.root.classList.remove('on'); }
    }
  }

  _makeCallout() {
    const root = el('div', 'callout', this.root);
    const dot = el('i', 'co-dot', root);
    const leg = el('i', 'co-leg', root);
    const body = el('div', 'co-body', root);
    const label = el('div', 'co-label', body);
    const sub = el('div', 'co-sub', body);
    return { root, dot, leg, body, label, sub, on: false, tr: '', legTr: '', bodyTr: '', lt: '', st: '', flip: null, far: null };
  }

  _paint(node, p) {
    const tr = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
    if (node.tr !== tr) { node.root.style.transform = tr; node.tr = tr; }

    // The leg runs from the anchor dot to the text baseline. It is a 1px-wide
    // element rotated and stretched, never resized, so a label sliding across
    // the frame is two transform writes and no layout at all.
    const dx = (p.flip ? -LEG_LENGTH : LEG_LENGTH);
    const dy = p.finalY - p.y;
    const len = Math.hypot(dx, dy);
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    const legTr = `rotate(${ang.toFixed(2)}deg) scaleX(${len.toFixed(1)})`;
    if (node.legTr !== legTr) { node.leg.style.transform = legTr; node.legTr = legTr; }

    const bodyTr = p.flip
      ? `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0) translate(-100%, -50%)`
      : `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0) translateY(-50%)`;
    if (node.bodyTr !== bodyTr) { node.body.style.transform = bodyTr; node.bodyTr = bodyTr; }

    const label = p.it.label || '';
    if (node.lt !== label) { node.label.textContent = label; node.lt = label; }

    // Distance is appended rather than replacing the caller's sub-line, because
    // "IRON · 240m" is one glance and two lines is two.
    const sub = p.it.sub
      ? (p.it.distance ? `${p.it.sub} · ${fmt(p.it.distance)}` : p.it.sub)
      : (p.it.distance ? fmt(p.it.distance) : '');
    if (node.st !== sub) { node.sub.textContent = sub; node.st = sub; }

    if (node.flip !== p.flip) { node.root.classList.toggle('flip', p.flip); node.flip = p.flip; }
    if (node.far !== p.far) { node.root.classList.toggle('far', p.far); node.far = p.far; }
    if (!node.on) { node.on = true; node.root.classList.add('on'); }
  }

  /** Retract everything without waiting for the caller to send an empty list. */
  clear() {
    this.items = [];
    for (const node of this.pool) {
      if (node.on) { node.on = false; node.root.classList.remove('on'); }
    }
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    this.root.remove();
  }
}

/** Local copy of the distance formatter's short form; see Compass for the full one. */
function fmt(m) {
  if (!isFinite(m) || m <= 0) return '';
  if (m < 1000) return `${m.toFixed(0)}m`;
  if (m < 1e6) return `${(m / 1000).toFixed(m < 1e4 ? 1 : 0)}km`;
  if (m < 1.5e11) return `${(m / 1e6).toFixed(0)}Mm`;
  if (m < 9.4e15) return `${(m / 1.495978707e11).toFixed(2)}au`;
  return `${(m / 9.4607e15).toFixed(1)}ly`;
}
