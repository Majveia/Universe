/**
 * Buildings, from a style rule to a triangle.
 *
 * A city is not a collection of buildings. It is one building rule applied a
 * thousand times with the parameters shaken slightly, which is why real streets
 * read as a place and randomised ones read as a heap. So everything here takes
 * a style record out of CivStyles and a seeded Rng and produces a *specification*
 * first — floor count, section stack, setback ledges, roof kind, where the
 * balconies are — with no reference to three.js at all. The specification is
 * plain numbers, so the whole layout stage runs under Node and can be moved into
 * a worker later without dragging WebGL across the boundary.
 *
 * Only then does the emitter turn a spec into vertices, and it never makes a
 * mesh: it appends into a shared accumulator that becomes a single merged
 * geometry per spatial chunk. Ten thousand buildings, a handful of draw calls.
 *
 * Three things do almost all the perceptual work, and they are worth naming
 * because everything else here is in service of them:
 *
 *   The silhouette. A building is recognised at distance by its outline and
 *   nothing else — not its material, not its detail. So the section stack is
 *   built from the style's taper, setback, twist and bulge before a single face
 *   is emitted, and `ringBudget` caps how many distinct masses a style is
 *   allowed so a language stays legible instead of dissolving into wobble.
 *
 *   The windows. One emissive quad per opening, each with its own on/off state
 *   and its own warm/cool bias, drawn through the parallax interior shader in
 *   Interiors.js. This single detail sells a night city more than anything else
 *   in the project, because a facade of a hundred separately-decided lights is
 *   read instantly as a hundred separate lives. They are instanced: the entire
 *   city's glazing is one draw call.
 *
 *   The junk. Roof machinery, aerials, pipe runs, balconies, panel lines. Real
 *   buildings are covered in the accumulated evidence of being used, and a clean
 *   extruded prism reads as an architectural render rather than a place. The
 *   panel lines in particular are free — they live in the fragment shader, keyed
 *   off a facade-space UV, and they give a flat wall a sense of manufacture at
 *   zero geometry cost.
 *
 * LOD is a chain of three: the full article, a simplified mass with the same
 * silhouette and no junk, and a billboard impostor whose shader draws its own
 * lit-window grid. Chunks swap between them by camera distance; the impostor
 * batch hides the instances whose chunk is currently drawn as geometry.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng, hashInt } from '../core/Rng.js';
import { clamp, lerp, smoothstep } from '../core/Noise.js';
import {
  Footprint, Roof, WindowMode, footprintPolygon, variantColor, floorsFor,
} from './CivStyles.js';
import { makeWindowMaterial } from './Interiors.js';

const TAU = Math.PI * 2;

// --- geometry accumulator ----------------------------------------------------

/**
 * Appends triangles into flat arrays and hands back one BufferGeometry.
 *
 * The attribute set is deliberately small and shared with Interiors.js so a
 * single material serves every opaque surface in the city:
 *
 *   position, normal, color  — colour is the albedo, authored linear
 *   aSurf  = (roughness, metalness, emissiveMask)
 *   aFacade = (u, v) in metres along the wall and up it, or, when emissiveMask
 *             is set, (blink phase, blink rate) — beacons need a phase and a
 *             lit strip does not need a facade coordinate.
 */
