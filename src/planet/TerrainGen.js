/**
 * The height field, and why it has the shape it has.
 *
 * Procedural terrain fails in a specific, recognisable way: it looks like noise
 * wrapped around a ball. Real terrain does not, because real terrain is the
 * residue of a small number of processes that each leave a distinct signature,
 * and the eye has spent a few million years learning to read them. So this file
 * runs those processes rather than approximating their output.
 *
 *   PLATES. A dozen-odd rigid caps drifting on the mantle. Where two converge
 *   the crust has nowhere to go but up, and you get a linear mountain belt with
 *   a trench on the oceanic side. Where two diverge you get a rift valley. Away
 *   from boundaries the crust is quiet. This single layer is what gives a planet
 *   *tectonic grain* — mountains in coherent chains rather than sprinkled
 *   everywhere — and it is the difference between a world and a texture.
 *
 *   CONTINENTS. Domain-warped fractal noise on top of the plate base. Warping
 *   is not decoration: an unwarped field has features aligned to the noise
 *   lattice, and coastlines that look combed. Warping bends them into the
 *   braided, re-entrant shapes real coasts have.
 *
 *   OROGENY. Ridged multifractal, but amplitude-modulated by the convergence
 *   mask so ridges exist only where the tectonics justify them. Ridged noise
 *   applied globally is the single most common tell of amateur terrain.
 *
 *   EROSION. Two mechanisms. Locally, high-frequency octaves are damped by the
 *   accumulated slope of the octaves beneath them (Quílez's derivative trick) —
 *   which is a cheap stand-in for the real fact that steep ground sheds its
 *   loose material, so detail survives on flats and is stripped from faces.
 *   Globally, an actual iterative hydraulic + thermal simulation runs once at
 *   load on a coarse grid over the region you can see, carving valleys and
 *   depositing fans; a flow-accumulation pass over the same grid finds where
 *   water collects and cuts river courses down the middle of them.
 *
 *   CRATERS. For worlds with no atmosphere to burn impactors up. A real crater
 *   is not a dent: it is a paraboloid floor, an overturned raised rim, an
 *   ejecta blanket thinning outward as roughly r^-3, and — above about 15 km
 *   diameter, where the floor rebounds elastically — a central peak.
 *
 * All of it is evaluated identically on the main thread and in the worker, from
 * the same module, so the mesh you see and the ground the player's feet test
 * against are the same surface to the last centimetre. That is a correctness
 * requirement, not an optimisation: any divergence is felt immediately as
 * sinking or floating.
 */

import { Noise, clamp, lerp, saturate, smoothstep } from '../core/Noise.js';
import { Rng, hashInt, hash3 } from '../core/Rng.js';
import { PlanetType } from '../universe/Catalog.js';

// -----------------------------------------------------------------------------
// Gradient noise with analytic derivatives.
//
// Simplex (in core/Noise.js) is the right primitive for most things, but the
// erosion damping needs ∂n/∂p at every octave and finite-differencing it would
// triple the cost. Classic Perlin gives the derivative in closed form for about
// the price of the value, so it is worth carrying a second noise basis.
// -----------------------------------------------------------------------------

const G3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

export class DerivNoise {
  constructor(seed = 1) {
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    let s = seed >>> 0 || 1;
    const nx = () => {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s;
    };
    for (let i = 255; i > 0; i--) {
      const j = nx() % (i + 1);
      const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
    }
    this.p = new Uint8Array(512);
    this.g = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.p[i] = perm[i & 255];
      this.g[i] = this.p[i] % 12;
    }
  }

  /** Value in ~[-1,1]; writes ∂/∂x,y,z into `d`. */
  eval(x, y, z, d) {
    const p = this.p, gi = this.g;
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    const fx = x - X, fy = y - Y, fz = z - Z;
    const xi = X & 255, yi = Y & 255, zi = Z & 255;

    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const w = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
    const du = 30 * fx * fx * (fx * (fx - 2) + 1);
    const dv = 30 * fy * fy * (fy * (fy - 2) + 1);
    const dw = 30 * fz * fz * (fz * (fz - 2) + 1);

    // Eight corner gradients and their dot products with the offset vector.
    const A = p[xi] + yi, AA = p[A & 255] + zi, AB = p[(A + 1) & 255] + zi;
    const B = p[(xi + 1) & 255] + yi, BA = p[B & 255] + zi, BB = p[(B + 1) & 255] + zi;

    const i000 = gi[AA & 255] * 3, i100 = gi[BA & 255] * 3;
    const i010 = gi[AB & 255] * 3, i110 = gi[BB & 255] * 3;
    const i001 = gi[(AA + 1) & 255] * 3, i101 = gi[(BA + 1) & 255] * 3;
    const i011 = gi[(AB + 1) & 255] * 3, i111 = gi[(BB + 1) & 255] * 3;

    const ax = G3[i000], ay = G3[i000 + 1], az = G3[i000 + 2];
    const bx = G3[i100], by = G3[i100 + 1], bz = G3[i100 + 2];
    const cx = G3[i010], cy = G3[i010 + 1], cz = G3[i010 + 2];
    const dx_ = G3[i110], dy_ = G3[i110 + 1], dz_ = G3[i110 + 2];
    const ex = G3[i001], ey = G3[i001 + 1], ez = G3[i001 + 2];
    const fx_ = G3[i101], fy_ = G3[i101 + 1], fz_ = G3[i101 + 2];
    const gx = G3[i011], gy = G3[i011 + 1], gz = G3[i011 + 2];
    const hx = G3[i111], hy = G3[i111 + 1], hz = G3[i111 + 2];

    const x1 = fx - 1, y1 = fy - 1, z1 = fz - 1;
    const va = ax * fx + ay * fy + az * fz;
    const vb = bx * x1 + by * fy + bz * fz;
    const vc = cx * fx + cy * y1 + cz * fz;
    const vd = dx_ * x1 + dy_ * y1 + dz_ * fz;
    const ve = ex * fx + ey * fy + ez * z1;
    const vf = fx_ * x1 + fy_ * fy + fz_ * z1;
    const vg = gx * fx + gy * y1 + gz * z1;
    const vh = hx * x1 + hy * y1 + hz * z1;

    const k1 = vb - va, k2 = vc - va, k3 = ve - va;
    const k4 = va - vb - vc + vd;
    const k5 = va - vc - ve + vg;
    const k6 = va - vb - ve + vf;
    const k7 = -va + vb + vc - vd + ve - vf - vg + vh;

    const value = va + k1 * u + k2 * v + k3 * w + k4 * u * v + k5 * v * w + k6 * w * u + k7 * u * v * w;

    if (d) {
      // Blend of the corner gradients, plus the chain-rule term from the fade.
      const gax = ax + u * (bx - ax) + v * (cx - ax) + w * (ex - ax) +
        u * v * (ax - bx - cx + dx_) + v * w * (ax - cx - ex + gx) + w * u * (ax - bx - ex + fx_) +
        u * v * w * (-ax + bx + cx - dx_ + ex - fx_ - gx + hx);
      const gay = ay + u * (by - ay) + v * (cy - ay) + w * (ey - ay) +
        u * v * (ay - by - cy + dy_) + v * w * (ay - cy - ey + gy) + w * u * (ay - by - ey + fy_) +
        u * v * w * (-ay + by + cy - dy_ + ey - fy_ - gy + hy);
      const gaz = az + u * (bz - az) + v * (cz - az) + w * (ez - az) +
        u * v * (az - bz - cz + dz_) + v * w * (az - cz - ez + gz) + w * u * (az - bz - ez + fz_) +
        u * v * w * (-az + bz + cz - dz_ + ez - fz_ - gz + hz);
      d[0] = gax + du * (k1 + k4 * v + k6 * w + k7 * v * w);
      d[1] = gay + dv * (k2 + k5 * w + k4 * u + k7 * w * u);
      d[2] = gaz + dw * (k3 + k6 * u + k5 * v + k7 * u * v);
    }
    return value;
  }
}

