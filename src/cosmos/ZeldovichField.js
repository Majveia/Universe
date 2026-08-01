/**
 * The Zel'dovich displacement field, in both languages.
 *
 * The web is drawn on the GPU and analysed on the CPU, and those two have to
 * agree about where a filament is. They previously did not: `tools/probe-web.mjs`
 * mirrored the field using `core/Noise.js`, whose simplex is a seeded
 * permutation-table variant, while the shader uses the seedless Ashima/McEwan
 * polynomial one. Both are unit-scale simplex noise, which is why the probe's
 * *statistical* conclusions (amplitude sweeps, contrast ratios) transferred
 * fine — but the two fields have their peaks in completely different places.
 * Any CPU analysis that needs to say "there is a node HERE" and have the GPU
 * draw something at the same spot cannot use a merely similar field.
 *
 * So this file owns both sides. `ZELDOVICH_GLSL` is the chunk the shaders
 * include; `snoise`, `potential` and `zeldovich` are a transliteration of that
 * same GLSL, expression for expression. `tools/verify-field.mjs` runs the two
 * against each other on real query points and fails if they diverge — the port
 * is checked, not asserted, because a silent drift here puts cluster sprites in
 * the middle of voids and nothing about the code would look wrong.
 *
 * Precision: the shader runs `highp` (float32), this runs float64. The
 * permutation arithmetic is exact in both — `permute` keeps values under 289
 * and its widest intermediate, `(289*34+1)*289`, is about 2.8e6, well inside
 * float32's exactly-representable integer range — so the two agree on which
 * simplex cell and which gradients are chosen. Only the smooth interpolation
 * differs, at the 1e-6 level. Verified, see above.
 */

/** GLSL side. Included by the web tracers and the galaxy sprites. */
export const ZELDOVICH_GLSL = /* glsl */ `
uniform float uGrowth;
uniform float uFieldScale;
uniform float uPsiAmp;

// A deliberately red-tilted potential: three octaves with a steep gain so the
// field is dominated by its longest wavelength. Anything flatter and the
// gradient turns to noise (see CosmicWeb.js).
float potential(vec3 p){
  // One large-scale domain warp adds the asymmetry real structure has —
  // filaments in the universe are bent and braided, never straight.
  vec3 w = vec3(snoise(p * 0.55 + 11.3),
                snoise(p * 0.55 + 27.1),
                snoise(p * 0.55 + 41.7));
  vec3 pw = p + w * 0.45;
  return snoise(pw) * 1.0
       + snoise(pw * 2.03 + 5.1) * 0.28
       + snoise(pw * 4.11 + 9.7) * 0.075;
}

// psi(q) = -grad(phi), and the trace of the deformation tensor lap(phi), from
// one seven-tap stencil.
vec3 zeldovich(vec3 q, out float lap){
  vec3 p = q * uFieldScale;
  const float e = 0.16;
  float f0  = potential(p);
  float fx1 = potential(p + vec3(e,0,0));
  float fx0 = potential(p - vec3(e,0,0));
  float fy1 = potential(p + vec3(0,e,0));
  float fy0 = potential(p - vec3(0,e,0));
  float fz1 = potential(p + vec3(0,0,e));
  float fz0 = potential(p - vec3(0,0,e));

  vec3 grad = vec3(fx1 - fx0, fy1 - fy0, fz1 - fz0) / (2.0 * e);
  lap = (fx1 + fx0 + fy1 + fy0 + fz1 + fz0 - 6.0 * f0) / (e * e);
  return -grad * uPsiAmp;
}

// rho/rhobar = 1/|det(dx/dq)|. First order, trace only. Clamped because a true
// caustic is a singularity and we have to draw something finite.
float zeldovichDensity(float lap){
  float J = 1.0 - uGrowth * lap * 0.045;
  return clamp(1.0 / max(abs(J), 0.06), 0.0, 18.0);
}
`;