export class MeshBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.col = [];
    this.srf = [];
    this.fac = [];
    this.idx = [];
    this.tris = 0;
  }

  get vertexCount() { return this.pos.length / 3; }

  _push(p, n, c, s, f) {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.col.push(c[0], c[1], c[2]);
    this.srf.push(s[0], s[1], s[2]);
    this.fac.push(f[0], f[1]);
  }

  tri(a, b, c, col, surf, fa, fb, fc) {
    const base = this.vertexCount;
    const n = normalOf(a, b, c);
    this._push(a, n, col, surf, fa || ZERO2);
    this._push(b, n, col, surf, fb || ZERO2);
    this._push(c, n, col, surf, fc || ZERO2);
    this.idx.push(base, base + 1, base + 2);
    this.tris += 1;
  }

  /** Winding a->b->c->d; the normal comes out of (b-a) x (d-a). */
  quad(a, b, c, d, col, surf, uvs) {
    const base = this.vertexCount;
    const n = normalOf(a, b, d);
    const u = uvs || QUAD_UV;
    this._push(a, n, col, surf, u[0]);
    this._push(b, n, col, surf, u[1]);
    this._push(c, n, col, surf, u[2]);
    this._push(d, n, col, surf, u[3]);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.tris += 2;
  }

  /** Axis-aligned box. `T` maps local (x,y,z) into world; pass null for identity. */
  box(T, x0, y0, z0, x1, y1, z1, col, surf) {
    const p = T || ident3;
    const a = p(x0, y0, z0), b = p(x1, y0, z0), c = p(x1, y0, z1), d = p(x0, y0, z1);
    const e = p(x0, y1, z0), f = p(x1, y1, z0), g = p(x1, y1, z1), h = p(x0, y1, z1);
    const w = x1 - x0, dp = z1 - z0, ht = y1 - y0;
    this.quad(e, f, g, h, col, surf, faceUv(w, dp));
    this.quad(d, c, b, a, col, surf, faceUv(w, dp));
    this.quad(a, b, f, e, col, surf, faceUv(w, ht));
    this.quad(c, d, h, g, col, surf, faceUv(w, ht));
    this.quad(b, c, g, f, col, surf, faceUv(dp, ht));
    this.quad(d, a, e, h, col, surf, faceUv(dp, ht));
  }

  /**
   * The side wall of one section: a band of quads between two closed rings of
   * the same vertex count. `uBase` continues the facade coordinate from the
   * section below so panel lines and grime streaks run unbroken up a tower.
   */
  ring(lower, upper, col, surf, uBase = 0, vBase = 0, out = null) {
    const n = lower.length / 3;
    let u = uBase;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = [lower[i * 3], lower[i * 3 + 1], lower[i * 3 + 2]];
      const b = [lower[j * 3], lower[j * 3 + 1], lower[j * 3 + 2]];
      const c = [upper[j * 3], upper[j * 3 + 1], upper[j * 3 + 2]];
      const d = [upper[i * 3], upper[i * 3 + 1], upper[i * 3 + 2]];
      const w = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const h = Math.hypot(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
      this.quad(a, b, c, d, col, surf, [
        [u, vBase], [u + w, vBase], [u + w, vBase + h], [u, vBase + h],
      ]);
      if (out) out.push({ a, b, c, d, u, w, h });
      u += w;
    }
    return u;
  }

  /** Fan cap from the ring's centroid. `up` true for a roof, false for a soffit. */
  cap(ring, col, surf, up = true) {
    const n = ring.length / 3;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += ring[i * 3]; cy += ring[i * 3 + 1]; cz += ring[i * 3 + 2]; }
    const c = [cx / n, cy / n, cz / n];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = [ring[i * 3], ring[i * 3 + 1], ring[i * 3 + 2]];
      const b = [ring[j * 3], ring[j * 3 + 1], ring[j * 3 + 2]];
      if (up) this.tri(c, a, b, col, surf);
      else this.tri(c, b, a, col, surf);
    }
    return c;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.srf, 3));
    g.setAttribute('aFacade', new THREE.Float32BufferAttribute(this.fac, 2));
    g.setIndex(this.vertexCount > 65535
      ? new THREE.Uint32BufferAttribute(this.idx, 1)
      : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

const ZERO2 = [0, 0];
const QUAD_UV = [[0, 0], [1, 0], [1, 1], [0, 1]];
function faceUv(w, h) { return [[0, 0], [w, 0], [w, h], [0, h]]; }
function ident3(x, y, z) { return [x, y, z]; }

function normalOf(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

// --- footprint helpers -------------------------------------------------------

/**
 * CivStyles emits polygons in increasing angle. Reversed here once, so that the
 * standard quad winding used everywhere below produces outward normals without
 * a per-face orientation test.
 */
export function orientFootprint(poly) {
  let area = 0;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += poly[i * 2] * poly[j * 2 + 1] - poly[j * 2] * poly[i * 2 + 1];
  }
  if (area <= 0) return poly;
  const out = new Array(poly.length);
  for (let i = 0; i < n; i++) {
    out[i * 2] = poly[(n - 1 - i) * 2];
    out[i * 2 + 1] = poly[(n - 1 - i) * 2 + 1];
  }
  return out;
}

/** Unit polygon -> a world-space ring at height y, scaled, rotated and placed. */
function ringAt(poly, cx, cz, w, d, y, scale, rot, yaw, leanX, leanZ) {
  const n = poly.length / 2;
  const out = new Array(n * 3);
  const ca = Math.cos(yaw + rot), sa = Math.sin(yaw + rot);
  for (let i = 0; i < n; i++) {
    const px = poly[i * 2] * w * scale;
    const pz = poly[i * 2 + 1] * d * scale;
    out[i * 3] = cx + px * ca - pz * sa + leanX;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = cz + px * sa + pz * ca + leanZ;
  }
  return out;
}

/** Fewer sides for the simplified LOD — the silhouette survives, the cost does not. */
function decimate(poly, maxSides) {
  const n = poly.length / 2;
  if (n <= maxSides) return poly;
  const out = [];
  for (let i = 0; i < maxSides; i++) {
    const k = Math.round((i * n) / maxSides) % n;
    out.push(poly[k * 2], poly[k * 2 + 1]);
  }
  return out;
}

// --- the specification -------------------------------------------------------

/**
 * Everything about one building that can be decided without triangles.
 *
 * `ctx` carries the lot: { x, z, yaw, w, d, groundY, density, character, civ,
 * ruinBias, roofPad }. `density` is the core-to-periphery gradient in [0,1] and
 * is the single strongest input — it decides height, and height decides skyline.
 */
export function makeBuildingSpec(style, rng, ctx) {
  const civ = ctx.civ;
  const ch = ctx.character || {};
  const floorH = rng.range(style.floorHeight[0], style.floorHeight[1]);
  const density = clamp(ctx.density ?? 0.5, 0, 1);

  let floors = floorsFor(style, rng, density);
  floors = Math.max(1, Math.round(floors * (ch.height ?? 1)));

  // A short lot cannot carry a tower: slenderness is a real constraint and
  // ignoring it is what produces the "pencil city" tell.
  const lotMin = Math.min(ctx.w, ctx.d);
  const maxSlender = lerp(6.5, 13.0, style.verticality);
  floors = Math.max(1, Math.min(floors, Math.round((lotMin * maxSlender) / floorH)));

  const ruined = rng.next() < (ctx.ruinBias ?? 0) * (ch.ruin ?? 1);
  const ruinCut = ruined ? rng.range(0.25, 0.8) : 1;
  const height = floors * floorH * ruinCut;

  // The section stack. Setback ledges are placed first because they are real
  // architectural events; the remaining ring budget is spent subdividing the
  // tallest spans so a taper reads as a curve rather than a cone.
  const cuts = new Set([0, 1]);
  if (style.setbackEvery > 0) {
    for (let f = style.setbackEvery; f < floors; f += style.setbackEvery) cuts.add(f / floors);
  }
  let ts = [...cuts].sort((a, b) => a - b);
  const budget = Math.max(2, Math.min(style.ringBudget, 10));
  while (ts.length - 1 > budget) {
    // Drop the cut bounding the shortest span — never the top or the bottom.
    let worst = 1, worstLen = Infinity;
    for (let i = 1; i < ts.length - 1; i++) {
      const len = ts[i + 1] - ts[i - 1];
      if (len < worstLen) { worstLen = len; worst = i; }
    }
    ts.splice(worst, 1);
  }
  while (ts.length - 1 < Math.min(budget, style.taper !== 0 || style.bulge ? budget : 3)) {
    let widest = 0, widestLen = -1;
    for (let i = 0; i < ts.length - 1; i++) {
      const len = ts[i + 1] - ts[i];
      if (len > widestLen) { widestLen = len; widest = i; }
    }
    if (widestLen < 0.08) break;
    ts.splice(widest + 1, 0, (ts[widest] + ts[widest + 1]) * 0.5);
  }

  const sections = [];
  for (let i = 0; i < ts.length - 1; i++) {
    const t0 = ts[i], t1 = ts[i + 1];
    const j0 = 1 + rng.range(-style.jitter, style.jitter) * 0.5;
    sections.push({
      t0, t1,
      y0: height * t0, y1: height * t1,
      s0: sectionScale(style, t0, floors) * (i === 0 ? 1 : j0),
      s1: sectionScale(style, t1, floors) * j0,
      r0: style.twist * t0 * Math.PI,
      r1: style.twist * t1 * Math.PI,
      floors: Math.max(1, Math.round((t1 - t0) * floors)),
    });
  }
  // Make each section start exactly where the one below ended, or the tower
  // develops seams that catch the light and read as broken geometry.
  for (let i = 1; i < sections.length; i++) sections[i].s0 = sections[i - 1].s1 * (1 - style.setbackAmount * (style.setbackEvery > 0 ? 1 : 0));
  if (style.setbackEvery > 0) {
    for (let i = 1; i < sections.length; i++) sections[i].s1 = Math.min(sections[i].s1, sections[i].s0);
  }

  const sides = style.footprint === Footprint.ROUND ? (rng.bool(0.3) ? 10 : 14)
    : style.footprint === Footprint.BLOB ? rng.int(9, 13) : 0;
  const poly = orientFootprint(footprintPolygon(style.footprint, rng, sides));

  const grime = style.mat.grime * lerp(0.55, 1.25, rng.next());
  const color = variantColor(style.mat.color, rng, 0.14, grime);
  const trim = variantColor(style.mat.trim, rng, 0.10, grime * 0.5);

  const orn = style.ornament;
  const stiltH = style.stiltHeight
    ? rng.range(style.stiltHeight[0], style.stiltHeight[1])
    : (civ?.settlement?.stilts && rng.next() < orn.stilts ? rng.range(1.5, 4.0) : 0);

  return {
    styleId: style.id,
    x: ctx.x, z: ctx.z, yaw: ctx.yaw ?? 0,
    w: ctx.w, d: ctx.d,
    groundY: ctx.groundY ?? 0,
    poly, sections, floors, floorHeight: floorH, height,
    color, trim,
    accent: style.mat.accent,
    surf: [style.mat.roughness, style.mat.metalness, 0],
    trimSurf: [style.mat.trimRoughness ?? style.mat.roughness * 0.8, style.mat.trimMetalness ?? style.mat.metalness, 0],
    lean: style.lean ? [rng.range(-1, 1) * style.lean * height, rng.range(-1, 1) * style.lean * height] : [0, 0],
    roof: style.roof,
    roofClutter: style.roofClutter * (ch.industry ? 1 + ch.industry * 0.5 : 1),
    parapet: style.parapet,
    stiltH,
    ruined, ruinCut,
    seed: rng.next(),
    // Ornament rolls are frozen here so the LOD variants agree with each other.
    balcony: rng.next() < orn.balcony * 0.85,
    buttress: rng.next() < orn.buttress * 0.8,
    fins: rng.next() < orn.fins,
    pipes: rng.next() < orn.pipes * 0.7,
    greeble: orn.greeble,
    banners: rng.next() < orn.banners * 0.5,
    crystals: rng.next() < orn.crystals,
    sails: rng.next() < orn.sails,
    vines: rng.next() < orn.vines * 0.6,
    window: style.window,
    signage: ch.signage ?? 1,
  };
}

function sectionScale(style, t, floors) {
  let s = 1 - style.taper * t;
  if (style.bulge) s *= 1 + style.bulge * Math.sin(Math.PI * t) * 0.45;
  if (style.setbackEvery > 0) {
    const step = Math.floor((t * floors) / style.setbackEvery);
    s *= Math.pow(1 - style.setbackAmount, step);
  }
  return Math.max(0.08, s);
}

// --- emission ----------------------------------------------------------------

/**
 * Writes one building into `mb` and its openings, sign anchors and landing pads
 * into `out`. `detail` is 2 for the full article and 1 for the simplified mass;
 * the silhouette is identical between them, which is what stops an LOD swap
 * from being visible.
 */
export function emitBuilding(mb, spec, out, opts = {}) {
  const detail = opts.detail ?? 2;
  const rng = new Rng(hashInt(Math.floor(spec.seed * 4294967296) ^ 0xb17d1));
  const baseY = spec.groundY + spec.stiltH;
  const col = spec.color, trim = spec.trim;
  const surf = spec.surf, tsurf = spec.trimSurf;
  const poly = detail >= 2 ? spec.poly : decimate(spec.poly, 8);

  if (spec.stiltH > 0.05) emitStilts(mb, spec, poly, detail);

  let u = 0;
  let prevTop = null;
  let prevScale = 0;
  const faces = detail >= 2 ? [] : null;

  for (let i = 0; i < spec.sections.length; i++) {
    const s = spec.sections[i];
    const leanA = [spec.lean[0] * s.t0, spec.lean[1] * s.t0];
    const leanB = [spec.lean[0] * s.t1, spec.lean[1] * s.t1];
    const lower = ringAt(poly, spec.x, spec.z, spec.w, spec.d, baseY + s.y0, s.s0, s.r0, spec.yaw, leanA[0], leanA[1]);
    const upper = ringAt(poly, spec.x, spec.z, spec.w, spec.d, baseY + s.y1, s.s1, s.r1, spec.yaw, leanB[0], leanB[1]);

    // A setback leaves a walkable ledge, and the ledge is the whole point of a
    // terraced style: it catches light, it holds plant, it breaks the wall.
    if (prevTop && prevScale > s.s0 + 1e-4) {
      mb.ring(prevTop, lower, trim, tsurf, 0, 0);
      emitLedge(mb, prevTop, lower, trim, tsurf);
      if (detail >= 2 && spec.parapet > 0.2) emitParapet(mb, lower, prevScale / s.s0, trim, tsurf, spec.parapet * 0.7);
    }

    const sectionFaces = [];
    u = mb.ring(lower, upper, col, surf, u, baseY + s.y0, sectionFaces);
    if (faces) faces.push({ faces: sectionFaces, section: s, index: i });
    else if (out && out.windows) collectWindows(sectionFaces, s, spec, out, rng, opts, 1);

    prevTop = upper;
    prevScale = s.s1;
  }

  if (faces && out && out.windows) {
    for (const f of faces) collectWindows(f.faces, f.section, spec, out, rng, opts, 2);
  }

  const topY = baseY + spec.height;
  const topScale = spec.sections[spec.sections.length - 1].s1;
  const topRot = spec.sections[spec.sections.length - 1].r1;
  const topRing = ringAt(poly, spec.x, spec.z, spec.w, spec.d, topY, topScale,
    topRot, spec.yaw, spec.lean[0], spec.lean[1]);

  emitRoof(mb, spec, topRing, topY, topScale, rng, out, detail);

  if (detail >= 2) {
    if (spec.buttress) emitButtresses(mb, spec, poly, baseY, trim, tsurf);
    if (spec.fins) emitFins(mb, spec, poly, baseY, trim, tsurf);
    if (spec.balcony) emitBalconies(mb, spec, faces, rng, trim, tsurf);
    if (spec.pipes) emitPipes(mb, spec, faces, rng);
    if (spec.ruined) emitRuinSlabs(mb, spec, topRing, topY, rng);
  }

  // Sign anchors: ground-floor faces where a passer-by would read them, and the
  // top of anything tall enough to be read from the next district.
  if (out && out.signs && faces && faces.length) {
    const ground = faces[0].faces;
    for (let i = 0; i < ground.length; i++) {
      const f = ground[i];
      if (f.w < 3) continue;
      const mx = (f.a[0] + f.b[0]) * 0.5, mz = (f.a[2] + f.b[2]) * 0.5;
      const nx = f.b[2] - f.a[2], nz = -(f.b[0] - f.a[0]);
      const l = Math.hypot(nx, nz) || 1;
      out.signs.push({
        position: [mx + (nx / l) * 0.45, baseY + spec.floorHeight * lerp(0.55, 0.85, rng.next()), mz + (nz / l) * 0.45],
        yaw: Math.atan2(nx / l, nz / l),
        faceWidth: f.w,
        scale: clamp(f.w / 9, 0.45, 1.6),
        weight: spec.signage,
        high: false,
      });
    }
    if (spec.height > 26 && rng.bool(0.35)) {
      const f = faces[faces.length - 1].faces[rng.int(0, faces[faces.length - 1].faces.length - 1)];
      const nx = f.b[2] - f.a[2], nz = -(f.b[0] - f.a[0]);
      const l = Math.hypot(nx, nz) || 1;
      out.signs.push({
        position: [(f.a[0] + f.b[0]) * 0.5 + (nx / l) * 0.5, topY - spec.floorHeight * 1.4, (f.a[2] + f.b[2]) * 0.5 + (nz / l) * 0.5],
        yaw: Math.atan2(nx / l, nz / l),
        faceWidth: f.w,
        scale: clamp(f.w / 6, 0.8, 3.2),
        weight: spec.signage * 1.4,
        high: true,
      });
    }
  }

  return mb;
}

function collectWindows(faces, section, spec, out, rng, opts, detail) {
  const w = spec.window;
  if (!w || w.mode === WindowMode.NONE) return;
  if (out.windowBudget !== undefined && out.windows.length >= out.windowBudget) return;

  const civ = spec.civ || opts.civ;
  const interior = (civ && civ.palette && civ.palette.interior) || [1.6, 1.3, 0.95];
  const cool = [interior[2] * 0.85, interior[1] * 0.95, interior[0] * 1.05];
  const lights = opts.lights ?? 1;
  const skip = w.skipFloors;
  const floorH = spec.floorHeight;
  const pitch = w.size[0] + w.gap;
  const rowStep = Math.max(floorH, w.size[1] + 0.35);
  // The simplified LOD keeps every other floor: at the distance it is used the
  // rhythm survives and the instance count halves.
  const floorStride = detail >= 2 ? 1 : 2;

  for (const f of faces) {
    if (f.w < w.size[0] * 1.4) continue;
    const rows = Math.max(1, Math.floor(f.h / rowStep));
    const cols = clamp(Math.floor((f.w - w.gap) / pitch), 1, w.cols[1]);
    if (cols < w.cols[0] && f.w < w.size[0] * (w.cols[0] + 1)) continue;

    // Face frame: edge direction, outward normal, and the true up direction,
    // which is not vertical on a tapered or leaning tower.
    const ex = f.b[0] - f.a[0], ez = f.b[2] - f.a[2];
    const el = Math.hypot(ex, ez) || 1;
    const nx = ez / el, nz = -ex / el;
    const ux = f.d[0] - f.a[0], uy = f.d[1] - f.a[1], uz = f.d[2] - f.a[2];
    const ul = Math.hypot(ux, uy, uz) || 1;

    const span = cols * pitch - w.gap;
    const x0 = (f.w - span) * 0.5 + w.size[0] * 0.5;

    for (let r = 0; r < rows; r += floorStride) {
      if (rng.next() < skip) continue;
      const vy = (r + 0.52) / rows;
      for (let c = 0; c < cols; c++) {
        if (out.windowBudget !== undefined && out.windows.length >= out.windowBudget) return;
        let along = x0 + c * pitch;
        let vv = vy;
        if (w.mode === WindowMode.IRREGULAR) {
          if (rng.bool(0.35)) continue;
          along += rng.range(-w.gap, w.gap) * 0.3;
          vv += rng.range(-0.3, 0.3) / rows;
        }
        const tAlong = along / f.w;
        const px = f.a[0] + ex * tAlong + ux * vv;
        const py = f.a[1] + uy * vv;
        const pz = f.a[2] + ez * tAlong + uz * vv;

        // Per-window decision. A facade where the lit fraction is right but the
        // *clustering* is wrong still reads as noise, so neighbouring windows
        // share a little of their state through the row seed.
        const rowBias = ((r * 2654435761 + Math.floor(spec.seed * 1e6)) % 1000) / 1000;
        const p = clamp(w.litFraction * lights * lerp(0.6, 1.4, rowBias), 0, 1);
        const on = rng.next() < p;
        const warmth = clamp(lerp(w.warmth[0], w.warmth[1], rng.next())
          + rng.range(-1, 1) * w.colorVariance * 0.5, 0, 1);
        const tint = [
          lerp(cool[0], interior[0], warmth),
          lerp(cool[1], interior[1], warmth),
          lerp(cool[2], interior[2], warmth),
        ];
        const v = 1 + rng.range(-1, 1) * w.colorVariance * 0.6;
        const halfW = w.size[0] * 0.5 * (w.mode === WindowMode.BAND ? 1.0 : lerp(0.92, 1.0, rng.next()));
        const halfH = Math.min(w.size[1], rowStep * 0.9) * 0.5;

        out.windows.push({
          // Proud of the wall by a couple of centimetres: the parallax shader
          // supplies the depth, so a real recess would only cost triangles.
          pos: [px + nx * 0.03, py, pz + nz * 0.03],
          right: [(ex / el) * halfW, 0, (ez / el) * halfW],
          up: [(ux / ul) * halfH, (uy / ul) * halfH, (uz / ul) * halfH],
          color: [tint[0] * v, tint[1] * v, tint[2] * v],
          seed: rng.next() * 512,
          lit: on ? lerp(0.55, 1.25, rng.next()) : 0.0,
        });
      }
    }
  }
}

// --- ornament ----------------------------------------------------------------

function emitLedge(mb, inner, outer, col, surf) {
  const n = inner.length / 3;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = [outer[i * 3], outer[i * 3 + 1], outer[i * 3 + 2]];
    const b = [outer[j * 3], outer[j * 3 + 1], outer[j * 3 + 2]];
    const c = [inner[j * 3], inner[j * 3 + 1], outer[j * 3 + 2]];
    void c;
    const cc = [inner[j * 3], outer[j * 3 + 1], inner[j * 3 + 2]];
    const dd = [inner[i * 3], outer[i * 3 + 1], inner[i * 3 + 2]];
    mb.quad(a, b, cc, dd, col, surf);
  }
}

