/**
 * Roads, and the ground they had to be argued out of.
 *
 * A city's street plan is the most legible record it keeps of its terrain. Roads
 * are the one piece of infrastructure that cannot lie about slope: a highway
 * that climbs a mountain in a straight line is the single loudest tell that a
 * world was generated rather than surveyed, because no one has ever built one.
 * Real roads take the cheapest line, and "cheapest" is dominated by grade — so
 * they run along contours, double back on themselves to gain height, cross water
 * at its narrowest point, and go *through* a ridge when going over it would cost
 * more than boring it.
 *
 * All of that falls out of two stages rather than being authored:
 *
 *   Route in plan. A* over a coarse terrain lattice where the edge cost is
 *   length times a quadratic penalty on grade. Set the penalty high enough and
 *   the router discovers switchbacks on its own, because eight hundred metres
 *   of traverse genuinely is cheaper than two hundred metres of cliff. Already
 *   routed corridors are discounted, so the network grows trunks and branches
 *   instead of a star of parallel roads out of the centre.
 *
 *   Then fit a profile. Take the exact terrain height under the route, relax it
 *   until no segment exceeds the maximum grade, and hold it above the waterline.
 *   Where the fitted profile sits below the ground it is a tunnel; where it sits
 *   above, a viaduct; where the ground is below sea level, a bridge. Cut, fill,
 *   bore and span all come from one number, which is how a highway engineer
 *   thinks about it and why the result looks like a highway.
 *
 * The layout half of this file is pure arithmetic and runs under Node. Only
 * `buildRoads` and `makeRoadMaterial` touch three.js.
 *
 * Draw-call cost of this module: 2 — one merged opaque mesh (deck, kerbs,
 * skirts, piers, portals, plazas, lamp posts) and, when the caller does not hand
 * one in, one merged emissive mesh (lamp heads, lane strips, tunnel lighting).
 */

import * as THREE from 'three';
import { Rng, hashInt } from '../core/Rng.js';
import { clamp, lerp, smoothstep } from '../core/Noise.js';
import { MeshBuilder } from './BuildingKit.js';

const TAU = Math.PI * 2;

// --- terrain sampling --------------------------------------------------------

/**
 * A cached square of the height field.
 *
 * Routing hits the same few thousand samples tens of thousands of times, so the
 * injected `sampleHeight` is evaluated once onto a lattice and everything after
 * reads bilinearly out of a Float32Array. The lattice is deliberately coarse —
 * it decides *where* a road goes, not what height it sits at; the profile stage
 * re-samples the real field along the chosen line.
 */
export class TerrainGrid {
  constructor(opts) {
    this.sampleHeight = opts.sampleHeight || (() => 0);
    this._normalFn = opts.sampleNormal || null;
    this.seaLevel = opts.seaLevel ?? -1e9;
    this.cx = opts.cx ?? 0;
    this.cz = opts.cz ?? 0;
    this.radius = opts.radius ?? 1000;
    const n = (this.n = Math.max(16, Math.min(257, opts.n ?? 129)));
    this.cell = (this.radius * 2) / (n - 1);
    this.x0 = this.cx - this.radius;
    this.z0 = this.cz - this.radius;

    const h = (this.h = new Float32Array(n * n));
    for (let j = 0; j < n; j++) {
      const z = this.z0 + j * this.cell;
      for (let i = 0; i < n; i++) h[j * n + i] = this.sampleHeight(this.x0 + i * this.cell, z);
    }

    // Central-difference gradient, stored as a magnitude. Used both by the
    // router's cost function and by site selection, so it is worth the pass.
    const g = (this.grade = new Float32Array(n * n));
    const inv = 1 / (2 * this.cell);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const im = Math.max(0, i - 1), ip = Math.min(n - 1, i + 1);
        const jm = Math.max(0, j - 1), jp = Math.min(n - 1, j + 1);
        const dx = (h[j * n + ip] - h[j * n + im]) * inv * (ip - im === 2 ? 1 : 2);
        const dz = (h[jp * n + i] - h[jm * n + i]) * inv * (jp - jm === 2 ? 1 : 2);
        g[j * n + i] = Math.hypot(dx, dz);
      }
    }

    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < h.length; i++) { if (h[i] < lo) lo = h[i]; if (h[i] > hi) hi = h[i]; }
    this.minHeight = lo;
    this.maxHeight = hi;
  }

  index(i, j) {
    const n = this.n;
    return Math.min(n - 1, Math.max(0, j)) * n + Math.min(n - 1, Math.max(0, i));
  }

  /** Bilinear read of the cached lattice — approximate, and fast. */
  heightAt(x, z) {
    const n = this.n;
    const fx = clamp((x - this.x0) / this.cell, 0, n - 1.001);
    const fz = clamp((z - this.z0) / this.cell, 0, n - 1.001);
    const i = fx | 0, j = fz | 0;
    const tx = fx - i, tz = fz - j;
    const h = this.h;
    const a = h[j * n + i], b = h[j * n + i + 1];
    const c = h[(j + 1) * n + i], d = h[(j + 1) * n + i + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }

  gradeAt(x, z) {
    const n = this.n;
    const i = clamp(Math.round((x - this.x0) / this.cell), 0, n - 1);
    const j = clamp(Math.round((z - this.z0) / this.cell), 0, n - 1);
    return this.grade[j * n + i];
  }

  /** Exact when the caller supplied one, otherwise finite-differenced. */
  normalAt(x, z) {
    if (this._normalFn) return this._normalFn(x, z);
    const e = this.cell * 0.5;
    const hx = this.sampleHeight(x + e, z) - this.sampleHeight(x - e, z);
    const hz = this.sampleHeight(x, z + e) - this.sampleHeight(x, z - e);
    const nx = -hx / (2 * e), nz = -hz / (2 * e);
    const l = Math.hypot(nx, 1, nz) || 1;
    return [nx / l, 1 / l, nz / l];
  }

  underwater(x, z) { return this.heightAt(x, z) < this.seaLevel; }
}

// --- routing -----------------------------------------------------------------

/** Binary min-heap over parallel arrays. Allocation-free in the inner loop. */
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      const tk = k[p]; k[p] = k[i]; k[i] = tk;
      const tv = v[p]; v[p] = v[i]; v[i] = tv;
      i = p;
    }
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        const tk = k[m]; k[m] = k[i]; k[i] = tk;
        const tv = v[m]; v[m] = v[i]; v[i] = tv;
        i = m;
      }
    }
    return top;
  }
}

// Eight compass steps plus eight knight steps. The knight moves are what let a
// route hold a 26 degree bearing instead of snapping to multiples of 45, which
// is the difference between a road and a staircase.
const STEPS = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
  [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2],
];

/**
 * Least-cost route between two world points.
 *
 * `usage` is a per-cell multiplier the caller mutates after each route so later
 * roads prefer to share a corridor. That single feedback term is what turns a
 * set of independent shortest paths into a road *network*.
 */