// -----------------------------------------------------------------------------
// The local tangent frame.
//
// A 6.4e6 m sphere cannot be rendered in float32 planet coordinates: at that
// magnitude the mantissa is quantised to about half a metre, so a walking
// character visibly ratchets. The fix is to never hand the GPU a planet-space
// coordinate at all. Everything the renderer sees lives in a right-handed frame
// pinned to the landing site, x east / y up / z south, where the numbers are
// small and float32 has millimetre precision out to a hundred kilometres —
// further than the terrain is ever drawn.
//
// The curvature is not lost, it is *in the height field*: a point (x, z) sits at
// y = -R + sqrt(R^2 - x^2 - z^2 + 2Rh + h^2), which is exactly the sphere, so
// the horizon drops away at the correct rate and distant mountains sink behind
// it. Because the frame is fixed for a session and the player never travels far
// enough to leave its precision envelope, no origin rebasing is needed — and
// rebasing is precisely the thing that would break the heightfield contract the
// character motor is written against.
// -----------------------------------------------------------------------------

export class LocalFrame {
  /** `dir` is the unit direction from the planet centre to the landing site. */
  constructor(radius, dir, poleHint) {
    this.radius = radius;
    const u = norm3(dir[0], dir[1], dir[2]);
    this.up = u;
    const pole = poleHint || [0, 1, 0];
    // East is the direction of rotation: pole x up. Degenerate at the poles, so
    // fall back to an arbitrary but deterministic tangent there.
    let e = cross3(pole, u);
    if (len3(e) < 1e-6) e = cross3([1, 0, 0], u);
    this.east = norm3(e[0], e[1], e[2]);
    const n = cross3(u, this.east);
    this.north = norm3(n[0], n[1], n[2]);
    this.latitude = Math.asin(clamp(dot3(u, pole), -1, 1));
  }

  /** Local (x, z) -> unit direction on the sphere. Gnomonic; exact to O(h/R). */
  directionAt(x, z, out) {
    const R = this.radius;
    const px = R * this.up[0] + x * this.east[0] - z * this.north[0];
    const py = R * this.up[1] + x * this.east[1] - z * this.north[1];
    const pz = R * this.up[2] + x * this.east[2] - z * this.north[2];
    const inv = 1 / Math.sqrt(px * px + py * py + pz * pz);
    out[0] = px * inv; out[1] = py * inv; out[2] = pz * inv;
    return out;
  }

  /** Unit direction -> local (x, z) on the tangent plane. Inverse of the above. */
  planarFromDirection(dx, dy, dz, out) {
    const R = this.radius;
    const du = dx * this.up[0] + dy * this.up[1] + dz * this.up[2];
    const de = dx * this.east[0] + dy * this.east[1] + dz * this.east[2];
    const dn = dx * this.north[0] + dy * this.north[1] + dz * this.north[2];
    const k = R / Math.max(du, 0.15);
    out[0] = de * k;
    out[1] = -dn * k;
    return out;
  }

  /** Planet-space point -> local render space. */
  toLocal(px, py, pz, out) {
    const R = this.radius;
    const qx = px - R * this.up[0];
    const qy = py - R * this.up[1];
    const qz = pz - R * this.up[2];
    out[0] = qx * this.east[0] + qy * this.east[1] + qz * this.east[2];
    out[1] = qx * this.up[0] + qy * this.up[1] + qz * this.up[2];
    out[2] = -(qx * this.north[0] + qy * this.north[1] + qz * this.north[2]);
    return out;
  }

  /** Local render space -> planet-space direction and radius. */
  toPlanet(x, y, z, out) {
    const R = this.radius;
    out[0] = (R + y) * this.up[0] + x * this.east[0] - z * this.north[0];
    out[1] = (R + y) * this.up[1] + x * this.east[1] - z * this.north[1];
    out[2] = (R + y) * this.up[2] + x * this.east[2] - z * this.north[2];
    return out;
  }

  serialize() {
    return { radius: this.radius, up: this.up, east: this.east, north: this.north, latitude: this.latitude };
  }