function emitParapet(mb, ring, k, col, surf, h) {
  void k;
  const n = ring.length / 3;
  const height = clamp(h * 1.1, 0.3, 1.4);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = [ring[i * 3], ring[i * 3 + 1], ring[i * 3 + 2]];
    const b = [ring[j * 3], ring[j * 3 + 1], ring[j * 3 + 2]];
    const c = [b[0], b[1] + height, b[2]];
    const d = [a[0], a[1] + height, a[2]];
    mb.quad(a, b, c, d, col, surf);
    mb.quad(d, c, b, a, col, surf);
  }
}

function emitStilts(mb, spec, poly, detail) {
  const n = poly.length / 2;
  const legs = detail >= 2 ? Math.min(n, 8) : 4;
  const r = 0.18 + spec.w * 0.012;
  for (let i = 0; i < legs; i++) {
    const k = Math.round((i * n) / legs) % n;
    const px = poly[k * 2] * spec.w * 0.82, pz = poly[k * 2 + 1] * spec.d * 0.82;
    const ca = Math.cos(spec.yaw), sa = Math.sin(spec.yaw);
    const x = spec.x + px * ca - pz * sa;
    const z = spec.z + px * sa + pz * ca;
    mb.box(null, x - r, spec.groundY - 1.0, z - r, x + r, spec.groundY + spec.stiltH, z + r,
      [spec.trim[0] * 0.7, spec.trim[1] * 0.7, spec.trim[2] * 0.7], spec.trimSurf);
  }
  // A deck under the floor plate, so the building does not float on sticks.
  const ring = ringAt(poly, spec.x, spec.z, spec.w, spec.d, spec.groundY + spec.stiltH, 1.04, 0, spec.yaw, 0, 0);
  mb.cap(ring, spec.trim, spec.trimSurf, false);
}