// --- CPU side ----------------------------------------------------------------
//
// Transliterated from the GLSL above. Written with scalar locals rather than
// arrays or a small vector class because the cluster finder calls `potential`
// tens of millions of times at startup and every allocation in here shows up
// directly as time on the loading screen.

// Where a floor() or a sign test follows, the arithmetic is rounded to float32
// with Math.fround so the CPU makes the same discrete choice the shader does.
//
// This is not defensive padding — it is load-bearing, and it is what the first
// version of this port got wrong. `n_` below is written in the GLSL as the
// truncated decimal 0.142857142857, which is slightly BELOW 1/7 in float64 and
// slightly ABOVE it in float32. The very next line takes floor(j * n_) to split
// a hash into a 7x7 gradient index, so at j = 35 the GPU floors 5.0000002 to 5
// and an honest float64 port floors 4.999999999995 to 4. Every gradient after
// that point is a different one, and snoise comes back with a range of about
// +/-4 instead of +/-1. tools/verify-field.mjs is what caught it.
//
// The smooth interpolation further down is left in float64: nothing discrete
// hangs off it, and the residual difference is ~1e-7.
const F = Math.fround;
const INV289 = F(1 / 289);
const mod289 = (x) => x - Math.floor(F(x * INV289)) * 289;
const permute = (x) => mod289(F(F(F(x * 34) + 1) * x));
const taylorInvSqrt = (r) => 1.79284291400159 - 0.85373472095314 * r;
/** GLSL `step(edge, x)`: 1 when x is at or above the edge. */
const step = (edge, x) => (x >= edge ? 1 : 0);

// `vec3 ns = n_ * D.wyz - D.xzx` with D = (0.0, 0.5, 1.0, 2.0), carrying the
// shader's literal through float32 exactly as the GPU sees it.
const N_ = F(0.142857142857);
const NS_X = F(N_ * 2.0);
const NS_Y = F(F(N_ * 0.5) - 1.0);
const NS_Z = N_;
const INV49 = F(NS_Z * NS_Z);

/**
 * 3D simplex noise — the exact function the shaders call, in JavaScript.
 *
 * Kept as one long routine on purpose. Splitting it into helpers reads better
 * but breaks the line-by-line correspondence with the GLSL, and that
 * correspondence is the only thing making this maintainable when the shader
 * changes.
 */