  static deserialize(o) {
    const f = Object.create(LocalFrame.prototype);
    f.radius = o.radius; f.up = o.up; f.east = o.east; f.north = o.north; f.latitude = o.latitude;
    return f;
  }
}

function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function len3(a) { return Math.hypot(a[0], a[1], a[2]); }
function norm3(x, y, z) {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

// -----------------------------------------------------------------------------
// The field itself.
// -----------------------------------------------------------------------------

const _d = new Float64Array(3);
const _dir = new Float64Array(3);
const _xz = new Float64Array(2);
const _plate = { base: 0, belt: 0, conv: 0, boundary: 0, oceanic: 0 };

export class TerrainField {
  constructor(planet, frame = null, erosion = null) {
    this.planet = planet;
    this.frame = frame;
    this.erosion = erosion;

    const t = planet.terrain || {};
    const seed = (t.seed ?? planet.seed ?? 1) >>> 0;
    this.seed = seed;
    this.radius = planet.radius;
    this.maxElev = t.maxElevation ?? 5000;
    this.oceanCoverage = planet.oceanCoverage ?? 0;
    this.hasWater = !!planet.hasWater;

    this.nBase = new Noise(seed);
    this.nWarp = new Noise(hashInt(seed ^ 0x1d3f7));
    this.nDetail = new Noise(hashInt(seed ^ 0x77c11));
    this.dn = new DerivNoise(hashInt(seed ^ 0xbeef1));
    this.dn2 = new DerivNoise(hashInt(seed ^ 0x2ac91));

    // Feature wavelengths in metres, converted to direction-space frequency by
    // f = R / λ (the noise is sampled on the unit sphere, so one noise unit of
    // arc is R metres).
    const R = this.radius;
    const contScale = clamp(t.continentScale ?? 1.2, 0.4, 3.0);
    const mtnScale = clamp(t.mountainScale ?? 2.0, 0.5, 5.0);
    this.fCont = R / (4.2e6 / contScale);
    this.fSub = R / 1.15e6;
    this.fBelt = R / 2.4e5;
    this.fRidge = (R / 5.5e4) * Math.sqrt(mtnScale);
    this.fHill = R / 5.0e3;
    this.fRock = R / 5.0e2;
    this.fMicro = R / 3.5e1;
    this.fDune = R / 3.0e2;

    this.ridgeStrength = clamp(t.ridgeStrength ?? 0.6, 0, 1.2);
    this.erosionAmt = clamp(t.erosion ?? 0.5, 0, 1);
    this.craterDensity = clamp(t.craterDensity ?? 0, 0, 1);
    this.duneStrength = clamp(t.duneStrength ?? 0, 0, 1);
    this.volcanism = clamp(t.volcanism ?? 0, 0, 1);
    this.roughness = clamp(t.roughness ?? 0.55, 0.2, 1);

    // Amplitude budget. `maxElevation` is the tallest peak the world supports;
    // everything below is a fraction of it so a low-relief world is uniformly
    // gentle rather than smooth-with-spikes.
    const m = this.maxElev;
    this.aCont = m * 0.50;
    this.aSub = m * 0.20;
    this.aOrogeny = m * 0.95;
    this.aRidge = m * 0.11;
    this.aHill = clamp(m * 0.030, 40, 260);
    this.aRock = clamp(m * 0.0028, 4, 22) * (0.6 + this.roughness);
    this.aMicro = 1.4 * (0.5 + this.roughness);

    // Ocean floor / continental platform elevations, in metres relative to sea
    // level. These are Earth-like on purpose: the bimodal hypsometric curve
    // (a shelf near 0 and an abyssal plain near -4 km, with very little in
    // between) is one of the most legible signatures a planet has.
    this.shelf = 120;
    this.abyss = -4200 * clamp(m / 6000, 0.35, 1.4);

    this._initPlates();

    const rng = new Rng(hashInt(seed ^ 0x9917));
    this.windAxis = norm3(rng.normal(), rng.normal(), rng.normal());
    this.moistBias = 0;
    this.profile = null; // attached by the realm
  }

  // --- tectonics -------------------------------------------------------------

  _initPlates() {
    const t = this.planet.terrain || {};
    const n = clamp(t.plateCount ?? 12, 4, 28);
    const rng = new Rng(hashInt(this.seed ^ 0x51a7e));
    this.plateCount = n;
    this.pCentre = new Float64Array(n * 3);
    this.pDrift = new Float64Array(n * 3);
    this.pCont = new Float64Array(n);

    const contFrac = clamp(1.05 - this.oceanCoverage, 0.06, 0.96);
    const s = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < n; i++) {
      rng.onSphere(s);
      this.pCentre[i * 3] = s.x; this.pCentre[i * 3 + 1] = s.y; this.pCentre[i * 3 + 2] = s.z;
      // Drift is a tangential vector — plates rotate about the centre, they do
      // not move radially.
      rng.onSphere(s);
      let dx = s.x, dy = s.y, dz = s.z;
      const c0 = this.pCentre[i * 3], c1 = this.pCentre[i * 3 + 1], c2 = this.pCentre[i * 3 + 2];
      const k = dx * c0 + dy * c1 + dz * c2;
      dx -= k * c0; dy -= k * c1; dz -= k * c2;
      const l = Math.hypot(dx, dy, dz) || 1;
      const speed = rng.range(0.35, 1.0);
      this.pDrift[i * 3] = (dx / l) * speed;
      this.pDrift[i * 3 + 1] = (dy / l) * speed;
      this.pDrift[i * 3 + 2] = (dz / l) * speed;
      // Continentality in [-1,1]: thick buoyant crust vs thin dense crust.
      this.pCont[i] = rng.next() < contFrac ? rng.range(0.35, 1.0) : rng.range(-1.0, -0.35);
    }
  }

  /**
   * Nearest two plates and the kinematics of the boundary between them.
   * Brute force over ~12 plates is cheaper than any spatial structure and is
   * exact, which matters because an approximate plate map produces boundaries
   * that wobble at the sample rate.
   */
  plates(dx, dy, dz, out) {
    let i1 = 0, i2 = 0, d1 = -2, d2 = -2;
    const C = this.pCentre;
    for (let i = 0; i < this.plateCount; i++) {
      const d = dx * C[i * 3] + dy * C[i * 3 + 1] + dz * C[i * 3 + 2];
      if (d > d1) { d2 = d1; i2 = i1; d1 = d; i1 = i; }
      else if (d > d2) { d2 = d; i2 = i; }
    }
    const a1 = Math.acos(clamp(d1, -1, 1));
    const a2 = Math.acos(clamp(d2, -1, 1));
    // Half the angular gap is the distance to the equidistant boundary.
    const boundary = ((a2 - a1) * 0.5) * this.radius;

    // Boundary normal: the tangential direction from plate 1's centre toward
    // plate 2's. Convergence is the relative drift projected onto it.
    let nx = C[i2 * 3] - C[i1 * 3], ny = C[i2 * 3 + 1] - C[i1 * 3 + 1], nz = C[i2 * 3 + 2] - C[i1 * 3 + 2];
    const k = nx * dx + ny * dy + nz * dz;
    nx -= k * dx; ny -= k * dy; nz -= k * dz;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const D = this.pDrift;
    const v1 = D[i1 * 3] * nx + D[i1 * 3 + 1] * ny + D[i1 * 3 + 2] * nz;
    const v2 = D[i2 * 3] * nx + D[i2 * 3 + 1] * ny + D[i2 * 3 + 2] * nz;
    out.conv = v1 - v2; // >0 converging, <0 rifting

    // Crust type, blended across the boundary so the shelf has somewhere to sit.
    const w = smoothstep(0, 260e3, boundary);
    const cont = lerp((this.pCont[i1] + this.pCont[i2]) * 0.5, this.pCont[i1], w);
    out.oceanic = cont;
    // Hypsometric mapping: a sharp step at the continental margin, flat either
    // side. This is the shelf break, and it is why coastlines are coastlines.
    out.base = lerp(this.abyss, this.shelf, smoothstep(-0.28, 0.20, cont));
    out.belt = Math.exp(-(boundary * boundary) / (2 * 165e3 * 165e3));
    out.boundary = boundary;
    return out;
  }

  // --- elevation layers ------------------------------------------------------

  /**
   * The slow part of the spectrum: plates, continents, the mountain envelope.
   * Everything the erosion grid and the rain-shadow test need, and nothing
   * that would alias at their sample rate.
   */
  macroElevation(dx, dy, dz) {
    const p = this.plates(dx, dy, dz, _plate);
    const n = this.nBase;

    const f = this.fCont;
    // Domain warp at continental scale. The warp vector is itself fbm, so the
    // coastline inherits structure at two scales and stops looking combed.
    const wx = n.fbm(dx * f * 0.6 + 11.3, dy * f * 0.6 + 4.1, dz * f * 0.6 + 7.7, 3);
    const wy = n.fbm(dx * f * 0.6 + 27.9, dy * f * 0.6 + 13.2, dz * f * 0.6 + 2.4, 3);
    const wz = n.fbm(dx * f * 0.6 + 41.5, dy * f * 0.6 + 31.8, dz * f * 0.6 + 19.6, 3);
    const warp = 0.55;
    const cont = n.fbm(dx * f + warp * wx, dy * f + warp * wy, dz * f + warp * wz, 5, 2.1, 0.52);

    const fs = this.fSub;
    const sub = n.fbm(dx * fs + 5.5, dy * fs + 9.1, dz * fs + 2.2, 4);

    let h = p.base + cont * this.aCont + sub * this.aSub;

    // Orogeny. Ridged multifractal, gated by the convergence belt and by
    // whatever elevation the crust already has — you do not raise a four
    // kilometre range out of an abyssal plain.
    const conv = p.conv;
    const beltMask = p.belt * saturate(conv * 1.6);
    const platform = smoothstep(-900, 900, h);
    const orogeny = beltMask * 0.85 + platform * 0.30 * saturate(cont * 1.4);
    if (orogeny > 0.002) {
      const fb = this.fBelt;
      const r = n.ridged(dx * fb, dy * fb, dz * fb, 5, 2.05, 0.52);
      h += r * this.aOrogeny * orogeny * this.ridgeStrength;
    }

    // Rifting. Divergent boundaries pull the crust apart: a graben on land, a
    // spreading ridge flanked by trenches at sea.
    if (conv < 0) {
      const rift = p.belt * saturate(-conv * 1.8);
      h -= rift * this.maxElev * 0.42;
      // The ridge crest itself is buoyant hot rock — a low swell in the middle
      // of the valley, which is what the mid-ocean ridges actually are.
      h += Math.exp(-(p.boundary * p.boundary) / (2 * 48e3 * 48e3)) * rift * this.maxElev * 0.22;
    }

    // Hotspot volcanism: isolated cones unrelated to plate boundaries.
    if (this.volcanism > 0.05) {
      const fv = this.radius / 9.0e5;
      const w = n.worley(dx * fv + 3.1, dy * fv + 8.8, dz * fv + 1.4, _worleyOut);
      const cone = Math.max(0, 1 - w.f1 * 3.2);
      h += Math.pow(cone, 2.4) * this.maxElev * 0.75 * this.volcanism;
      // Summit caldera — a real shield volcano is a cone with a hole in it.
      h -= Math.exp(-w.f1 * w.f1 * 900) * this.maxElev * 0.16 * this.volcanism;
    }

    return h;
  }

  /**
   * Full elevation, metres relative to sea level.
   *
   * The mid and high bands are damped by the accumulated gradient of the bands
   * beneath them. Physically that is mass wasting: loose material cannot rest
   * on a steep face, so detail accumulates in hollows and is stripped from
   * spurs. Perceptually it is the single change that turns "fractal noise" into
   * "eroded landscape".
   */
  elevation(dx, dy, dz) {
    let h = this.macroElevation(dx, dy, dz);

    const dn = this.dn;
    const d = _d;

    // --- mid band: hills and spurs, erosion-damped -------------------------
    let amp = this.aHill;
    let freq = this.fHill;
    let gx = 0, gy = 0, gz = 0;
    const damp = 0.9 + this.erosionAmt * 3.4;
    for (let i = 0; i < 5; i++) {
      const v = dn.eval(dx * freq, dy * freq, dz * freq, d);
      gx += d[0] * freq * 1e-3; gy += d[1] * freq * 1e-3; gz += d[2] * freq * 1e-3;
      const slope2 = gx * gx + gy * gy + gz * gz;
      h += (amp * v) / (1 + damp * slope2);
      amp *= 0.48; freq *= 2.13;
    }

    // --- ridge sharpening --------------------------------------------------
    // A second, higher-frequency ridged pass keeps arêtes crisp where the macro
    // layer already decided there is a mountain, without adding ridges to plains.
    const relief = saturate((h - 500) / Math.max(this.maxElev * 0.55, 1));
    if (relief > 0.02) {
      const fr = this.fRidge;
      const r = this.nDetail.ridged(dx * fr, dy * fr, dz * fr, 4, 2.2, 0.5);
      h += (r - 0.32) * this.aRidge * relief * (0.5 + this.ridgeStrength * 0.8);
    }

    // --- dunes -------------------------------------------------------------
    if (this.duneStrength > 0.02) {
      const fd = this.fDune;
      // Anisotropy: compressing the sample coordinate along the prevailing wind
      // stretches the features across it, which is exactly the transverse dune
      // form wind actually builds.
      const wa = this.windAxis;
      let px = dx * fd, py = dy * fd, pz = dz * fd;
      const k = (px * wa[0] + py * wa[1] + pz * wa[2]) * 0.78;
      px -= k * wa[0]; py -= k * wa[1]; pz -= k * wa[2];
      const b = this.nDetail.billow(px, py, pz, 3);
      // Sand only collects on gentle ground and low altitude.
      const mask = (1 - smoothstep(0, this.maxElev * 0.45, Math.max(h, 0))) * (h > -20 ? 1 : 0);
      h += (b * 0.5 + 0.5) * 26 * this.duneStrength * mask;
    }

    // --- craters -----------------------------------------------------------
    if (this.craterDensity > 0.03) h += this._craters(dx, dy, dz);

    // --- erosion grid overlay (hydraulic + thermal + rivers) ---------------
    if (this.erosion) h += this._erosionDelta(dx, dy, dz);

    // --- fine bands --------------------------------------------------------
    const dn2 = this.dn2;
    let a2 = this.aRock;
    let f2 = this.fRock;
    let sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < 3; i++) {
      const v = dn2.eval(dx * f2, dy * f2, dz * f2, d);
      sx += d[0] * f2 * 1e-5; sy += d[1] * f2 * 1e-5; sz += d[2] * f2 * 1e-5;
      h += (a2 * v) / (1 + 2.0 * (sx * sx + sy * sy + sz * sz));
      a2 *= 0.5; f2 *= 2.31;
    }
    const fm = this.fMicro;
    h += dn2.eval(dx * fm, dy * fm, dz * fm, null) * this.aMicro;

    return h;
  }

  /**
   * Impact cratering, three size classes deep.
   *
   * The profile is the real one: a paraboloid excavation, a rim overturned
   * about 4% of the diameter above the pre-impact surface, an ejecta blanket
   * decaying outward, and — only for the large ones, where the transient
   * cavity collapses and the floor rebounds — a central peak. Skipping the rim
   * is what makes procedural craters read as golf divots.
   */
  _craters(dx, dy, dz) {
    let total = 0;
    // Three lattices, each an order of magnitude apart in crater size. Small
    // craters are far more numerous, matching the observed power-law size
    // distribution (N ∝ D^-2 or so).
    const scales = _craterScales;
    for (let s = 0; s < 3; s++) {
      const f = this.radius / scales[s].wl;
      const px = dx * f, py = dy * f, pz = dz * f;
      const xi = Math.floor(px), yi = Math.floor(py), zi = Math.floor(pz);
      for (let oz = -1; oz <= 1; oz++) {
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const cx = xi + ox, cy = yi + oy, cz = zi + oz;
            const hsh = hash3(cx, cy, cz);
            const present = (hsh & 0xffff) / 65536;
            if (present > this.craterDensity * scales[s].density) continue;
            const jx = cx + ((hsh >>> 16) & 255) / 255;
            const jy = cy + ((hsh >>> 8) & 255) / 255;
            const jz = cz + (hashInt(hsh) & 255) / 255;
            const ddx = px - jx, ddy = py - jy, ddz = pz - jz;
            const dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
            const radius = scales[s].radius * (0.45 + present / Math.max(this.craterDensity, 1e-3) * 0.9);
            if (dist > radius * 2.3) continue;
            const q = dist / radius;
            const depth = radius * scales[s].wl / this.radius * 0.19;
            total += craterProfile(q, radius > scales[s].radius * 1.05) * depth;
          }
        }
      }
    }
    return total;
  }

  _erosionDelta(dx, dy, dz) {
    const g = this.erosion;
    this.frame.planarFromDirection(dx, dy, dz, _xz);
    return sampleGridSmooth(g.delta, g.n, g.half, _xz[0], _xz[1]);
  }

  /** River strength in [0,1] at a direction. Drives wetness, sediment, sound. */
  flowAt(dx, dy, dz) {
    if (!this.erosion) return 0;
    const g = this.erosion;
    this.frame.planarFromDirection(dx, dy, dz, _xz);
    return saturate(sampleGridSmooth(g.flow, g.n, g.half, _xz[0], _xz[1]));
  }

  /**
   * Moisture in [0,1]. Three terms that between them explain most of where
   * rain actually falls: a synoptic pattern, proximity to open water, and the
   * orographic shadow cast by whatever range lies upwind.
   */
  moistureAt(dx, dy, dz, h) {
    const f = this.radius / 9.0e5;
    const base = this.nWarp.fbm(dx * f, dy * f, dz * f, 4) * 0.5 + 0.5;

    // Sea proximity: cheap and surprisingly effective — anything within a few
    // hundred metres of sea level and not shadowed is coastal and damp.
    const seaProx = this.hasWater ? 1 - smoothstep(0, 1400, Math.max(h, 0)) : 0;

    // Rain shadow. Step upwind by ~90 km and ask how much rock the air had to
    // climb over; every metre of that is a metre of condensation that fell on
    // the other side.
    const wa = this.windAxis;
    const step = 9.0e4 / this.radius;
    let ux = dx + wa[0] * step, uy = dy + wa[1] * step, uz = dz + wa[2] * step;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const hUp = this.macroElevation(ux, uy, uz);
    const shadow = smoothstep(180, 2200, hUp - h);

    return saturate(base * 0.55 + 0.30 + this.moistBias + seaProx * 0.30 - shadow * 0.62);
  }

  /** Everything a terrain vertex needs, in one pass. `out` is reused. */
  sample(dx, dy, dz, h, out) {
    const lat = Math.asin(clamp(dy * this._poleY + dx * this._poleX + dz * this._poleZ, -1, 1));
    out.h = h;
    out.lat = lat;
    out.moisture = this.moistureAt(dx, dy, dz, h);
    out.flow = this.flowAt(dx, dy, dz);
    return out;
  }

  setPole(px, py, pz) {
    this._poleX = px; this._poleY = py; this._poleZ = pz;
  }

  /**
   * Height above sea level at a local-frame column, and the local-space y that
   * puts a body's feet on it. This is the function the character motor lives
   * on, so it is written to be allocation-free and cheap.
   */
  localHeight(x, z) {
    const R = this.radius;
    this.frame.directionAt(x, z, _dir);
    const h = this.elevation(_dir[0], _dir[1], _dir[2]);
    // y solves |(R+y)U + xE - zN| = R + h exactly.
    const inner = R * R + 2 * R * h + h * h - x * x - z * z;
    return -R + Math.sqrt(Math.max(inner, 1));
  }

  serialize() {
    return {
      planet: this.planet,
      frame: this.frame ? this.frame.serialize() : null,
      erosion: this.erosion
        ? { n: this.erosion.n, half: this.erosion.half, delta: this.erosion.delta, flow: this.erosion.flow }
        : null,
      pole: [this._poleX, this._poleY, this._poleZ],
      moistBias: this.moistBias,
    };
  }

  static deserialize(o) {
    const f = new TerrainField(o.planet, o.frame ? LocalFrame.deserialize(o.frame) : null, o.erosion);
    f.setPole(o.pole[0], o.pole[1], o.pole[2]);
    f.moistBias = o.moistBias;
    return f;
  }
}