function emitButtresses(mb, spec, poly, baseY, col, surf) {
  const n = poly.length / 2;
  const count = Math.min(n, 8);
  const h = spec.height * lerp(0.25, 0.5, (spec.seed * 7) % 1);
  const ca = Math.cos(spec.yaw), sa = Math.sin(spec.yaw);
  for (let i = 0; i < count; i++) {
    const k = Math.round((i * n) / count) % n;
    const j = (k + 1) % n;
    const mxu = (poly[k * 2] + poly[j * 2]) * 0.5;
    const mzu = (poly[k * 2 + 1] + poly[j * 2 + 1]) * 0.5;
    const px = mxu * spec.w, pz = mzu * spec.d;
    const x = spec.x + px * ca - pz * sa;
    const z = spec.z + px * sa + pz * ca;
    const ox = spec.x + px * 1.4 * ca - pz * 1.4 * sa;
    const oz = spec.z + px * 1.4 * sa + pz * 1.4 * ca;
    const w = Math.min(spec.w, spec.d) * 0.16;
    const dx = -(pz * ca + px * sa), dz = px * ca - pz * sa;
    const l = Math.hypot(dx, dz) || 1;
    const hx = (dx / l) * w, hz = (dz / l) * w;
    // A flying buttress is a wedge: wide at the foot, meeting the wall high up.
    mb.tri([ox - hx, baseY, oz - hz], [ox + hx, baseY, oz + hz], [x + hx, baseY + h, z + hz], col, surf);
    mb.tri([ox - hx, baseY, oz - hz], [x + hx, baseY + h, z + hz], [x - hx, baseY + h, z - hz], col, surf);
    mb.quad([ox + hx, baseY, oz + hz], [ox - hx, baseY, oz - hz], [x - hx, baseY + h, z - hz], [x + hx, baseY + h, z + hz], col, surf);
  }
}

function emitFins(mb, spec, poly, baseY, col, surf) {
  const n = poly.length / 2;
  const ca = Math.cos(spec.yaw), sa = Math.sin(spec.yaw);
  const depth = Math.min(spec.w, spec.d) * 0.11;
  for (let i = 0; i < n; i++) {
    const px = poly[i * 2] * spec.w, pz = poly[i * 2 + 1] * spec.d;
    const l = Math.hypot(px, pz) || 1;
    const ux = (px / l) * depth, uz = (pz / l) * depth;
    const x = spec.x + px * ca - pz * sa;
    const z = spec.z + px * sa + pz * ca;
    const ox = x + (ux * ca - uz * sa), oz = z + (ux * sa + uz * ca);
    const top = baseY + spec.height * 0.98;
    const w = 0.22;
    mb.quad([x, baseY, z], [ox, baseY, oz], [ox, top, oz], [x, top, z], col, surf);
    mb.quad([ox, baseY, oz], [x, baseY, z], [x, top, z], [ox, top, oz], col, surf);
    void w;
  }
}