export function routePath(grid, ax, az, bx, bz, o = {}) {
  const n = grid.n, cell = grid.cell, h = grid.h;
  const maxGrade = o.maxGrade ?? 0.085;
  const slopePenalty = o.slopePenalty ?? 26;
  const bridgeCost = o.bridgeCost ?? 9;
  const sea = grid.seaLevel;
  const usage = o.usage || null;
  const maxExpand = o.maxExpand ?? n * n * 2;

  const si = clamp(Math.round((ax - grid.x0) / cell), 0, n - 1);
  const sj = clamp(Math.round((az - grid.z0) / cell), 0, n - 1);
  const ti = clamp(Math.round((bx - grid.x0) / cell), 0, n - 1);
  const tj = clamp(Math.round((bz - grid.z0) / cell), 0, n - 1);
  const start = sj * n + si, goal = tj * n + ti;
  if (start === goal) return [[ax, az], [bx, bz]];

  const g = new Float32Array(n * n).fill(Infinity);
  const from = new Int32Array(n * n).fill(-1);
  const closed = new Uint8Array(n * n);
  const heap = new Heap();
  g[start] = 0;
  heap.push(0, start);
  let expanded = 0;

  while (heap.size) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goal) break;
    if (++expanded > maxExpand) break;

    const ci = cur % n, cj = (cur / n) | 0;
    const h0 = h[cur];
    for (let s = 0; s < STEPS.length; s++) {
      const ni = ci + STEPS[s][0], nj = cj + STEPS[s][1];
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
      const nk = nj * n + ni;
      if (closed[nk]) continue;
      const h1 = h[nk];
      const len = Math.hypot(STEPS[s][0] * cell, STEPS[s][1] * cell);
      const gr = Math.abs(h1 - h0) / len;
      // Quadratic in grade, so a gentle traverse is nearly free and a scramble
      // is ruinous. This one line is the whole reason switchbacks appear.
      let c = len * (1 + slopePenalty * (gr / maxGrade) * (gr / maxGrade));
      if ((h0 + h1) * 0.5 < sea) c += len * bridgeCost;
      if (usage) c *= usage[nk];
      const ng = g[cur] + c;
      if (ng < g[nk]) {
        g[nk] = ng;
        from[nk] = cur;
        const dx = (ti - ni) * cell, dz = (tj - nj) * cell;
        heap.push(ng + Math.hypot(dx, dz), nk);
      }
    }
  }

  if (from[goal] < 0 && start !== goal) {
    // Unreachable within the budget: fall back to the straight line rather than
    // dropping the road, because a missing arterial is far more visible than a
    // slightly rude one.
    return [[ax, az], [bx, bz]];
  }

  const out = [];
  for (let k = goal; k >= 0; k = from[k]) {
    out.push([grid.x0 + (k % n) * cell, grid.z0 + (((k / n) | 0)) * cell]);
    if (k === start) break;
  }
  out.reverse();
  out[0] = [ax, az];
  out[out.length - 1] = [bx, bz];

  if (usage) {
    // Discount this corridor and a one-cell skirt around it. The skirt matters:
    // without it parallel roads sit exactly one cell apart and read as a moire.
    for (const p of out) {
      const i = clamp(Math.round((p[0] - grid.x0) / cell), 0, n - 1);
      const j = clamp(Math.round((p[1] - grid.z0) / cell), 0, n - 1);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const k = grid.index(i + di, j + dj);
          const d = di === 0 && dj === 0 ? (o.reuse ?? 0.22) : (o.reuse ?? 0.22) * 2.2;
          usage[k] = Math.min(usage[k], Math.max(0.12, d));
        }
      }
    }
  }
  return out;
}

// --- polyline utilities ------------------------------------------------------

/** Chaikin corner cutting. Two rounds turns a lattice path into a road. */
export function chaikin(pts, rounds = 2, closed = false) {
  let cur = pts;
  for (let r = 0; r < rounds; r++) {
    if (cur.length < 3) return cur;
    const out = closed ? [] : [cur[0]];
    const n = cur.length;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = cur[i], b = cur[(i + 1) % n];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    if (!closed) out.push(cur[n - 1]);
    cur = out;
  }
  return cur;
}

/** Uniform arclength resample of a 2D polyline. */
export function resample(pts, step) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]];
  let carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    let t = step - carry;
    while (t <= len) {
      out.push([a[0] + (dx * t) / len, a[1] + (dz * t) / len]);
      t += step;
    }
    carry = (len - (t - step)) % step;
  }
  const last = pts[pts.length - 1];
  const prev = out[out.length - 1];
  if (Math.hypot(last[0] - prev[0], last[1] - prev[1]) > step * 0.4) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

export function polylineLength(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}

// --- profile fitting ---------------------------------------------------------

/**
 * Turns a 2D route into a 3D road, and decides where it is a bridge and where
 * it is a tunnel.
 *
 * The relaxation is symmetric on purpose. A one-sided grade clamp drags the
 * whole profile downhill and every road ends up in a trench; pushing both ends
 * of an over-steep segment toward each other keeps the profile centred on the
 * terrain and produces the balanced cut-and-fill a real alignment has.
 */
export function fitProfile(pts, sample, o = {}) {
  const n = pts.length;
  const maxGrade = o.maxGrade ?? 0.085;
  const sea = o.seaLevel ?? -1e9;
  const freeboard = o.freeboard ?? 5.5;
  const raw = new Float64Array(n);
  const ds = new Float64Array(n);
  for (let i = 0; i < n; i++) raw[i] = sample(pts[i][0], pts[i][1]);
  for (let i = 1; i < n; i++) ds[i] = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) || 1e-3;

  const y = new Float64Array(n);
  // Seed with a short box blur so single-sample spikes never drive the fit.
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2);
    let s = 0;
    for (let k = a; k <= b; k++) s += raw[k];
    y[i] = s / (b - a + 1);
  }
  // Water forces the deck up: a road does not dip into a lake on its way past.
  for (let i = 0; i < n; i++) if (raw[i] < sea) y[i] = Math.max(y[i], sea + freeboard);

  for (let pass = 0; pass < 48; pass++) {
    let worst = 0;
    for (let i = 1; i < n; i++) {
      const limit = maxGrade * ds[i];
      const d = y[i] - y[i - 1];
      const over = Math.abs(d) - limit;
      if (over > 0) {
        worst = Math.max(worst, over);
        const push = (over * 0.5 + 1e-4) * Math.sign(d);
        y[i] -= push;
        y[i - 1] += push;
      }
    }
    // Endpoints are junctions and must stay where the network expects them.
    y[0] = Math.max(y[0], raw[0] < sea ? sea + freeboard : raw[0] - (o.maxCut ?? 3));
    y[n - 1] = Math.max(y[n - 1], raw[n - 1] < sea ? sea + freeboard : raw[n - 1] - (o.maxCut ?? 3));
    for (let i = 0; i < n; i++) if (raw[i] < sea) y[i] = Math.max(y[i], sea + freeboard);
    if (worst < 0.01) break;
  }

  const tunnelDepth = o.tunnelDepth ?? 7;
  const viaductHeight = o.viaductHeight ?? 4.5;
  const nodes = new Array(n);
  for (let i = 0; i < n; i++) {
    const cut = raw[i] - y[i];
    let kind = 'ground';
    if (raw[i] < sea) kind = 'bridge';
    else if (cut > tunnelDepth) kind = 'tunnel';
    else if (-cut > viaductHeight) kind = 'bridge';
    nodes[i] = { x: pts[i][0], y: y[i], z: pts[i][1], raw: raw[i], cut, kind, s: 0 };
  }
  // Runs shorter than three samples are noise in the classification, not
  // architecture. Collapsing them stops a highway sprouting a four-metre tunnel.
  for (let i = 0; i < n; i++) {
    if (nodes[i].kind === 'ground') continue;
    let j = i;
    while (j + 1 < n && nodes[j + 1].kind === nodes[i].kind) j++;
    if (j - i < 2) for (let k = i; k <= j; k++) nodes[k].kind = 'ground';
    i = j;
  }
  let s = 0;
  for (let i = 0; i < n; i++) { if (i) s += ds[i]; nodes[i].s = s; }
  return nodes;
}

// --- road field --------------------------------------------------------------

/**
 * Distance-to-nearest-road, as a raster.
 *
 * Building placement asks "how far is this lot from tarmac" hundreds of
 * thousands of times, and testing every segment each time is quadratic. A
 * chamfer distance transform answers it in one array read, and the same field
 * doubles as the frontage test — a lot whose distance is just past the setback
 * is by definition on a street.
 */