const _worleyOut = { f1: 0, f2: 0, id: 0 };

const _craterScales = [
  { wl: 1.1e5, radius: 0.38, density: 0.55 },   // basins, ~40 km
  { wl: 1.6e4, radius: 0.34, density: 0.85 },   // craters, ~5 km
  { wl: 2.2e3, radius: 0.30, density: 1.0 },    // pits, ~700 m
];

function craterProfile(q, big) {
  if (q > 2.3) return 0;
  let h;
  if (q < 1) {
    // Paraboloid floor rising to an overturned rim just past the radius.
    h = -1 + q * q * 1.58;
  } else {
    // Ejecta blanket. Real blankets thin as roughly r^-3; an exponential is
    // close enough over the two radii that are actually visible and does not
    // blow up at the rim.
    h = 0.58 * Math.exp(-(q - 1) * 2.9);
  }
  // Central peak: only complex craters have one, and it never reaches the rim.
  if (big) h += 0.62 * Math.exp(-q * q * 26);
  return h;
}

// -----------------------------------------------------------------------------
// Erosion.
//
// The analytic layers above give a plausible *shape*, but they cannot produce
// the two features that most say "water has been here": dendritic valley
// networks, and sediment fans where a valley opens onto a plain. Those are
// emergent — they require the material to actually be moved. So once, at load,
// we run a real simulation on a coarse grid covering the region you can see,
// and store the difference from the analytic base as an additive correction.
//
// A coarse grid is not a compromise, it is the right resolution: hydraulic
// erosion organises the landscape at the scale of drainage basins, tens of
// kilometres across. Everything finer is handled by the analytic bands, which
// are already slope-damped. Storing only the *delta* means the correction can
// be sampled with a smooth (C1) filter and added to a full-resolution field
// without quantising it to the grid.
// -----------------------------------------------------------------------------