function emitBalconies(mb, spec, faces, rng, col, surf) {
  if (!faces) return;
  const depth = clamp(Math.min(spec.w, spec.d) * 0.10, 0.7, 1.8);
  for (const sec of faces) {
    for (const f of sec.faces) {
      if (f.w < 3.5) continue;
      const rows = Math.max(1, Math.floor(f.h / spec.floorHeight));
      const ex = f.b[0] - f.a[0], ez = f.b[2] - f.a[2];
      const el = Math.hypot(ex, ez) || 1;
      const nx = ez / el, nz = -ex / el;
      for (let r = 0; r < rows; r++) {
        if (rng.next() > 0.45) continue;
        const y = f.a[1] + (f.h * (r + 0.02)) / rows;
        const t0 = rng.range(0.06, 0.4), t1 = t0 + rng.range(0.25, 0.5);
        const ax = f.a[0] + ex * t0, az = f.a[2] + ez * t0;
        const bx = f.a[0] + ex * Math.min(t1, 0.96), bz = f.a[2] + ez * Math.min(t1, 0.96);
        const ox = nx * depth, oz = nz * depth;
        // Slab, then a rail. The rail is what makes it read as inhabited.
        mb.quad([ax, y, az], [bx, y, bz], [bx + ox, y, bz + oz], [ax + ox, y, az + oz], col, surf);
        mb.quad([ax + ox, y, az + oz], [bx + ox, y, bz + oz], [bx + ox, y - 0.16, bz + oz], [ax + ox, y - 0.16, az + oz], col, surf);
        const rh = rng.range(0.85, 1.15);
        mb.quad([ax + ox, y, az + oz], [bx + ox, y, bz + oz], [bx + ox, y + rh, bz + oz], [ax + ox, y + rh, az + oz], col, surf);
        mb.quad([bx + ox, y, bz + oz], [ax + ox, y, az + oz], [ax + ox, y + rh, az + oz], [bx + ox, y + rh, bz + oz], col, surf);
      }
    }
  }
}

function emitPipes(mb, spec, faces, rng) {
  if (!faces || !faces.length) return;
  const col = [spec.trim[0] * 0.75, spec.trim[1] * 0.72, spec.trim[2] * 0.68];
  const surf = [0.55, 0.7, 0];
  const sec = faces[0];
  const nRuns = rng.int(2, 5);
  for (let i = 0; i < nRuns; i++) {
    const f = sec.faces[rng.int(0, sec.faces.length - 1)];
    if (f.w < 2) continue;
    const ex = f.b[0] - f.a[0], ez = f.b[2] - f.a[2];
    const el = Math.hypot(ex, ez) || 1;
    const nx = ez / el, nz = -ex / el;
    const t = rng.range(0.1, 0.9);
    const r = rng.range(0.07, 0.19);
    const x = f.a[0] + ex * t + nx * (r + 0.06);
    const z = f.a[2] + ez * t + nz * (r + 0.06);
    const top = f.a[1] + spec.height * rng.range(0.35, 0.95);
    mb.box(null, x - r, f.a[1] - 0.3, z - r, x + r, top, z + r, col, surf);
    // A bracket every few metres. Repetition at a fixed pitch is the cue that
    // reads as "installed" rather than "modelled".
    for (let y = f.a[1] + 2.5; y < top; y += rng.range(3.5, 6)) {
      mb.box(null, x - r * 1.7, y, z - r * 1.7, x + r * 1.7, y + 0.16, z + r * 1.7, col, surf);
    }
  }
}

function emitRuinSlabs(mb, spec, topRing, topY, rng) {
  const n = topRing.length / 3;
  const col = [spec.color[0] * 0.65, spec.color[1] * 0.62, spec.color[2] * 0.6];
  const surf = [0.98, 0.02, 0];
  // Exposed floor plates where the shell came off, each one a little lower.
  const plates = rng.int(1, 3);
  for (let i = 0; i < plates; i++) {
    const y = topY - i * spec.floorHeight * rng.range(0.9, 1.4);
    const k = rng.range(0.35, 0.85);
    const ring = new Array(n * 3);
    for (let v = 0; v < n; v++) {
      ring[v * 3] = spec.x + (topRing[v * 3] - spec.x) * k;
      ring[v * 3 + 1] = y;
      ring[v * 3 + 2] = spec.z + (topRing[v * 3 + 2] - spec.z) * k;
    }
    mb.cap(ring, col, surf, true);
  }
}

// --- roofs -------------------------------------------------------------------

function emitRoof(mb, spec, ring, topY, topScale, rng, out, detail) {
  const col = spec.trim, surf = spec.trimSurf;
  const n = ring.length / 3;
  const r = Math.min(spec.w, spec.d) * topScale * 0.5;

  switch (spec.roof) {
    case Roof.SPIRE: {
      const apex = [spec.x + spec.lean[0], topY + r * lerp(2.0, 4.5, rng.next()), spec.z + spec.lean[1]];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        mb.tri([ring[i * 3], ring[i * 3 + 1], ring[i * 3 + 2]],
          [ring[j * 3], ring[j * 3 + 1], ring[j * 3 + 2]], apex, col, surf);
      }
      break;
    }
    case Roof.DOME: {
      const steps = detail >= 2 ? 4 : 2;
      let prev = ring;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const k = Math.cos((t * Math.PI) / 2);
        const y = topY + Math.sin((t * Math.PI) / 2) * r * 0.9;
        const next = new Array(n * 3);
        for (let v = 0; v < n; v++) {
          next[v * 3] = spec.x + (ring[v * 3] - spec.x) * k;
          next[v * 3 + 1] = y;
          next[v * 3 + 2] = spec.z + (ring[v * 3 + 2] - spec.z) * k;
        }
        mb.ring(prev, next, col, surf);
        prev = next;
      }
      break;
    }
    case Roof.ORGANIC: {
      const steps = detail >= 2 ? 3 : 2;
      let prev = ring;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const k = Math.pow(1 - t, 0.7);
        const y = topY + t * r * 1.4;
        const next = new Array(n * 3);
        for (let v = 0; v < n; v++) {
          next[v * 3] = spec.x + (ring[v * 3] - spec.x) * k;
          next[v * 3 + 1] = y;
          next[v * 3 + 2] = spec.z + (ring[v * 3 + 2] - spec.z) * k;
        }
        mb.ring(prev, next, spec.color, spec.surf);
        prev = next;
      }
      break;
    }
    case Roof.RIDGE: {
      // A pitched roof needs a ridge line, and the line has to have a direction
      // that agrees with the building, not with the world.
      const ca = Math.cos(spec.yaw), sa = Math.sin(spec.yaw);
      const h = r * rng.range(0.6, 1.1);
      const ex = ca * spec.w * topScale * 0.55, ez = sa * spec.w * topScale * 0.55;
      const p0 = [spec.x - ex, topY + h, spec.z - ez];
      const p1 = [spec.x + ex, topY + h, spec.z + ez];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = [ring[i * 3], ring[i * 3 + 1], ring[i * 3 + 2]];
        const b = [ring[j * 3], ring[j * 3 + 1], ring[j * 3 + 2]];
        const side = (a[0] - spec.x) * (-sa) + (a[2] - spec.z) * ca;
        mb.tri(a, b, side > 0 ? p1 : p0, col, surf);
      }
      mb.quad(p0, p1, p1, p0, col, surf);
      break;
    }
    case Roof.SHATTER: {
      const shards = detail >= 2 ? rng.int(3, 7) : 2;
      for (let i = 0; i < shards; i++) {
        const a = rng.range(0, TAU);
        const rr = r * rng.range(0.15, 0.7);
        const cx = spec.x + Math.cos(a) * rr, cz = spec.z + Math.sin(a) * rr;
        const hh = r * rng.range(0.8, 3.2);
        const w = r * rng.range(0.12, 0.3);
        const apex = [cx + rng.range(-1, 1) * w, topY + hh, cz + rng.range(-1, 1) * w];
        for (let k = 0; k < 4; k++) {
          const a0 = (k / 4) * TAU + a, a1 = ((k + 1) / 4) * TAU + a;
          mb.tri([cx + Math.cos(a0) * w, topY, cz + Math.sin(a0) * w],
            [cx + Math.cos(a1) * w, topY, cz + Math.sin(a1) * w], apex,
            spec.accent, [0.12, 0.2, 0]);
        }
      }
      break;
    }
    case Roof.CANOPY: {
      const masts = detail >= 2 ? rng.int(2, 4) : 1;
      const mh = r * rng.range(1.2, 2.2);
      const tips = [];
      for (let i = 0; i < masts; i++) {
        const a = (i / masts) * TAU + rng.range(0, 1);
        const rr = r * 0.55;
        const x = spec.x + Math.cos(a) * rr, z = spec.z + Math.sin(a) * rr;
        mb.box(null, x - 0.12, topY, z - 0.12, x + 0.12, topY + mh, z + 0.12, col, surf);
        tips.push([x, topY + mh, z]);
      }
      // The fabric: a low-tension surface from each mast tip out to the parapet.
      const cloth = spec.accent;
      const csurf = [0.85, 0, 0];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = [ring[i * 3], ring[i * 3 + 1] + 0.4, ring[i * 3 + 2]];
        const b = [ring[j * 3], ring[j * 3 + 1] + 0.4, ring[j * 3 + 2]];
        const tip = tips[i % tips.length];
        mb.tri(a, b, tip, cloth, csurf);
        mb.tri(b, a, tip, cloth, csurf);
      }
      break;
    }
    case Roof.MAST: {
      const mh = Math.max(8, spec.height * rng.range(0.14, 0.32));
      const w = Math.max(0.35, r * 0.09);
      mb.box(null, spec.x - w, topY, spec.z - w, spec.x + w, topY + mh, spec.z + w, col, surf);
      emitBeacon(mb, spec.x, topY + mh, spec.z, w * 2.4, rng);
      mb.cap(ring, col, surf, true);
      break;
    }
    case Roof.STEPPED: {
      let prev = ring;
      let y = topY;
      const steps = detail >= 2 ? rng.int(2, 4) : 1;
      for (let s = 0; s < steps; s++) {
        const k = 1 - (s + 1) * 0.17;
        y += spec.floorHeight * rng.range(0.5, 1.1);
        const next = new Array(n * 3);
        for (let v = 0; v < n; v++) {
          next[v * 3] = spec.x + (ring[v * 3] - spec.x) * k;
          next[v * 3 + 1] = y;
          next[v * 3 + 2] = spec.z + (ring[v * 3 + 2] - spec.z) * k;
        }
        const flat = next.slice();
        for (let v = 0; v < n; v++) flat[v * 3 + 1] = prev[v * 3 + 1];
        mb.cap(prev, col, surf, true);
        mb.ring(flat, next, col, surf);
        prev = next;
      }
      mb.cap(prev, col, surf, true);
      break;
    }
    case Roof.TERRACE:
    case Roof.FLAT:
    default: {
      mb.cap(ring, col, surf, true);
      if (spec.parapet > 0.05 && detail >= 2) emitParapet(mb, ring, 1, col, surf, spec.parapet);
      break;
    }
  }

  // Machinery. This is the layer that turns a roofline into a skyline, and it
  // is worth spending triangles on because it is silhouetted against the sky
  // from everywhere in the city.
  const flatish = spec.roof === Roof.FLAT || spec.roof === Roof.TERRACE
    || spec.roof === Roof.STEPPED || spec.roof === Roof.MAST;
  if (flatish && detail >= 2 && spec.roofClutter > 0.02) {
    emitRoofClutter(mb, spec, ring, topY, r, rng, out);
  }
  if (out && out.pads && flatish && r > 7 && rng.next() < 0.28) {
    out.pads.push({ position: [spec.x, topY + 0.25, spec.z], radius: r * 0.7, seed: rng.next() });
  }
}