export function snoise(vx, vy, vz) {
  const C_x = 1 / 6, C_y = 1 / 3;

  // Skew into simplex-lattice space and find the containing cell.
  const s = (vx + vy + vz) * C_y;
  let ix = Math.floor(vx + s), iy = Math.floor(vy + s), iz = Math.floor(vz + s);
  const t = (ix + iy + iz) * C_x;
  const x0x = vx - ix + t, x0y = vy - iy + t, x0z = vz - iz + t;

  // Rank the components to pick which of the six tetrahedra we are in.
  const gx = step(x0y, x0x), gy = step(x0z, x0y), gz = step(x0x, x0z);
  const lx = 1 - gx, ly = 1 - gy, lz = 1 - gz;
  const i1x = Math.min(gx, lz), i1y = Math.min(gy, lx), i1z = Math.min(gz, ly);
  const i2x = Math.max(gx, lz), i2y = Math.max(gy, lx), i2z = Math.max(gz, ly);

  // Offsets to the other three corners.
  const x1x = x0x - i1x + C_x, x1y = x0y - i1y + C_x, x1z = x0z - i1z + C_x;
  const x2x = x0x - i2x + C_y, x2y = x0y - i2y + C_y, x2z = x0z - i2z + C_y;
  const x3x = x0x - 0.5, x3y = x0y - 0.5, x3z = x0z - 0.5;

  ix = mod289(ix); iy = mod289(iy); iz = mod289(iz);

  // Hash the four corners through the permutation polynomial.
  const pz0 = permute(iz + 0),    pz1 = permute(iz + i1z);
  const pz2 = permute(iz + i2z),  pz3 = permute(iz + 1);
  const py0 = permute(pz0 + iy + 0),   py1 = permute(pz1 + iy + i1y);
  const py2 = permute(pz2 + iy + i2y), py3 = permute(pz3 + iy + 1);
  const p0h = permute(py0 + ix + 0),   p1h = permute(py1 + ix + i1x);
  const p2h = permute(py2 + ix + i2x), p3h = permute(py3 + ix + 1);

  // Unpack each hash into a gradient on the 7x7 lattice of the octahedron.
  const j0 = p0h - 49 * Math.floor(F(p0h * INV49));
  const j1 = p1h - 49 * Math.floor(F(p1h * INV49));
  const j2 = p2h - 49 * Math.floor(F(p2h * INV49));
  const j3 = p3h - 49 * Math.floor(F(p3h * INV49));

  const xf0 = Math.floor(F(j0 * NS_Z)), xf1 = Math.floor(F(j1 * NS_Z));
  const xf2 = Math.floor(F(j2 * NS_Z)), xf3 = Math.floor(F(j3 * NS_Z));
  const yf0 = j0 - 7 * xf0, yf1 = j1 - 7 * xf1;
  const yf2 = j2 - 7 * xf2, yf3 = j3 - 7 * xf3;

  const X0 = F(F(xf0 * NS_X) + NS_Y), X1 = F(F(xf1 * NS_X) + NS_Y);
  const X2 = F(F(xf2 * NS_X) + NS_Y), X3 = F(F(xf3 * NS_X) + NS_Y);
  const Y0 = F(F(yf0 * NS_X) + NS_Y), Y1 = F(F(yf1 * NS_X) + NS_Y);
  const Y2 = F(F(yf2 * NS_X) + NS_Y), Y3 = F(F(yf3 * NS_X) + NS_Y);

  // h decides the octant reflection below, and it can land exactly on zero:
  // |X| and |Y| both come from {1,3,5,7,9,11,13}/14 and those pairs do sum to
  // 1. Rounding this the way the shader rounds it keeps the sign test agreeing.
  const h0 = F(F(1 - Math.abs(X0)) - Math.abs(Y0));
  const h1 = F(F(1 - Math.abs(X1)) - Math.abs(Y1));
  const h2 = F(F(1 - Math.abs(X2)) - Math.abs(Y2));
  const h3 = F(F(1 - Math.abs(X3)) - Math.abs(Y3));

  // Reflect the gradient into the correct octant. `sh` is -1 where h <= 0.
  const sh0 = -step(h0, 0), sh1 = -step(h1, 0);
  const sh2 = -step(h2, 0), sh3 = -step(h3, 0);

  let g0x = X0 + (Math.floor(X0) * 2 + 1) * sh0;
  let g0y = Y0 + (Math.floor(Y0) * 2 + 1) * sh0;
  let g0z = h0;
  let g1x = X1 + (Math.floor(X1) * 2 + 1) * sh1;
  let g1y = Y1 + (Math.floor(Y1) * 2 + 1) * sh1;
  let g1z = h1;
  let g2x = X2 + (Math.floor(X2) * 2 + 1) * sh2;
  let g2y = Y2 + (Math.floor(Y2) * 2 + 1) * sh2;
  let g2z = h2;
  let g3x = X3 + (Math.floor(X3) * 2 + 1) * sh3;
  let g3y = Y3 + (Math.floor(Y3) * 2 + 1) * sh3;
  let g3z = h3;

  // Normalise (the Taylor approximation the GLSL uses, not a real rsqrt — a
  // true normalisation gives visibly different values).
  const nr0 = taylorInvSqrt(g0x * g0x + g0y * g0y + g0z * g0z);
  const nr1 = taylorInvSqrt(g1x * g1x + g1y * g1y + g1z * g1z);
  const nr2 = taylorInvSqrt(g2x * g2x + g2y * g2y + g2z * g2z);
  const nr3 = taylorInvSqrt(g3x * g3x + g3y * g3y + g3z * g3z);
  g0x *= nr0; g0y *= nr0; g0z *= nr0;
  g1x *= nr1; g1y *= nr1; g1z *= nr1;
  g2x *= nr2; g2y *= nr2; g2z *= nr2;
  g3x *= nr3; g3y *= nr3; g3z *= nr3;

  // Radial falloff, to the fourth power, times the gradient dotted with the
  // offset. `m` is squared once here and once inside the sum.
  let m0 = 0.6 - (x0x * x0x + x0y * x0y + x0z * x0z);
  let m1 = 0.6 - (x1x * x1x + x1y * x1y + x1z * x1z);
  let m2 = 0.6 - (x2x * x2x + x2y * x2y + x2z * x2z);
  let m3 = 0.6 - (x3x * x3x + x3y * x3y + x3z * x3z);
  m0 = m0 < 0 ? 0 : m0 * m0;
  m1 = m1 < 0 ? 0 : m1 * m1;
  m2 = m2 < 0 ? 0 : m2 * m2;
  m3 = m3 < 0 ? 0 : m3 * m3;

  return 42.0 * (
    m0 * m0 * (g0x * x0x + g0y * x0y + g0z * x0z) +
    m1 * m1 * (g1x * x1x + g1y * x1y + g1z * x1z) +
    m2 * m2 * (g2x * x2x + g2y * x2y + g2z * x2z) +
    m3 * m3 * (g3x * x3x + g3y * x3y + g3z * x3z)
  );
}