export function buildErosionGrid(field, frame, opts = {}) {
  const n = opts.n || 320;
  const half = opts.half || 170e3;
  const cell = (half * 2) / (n - 1);
  const strength = clamp(opts.strength ?? field.erosionAmt, 0, 1);

  const base = new Float32Array(n * n);
  const h = new Float32Array(n * n);
  const dir = new Float64Array(3);

  for (let j = 0; j < n; j++) {
    const z = -half + j * cell;
    for (let i = 0; i < n; i++) {
      const x = -half + i * cell;
      frame.directionAt(x, z, dir);
      const v = field.macroElevation(dir[0], dir[1], dir[2]);
      base[j * n + i] = v;
      h[j * n + i] = v;
    }
  }

  thermalErosion(h, n, cell, 8 + Math.round(strength * 14), 0.62 + strength * 0.25);
  hydraulicErosion(h, n, cell, {
    droplets: Math.round(n * n * (0.6 + strength * 1.4)),
    seed: hashInt(field.seed ^ 0x0d0e),
    strength,
  });

  const flow = flowAccumulation(h, n);

  // Carve the channels. Depth scales with the square root of accumulated
  // discharge, which is the empirical hydraulic-geometry relation — a river
  // with a hundred times the catchment is about ten times as incised, not a
  // hundred times.
  const delta = new Float32Array(n * n);
  const maxCut = 4 + strength * 26;
  for (let i = 0; i < n * n; i++) {
    const f = flow[i];
    const cut = Math.sqrt(f) * maxCut;
    delta[i] = h[i] - base[i] - cut;
  }

  // One box-blur pass keeps the delta free of single-cell spikes that the
  // droplet pass can leave behind, which would show up as pimples once the
  // full-resolution bands are added on top.
  blur(delta, n, 1);

  // Fade to zero at the region edge so the boundary between "simulated" and
  // "analytic only" is invisible rather than a cliff.
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const fx = Math.min(i, n - 1 - i) / (n * 0.12);
      const fz = Math.min(j, n - 1 - j) / (n * 0.12);
      const k = smoothstep(0, 1, Math.min(fx, fz));
      delta[j * n + i] *= k;
      flow[j * n + i] *= k;
    }
  }

  return { n, half, cell, delta, flow };
}