function emitBeacon(mb, x, y, z, s, rng) {
  // Aircraft warning light. Pushed hard into HDR and given a blink phase in the
  // facade attribute, so the post chain blooms it and the whole skyline pulses
  // slightly out of step with itself.
  const c = [7.0, 0.55, 0.35];
  const surf = [1, 0, 1];
  const ph = rng.next();
  const f = [[ph, 0.9], [ph, 0.9], [ph, 0.9], [ph, 0.9]];
  const h = s * 0.5;
  mb.quad([x - h, y, z - h], [x + h, y, z - h], [x + h, y + s, z - h], [x - h, y + s, z - h], c, surf, f);
  mb.quad([x + h, y, z + h], [x - h, y, z + h], [x - h, y + s, z + h], [x + h, y + s, z + h], c, surf, f);
  mb.quad([x + h, y, z - h], [x + h, y, z + h], [x + h, y + s, z + h], [x + h, y + s, z - h], c, surf, f);
  mb.quad([x - h, y, z + h], [x - h, y, z - h], [x - h, y + s, z - h], [x - h, y + s, z + h], c, surf, f);
}

function emitRoofClutter(mb, spec, ring, topY, r, rng, out) {
  const k = spec.roofClutter;
  const count = Math.round(lerp(1, 9, k) * clamp(r / 8, 0.4, 2.2));
  const col = [spec.trim[0] * 0.8, spec.trim[1] * 0.8, spec.trim[2] * 0.78];
  const surf = [0.7, 0.45, 0];

  for (let i = 0; i < count; i++) {
    const a = rng.range(0, TAU);
    const rr = r * Math.sqrt(rng.next()) * 0.78;
    const x = spec.x + Math.cos(a) * rr, z = spec.z + Math.sin(a) * rr;
    const kind = rng.weighted(['plant', 'tank', 'vent', 'shed', 'dish'], [1.4, 0.9, 1.1, 0.7, k * 0.6]);
    switch (kind) {
      case 'tank': {
        const rad = rng.range(0.7, 2.0), h = rng.range(1.6, 4.2);
        const seg = 8;
        const lower = [], upper = [];
        for (let s = 0; s < seg; s++) {
          const ang = -(s / seg) * TAU;
          lower.push(x + Math.cos(ang) * rad, topY, z + Math.sin(ang) * rad);
          upper.push(x + Math.cos(ang) * rad, topY + h, z + Math.sin(ang) * rad);
        }
        mb.ring(lower, upper, col, surf);
        mb.cap(upper, col, surf, true);
        break;
      }
      case 'vent': {
        const w = rng.range(0.3, 0.8), h = rng.range(1.0, 3.0);
        mb.box(null, x - w, topY, z - w, x + w, topY + h, z + w, col, surf);
        mb.box(null, x - w * 1.5, topY + h, z - w * 1.5, x + w * 1.5, topY + h + 0.25, z + w * 1.5, col, surf);
        break;
      }
      case 'shed': {
        const w = rng.range(1.5, 4.0), d = rng.range(1.5, 3.5), h = rng.range(2.0, 3.4);
        mb.box(null, x - w, topY, z - d, x + w, topY + h, z + d, col, surf);
        break;
      }
      case 'dish': {
        const rad = rng.range(0.8, 2.2);
        const mast = rng.range(1.0, 2.5);
        mb.box(null, x - 0.1, topY, z - 0.1, x + 0.1, topY + mast, z + 0.1, col, surf);
        const tilt = rng.range(0.3, 0.9);
        const seg = 7;
        const rim = [];
        for (let s = 0; s < seg; s++) {
          const ang = -(s / seg) * TAU;
          rim.push(x + Math.cos(ang) * rad, topY + mast + Math.sin(ang) * rad * tilt, z + Math.sin(ang) * rad * 0.4);
        }
        mb.cap(rim, [col[0] * 1.2, col[1] * 1.2, col[2] * 1.2], [0.4, 0.2, 0], true);
        break;
      }
      default: {
        const w = rng.range(0.8, 2.4), d = rng.range(0.8, 2.0), h = rng.range(0.8, 2.2);
        mb.box(null, x - w, topY, z - d, x + w, topY + h, z + d, col, surf);
        if (rng.bool(0.4)) mb.box(null, x - w * 0.4, topY + h, z - d * 0.4, x + w * 0.4, topY + h + rng.range(0.4, 1.2), z + d * 0.4, col, surf);
      }
    }
  }

  // Aerials. Always the tallest thing, always thin, always the last silhouette
  // element the eye resolves — which is exactly why they are worth having.
  const masts = rng.int(0, k > 0.6 ? 4 : 2);
  for (let i = 0; i < masts; i++) {
    const a = rng.range(0, TAU);
    const rr = r * rng.range(0.2, 0.85);
    const x = spec.x + Math.cos(a) * rr, z = spec.z + Math.sin(a) * rr;
    const h = rng.range(3, 16) * clamp(spec.height / 30, 0.5, 2.0);
    const w = rng.range(0.06, 0.16);
    mb.box(null, x - w, topY, z - w, x + w, topY + h, z + w, col, [0.6, 0.8, 0]);
    for (let s = 0; s < 3; s++) {
      const y = topY + h * rng.range(0.3, 0.95);
      const cw = rng.range(0.3, 1.1);
      const ang = rng.range(0, TAU);
      mb.box(null, x - Math.abs(Math.cos(ang)) * cw, y, z - Math.abs(Math.sin(ang)) * cw,
        x + Math.abs(Math.cos(ang)) * cw, y + 0.07, z + Math.abs(Math.sin(ang)) * cw, col, [0.6, 0.8, 0]);
    }
    if (h > 8 || rng.bool(0.4)) emitBeacon(mb, x, topY + h, z, 0.5, rng);
  }
  void out;
}

