/**
 * CPU-side procedural noise.
 *
 * Terrain, biome masks and city layouts are evaluated on the CPU (workers +
 * main thread), so this needs to be allocation-free and fast. Everything here
 * is deterministic given a seed and mirrors `shaders/noise.glsl` closely enough
 * that GPU and CPU agree on where a mountain is.
 */

const F3 = 1 / 3;
const G3 = 1 / 6;

const GRAD3 = new Int8Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1,
  0, 1, -1, 0, -1, -1,
]);

export class Noise {
  constructor(seed = 1337) {
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    // Deterministic shuffle from the seed.
    let s = seed >>> 0 || 1;
    const nextInt = () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s;
    };
    for (let i = 255; i > 0; i--) {
      const j = nextInt() % (i + 1);
      const t = perm[i];
      perm[i] = perm[j];
      perm[j] = t;
    }
    this.p = new Uint8Array(512);
    this.pMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.p[i] = perm[i & 255];
      this.pMod12[i] = this.p[i] % 12;
    }
  }

  /** 3D simplex noise, roughly [-1,1]. */
  noise3(xin, yin, zin) {
    const p = this.p;
    const pMod12 = this.pMod12;
    let n0, n1, n2, n3;

    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);

    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
      } else if (x0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1;
      } else {
        i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1;
      }
    } else {
      if (y0 < z0) {
        i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1;
      } else if (x0 < z0) {
        i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1;
      } else {
        i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
      }
    }

    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;

    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;

    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 < 0) n0 = 0;
    else {
      const gi0 = pMod12[ii + p[jj + p[kk]]] * 3;
      t0 *= t0;
      n0 = t0 * t0 * (GRAD3[gi0] * x0 + GRAD3[gi0 + 1] * y0 + GRAD3[gi0 + 2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 < 0) n1 = 0;
    else {
      const gi1 = pMod12[ii + i1 + p[jj + j1 + p[kk + k1]]] * 3;
      t1 *= t1;
      n1 = t1 * t1 * (GRAD3[gi1] * x1 + GRAD3[gi1 + 1] * y1 + GRAD3[gi1 + 2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 < 0) n2 = 0;
    else {
      const gi2 = pMod12[ii + i2 + p[jj + j2 + p[kk + k2]]] * 3;
      t2 *= t2;
      n2 = t2 * t2 * (GRAD3[gi2] * x2 + GRAD3[gi2 + 1] * y2 + GRAD3[gi2 + 2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 < 0) n3 = 0;
    else {
      const gi3 = pMod12[ii + 1 + p[jj + 1 + p[kk + 1]]] * 3;
      t3 *= t3;
      n3 = t3 * t3 * (GRAD3[gi3] * x3 + GRAD3[gi3 + 1] * y3 + GRAD3[gi3 + 2] * z3);
    }
    return 32 * (n0 + n1 + n2 + n3);
  }

  /** Classic fractal Brownian motion. */
  fbm(x, y, z, octaves = 5, lacunarity = 2.0, gain = 0.5) {
    let amp = 0.5;
    let freq = 1.0;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise3(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Absolute-value fbm — produces creases that read as mountain ridges. */
  ridged(x, y, z, octaves = 5, lacunarity = 2.0, gain = 0.5) {
    let amp = 0.5;
    let freq = 1.0;
    let sum = 0;
    let norm = 0;
    let prev = 1.0;
    for (let i = 0; i < octaves; i++) {
      let n = 1.0 - Math.abs(this.noise3(x * freq, y * freq, z * freq));
      n *= n;
      n *= prev;
      prev = n;
      sum += amp * n;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Billow — inverted ridges, good for dunes and cumulus. */
  billow(x, y, z, octaves = 5, lacunarity = 2.0, gain = 0.5) {
    let amp = 0.5;
    let freq = 1.0;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * (Math.abs(this.noise3(x * freq, y * freq, z * freq)) * 2 - 1);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /**
   * Domain-warped fbm. The single most valuable trick for making procedural
   * terrain stop looking procedural — it bends the field along itself so
   * features curve and braid instead of sitting on a grid.
   */
  warpedFbm(x, y, z, octaves = 5, warp = 0.6) {
    const qx = this.fbm(x + 5.2, y + 1.3, z + 2.8, 3);
    const qy = this.fbm(x + 9.2, y + 7.3, z + 4.8, 3);
    const qz = this.fbm(x + 3.7, y + 2.9, z + 8.1, 3);
    return this.fbm(x + warp * qx, y + warp * qy, z + warp * qz, octaves);
  }

  /**
   * Worley / cellular F1 distance. Returns {f1, f2, id} — `id` is a stable
   * per-cell hash used to colour crystal facets, tile plates, city blocks.
   */
  worley(x, y, z, out = { f1: 0, f2: 0, id: 0 }) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    let f1 = 1e9;
    let f2 = 1e9;
    let id = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = xi + dx;
          const cy = yi + dy;
          const cz = zi + dz;
          const h = cellHash(cx, cy, cz);
          const px = cx + ((h & 255) / 255);
          const py = cy + (((h >> 8) & 255) / 255);
          const pz = cz + (((h >> 16) & 255) / 255);
          const ddx = px - x;
          const ddy = py - y;
          const ddz = pz - z;
          const d = ddx * ddx + ddy * ddy + ddz * ddz;
          if (d < f1) {
            f2 = f1;
            f1 = d;
            id = h;
          } else if (d < f2) {
            f2 = d;
          }
        }
      }
    }
    out.f1 = Math.sqrt(f1);
    out.f2 = Math.sqrt(f2);
    out.id = id >>> 0;
    return out;
  }
}

function cellHash(x, y, z) {
  let h = Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(z, 0xcb1ab31f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Shared default instance for callers that do not need their own seed. */
export const noise = new Noise(20260728);

// --- small math helpers used across the codebase -----------------------------

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const saturate = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const smootherstep = (e0, e1, x) => {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
/** Frame-rate independent exponential approach. `speed` is per second. */
export const damp = (a, b, speed, dt) => lerp(a, b, 1 - Math.exp(-speed * dt));
export const mod = (n, m) => ((n % m) + m) % m;