/**
 * Thermal (mass-wasting) erosion. Material above the angle of repose slides to
 * its lower neighbours. Cheap, and it is what stops every ridge from being a
 * knife edge — real slopes cap out near 35 degrees in loose rock.
 */
function thermalErosion(h, n, cell, iterations, talusScale) {
  const talus = talusScale * cell * 0.7; // max sustainable height difference
  const delta = new Float32Array(n * n);
  for (let it = 0; it < iterations; it++) {
    delta.fill(0);
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const k = j * n + i;
        const hc = h[k];
        let total = 0;
        let maxDiff = 0;
        for (let o = 0; o < 8; o++) {
          const d = hc - h[k + NEIGH[o]];
          if (d > talus) { total += d - talus; if (d > maxDiff) maxDiff = d; }
        }
        if (total <= 0) continue;
        const move = Math.min(maxDiff - talus, total) * 0.35;
        for (let o = 0; o < 8; o++) {
          const d = hc - h[k + NEIGH[o]];
          if (d > talus) {
            const share = ((d - talus) / total) * move;
            delta[k] -= share;
            delta[k + NEIGH[o]] += share;
          }
        }
      }
    }
    for (let i = 0; i < n * n; i++) h[i] += delta[i];
  }
}

let NEIGH = null;

/**
 * Droplet-based hydraulic erosion.
 *
 * Each droplet carries momentum, water and dissolved sediment. Its capacity to
 * hold sediment is proportional to speed and to how steeply it is descending;
 * when it slows or flattens out it drops the excess, which is what builds
 * alluvial fans at the mouths of valleys. Momentum (the `inertia` term) is what
 * makes the resulting channels smooth curves instead of staircases down the
 * steepest-descent lattice.
 */
