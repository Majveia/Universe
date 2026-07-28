/**
 * Deterministic hash-based pseudo-randomness.
 *
 * Everything in UNIVERSE is generated from a 32-bit seed, so any location in the
 * cosmos can be reconstructed from its coordinates alone without storing state.
 * That is what lets the universe be effectively unbounded: we never persist a
 * galaxy, we re-derive it.
 */

/** FNV-1a over a string -> uint32. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Integer avalanche (Thomas Wang / murmur finalizer). */
export function hashInt(x) {
  x = x >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

export function hash2(x, y) {
  return hashInt(hashInt(x) ^ Math.imul(y >>> 0, 0x9e3779b9));
}

export function hash3(x, y, z) {
  return hashInt(hash2(x, y) ^ Math.imul(z >>> 0, 0x85ebca6b));
}

/**
 * sfc32 — small, fast, statistically solid. Seeded from four uint32 words.
 * Deliberately not Math.random(): reproducibility is a hard requirement.
 */
export class Rng {
  constructor(seed = 1) {
    if (typeof seed === 'string') seed = hashString(seed);
    let s = seed >>> 0 || 1;
    this.a = hashInt(s ^ 0x9e3779b9);
    this.b = hashInt(this.a ^ 0x243f6a88);
    this.c = hashInt(this.b ^ 0xb7e15162);
    this.d = hashInt(this.c ^ 0x0f1bbcdc);
    // Warm up so nearby seeds decorrelate.
    for (let i = 0; i < 12; i++) this.next();
  }

  /** [0,1) */
  next() {
    const a = this.a | 0,
      b = this.b | 0,
      c = this.c | 0,
      d = this.d | 0;
    const t = (((a + b) | 0) + d) | 0;
    this.d = (d + 1) | 0;
    this.a = b ^ (b >>> 9);
    this.b = (c + (c << 3)) | 0;
    this.c = (c << 21) | (c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** [min,max) */
  range(min, max) {
    return min + (max - min) * this.next();
  }

  /** Integer in [min,max] inclusive. */
  int(min, max) {
    return Math.floor(min + (max - min + 1) * this.next());
  }

  bool(p = 0.5) {
    return this.next() < p;
  }

  sign() {
    return this.next() < 0.5 ? -1 : 1;
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length) % arr.length];
  }

  /** Fisher-Yates, in place. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /** Weighted pick. `weights` parallel to `items`. */
  weighted(items, weights) {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  /** Box-Muller normal deviate. */
  normal(mean = 0, stdev = 1) {
    if (this._spare !== undefined) {
      const v = this._spare;
      this._spare = undefined;
      return mean + stdev * v;
    }
    let u = 0,
      v = 0,
      s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this._spare = v * mul;
    return mean + stdev * u * mul;
  }

  /** Uniform point on the unit sphere. */
  onSphere(out = { x: 0, y: 0, z: 0 }) {
    const u = this.next() * 2 - 1;
    const t = this.next() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    out.x = r * Math.cos(t);
    out.y = u;
    out.z = r * Math.sin(t);
    return out;
  }

  /** Uniform point in the unit disc. */
  inDisc(out = { x: 0, y: 0 }) {
    const t = this.next() * Math.PI * 2;
    const r = Math.sqrt(this.next());
    out.x = r * Math.cos(t);
    out.y = r * Math.sin(t);
    return out;
  }

  /** Derive an independent child stream — keeps subsystems from correlating. */
  fork(tag = 0) {
    return new Rng(hashInt(this.a ^ hashInt(typeof tag === 'string' ? hashString(tag) : tag)));
  }
}

/** Stateless [0,1) from coordinates — no allocation, safe in hot loops. */
export function rand1(x) {
  return hashInt(x) / 4294967296;
}
export function rand2(x, y) {
  return hash2(x, y) / 4294967296;
}
export function rand3(x, y, z) {
  return hash3(x, y, z) / 4294967296;
}