export class RoadField {
  constructor(paths, o = {}) {
    this.cell = o.cell ?? 6;
    this.x0 = o.x0 ?? 0;
    this.z0 = o.z0 ?? 0;
    const n = (this.n = Math.max(16, Math.min(1024, o.n ?? 256)));
    const d = (this.d = new Float32Array(n * n).fill(1e6));
    // Rasterise the carriageway, then grow outward. Each sample stamps a disc
    // rather than a point so a coarse cell cannot leak between two samples.
    for (const p of paths) {
      const hw = (p.width ?? 8) * 0.5 + (o.margin ?? 0);
      const pts = p.nodes || p;
      for (let i = 0; i < pts.length; i++) {
        const px = pts[i].x ?? pts[i][0];
        const pz = pts[i].z ?? pts[i][1];
        const r = Math.ceil(hw / this.cell);
        const ci = Math.round((px - this.x0) / this.cell);
        const cj = Math.round((pz - this.z0) / this.cell);
        for (let dj = -r; dj <= r; dj++) {
          const j = cj + dj;
          if (j < 0 || j >= n) continue;
          for (let di = -r; di <= r; di++) {
            const ii = ci + di;
            if (ii < 0 || ii >= n) continue;
            const dist = Math.hypot(di * this.cell, dj * this.cell) - hw;
            const k = j * n + ii;
            if (dist < d[k]) d[k] = Math.max(0, dist);
          }
        }
      }
    }
    const c = this.cell, dg = c * 1.41421356;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        let v = d[k];
        if (i > 0) v = Math.min(v, d[k - 1] + c);
        if (j > 0) v = Math.min(v, d[k - n] + c);
        if (i > 0 && j > 0) v = Math.min(v, d[k - n - 1] + dg);
        if (i < n - 1 && j > 0) v = Math.min(v, d[k - n + 1] + dg);
        d[k] = v;
      }
    }
    for (let j = n - 1; j >= 0; j--) {
      for (let i = n - 1; i >= 0; i--) {
        const k = j * n + i;
        let v = d[k];
        if (i < n - 1) v = Math.min(v, d[k + 1] + c);
        if (j < n - 1) v = Math.min(v, d[k + n] + c);
        if (i < n - 1 && j < n - 1) v = Math.min(v, d[k + n + 1] + dg);
        if (i > 0 && j < n - 1) v = Math.min(v, d[k + n - 1] + dg);
        d[k] = v;
      }
    }
  }

  distance(x, z) {
    const n = this.n;
    const i = Math.round((x - this.x0) / this.cell);
    const j = Math.round((z - this.z0) / this.cell);
    if (i < 0 || j < 0 || i >= n || j >= n) return 1e6;
    return this.d[j * n + i];
  }

  /** Downhill direction of the distance field — points away from the street. */
  gradient(x, z, out = [0, 0]) {
    const e = this.cell;
    out[0] = this.distance(x + e, z) - this.distance(x - e, z);
    out[1] = this.distance(x, z + e) - this.distance(x, z - e);
    const l = Math.hypot(out[0], out[1]) || 1;
    out[0] /= l; out[1] /= l;
    return out;
  }
}

// --- street patterns ---------------------------------------------------------

/**
 * The local streets inside one district.
 *
 * Arterials get routed because they cross the whole site and the terrain has an
 * opinion about them. Local streets do not: they are laid out by habit, and the
 * habit is the culture's settlement pattern. A surveyed grid stays a grid even
 * where it should not; a terraced town follows the contour because carrying
 * water uphill is the thing it organises itself around; an organic town is the
 * hardened residue of footpaths and never resolves into anything.
 */
export function localStreets(district, civ, grid, rng, o = {}) {
  const out = [];
  const r = district.radius;
  const cx = district.x, cz = district.z;
  const spacing = clamp(o.spacing ?? civ.settlement.blockScale, 26, 220);
  const pattern = civ.settlement.pattern;
  const yaw = district.yaw ?? 0;
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  const L = (u, v) => [cx + u * ca - v * sa, cz + u * sa + v * ca];

  const push = (pts) => {
    if (pts.length > 2) out.push(pts);
  };

  if (pattern === 'terraced' || (civ.settlement.terracing > 0.6 && rng.bool(0.6))) {
    // Contour following: step perpendicular to the local gradient. The road
    // holds its altitude, which is exactly what a hill town's streets do, and
    // the cross-streets become stairs — implied here by their steepness.
    const bands = Math.max(2, Math.round((r * 2) / spacing));
    for (let b = 0; b < bands; b++) {
      const startV = -r + ((b + 0.5) * (r * 2)) / bands;
      const seed = L(-r * 0.85, startV);
      const pts = [seed];
      let px = seed[0], pz = seed[1];
      const target = grid.heightAt(px, pz);
      const stepLen = spacing * 0.35;
      for (let k = 0; k < 90; k++) {
        // March roughly along +u, corrected back toward the seed altitude.
        const e = 4;
        const gx = (grid.heightAt(px + e, pz) - grid.heightAt(px - e, pz)) / (2 * e);
        const gz = (grid.heightAt(px, pz + e) - grid.heightAt(px, pz - e)) / (2 * e);
        const gl = Math.hypot(gx, gz) || 1e-4;
        // Tangent to the contour, oriented to keep travelling the same way.
        let tx = -gz / gl, tz = gx / gl;
        if (tx * ca + tz * sa < 0) { tx = -tx; tz = -tz; }
        const err = clamp((target - grid.heightAt(px, pz)) * 0.12, -0.6, 0.6);
        tx += (-gx / gl) * err; tz += (-gz / gl) * err;
        const tl = Math.hypot(tx, tz) || 1;
        px += (tx / tl) * stepLen;
        pz += (tz / tl) * stepLen;
        if (Math.hypot(px - cx, pz - cz) > r * 1.1) break;
        pts.push([px, pz]);
      }
      push(pts);
    }
    // A handful of climbing links so the terraces are actually connected.
    const links = Math.max(1, Math.round(r / (spacing * 1.6)));
    for (let i = 0; i < links; i++) {
      const u = lerp(-r * 0.7, r * 0.7, (i + 0.5) / links) + rng.range(-8, 8);
      push([L(u, -r * 0.8), L(u + rng.range(-20, 20), 0), L(u, r * 0.8)]);
    }
    return out;
  }

  if (pattern === 'organic' || pattern === 'scattered') {
    // Lay a few wandering spines and hang short lanes off them. The wander is
    // low-frequency: a street that wobbles every ten metres reads as a mistake,
    // one that drifts over a hundred reads as history.
    const spines = Math.max(2, Math.round((r * 2) / (spacing * 1.35)));
    for (let s = 0; s < spines; s++) {
      const a0 = rng.range(0, TAU);
      const pts = [];
      let px = cx + Math.cos(a0) * r * rng.range(0.75, 1.0);
      let pz = cz + Math.sin(a0) * r * rng.range(0.75, 1.0);
      let dir = Math.atan2(cz - pz, cx - px) + rng.range(-0.5, 0.5);
      const steps = Math.round((r * 2) / (spacing * 0.3));
      for (let k = 0; k < steps; k++) {
        pts.push([px, pz]);
        dir += rng.range(-0.16, 0.16) + Math.sin(k * 0.21 + s) * 0.05;
        px += Math.cos(dir) * spacing * 0.3;
        pz += Math.sin(dir) * spacing * 0.3;
        if (Math.hypot(px - cx, pz - cz) > r * 1.08) break;
      }
      push(pts);
      const lanes = rng.int(1, 3);
      for (let l = 0; l < lanes; l++) {
        if (pts.length < 4) break;
        const i = rng.int(1, pts.length - 2);
        const a = rng.range(0, TAU);
        push([pts[i], [pts[i][0] + Math.cos(a) * spacing * 0.8, pts[i][1] + Math.sin(a) * spacing * 0.8]]);
      }
    }
    return out;
  }

  if (pattern === 'radial' || pattern === 'spoke') {
    const rings = Math.max(1, Math.round(r / spacing));
    for (let k = 1; k <= rings; k++) {
      const rr = (k / rings) * r * 0.95;
      const seg = Math.max(10, Math.round((TAU * rr) / (spacing * 0.35)));
      const pts = [];
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * TAU + yaw;
        pts.push([cx + Math.cos(a) * rr, cz + Math.sin(a) * rr]);
      }
      push(pts);
    }
    const spokes = Math.max(4, Math.round((TAU * r) / (spacing * 1.5)));
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * TAU + yaw + rng.range(-0.05, 0.05);
      push([[cx + Math.cos(a) * r * 0.06, cz + Math.sin(a) * r * 0.06],
        [cx + Math.cos(a) * r * 0.55, cz + Math.sin(a) * r * 0.55],
        [cx + Math.cos(a) * r * 0.98, cz + Math.sin(a) * r * 0.98]]);
    }
    return out;
  }

  // grid and linear. `linear` gets a strong anisotropy: three blocks deep and
  // as long as the valley allows, which is what a road-town or a rail-town is.
  const anis = pattern === 'linear' ? 3.2 : 1.0;
  const nu = Math.max(2, Math.round((r * 2 * anis) / spacing));
  const nv = Math.max(2, Math.round((r * 2) / (spacing * anis)));
  const jitter = civ.settlement.organic * spacing * 0.06;
  for (let i = 0; i <= nu; i++) {
    const u = lerp(-r * anis, r * anis, i / nu);
    const pts = [];
    for (let k = 0; k <= 6; k++) {
      const v = lerp(-r, r, k / 6);
      const p = L(u + rng.range(-jitter, jitter), v);
      pts.push(p);
    }
    push(pts);
  }
  for (let j = 0; j <= nv; j++) {
    const v = lerp(-r, r, j / nv);
    const pts = [];
    for (let k = 0; k <= 6; k++) {
      const u = lerp(-r * anis, r * anis, k / 6);
      pts.push(L(u, v + rng.range(-jitter, jitter)));
    }
    push(pts);
  }
  return out;
}