function hydraulicErosion(h, n, cell, opts) {
  const rng = new Rng(opts.seed || 1);
  const droplets = opts.droplets;
  const inertia = 0.055;
  const capacityFactor = 3.4 + opts.strength * 4.0;
  const minSlope = 0.008;
  const erodeSpeed = 0.28 * (0.4 + opts.strength);
  const depositSpeed = 0.24;
  const evaporate = 0.021;
  const gravity = 5.0;
  const maxSteps = 44;
  const radius = 2;

  // Precomputed deposition brush — spreading erosion over a small disc stops
  // droplets from drilling one-cell-wide holes.
  const brush = [];
  const brushW = [];
  let wsum = 0;
  for (let by = -radius; by <= radius; by++) {
    for (let bx = -radius; bx <= radius; bx++) {
      const d2 = bx * bx + by * by;
      if (d2 > radius * radius) continue;
      const w = 1 - Math.sqrt(d2) / radius;
      brush.push(by * n + bx);
      brushW.push(w);
      wsum += w;
    }
  }
  for (let i = 0; i < brushW.length; i++) brushW[i] /= wsum;

  const grad = new Float64Array(3);

  for (let dNo = 0; dNo < droplets; dNo++) {
    let px = rng.range(radius + 1, n - radius - 2);
    let pz = rng.range(radius + 1, n - radius - 2);
    let dx = 0, dz = 0;
    let speed = 1, water = 1, sediment = 0;

    for (let step = 0; step < maxSteps; step++) {
      const nx = Math.floor(px), nz = Math.floor(pz);
      if (nx < radius + 1 || nz < radius + 1 || nx >= n - radius - 2 || nz >= n - radius - 2) break;
      const cellOffX = px - nx, cellOffZ = pz - nz;
      const idx = nz * n + nx;
      heightAndGradient(h, n, nx, nz, cellOffX, cellOffZ, grad);
      const hOld = grad[2];

      dx = dx * inertia - grad[0] * (1 - inertia);
      dz = dz * inertia - grad[1] * (1 - inertia);
      const dl = Math.hypot(dx, dz);
      if (dl < 1e-8) break;
      dx /= dl; dz /= dl;
      px += dx; pz += dz;

      const mx = Math.floor(px), mz = Math.floor(pz);
      if (mx < radius + 1 || mz < radius + 1 || mx >= n - radius - 2 || mz >= n - radius - 2) break;
      heightAndGradient(h, n, mx, mz, px - mx, pz - mz, grad);
      const hNew = grad[2];
      const dh = hNew - hOld;

      const capacity = Math.max(-dh / cell, minSlope) * speed * water * capacityFactor * cell;

      if (sediment > capacity || dh > 0) {
        // Uphill or over capacity: drop material. Filling a pit exactly to its
        // brim (rather than dumping everything) is what lets lakes form.
        const amount = dh > 0 ? Math.min(dh, sediment) : (sediment - capacity) * depositSpeed;
        sediment -= amount;
        // Bilinear deposit back into the four cells we straddled.
        h[idx] += amount * (1 - cellOffX) * (1 - cellOffZ);
        h[idx + 1] += amount * cellOffX * (1 - cellOffZ);
        h[idx + n] += amount * (1 - cellOffX) * cellOffZ;
        h[idx + n + 1] += amount * cellOffX * cellOffZ;
      } else {
        const amount = Math.min((capacity - sediment) * erodeSpeed, -dh);
        for (let b = 0; b < brush.length; b++) {
          const k = idx + brush[b];
          const take = amount * brushW[b];
          h[k] -= take;
        }
        sediment += amount;
      }

      speed = Math.sqrt(Math.max(0, speed * speed - dh * gravity / cell));
      water *= 1 - evaporate;
      if (water < 0.012) break;
    }
  }
}