/** The red-tilted potential. Mirror of `potential()` in the GLSL above. */
export function potential(x, y, z) {
  const wx = snoise(x * 0.55 + 11.3, y * 0.55 + 11.3, z * 0.55 + 11.3);
  const wy = snoise(x * 0.55 + 27.1, y * 0.55 + 27.1, z * 0.55 + 27.1);
  const wz = snoise(x * 0.55 + 41.7, y * 0.55 + 41.7, z * 0.55 + 41.7);
  const px = x + wx * 0.45, py = y + wy * 0.45, pz = z + wz * 0.45;
  return snoise(px, py, pz) * 1.0
       + snoise(px * 2.03 + 5.1, py * 2.03 + 5.1, pz * 2.03 + 5.1) * 0.28
       + snoise(px * 4.11 + 9.7, py * 4.11 + 9.7, pz * 4.11 + 9.7) * 0.075;
}

const STENCIL_E = 0.16;

/**
 * Displacement and deformation trace at one Lagrangian point.
 *
 * Writes into `out` — `{psiX, psiY, psiZ, lap}` — rather than returning a fresh
 * object, for the same allocation reason as above. Pass the same scratch object
 * every call.
 */
export function zeldovich(qx, qy, qz, fieldScale, psiAmp, out) {
  const px = qx * fieldScale, py = qy * fieldScale, pz = qz * fieldScale;
  const e = STENCIL_E;
  const f0 = potential(px, py, pz);
  const fx1 = potential(px + e, py, pz), fx0 = potential(px - e, py, pz);
  const fy1 = potential(px, py + e, pz), fy0 = potential(px, py - e, pz);
  const fz1 = potential(px, py, pz + e), fz0 = potential(px, py, pz - e);

  const gx = (fx1 - fx0) / (2 * e);
  const gy = (fy1 - fy0) / (2 * e);
  const gz = (fz1 - fz0) / (2 * e);

  out.psiX = -gx * psiAmp;
  out.psiY = -gy * psiAmp;
  out.psiZ = -gz * psiAmp;
  out.lap = (fx1 + fx0 + fy1 + fy0 + fz1 + fz0 - 6 * f0) / (e * e);
  return out;
}

/** Mirror of `zeldovichDensity()`. */
export function zeldovichDensity(lap, growth) {
  const J = 1 - growth * lap * 0.045;
  const d = 1 / Math.max(Math.abs(J), 0.06);
  return d > 18 ? 18 : d;
}

/** Scratch object shaped for `zeldovich()`'s `out` parameter. */
export const fieldScratch = () => ({ psiX: 0, psiY: 0, psiZ: 0, lap: 0 });