// --- the plan ----------------------------------------------------------------

const CLASS_WIDTH = { highway: 1.9, arterial: 1.35, street: 0.72, lane: 0.42 };

/**
 * Builds the whole network: highways out to the horizon, arterials between
 * district centres, a ring if the culture thinks in rings, and local streets
 * inside each district. Returns plain data — no three.js — so a worker or a
 * Node test can hold the entire plan.
 */
export function planRoads(opts) {
  const { grid, civ, districts, core } = opts;
  const rng = opts.rng || new Rng(hashInt((civ.seed ^ 0x0adbeef) >>> 0));
  const base = civ.settlement.streetWidth;
  const usage = new Float32Array(grid.n * grid.n).fill(1);
  const maxGrade = clamp(0.16 - civ.tech.level * 0.06, 0.055, 0.16);
  const routeOpts = {
    usage, maxGrade,
    slopePenalty: lerp(40, 16, civ.tech.level),
    bridgeCost: lerp(16, 5, civ.tech.level),
    maxExpand: grid.n * grid.n * 3,
  };
  const profOpts = {
    maxGrade, seaLevel: grid.seaLevel,
    freeboard: lerp(4, 9, civ.tech.level),
    tunnelDepth: lerp(14, 6, civ.tech.level),
    viaductHeight: lerp(9, 3.5, civ.tech.level),
  };

  const paths = [];
  const addPath = (pts2d, cls, meta = {}) => {
    if (pts2d.length < 2) return null;
    const smooth = chaikin(pts2d, cls === 'street' || cls === 'lane' ? 1 : 2);
    const step = cls === 'highway' || cls === 'arterial' ? 14 : 10;
    const rs = resample(smooth, step);
    if (rs.length < 2) return null;
    const nodes = fitProfile(rs, (x, z) => grid.sampleHeight(x, z), profOpts);
    const width = base * CLASS_WIDTH[cls] * (meta.widthScale ?? 1);
    const p = {
      cls, width, nodes,
      length: nodes[nodes.length - 1].s,
      district: meta.district ?? -1,
      seed: rng.next(),
    };
    paths.push(p);
    return p;
  };

  // Trunks first so everything after can share their corridors.
  const junctions = [{ x: core.x, z: core.z, degree: 0, plaza: 1.0, kind: 'core' }];
  for (const d of districts) {
    const route = routePath(grid, core.x, core.z, d.x, d.z, routeOpts);
    const p = addPath(route, 'arterial', { district: d.index });
    if (p) {
      d.arterial = p;
      junctions.push({ x: d.x, z: d.z, degree: 0, plaza: d.character.plaza, kind: d.kind });
    }
  }

  // Highways leaving the site. A city with no visible reason to exist beyond
  // its own edge reads as a diorama; roads running off the map fix that for
  // almost nothing.
  const gateCount = clamp(Math.round(1 + civ.tech.level * 4), 2, 5);
  const gates = [];
  for (let i = 0; i < gateCount; i++) {
    const a = (i / gateCount) * TAU + rng.range(0, 0.6);
    const rr = grid.radius * 0.97;
    let gx = grid.cx + Math.cos(a) * rr, gz = grid.cz + Math.sin(a) * rr;
    // Nudge the gate to the least awful cell on that bearing: a highway that
    // terminates in a cliff face is worse than one that leaves at an angle.
    let best = Infinity;
    for (let k = -6; k <= 6; k++) {
      const aa = a + k * 0.06;
      const tx = grid.cx + Math.cos(aa) * rr, tz = grid.cz + Math.sin(aa) * rr;
      const cost = grid.gradeAt(tx, tz) + (grid.heightAt(tx, tz) < grid.seaLevel ? 3 : 0);
      if (cost < best) { best = cost; gx = tx; gz = tz; }
    }
    const route = routePath(grid, core.x, core.z, gx, gz, routeOpts);
    const p = addPath(route, 'highway', {});
    if (p) gates.push({ x: gx, z: gz, path: p });
  }

  // A ring road, if the culture thinks in rings at all. Routed segment by
  // segment through the district centres so it obeys the same terrain the
  // arterials did instead of hovering as a perfect circle.
  if (civ.settlement.ring > 0.45 && districts.length >= 3) {
    const ordered = districts.slice().sort((a, b) =>
      Math.atan2(a.z - core.z, a.x - core.x) - Math.atan2(b.z - core.z, b.x - core.x));
    const loop = [];
    for (let i = 0; i < ordered.length; i++) {
      const a = ordered[i], b = ordered[(i + 1) % ordered.length];
      const seg = routePath(grid, a.x, a.z, b.x, b.z, routeOpts);
      for (let k = i === 0 ? 0 : 1; k < seg.length; k++) loop.push(seg[k]);
    }
    addPath(loop, 'arterial', { widthScale: 1.15 });
  }

  // Local streets, then the alleys that make a block a block.
  for (const d of districts) {
    const spacing = civ.settlement.blockScale * clamp(d.character.lot, 0.35, 3.4) * lerp(1.25, 0.72, d.density);
    const streets = localStreets(d, civ, grid, rng, { spacing });
    for (const s of streets) {
      // Clip to the district's own cell so quarters do not bleed into each other.
      const clipped = clipToDistrict(s, d, districts);
      for (const piece of clipped) {
        if (polylineLength(piece) < spacing * 0.6) continue;
        addPath(piece, d.character.lot < 0.6 ? 'lane' : 'street', { district: d.index });
      }
    }
  }

  // Junction plazas. Only where roads genuinely meet and the district is the
  // sort that has public space — a plaza in an industrial yard is a car park.
  const plazas = [];
  for (const j of junctions) {
    const w = j.plaza ?? 0.4;
    if (w < 0.25) continue;
    if (!rng.bool(clamp(w * civ.settlement.plazaFrequency * 3.0, 0.1, 0.95))) continue;
    const r = lerp(14, 46, w) * lerp(0.8, 1.4, rng.next());
    plazas.push({
      x: j.x, z: j.z, y: grid.sampleHeight(j.x, j.z),
      radius: r,
      sides: rng.weighted([4, 6, 8, 14], [0.8, 1.0, 1.0, 1.2]),
      rot: rng.range(0, TAU),
      kind: j.kind,
      seed: rng.next(),
    });
  }

  let bridgeSpans = 0, tunnelSpans = 0;
  for (const p of paths) {
    let prev = 'ground';
    for (const nd of p.nodes) {
      if (nd.kind !== prev) {
        if (nd.kind === 'bridge') bridgeSpans++;
        if (nd.kind === 'tunnel') tunnelSpans++;
        prev = nd.kind;
      }
    }
  }

  return {
    paths, plazas, gates, junctions, usage,
    stats: {
      paths: paths.length,
      metres: Math.round(paths.reduce((a, p) => a + p.length, 0)),
      bridgeSpans, tunnelSpans,
    },
  };
}