function heightAndGradient(h, n, x, z, fx, fz, out) {
  const i = z * n + x;
  const h00 = h[i], h10 = h[i + 1], h01 = h[i + n], h11 = h[i + n + 1];
  out[0] = (h10 - h00) * (1 - fz) + (h11 - h01) * fz;
  out[1] = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
  out[2] = h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz;
}

/**
 * D8 flow accumulation. Process cells from high to low, pushing each cell's
 * accumulated discharge into its steepest downhill neighbour; by the time a
 * cell is visited every cell that drains into it has already contributed. The
 * result is the drainage network — and where it exceeds a threshold, a river.
 */
function flowAccumulation(h, n) {
  const count = n * n;
  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  // Sorting by height is the whole algorithm; a typed sort of ~100k entries is
  // a couple of milliseconds.
  const arr = Array.from(order);
  arr.sort((a, b) => h[b] - h[a]);

  const acc = new Float32Array(count);
  acc.fill(1);
  for (let oi = 0; oi < count; oi++) {
    const k = arr[oi];
    const j = (k / n) | 0;
    const i = k - j * n;
    if (i === 0 || j === 0 || i === n - 1 || j === n - 1) continue;
    let best = -1, bestDrop = 0;
    for (let o = 0; o < 8; o++) {
      const nk = k + NEIGH[o];
      const drop = (h[k] - h[nk]) * NEIGH_INV[o];
      if (drop > bestDrop) { bestDrop = drop; best = nk; }
    }
    if (best >= 0) acc[best] += acc[k];
  }

  // Map discharge to a 0..1 river mask. Log because catchment areas span four
  // orders of magnitude and a linear map would show only the trunk stream.
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = smoothstep(3.6, 7.6, Math.log(acc[i] + 1));
  }
  blur(out, n, 1);
  return out;
}

function blur(a, n, r) {
  const tmp = new Float32Array(a.length);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let o = -r; o <= r; o++) {
        const k = i + o;
        if (k < 0 || k >= n) continue;
        s += a[j * n + k]; c++;
      }
      tmp[j * n + i] = s / c;
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let o = -r; o <= r; o++) {
        const k = j + o;
        if (k < 0 || k >= n) continue;
        s += tmp[k * n + i]; c++;
      }
      a[j * n + i] = s / c;
    }
  }
}

/**
 * Sampling with a smoothstep-weighted bilinear filter.
 *
 * Plain bilinear is only C0, and a C0 term added to a height field shows up as
 * a faint quilt of creases once the normals are differenced — one of those
 * artefacts that is invisible in a wireframe and glaring under a low sun.
 * Weighting by smoothstep costs two multiplies and makes the field C1.
 */
export function sampleGridSmooth(arr, n, half, x, z) {
  const cell = (half * 2) / (n - 1);
  const fx = (x + half) / cell;
  const fz = (z + half) / cell;
  if (fx < 0 || fz < 0 || fx >= n - 1 || fz >= n - 1) return 0;
  const i = fx | 0, j = fz | 0;
  let u = fx - i, v = fz - j;
  u = u * u * (3 - 2 * u);
  v = v * v * (3 - 2 * v);
  const k = j * n + i;
  const a = arr[k], b = arr[k + 1], c = arr[k + n], d = arr[k + n + 1];
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

// Neighbour offsets, initialised lazily because they depend on the grid pitch.
export function initNeighbours(n) {
  NEIGH = new Int32Array([-n - 1, -n, -n + 1, -1, 1, n - 1, n, n + 1]);
}
const NEIGH_INV = new Float32Array([0.7071, 1, 0.7071, 1, 1, 0.7071, 1, 0.7071]);

/**
 * Pick somewhere worth standing.
 *
 * Landing at a uniformly random point on a water world puts you in the middle
 * of an ocean, and landing at a random point on any world usually puts you on a
 * featureless plain. So we score candidates: above water, not too steep to
 * stand on, and with a strong preference for relief nearby and for a coast or a
 * river within sight. Establishing shots are the whole point of arriving.
 */
export function findLandingSite(field, seed, poleHint) {
  const rng = new Rng(hashInt((seed ?? 1) ^ 0x1a4d));
  const s = { x: 0, y: 0, z: 0 };
  let best = null;
  let bestScore = -1e9;
  const R = field.radius;

  for (let i = 0; i < 220; i++) {
    rng.onSphere(s);
    const h = field.elevation(s.x, s.y, s.z);
    if (field.hasWater && h < 6) continue;
    if (h > field.maxElev * 0.86) continue;

    // Relief within ~6 km: how interesting is the view from here.
    const e = 6000 / R;
    const h1 = field.macroElevation(s.x + e, s.y, s.z);
    const h2 = field.macroElevation(s.x - e, s.y, s.z);
    const h3 = field.macroElevation(s.x, s.y + e, s.z);
    const h4 = field.macroElevation(s.x, s.y, s.z + e);
    const relief = (Math.abs(h1 - h) + Math.abs(h2 - h) + Math.abs(h3 - h) + Math.abs(h4 - h)) * 0.25;

    // Local slope over 40 m: we want somewhere the character can actually stand.
    const e2 = 40 / R;
    const g1 = field.elevation(s.x + e2, s.y, s.z);
    const g2 = field.elevation(s.x, s.y + e2, s.z);
    const slope = (Math.abs(g1 - h) + Math.abs(g2 - h)) / 40;

    let score = relief * 0.02 - slope * 220;
    // Coastal bonus: a shoreline in the establishing shot is worth a lot.
    if (field.hasWater) score += 90 * Math.exp(-Math.pow((h - 70) / 260, 2));
    score += rng.range(0, 12);
    if (score > bestScore) { bestScore = score; best = [s.x, s.y, s.z]; }
  }

  if (!best) {
    rng.onSphere(s);
    best = [s.x, s.y, s.z];
  }
  return best;
}

export { clamp, lerp, saturate, smoothstep };