// --- materials ---------------------------------------------------------------

const CITY_SURFACE_COMMON = /* glsl */ `
  varying vec3 vSurfP;
  varying vec2 vFacadeP;
  varying vec3 vWorldP;
`;

const CITY_HASH = /* glsl */ `
  float civHash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
  float civHash21(vec2 p){
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
`;

/**
 * The single material every opaque surface in the city uses.
 *
 * Built on MeshStandardMaterial rather than a bespoke shader because the city
 * has to sit under the same sun, sky and shadow cascade as the terrain, and
 * re-deriving three.js's lighting to save two texture fetches is a bad trade.
 * What is added is entirely surface: per-vertex roughness and metalness so one
 * mesh can hold concrete, steel and glass; panel lines and grime keyed to a
 * facade-space coordinate; and an emissive channel with a blink phase for the
 * beacons and light strips.
 *
 * Panel lines are the highest-value line of shader code in this file. A flat
 * wall with a 3 m grid of shallow grooves reads as *manufactured*; the same
 * wall without them reads as an untextured box, no matter how good the
 * silhouette is.
 */
export function makeCityMaterial(civ, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1.0,
    metalness: 0.0,
    side: THREE.FrontSide,
    shadowSide: THREE.FrontSide,
  });
  mat.name = 'city-surface';

  const uniforms = {
    uTime: { value: 0 },
    uWet: { value: 0 },
    uGrime: { value: opts.grime ?? 0.7 },
    uPanel: { value: opts.panel ?? 1.0 },
    uEmissiveGain: { value: opts.emissiveGain ?? 1.0 },
  };
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aSurf;
        attribute vec2 aFacade;
        ${CITY_SURFACE_COMMON}
      `)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vSurfP = aSurf;
        vFacadeP = aFacade;
        vWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform float uWet;
        uniform float uGrime;
        uniform float uPanel;
        uniform float uEmissiveGain;
        ${CITY_SURFACE_COMMON}
        ${CITY_HASH}

        // Shallow grooves on a 3 m x floor-height lattice, widened by fwidth so
        // they neither alias at distance nor fatten up close.
        float civPanel(vec2 uv){
          vec2 cell = vec2(3.1, 3.4);
          vec2 q = uv / cell;
          vec2 f = abs(fract(q) - 0.5);
          vec2 w = fwidth(q) * 1.4 + 1e-4;
          vec2 l = smoothstep(0.5 - w, 0.5, f);
          return max(l.x, l.y);
        }

        // Vertical streaks below every ledge. Dirt runs down, never up, and the
        // asymmetry is what makes weathering read as gravity rather than noise.
        float civGrime(vec2 uv){
          float band = fract(uv.y / 3.4);
          float col = civHash21(vec2(floor(uv.x * 0.55), floor(uv.y / 3.4)));
          float streak = smoothstep(0.0, 0.55, band) * step(0.45, col);
          float fine = civHash21(vec2(floor(uv.x * 3.0), 0.0));
          return streak * (0.35 + 0.65 * fine);
        }
      `)
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = clamp(vSurfP.x, 0.02, 1.0);
      `)
      .replace('#include <metalnessmap_fragment>', `
        float metalnessFactor = clamp(vSurfP.y, 0.0, 1.0);
      `)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float emiMask = vSurfP.z;
        if (emiMask < 0.5) {
          float pl = civPanel(vFacadeP);
          float gr = civGrime(vFacadeP) * uGrime;
          diffuseColor.rgb *= 1.0 - pl * 0.30 * uPanel;
          diffuseColor.rgb *= 1.0 - gr * 0.22;
          // Wet surfaces darken and tighten before they ever reflect anything.
          diffuseColor.rgb *= 1.0 - uWet * 0.35;
          roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.25 + 0.03, uWet);
        } else {
          diffuseColor.rgb *= 0.04;
        }
      `)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vSurfP.z > 0.5) {
          float rate = vFacadeP.y;
          float blink = rate > 0.01
            ? step(0.5, fract(uTime * rate + vFacadeP.x))
            : 1.0;
          totalEmissiveRadiance += vColor * vSurfP.z * blink * uEmissiveGain;
        }
      `);
  };
  // A changed define forces a recompile; this key keeps three from sharing a
  // cached program between two city materials with different injections.
  mat.customProgramCacheKey = () => 'city-surface-1';
  return mat;
}

// --- window batch ------------------------------------------------------------

/**
 * Every window in the city, in one draw call.
 *
 * Interiors.js owns the shader; this owns the buffers. It is an
 * InstancedBufferGeometry on a plain Mesh rather than an InstancedMesh, because
 * the interior shader builds its own world position out of the per-instance
 * frame and would ignore an instance matrix — so allocating sixteen floats per
 * window to store an identity would be pure waste.
 */
export function buildWindows(windows, civ, opts = {}) {
  const n = windows.length;
  if (!n) return null;

  const geo = new THREE.InstancedBufferGeometry();
  const quad = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
  geo.setAttribute('position', new THREE.BufferAttribute(quad, 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);

  const aPos = new Float32Array(n * 3);
  const aRight = new Float32Array(n * 3);
  const aUp = new Float32Array(n * 3);
  const aColor = new Float32Array(n * 3);
  const aFlags = new Float32Array(n * 2);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < n; i++) {
    const w = windows[i];
    aPos[i * 3] = w.pos[0]; aPos[i * 3 + 1] = w.pos[1]; aPos[i * 3 + 2] = w.pos[2];
    aRight[i * 3] = w.right[0]; aRight[i * 3 + 1] = w.right[1]; aRight[i * 3 + 2] = w.right[2];
    aUp[i * 3] = w.up[0]; aUp[i * 3 + 1] = w.up[1]; aUp[i * 3 + 2] = w.up[2];
    aColor[i * 3] = w.color[0]; aColor[i * 3 + 1] = w.color[1]; aColor[i * 3 + 2] = w.color[2];
    aFlags[i * 2] = w.seed;
    aFlags[i * 2 + 1] = w.lit;
    if (w.pos[0] < minX) minX = w.pos[0];
    if (w.pos[1] < minY) minY = w.pos[1];
    if (w.pos[2] < minZ) minZ = w.pos[2];
    if (w.pos[0] > maxX) maxX = w.pos[0];
    if (w.pos[1] > maxY) maxY = w.pos[1];
    if (w.pos[2] > maxZ) maxZ = w.pos[2];
  }

  geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(aPos, 3));
  geo.setAttribute('aRight', new THREE.InstancedBufferAttribute(aRight, 3));
  geo.setAttribute('aUp', new THREE.InstancedBufferAttribute(aUp, 3));
  geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(aColor, 3));
  geo.setAttribute('aFlags', new THREE.InstancedBufferAttribute(aFlags, 2));
  geo.instanceCount = n;

  // Instanced attributes never reach the bounding-sphere computation, so it has
  // to be supplied or three culls the whole batch the moment the origin leaves
  // the frustum.
  const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;
  geo.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(cx, cy, cz),
    Math.hypot(maxX - cx, maxY - cy, maxZ - cz) + 4
  );

  const mat = opts.material || makeWindowMaterial(civ, opts);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'city-windows';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 2;
  return mesh;
}

// --- impostors ---------------------------------------------------------------

const IMPOSTOR_VERT = /* glsl */ `
  precision highp float;
  attribute vec3 aOrigin;
  attribute vec3 aSize;      // half width, height, half depth
  attribute vec3 aTint;
  attribute vec2 aMeta;      // x = seed, y = chunk index
  uniform float uChunkVis[16];
  varying vec2 vUv;
  varying vec3 vTint;
  varying float vSeed;
  varying vec3 vNrm;
  varying float vFade;

  void main(){
    vSeed = aMeta.x;
    vTint = aTint;
    float vis = uChunkVis[int(aMeta.y)];

    // Cylindrical billboard: yaw toward the camera, keep vertical vertical.
    vec3 toCam = cameraPosition - aOrigin;
    vec2 f = normalize(vec2(toCam.x, toCam.z) + vec2(1e-5));
    vec3 right = vec3(f.y, 0.0, -f.x);
    vec3 up = vec3(0.0, 1.0, 0.0);
    vNrm = vec3(f.x, 0.0, f.y);

    vUv = position.xy + 0.5;
    vec3 world = aOrigin
      + right * position.x * 2.0 * aSize.x * vis
      + up * (position.y + 0.5) * aSize.y * vis;
    vFade = vis;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(world, 1.0);
  }