/** Splits a street where it leaves its own district's Voronoi cell. */
function clipToDistrict(pts, d, districts) {
  const inside = (p) => {
    let bd = Infinity, bi = -1;
    for (const o of districts) {
      const dd = (p[0] - o.x) * (p[0] - o.x) + (p[1] - o.z) * (p[1] - o.z);
      const w = dd / (o.weight * o.weight);
      if (w < bd) { bd = w; bi = o.index; }
    }
    return bi === d.index;
  };
  const out = [];
  let cur = [];
  for (const p of pts) {
    if (inside(p)) cur.push(p);
    else if (cur.length) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out;
}

// --- geometry ----------------------------------------------------------------

/**
 * Writes a quad with explicit per-vertex normals.
 *
 * MeshBuilder derives a flat normal from the winding, which is right for a wall
 * and wrong for a road: a carriageway shaded flat facets visibly at every
 * sample, and on a wet surface the facets are exactly where the specular is.
 * Reaching into the accumulator's arrays here keeps that fix local instead of
 * changing the shared class for one caller.
 */
function smoothQuad(mb, a, b, c, d, na, nb, nc, nd, col, surf, uv) {
  const base = mb.vertexCount;
  mb._push(a, na, col, surf, uv[0]);
  mb._push(b, nb, col, surf, uv[1]);
  mb._push(c, nc, col, surf, uv[2]);
  mb._push(d, nd, col, surf, uv[3]);
  mb.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  mb.tris += 2;
}

/** Per-sample road frame: forward, left, and the deck normal. */
function frames(nodes) {
  const n = nodes.length;
  const f = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = nodes[Math.max(0, i - 1)], b = nodes[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x, ty = b.y - a.y, tz = b.z - a.z;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    // Left is horizontal by construction: roads are cambered, never banked, and
    // a banked procedural road looks like a rollercoaster.
    let lx = -tz, lz = tx;
    const ll = Math.hypot(lx, lz) || 1;
    lx /= ll; lz /= ll;
    const nx = ty * lz * -1, ny = tx * lz - tz * lx, nz = ty * lx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    f[i] = { tx, ty, tz, lx, lz, nx: nx / nl, ny: ny / nl, nz: nz / nl };
  }
  return f;
}

const ROAD_SURF = [0.62, 0.04, 0];
const KERB_SURF = [0.85, 0.02, 0];
const STRUCT_SURF = [0.72, 0.10, 0];

function emitPath(mb, emissive, path, civ, rng, o) {
  const nodes = path.nodes;
  const fr = frames(nodes);
  const hw = path.width * 0.5;
  const walk = path.cls === 'highway' ? 0 : Math.min(3.2, path.width * 0.16);
  const deck = o.deckColor;
  const kerb = o.kerbColor;
  const n = nodes.length;

  for (let i = 0; i < n - 1; i++) {
    const A = nodes[i], B = nodes[i + 1];
    if (A.kind === 'tunnel' && B.kind === 'tunnel' && !o.tunnelInterior) {
      // The deck still exists inside the bore — traffic and pedestrians use it —
      // but nothing else needs emitting for a segment nobody can see.
    }
    const fa = fr[i], fb = fr[i + 1];
    const a0 = [A.x - fa.lx * hw, A.y, A.z - fa.lz * hw];
    const a1 = [A.x + fa.lx * hw, A.y, A.z + fa.lz * hw];
    const b0 = [B.x - fb.lx * hw, B.y, B.z - fb.lz * hw];
    const b1 = [B.x + fb.lx * hw, B.y, B.z + fb.lz * hw];
    const na = [fa.nx, fa.ny, fa.nz], nb = [fb.nx, fb.ny, fb.nz];
    // aFacade carries (across in metres, along in metres): lane markings key
    // off the first, the wear pattern and dashes off the second.
    smoothQuad(mb, a0, b0, b1, a1, na, nb, nb, na, deck, ROAD_SURF,
      [[-hw, A.s], [-hw, B.s], [hw, B.s], [hw, A.s]]);

    // Kerb and skirt. The skirt is not decoration: without a lip dropped to the
    // real ground the carriageway either floats above the terrain or is buried
    // in it, and both are instantly fatal to the read.
    for (const side of [-1, 1]) {
      const ea = [A.x + fa.lx * hw * side, A.y, A.z + fa.lz * hw * side];
      const eb = [B.x + fb.lx * hw * side, B.y, B.z + fb.lz * hw * side];
      if (walk > 0.1) {
        const wa = [ea[0] + fa.lx * walk * side, A.y + 0.16, ea[2] + fa.lz * walk * side];
        const wb = [eb[0] + fb.lx * walk * side, B.y + 0.16, eb[2] + fb.lz * walk * side];
        const ka = [ea[0], A.y + 0.16, ea[2]], kb = [eb[0], B.y + 0.16, eb[2]];
        if (side < 0) {
          smoothQuad(mb, ea, eb, kb, ka, na, nb, na, nb, kerb, KERB_SURF,
            [[0, A.s], [0, B.s], [0.16, B.s], [0.16, A.s]]);
          smoothQuad(mb, ka, kb, wb, wa, UP, UP, UP, UP, kerb, KERB_SURF,
            [[0, A.s], [0, B.s], [walk, B.s], [walk, A.s]]);
        } else {
          smoothQuad(mb, eb, ea, ka, kb, na, nb, na, nb, kerb, KERB_SURF,
            [[0, B.s], [0, A.s], [0.16, A.s], [0.16, B.s]]);
          smoothQuad(mb, kb, ka, wa, wb, UP, UP, UP, UP, kerb, KERB_SURF,
            [[0, B.s], [0, A.s], [walk, A.s], [walk, B.s]]);
        }
        ea[0] += fa.lx * walk * side; ea[2] += fa.lz * walk * side; ea[1] += 0.16;
        eb[0] += fb.lx * walk * side; eb[2] += fb.lz * walk * side; eb[1] += 0.16;
      }
      if (A.kind === 'bridge' || B.kind === 'bridge') continue;
      const ga = [ea[0] + fa.lx * 2.5 * side, Math.min(A.raw, ea[1]) - 0.6, ea[2] + fa.lz * 2.5 * side];
      const gb = [eb[0] + fb.lx * 2.5 * side, Math.min(B.raw, eb[1]) - 0.6, eb[2] + fb.lz * 2.5 * side];
      if (side < 0) {
        smoothQuad(mb, ea, eb, gb, ga, na, nb, UP, UP, o.vergeColor, KERB_SURF,
          [[0, A.s], [0, B.s], [3, B.s], [3, A.s]]);
      } else {
        smoothQuad(mb, eb, ea, ga, gb, nb, na, UP, UP, o.vergeColor, KERB_SURF,
          [[0, B.s], [0, A.s], [3, A.s], [3, B.s]]);
      }
    }
  }

  emitSpans(mb, emissive, path, fr, hw, civ, rng, o);
  emitFurniture(mb, emissive, path, fr, hw, walk, civ, rng, o);
}

const UP = [0, 1, 0];

/** Bridge decks get girders and piers; tunnels get a bore and two portals. */
function emitSpans(mb, emissive, path, fr, hw, civ, rng, o) {
  const nodes = path.nodes;
  const n = nodes.length;
  let i = 0;
  while (i < n) {
    const kind = nodes[i].kind;
    let j = i;
    while (j + 1 < n && nodes[j + 1].kind === kind) j++;
    if (kind === 'bridge') emitBridge(mb, emissive, nodes, fr, i, j, hw, civ, rng, o);
    else if (kind === 'tunnel') emitTunnel(mb, emissive, nodes, fr, i, j, hw, civ, rng, o);
    i = j + 1;
  }
}

function emitBridge(mb, emissive, nodes, fr, i0, i1, hw, civ, rng, o) {
  const col = o.structColor;
  const girder = Math.max(0.9, hw * 0.22);
  for (let i = i0; i < i1; i++) {
    const A = nodes[i], B = nodes[i + 1];
    const fa = fr[i], fb = fr[i + 1];
    for (const side of [-1, 1]) {
      const ax = A.x + fa.lx * hw * side, az = A.z + fa.lz * hw * side;
      const bx = B.x + fb.lx * hw * side, bz = B.z + fb.lz * hw * side;
      // Girder web.
      mb.quad([ax, A.y, az], [bx, B.y, bz], [bx, B.y - girder, bz], [ax, A.y - girder, az],
        col, STRUCT_SURF, [[0, 0], [1, 0], [1, 1], [0, 1]]);
      mb.quad([bx, B.y, bz], [ax, A.y, az], [ax, A.y - girder, az], [bx, B.y - girder, bz],
        col, STRUCT_SURF, [[0, 0], [1, 0], [1, 1], [0, 1]]);
      // Parapet. A bridge without one reads as a ramp.
      const ph = 1.15;
      mb.quad([ax, A.y + 0.16, az], [bx, B.y + 0.16, bz], [bx, B.y + ph, bz], [ax, A.y + ph, az],
        col, STRUCT_SURF, [[0, 0], [1, 0], [1, 1], [0, 1]]);
      mb.quad([bx, B.y + 0.16, bz], [ax, A.y + 0.16, az], [ax, A.y + ph, az], [bx, B.y + ph, bz],
        col, STRUCT_SURF, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
  }
  // Piers on a regular pitch. Regular is the point — an irregular colonnade
  // reads as damage, and damage is a decision the history should make, not the
  // geometry.
  const span = Math.max(2, Math.round(lerp(6, 3, civ.tech.level)));
  const pw = Math.max(1.1, hw * 0.3);
  for (let i = i0 + span; i < i1; i += span) {
    const A = nodes[i];
    const drop = A.y - A.raw;
    if (drop < 2.5) continue;
    const f = fr[i];
    for (const side of [-1, 1]) {
      const x = A.x + f.lx * hw * 0.62 * side, z = A.z + f.lz * hw * 0.62 * side;
      mb.box(null, x - pw * 0.5, A.raw - 1.5, z - pw * 0.5, x + pw * 0.5, A.y - 1.0, z + pw * 0.5,
        col, STRUCT_SURF);
    }
    // A cross-brace at half height turns two posts into a bent.
    if (drop > 12) {
      const y = lerp(A.raw, A.y, 0.55);
      const l = hw * 0.62;
      mb.box(null, A.x - Math.abs(f.lx) * l - 0.4, y, A.z - Math.abs(f.lz) * l - 0.4,
        A.x + Math.abs(f.lx) * l + 0.4, y + 0.8, A.z + Math.abs(f.lz) * l + 0.4, col, STRUCT_SURF);
    }
  }
  void emissive; void rng;
}

function emitTunnel(mb, emissive, nodes, fr, i0, i1, hw, civ, rng, o) {
  const col = o.structColor;
  const clear = Math.max(6.5, hw * 0.9);
  // The bore. Only walls and a soffit — no floor, the deck already exists — and
  // wound inward so it is visible from inside and culls away from outside.
  for (let i = i0; i < i1; i++) {
    const A = nodes[i], B = nodes[i + 1];
    const fa = fr[i], fb = fr[i + 1];
    const w = hw + 1.2;
    for (const side of [-1, 1]) {
      const ax = A.x + fa.lx * w * side, az = A.z + fa.lz * w * side;
      const bx = B.x + fb.lx * w * side, bz = B.z + fb.lz * w * side;
      if (side > 0) {
        mb.quad([ax, A.y, az], [bx, B.y, bz], [bx, B.y + clear, bz], [ax, A.y + clear, az],
          col, STRUCT_SURF, [[0, A.s], [0, B.s], [clear, B.s], [clear, A.s]]);
      } else {
        mb.quad([bx, B.y, bz], [ax, A.y, az], [ax, A.y + clear, az], [bx, B.y + clear, bz],
          col, STRUCT_SURF, [[0, B.s], [0, A.s], [clear, A.s], [clear, B.s]]);
      }
    }
    const al = [A.x + fa.lx * w, A.y + clear, A.z + fa.lz * w];
    const ar = [A.x - fa.lx * w, A.y + clear, A.z - fa.lz * w];
    const bl = [B.x + fb.lx * w, B.y + clear, B.z + fb.lz * w];
    const br = [B.x - fb.lx * w, B.y + clear, B.z - fb.lz * w];
    mb.quad(ar, br, bl, al, col, STRUCT_SURF, [[0, A.s], [0, B.s], [w * 2, B.s], [w * 2, A.s]]);

    // Strip lighting on the crown. A tunnel mouth that is not brighter than the
    // rock around it looks like a hole; one that glows reads as infrastructure.
    if (emissive && i % 3 === 0) {
      const c = o.lampColor;
      const y = A.y + clear - 0.25;
      const l = hw * 0.5;
      emissive.quad(
        [A.x - fa.lx * l, y, A.z - fa.lz * l], [B.x - fb.lx * l, y, B.z - fb.lz * l],
        [B.x + fb.lx * l, y, B.z + fb.lz * l], [A.x + fa.lx * l, y, A.z + fa.lz * l],
        c, [1, 0, 1]);
    }
  }
  // Portals: a heavy collar at each mouth, which is what actually sells a bore
  // as engineered rather than as a cave.
  for (const end of [i0, i1]) {
    const A = nodes[end];
    const f = fr[end];
    const w = hw + 3.0;
    const t = end === i0 ? 1 : -1;
    const ox = f.tx * 1.6 * t, oz = f.tz * 1.6 * t;
    mb.box(null,
      Math.min(A.x - f.lx * w, A.x + f.lx * w) - 1.4 + ox, A.y - 1.0, Math.min(A.z - f.lz * w, A.z + f.lz * w) - 1.4 + oz,
      Math.max(A.x - f.lx * w, A.x + f.lx * w) + 1.4 + ox, A.y + clear + 2.6, Math.max(A.z - f.lz * w, A.z + f.lz * w) + 1.4 + oz,
      col, STRUCT_SURF);
  }
  void civ; void rng;
}

/** Lamp posts, and the light on top of them. */
function emitFurniture(mb, emissive, path, fr, hw, walk, civ, rng, o) {
  if (civ.tech.level < 0.12) return;
  if (path.cls === 'lane' && !rng.bool(0.4)) return;
  const nodes = path.nodes;
  const spacing = lerp(52, 26, civ.tech.level) * (path.cls === 'highway' ? 1.7 : 1);
  const height = lerp(4.5, 9.5, civ.tech.level) * clamp(civ.species.sizeRel, 0.6, 1.6);
  const col = o.structColor;
  const lamp = o.lampColor;
  const arms = clamp(Math.round(civ.species.eyes / 2), 1, 3);
  let next = spacing * 0.5;
  let side = 1;
  const lit = civ.history.lights;

  for (let i = 1; i < nodes.length; i++) {
    const A = nodes[i];
    if (A.s < next) continue;
    next += spacing;
    side = -side;
    if (A.kind === 'tunnel') continue;
    const f = fr[i];
    const off = hw + walk * 0.55;
    const x = A.x + f.lx * off * side, z = A.z + f.lz * off * side;
    const y = A.y + 0.16;
    mb.box(null, x - 0.11, y, z - 0.11, x + 0.11, y + height, z + 0.11, col, STRUCT_SURF);
    // The arm reaches over the carriageway, which is the silhouette that says
    // "street light" from a kilometre away.
    const reach = hw * 0.45;
    mb.box(null,
      Math.min(x, x - f.lx * reach * side) - 0.09, y + height - 0.18, Math.min(z, z - f.lz * reach * side) - 0.09,
      Math.max(x, x - f.lx * reach * side) + 0.09, y + height, Math.max(z, z - f.lz * reach * side) + 0.09,
      col, STRUCT_SURF);
    if (!emissive) continue;
    if (rng.next() > lit) continue;   // a dying city has dark posts, not no posts
    for (let a = 0; a < arms; a++) {
      const t = arms === 1 ? 1 : 0.4 + (a / (arms - 1)) * 0.6;
      const lx = x - f.lx * reach * side * t, lz = z - f.lz * reach * side * t;
      const ly = y + height - 0.3;
      const s = 0.42;
      emissive.quad([lx - s, ly, lz - s], [lx + s, ly, lz - s], [lx + s, ly, lz + s], [lx - s, ly, lz + s],
        lamp, [1, 0, 1]);
    }
  }
}

/** A paved polygon where roads meet. */
function emitPlaza(mb, emissive, plaza, grid, civ, rng, o) {
  const n = plaza.sides;
  const ring = [];
  let ymax = -Infinity;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + plaza.rot;
    const x = plaza.x + Math.cos(a) * plaza.radius;
    const z = plaza.z + Math.sin(a) * plaza.radius;
    ymax = Math.max(ymax, grid.sampleHeight(x, z));
    ring.push([x, z]);
  }
  // One level, terraced into the slope. A plaza that follows the ground is a
  // field; a plaza that cuts a level out of it is civic.
  const y = Math.max(plaza.y, ymax - 1.2) + 0.08;
  const col = o.plazaColor;
  const centre = [plaza.x, y, plaza.z];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    mb.tri(centre, [a[0], y, a[1]], [b[0], y, b[1]], col, [0.68, 0.03, 0],
      [0, 0], [a[0] - plaza.x, a[1] - plaza.z], [b[0] - plaza.x, b[1] - plaza.z]);
    // Skirt down to the ground so the slab is not a floating disc.
    const ga = grid.sampleHeight(a[0], a[1]) - 0.8;
    const gb = grid.sampleHeight(b[0], b[1]) - 0.8;
    mb.quad([b[0], y, b[1]], [a[0], y, a[1]], [a[0], Math.min(ga, y - 0.3), a[1]], [b[0], Math.min(gb, y - 0.3), b[1]],
      o.vergeColor, KERB_SURF, [[0, 0], [1, 0], [1, 1], [0, 1]]);
  }

  // Something in the middle. An empty plaza is a car park; a plaza with one
  // vertical object in it is a place people agreed to meet.
  const kind = rng.weighted(['pillar', 'basin', 'brazier', 'bare'],
    [1.0, civ.settlement.preferredSite === 'coast' ? 1.2 : 0.7, 1 - civ.tech.level, 0.6]);
  if (kind === 'pillar') {
    const h = plaza.radius * rng.range(0.5, 1.1);
    const w = Math.max(0.5, plaza.radius * 0.06);
    mb.box(null, plaza.x - w, y, plaza.z - w, plaza.x + w, y + h, plaza.z + w, o.structColor, STRUCT_SURF);
    if (emissive) {
      const c = o.lampColor;
      emissive.quad([plaza.x - w * 1.6, y + h, plaza.z - w * 1.6], [plaza.x + w * 1.6, y + h, plaza.z - w * 1.6],
        [plaza.x + w * 1.6, y + h, plaza.z + w * 1.6], [plaza.x - w * 1.6, y + h, plaza.z + w * 1.6], c, [1, 0, 1]);
    }
  } else if (kind === 'basin') {
    const r = plaza.radius * 0.28;
    const seg = 10;
    const lower = [], upper = [];
    for (let i = 0; i < seg; i++) {
      const a = -(i / seg) * TAU;
      lower.push(plaza.x + Math.cos(a) * r, y, plaza.z + Math.sin(a) * r);
      upper.push(plaza.x + Math.cos(a) * r, y + 0.7, plaza.z + Math.sin(a) * r);
    }
    mb.ring(lower, upper, o.structColor, STRUCT_SURF);
    if (emissive) {
      const c = [o.lampColor[0] * 0.22, o.lampColor[1] * 0.26, o.lampColor[2] * 0.32];
      const inner = [];
      for (let i = 0; i < seg; i++) {
        const a = -(i / seg) * TAU;
        inner.push(plaza.x + Math.cos(a) * r * 0.92, y + 0.5, plaza.z + Math.sin(a) * r * 0.92);
      }
      emissive.cap(inner, c, [1, 0, 1], true);
    }
  } else if (kind === 'brazier') {
    const h = 1.6;
    const w = plaza.radius * 0.09;
    mb.box(null, plaza.x - w, y, plaza.z - w, plaza.x + w, y + h, plaza.z + w, o.structColor, STRUCT_SURF);
    if (emissive) {
      const c = [o.lampColor[0] * 2.2, o.lampColor[1] * 1.5, o.lampColor[2] * 0.7];
      emissive.quad([plaza.x - w, y + h, plaza.z - w], [plaza.x + w, y + h, plaza.z - w],
        [plaza.x + w, y + h, plaza.z + w], [plaza.x - w, y + h, plaza.z + w], c, [1, 0, 1]);
    }
  }
}

// --- material ----------------------------------------------------------------

/**
 * The road surface.
 *
 * Wet tarmac at night is the single most recognisable image in the reference
 * set, and it is not a reflection trick — it is a roughness trick. Water fills
 * the pores of the aggregate, the surface goes from 0.65 rough to near mirror
 * in the puddles only, and the dry patches between them are what make the wet
 * ones read. So puddles are a mask, not a global wetness, and they pool where
 * the camber is lowest because that is where water actually goes.
 *
 * Lane markings come out of the same facade coordinate the buildings use:
 * `aFacade.x` is metres across the carriageway and `aFacade.y` metres along it,
 * so a dashed line is one `fract` and never swims when the road curves.
 */
export function makeRoadMaterial(civ, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1.0,
    metalness: 0.0,
    side: THREE.FrontSide,
    shadowSide: THREE.FrontSide,
  });
  mat.name = 'city-road';

  const neon = civ?.palette?.neonHDR || [1.2, 0.5, 0.9];
  const uniforms = {
    uTime: { value: 0 },
    uWet: { value: opts.wet ?? 0.55 },
    uNight: { value: 1 },
    uPaint: { value: opts.paint ?? (civ ? clamp(civ.tech.level * 1.4, 0.05, 1.2) : 0.6) },
    uPaintColor: { value: new THREE.Vector3(neon[0], neon[1], neon[2]) },
    uLaneWidth: { value: opts.laneWidth ?? 3.4 },
  };
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aSurf;
        attribute vec2 aFacade;
        varying vec3 vSurfP;
        varying vec2 vFacadeP;
        varying vec3 vRoadW;
      `)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vSurfP = aSurf;
        vFacadeP = aFacade;
        vRoadW = (modelMatrix * vec4(transformed, 1.0)).xyz;
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform float uWet;
        uniform float uNight;
        uniform float uPaint;
        uniform vec3 uPaintColor;
        uniform float uLaneWidth;
        varying vec3 vSurfP;
        varying vec2 vFacadeP;
        varying vec3 vRoadW;

        float rdHash21(vec2 p){
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        float rdValue(vec2 p){
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(rdHash21(i), rdHash21(i + vec2(1.0, 0.0)), f.x),
                     mix(rdHash21(i + vec2(0.0, 1.0)), rdHash21(i + vec2(1.0, 1.0)), f.x), f.y);
        }
      `)
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = clamp(vSurfP.x, 0.02, 1.0);
      `)
      .replace('#include <metalnessmap_fragment>', `
        float metalnessFactor = clamp(vSurfP.y, 0.0, 1.0);
      `)
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (vSurfP.z < 0.5) {
          vec2 fp = vFacadeP;
          // Aggregate: two octaves, one at the scale of a chipping and one at
          // the scale of a repair patch. Without the coarse octave a road is
          // uniformly grey and reads as a ribbon of paper.
          float grain = rdValue(vRoadW.xz * 2.7) * 0.5 + rdValue(vRoadW.xz * 0.19) * 0.5;
          diffuseColor.rgb *= 0.78 + grain * 0.44;

          // Wheel polish: two bands of worn, smoother surface either side of the
          // centre line, exactly where tyres run.
          float track = min(abs(abs(fp.x) - uLaneWidth * 0.52), 3.0);
          float wear = 1.0 - smoothstep(0.0, 0.9, track);
          roughnessFactor *= mix(1.0, 0.74, wear);
          diffuseColor.rgb *= mix(1.0, 0.88, wear);

          // Puddles. Low camber plus a low-frequency mask, so the wet patches
          // are large, connected and in the gutters — never a dot screen.
          float pond = rdValue(vRoadW.xz * 0.085 + vec2(11.0, 3.0));
          float gutter = smoothstep(0.35, 1.0, abs(fp.x) / max(uLaneWidth * 2.0, 1.0));
          float puddle = smoothstep(0.52, 0.78, pond * (0.55 + gutter * 0.75)) * uWet;
          roughnessFactor = mix(roughnessFactor, 0.035, puddle);
          metalnessFactor = mix(metalnessFactor, 0.25, puddle);
          diffuseColor.rgb *= 1.0 - puddle * 0.55;
          // Even outside the puddles a damp road is darker and tighter.
          roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.55, uWet * 0.6);
          diffuseColor.rgb *= 1.0 - uWet * 0.18;

          // Markings. Centre line solid, lane dividers dashed on a 9 m pitch,
          // both eroded by the same grain so they are not printed decals.
          float centre = 1.0 - smoothstep(0.10, 0.22, abs(fp.x));
          float lane = 1.0 - smoothstep(0.08, 0.18, abs(mod(abs(fp.x) + uLaneWidth * 0.5, uLaneWidth) - uLaneWidth * 0.5));
          lane *= step(0.45, fract(fp.y / 9.0)) * step(uLaneWidth * 0.8, abs(fp.x));
          float paint = clamp(centre + lane, 0.0, 1.0) * uPaint * smoothstep(0.25, 0.6, grain);
          diffuseColor.rgb = mix(diffuseColor.rgb, uPaintColor * 0.16, paint * 0.85);
        }
      `)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vSurfP.z > 0.5) {
          totalEmissiveRadiance += vColor * vSurfP.z;
        } else if (uPaint > 0.55) {
          // Lit lane edging on a high-technology road. Kept well above 1 so the
          // post chain blooms it; a glow strip that does not bloom is a sticker.
          float edge = 1.0 - smoothstep(0.06, 0.16, abs(abs(vFacadeP.x) - uLaneWidth * 1.55));
          totalEmissiveRadiance += uPaintColor * edge * uNight * (uPaint - 0.55) * 1.6;
        }
      `);
  };
  mat.customProgramCacheKey = () => 'city-road-1';
  return mat;
}

// --- build -------------------------------------------------------------------

/**
 * Turns a plan into meshes. `opts.emissive` lets the caller pool this module's
 * glowing bits into one city-wide emissive batch; without it the module makes
 * its own and costs one extra draw call.
 */
export function buildRoads(plan, civ, grid, opts = {}) {
  const rng = new Rng(hashInt((civ.seed ^ 0x2a0d5) >>> 0));
  const mb = new MeshBuilder();
  const ownEmissive = !opts.emissive;
  const emissive = opts.emissive || new MeshBuilder();

  const pal = civ.palette;
  const lampMix = 0.45;
  const neon = pal.neonHDR;
  const lampColor = [
    lerp(neon[0], 2.6, lampMix), lerp(neon[1], 2.6, lampMix), lerp(neon[2], 2.6, lampMix),
  ];
  const stone = pal.stone;
  const o = {
    deckColor: [stone[0] * 0.24 + 0.020, stone[1] * 0.24 + 0.021, stone[2] * 0.25 + 0.024],
    kerbColor: [stone[0] * 0.55, stone[1] * 0.54, stone[2] * 0.52],
    vergeColor: [stone[0] * 0.42, stone[1] * 0.44, stone[2] * 0.38],
    structColor: [stone[0] * 0.48, stone[1] * 0.47, stone[2] * 0.46],
    plazaColor: [stone[0] * 0.62, stone[1] * 0.60, stone[2] * 0.57],
    lampColor,
    tunnelInterior: true,
  };

  const detail = clamp(opts.cityDetail ?? 1, 0.3, 1.4);
  for (const p of plan.paths) {
    // At low detail the alleys stop being modelled: they are still in the plan,
    // so traffic and crowds still use them, they are just not tarmac any more.
    if (detail < 0.6 && p.cls === 'lane') continue;
    emitPath(mb, emissive, p, civ, rng, o);
  }
  for (const pz of plan.plazas) emitPlaza(mb, emissive, pz, grid, civ, rng, o);

  const group = new THREE.Group();
  group.name = 'roads';
  const meshes = [];

  const material = opts.material || makeRoadMaterial(civ, opts);
  if (mb.tris) {
    const mesh = new THREE.Mesh(mb.build(), material);
    mesh.name = 'road-surface';
    mesh.receiveShadow = !!opts.shadows;
    mesh.castShadow = false;
    group.add(mesh);
    meshes.push(mesh);
  }
  if (ownEmissive && emissive.tris) {
    const em = new THREE.Mesh(emissive.build(), new THREE.MeshBasicMaterial({
      vertexColors: true, toneMapped: false, side: THREE.DoubleSide,
    }));
    em.name = 'road-lights';
    group.add(em);
    meshes.push(em);
  }

  return {
    group,
    material,
    stats: {
      drawCalls: meshes.length,
      triangles: mb.tris + (ownEmissive ? emissive.tris : 0),
      vertices: mb.vertexCount + (ownEmissive ? emissive.vertexCount : 0),
      ...plan.stats,
    },
    update(dt, ctx = {}) {
      const u = material.userData.uniforms;
      if (!u) return;
      u.uTime.value += dt;
      if (ctx.night !== undefined) u.uNight.value = ctx.night;
      if (ctx.wet !== undefined) u.uWet.value = ctx.wet;
    },
    dispose() {
      for (const m of meshes) {
        m.geometry.dispose();
        if (m.material !== opts.material) m.material.dispose();
      }
      group.clear();
    },
  };
}

/**
 * Walkable and driveable lines extracted from the plan.
 *
 * Traffic and crowds both want the same thing — a list of polylines with a
 * speed limit and an altitude — so it is produced once here rather than twice,
 * badly, in two other files.
 */
export function extractLanes(plan, o = {}) {
  const drive = [];
  const walk = [];
  const laneOffset = o.laneOffset ?? 0.28;
  for (const p of plan.paths) {
    if (p.nodes.length < 4) continue;
    const fr = frames(p.nodes);
    const hw = p.width * 0.5;
    for (const side of [-1, 1]) {
      const pts = [];
      for (let i = 0; i < p.nodes.length; i++) {
        const nd = p.nodes[i], f = fr[i];
        const d = hw * laneOffset * side;
        pts.push([nd.x + f.lx * d, nd.y + 0.28, nd.z + f.lz * d]);
      }
      if (side < 0) pts.reverse();
      drive.push({ pts, width: p.width, cls: p.cls, district: p.district, length: p.length });
    }
    if (p.cls === 'highway') continue;
    const walkOff = hw + Math.min(3.2, p.width * 0.16) * 0.5;
    for (const side of [-1, 1]) {
      const pts = [];
      for (let i = 0; i < p.nodes.length; i++) {
        const nd = p.nodes[i], f = fr[i];
        if (nd.kind === 'tunnel') continue;
        pts.push([nd.x + f.lx * walkOff * side, nd.y + 0.22, nd.z + f.lz * walkOff * side]);
      }
      if (pts.length > 3) {
        if (side < 0) pts.reverse();
        walk.push({ pts, cls: p.cls, district: p.district, length: p.length });
      }
    }
  }
  return { drive, walk };
}

export { frames as roadFrames, smoothQuad as roadQuad };