`;

const IMPOSTOR_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform vec3 uWindow;
  uniform float uNight;
  varying vec2 vUv;
  varying vec3 vTint;
  varying float vSeed;
  varying vec3 vNrm;
  varying float vFade;

  float imHash(vec2 p){
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main(){
    if (vFade < 0.5) discard;

    // Diffuse without a normal map: a billboard has one normal, so the shading
    // has to come from a wrap term or the far city goes flat and papery.
    float ndl = max(dot(vNrm, uSunDir) * 0.5 + 0.5, 0.0);
    vec3 lit = vTint * (uSunColor * ndl * 0.8 + uSkyColor * 0.35);

    // The window grid. At impostor range this is the only thing carrying the
    // read, so the cell aspect is deliberately matched to a storey.
    vec2 cell = vec2(9.0, 26.0);
    vec2 g = vUv * cell;
    vec2 gi = floor(g);
    vec2 gf = fract(g);
    float mask = step(0.18, gf.x) * step(gf.x, 0.82) * step(0.25, gf.y) * step(gf.y, 0.80);
    float on = step(0.52, imHash(gi + vSeed * 37.0));
    float warm = imHash(gi.yx + vSeed * 11.0);
    vec3 wc = uWindow * mix(0.75, 1.3, warm);
    lit += wc * mask * on * uNight * 0.9;

    // A soft vertical falloff at the very top hides the hard edge of the quad
    // against a bright sky.
    lit *= 1.0 - smoothstep(0.94, 1.0, vUv.y) * 0.55;
    gl_FragColor = vec4(lit, 1.0);
  }
`;

/** One instanced billboard per far building; the shader draws its own facade. */
export function buildImpostors(list, civ, opts = {}) {
  const n = list.length;
  if (!n) return null;
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
  geo.setAttribute('position', new THREE.BufferAttribute(quad, 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);

  const aOrigin = new Float32Array(n * 3);
  const aSize = new Float32Array(n * 3);
  const aTint = new Float32Array(n * 3);
  const aMeta = new Float32Array(n * 2);
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, maxY = 0;
  for (let i = 0; i < n; i++) {
    const b = list[i];
    aOrigin[i * 3] = b.x; aOrigin[i * 3 + 1] = b.y; aOrigin[i * 3 + 2] = b.z;
    aSize[i * 3] = b.halfWidth; aSize[i * 3 + 1] = b.height; aSize[i * 3 + 2] = b.halfWidth;
    aTint[i * 3] = b.color[0]; aTint[i * 3 + 1] = b.color[1]; aTint[i * 3 + 2] = b.color[2];
    aMeta[i * 2] = b.seed; aMeta[i * 2 + 1] = b.chunk;
    minX = Math.min(minX, b.x); maxX = Math.max(maxX, b.x);
    minZ = Math.min(minZ, b.z); maxZ = Math.max(maxZ, b.z);
    maxY = Math.max(maxY, b.y + b.height);
  }
  geo.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(aOrigin, 3));
  geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(aSize, 3));
  geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(aTint, 3));
  geo.setAttribute('aMeta', new THREE.InstancedBufferAttribute(aMeta, 2));
  geo.instanceCount = n;
  const cx = (minX + maxX) * 0.5, cz = (minZ + maxZ) * 0.5;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, maxY * 0.5, cz),
    Math.hypot(maxX - cx, maxY, maxZ - cz) + 10);

  const win = (civ && civ.palette && civ.palette.interior) || [1.8, 1.4, 1.0];
  const uniforms = {
    uChunkVis: { value: new Float32Array(16).fill(1) },
    uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3).normalize() },
    uSunColor: { value: new THREE.Color(1.0, 0.95, 0.88) },
    uSkyColor: { value: new THREE.Color(0.10, 0.14, 0.22) },
    uWindow: { value: new THREE.Vector3(win[0], win[1], win[2]) },
    uNight: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: IMPOSTOR_VERT,
    fragmentShader: IMPOSTOR_FRAG,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  mat.name = 'city-impostor';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'city-impostors';
  mesh.frustumCulled = true;
  void opts;
  return mesh;
}

// --- LOD assembly ------------------------------------------------------------

/**
 * Chunked LOD.
 *
 * Merged geometry and per-object LOD are mutually exclusive, so the unit of
 * switching is a spatial chunk of a few hundred buildings. Each chunk owns a
 * full mesh and a simplified one; beyond the impostor range both are hidden and
 * the chunk's buildings appear in the shared billboard batch instead. Because
 * the simplified mass keeps the section stack, the swap changes detail without
 * changing outline, which is the only kind of pop the eye forgives.
 */
export class BuildingLod {
  constructor(chunks, impostor, opts = {}) {
    this.group = new THREE.Group();
    this.group.name = 'buildings';
    this.chunks = chunks;
    this.impostor = impostor;
    this.nearDist = opts.nearDist ?? 420;
    this.farDist = opts.farDist ?? 1500;
    this._vis = impostor ? impostor.material.uniforms.uChunkVis.value : null;

    for (const c of chunks) {
      if (c.lod0) this.group.add(c.lod0);
      if (c.lod1) this.group.add(c.lod1);
    }
    if (impostor) this.group.add(impostor);
  }

  update(camera) {
    if (!camera) return;
    const cp = camera.position;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      const dx = cp.x - c.center[0], dy = cp.y - c.center[1], dz = cp.z - c.center[2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - c.radius;
      const near = d < this.nearDist;
      const mid = !near && d < this.farDist;
      if (c.lod0) c.lod0.visible = near;
      if (c.lod1) c.lod1.visible = mid;
      if (this._vis) this._vis[Math.min(15, c.index)] = near || mid ? 0 : 1;
    }
  }

  dispose() {
    for (const c of this.chunks) {
      if (c.lod0) { c.lod0.geometry.dispose(); }
      if (c.lod1) { c.lod1.geometry.dispose(); }
    }
    if (this.impostor) {
      this.impostor.geometry.dispose();
      this.impostor.material.dispose();
    }
    this.group.clear();
  }
}

/** Merge a list of built geometries into one, or return the single one given. */
export function mergeAll(geometries) {
  const live = geometries.filter((g) => g && g.attributes.position.count > 0);
  if (!live.length) return null;
  if (live.length === 1) return live[0];
  const merged = mergeGeometries(live, false);
  for (const g of live) g.dispose();
  return merged;
}

/** Recursive teardown for anything this module hands back inside a Group. */
export function disposeObject3D(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        for (const k in m) {
          const v = m[k];
          if (v && v.isTexture) v.dispose();
        }
        m.dispose();
      }
    }
  });
  root.clear();
}

export { smoothstep, lerp, clamp };
