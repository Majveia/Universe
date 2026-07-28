/**
 * Shared GLSL chunks.
 *
 * Exported as JS strings rather than .glsl files so every shader in the project
 * composes them the same way and the single-file build has nothing to resolve
 * at runtime. Concatenate what you need; there are no #includes to chase.
 */

export const GLSL_CONST = /* glsl */ `
#ifndef UNI_CONST
#define UNI_CONST
const float PI      = 3.141592653589793;
const float TAU     = 6.283185307179586;
const float HALF_PI = 1.570796326794897;
const float INV_PI  = 0.318309886183791;
const float EPS     = 1e-6;
#endif
`;

export const GLSL_HASH = /* glsl */ `
#ifndef UNI_HASH
#define UNI_HASH
// Integer avalanche hashes. Bit-exact across drivers (no sin()-based hashing,
// which drifts badly on mobile GPUs and produces visible banding).
uint uhash(uint x){
  x ^= x >> 16; x *= 0x7feb352du;
  x ^= x >> 15; x *= 0x846ca68bu;
  x ^= x >> 16; return x;
}
float hash11(float p){ return float(uhash(uint(int(p)))) / 4294967296.0; }
float hash13(vec3 p){
  uvec3 q = uvec3(ivec3(floor(p)));
  uint h = uhash(q.x ^ uhash(q.y ^ uhash(q.z)));
  return float(h) / 4294967296.0;
}
vec3 hash33(vec3 p){
  uvec3 q = uvec3(ivec3(floor(p)));
  uint h = uhash(q.x ^ uhash(q.y ^ uhash(q.z)));
  uint h2 = uhash(h + 0x9e3779b9u);
  uint h3 = uhash(h2 + 0x85ebca6bu);
  return vec3(float(h), float(h2), float(h3)) / 4294967296.0;
}
vec2 hash22(vec2 p){
  uvec2 q = uvec2(ivec2(floor(p)));
  uint h = uhash(q.x ^ uhash(q.y));
  uint h2 = uhash(h + 0x9e3779b9u);
  return vec2(float(h), float(h2)) / 4294967296.0;
}
#endif
`;

export const GLSL_NOISE = /* glsl */ `
#ifndef UNI_NOISE
#define UNI_NOISE
// --- 3D simplex (Ashima/McEwan, public domain) -------------------------------
vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

float fbm(vec3 p, int octaves, float lacunarity, float gain){
  float amp = 0.5, freq = 1.0, sum = 0.0, norm = 0.0;
  for (int i = 0; i < 12; i++){
    if (i >= octaves) break;
    sum += amp * snoise(p * freq);
    norm += amp;
    amp *= gain; freq *= lacunarity;
  }
  return sum / max(norm, EPS);
}
float fbm(vec3 p, int octaves){ return fbm(p, octaves, 2.0, 0.5); }

float ridged(vec3 p, int octaves, float lacunarity, float gain){
  float amp = 0.5, freq = 1.0, sum = 0.0, norm = 0.0, prev = 1.0;
  for (int i = 0; i < 12; i++){
    if (i >= octaves) break;
    float n = 1.0 - abs(snoise(p * freq));
    n *= n; n *= prev; prev = n;
    sum += amp * n; norm += amp;
    amp *= gain; freq *= lacunarity;
  }
  return sum / max(norm, EPS);
}
float ridged(vec3 p, int octaves){ return ridged(p, octaves, 2.0, 0.5); }

float billow(vec3 p, int octaves){
  float amp = 0.5, freq = 1.0, sum = 0.0, norm = 0.0;
  for (int i = 0; i < 12; i++){
    if (i >= octaves) break;
    sum += amp * (abs(snoise(p * freq)) * 2.0 - 1.0);
    norm += amp; amp *= 0.5; freq *= 2.0;
  }
  return sum / max(norm, EPS);
}

// Domain warp — the difference between "noise" and "landscape".
float warpedFbm(vec3 p, int octaves, float warp){
  vec3 q = vec3(fbm(p + vec3(5.2,1.3,2.8), 3),
                fbm(p + vec3(9.2,7.3,4.8), 3),
                fbm(p + vec3(3.7,2.9,8.1), 3));
  return fbm(p + warp * q, octaves);
}

// Worley F1/F2. .x = nearest, .y = second nearest, .z = cell id in [0,1).
vec3 worley(vec3 p){
  vec3 i = floor(p);
  vec3 f = fract(p);
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++){
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 o = hash33(i + g);
    vec3 d = g + o - f;
    float dd = dot(d, d);
    if (dd < f1){ f2 = f1; f1 = dd; id = o.x; }
    else if (dd < f2){ f2 = dd; }
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}

// Curl of a noise field — divergence-free, so particles advected by it swirl
// like a fluid instead of piling up at sinks.
vec3 curlNoise(vec3 p){
  const float e = 0.1;
  float n1, n2;
  n1 = snoise(vec3(p.x, p.y + e, p.z));
  n2 = snoise(vec3(p.x, p.y - e, p.z));
  float a = n1 - n2;
  n1 = snoise(vec3(p.x, p.y, p.z + e));
  n2 = snoise(vec3(p.x, p.y, p.z - e));
  float b = n1 - n2;
  float x = a - b;
  n1 = snoise(vec3(p.x, p.y, p.z + e));
  n2 = snoise(vec3(p.x, p.y, p.z - e));
  a = n1 - n2;
  n1 = snoise(vec3(p.x + e, p.y, p.z));
  n2 = snoise(vec3(p.x - e, p.y, p.z));
  b = n1 - n2;
  float y = a - b;
  n1 = snoise(vec3(p.x + e, p.y, p.z));
  n2 = snoise(vec3(p.x - e, p.y, p.z));
  a = n1 - n2;
  n1 = snoise(vec3(p.x, p.y + e, p.z));
  n2 = snoise(vec3(p.x, p.y - e, p.z));
  b = n1 - n2;
  float z = a - b;
  return normalize(vec3(x, y, z) / (2.0 * e));
}
#endif
`;

export const GLSL_COLOR = /* glsl */ `
#ifndef UNI_COLOR
#define UNI_COLOR
// Blackbody radiance -> linear sRGB. Physically motivated (Planck-ish fit), so
// a 3000K star reads warm-orange and a 30000K star reads violet-white without
// any hand-picked palette.
vec3 blackbody(float K){
  K = clamp(K, 1000.0, 40000.0);
  float t = K / 100.0;
  vec3 c;
  if (t <= 66.0){
    c.r = 1.0;
    c.g = clamp(0.39008157876 * log(t) - 0.63184144378, 0.0, 1.0);
    c.b = t <= 19.0 ? 0.0 : clamp(0.54320678911 * log(t - 10.0) - 1.19625408914, 0.0, 1.0);
  } else {
    c.r = clamp(1.29293618606 * pow(t - 60.0, -0.1332047592), 0.0, 1.0);
    c.g = clamp(1.12989086089 * pow(t - 60.0, -0.0755148492), 0.0, 1.0);
    c.b = 1.0;
  }
  // sRGB -> linear
  return pow(c, vec3(2.2));
}

// Iñigo Quílez cosine palette. Cheap, smooth, and never bands.
vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d){
  return a + b * cos(TAU * (c * t + d));
}

vec3 linearToSrgb(vec3 c){
  return mix(c * 12.92, 1.055 * pow(max(c, 1e-5), vec3(1.0/2.4)) - 0.055, step(0.0031308, c));
}
vec3 srgbToLinear(vec3 c){
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// AgX-flavoured tonemap. Chosen over ACES because it desaturates highlights
// more gracefully — critical when a star core hits 60x white on an OLED.
vec3 agxDefaultContrastApprox(vec3 x){
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return  15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x
        + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 col){
  const mat3 agx_mat = mat3(
    0.842479062253094, 0.0423282422610123, 0.0423756549057051,
    0.0784335999999992, 0.878468636469772, 0.0784336,
    0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  const float min_ev = -12.47393;
  const float max_ev = 4.026069;
  col = agx_mat * col;
  col = clamp(log2(max(col, 1e-10)), min_ev, max_ev);
  col = (col - min_ev) / (max_ev - min_ev);
  return agxDefaultContrastApprox(col);
}
vec3 agxEotf(vec3 col){
  const mat3 agx_mat_inv = mat3(
     1.19687900512017, -0.0528968517574562, -0.0529716355144438,
    -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
    -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  col = agx_mat_inv * col;
  return pow(max(col, 0.0), vec3(2.2));
}
vec3 agxLook(vec3 col, float sat, vec3 slope, float power){
  float luma = lum(col);
  col = pow(max(col * slope, 0.0), vec3(power));
  return luma + sat * (col - luma);
}
#endif
`;

export const GLSL_MATH = /* glsl */ `
#ifndef UNI_MATH
#define UNI_MATH
float saturate(float x){ return clamp(x, 0.0, 1.0); }
vec2  saturate(vec2 x){ return clamp(x, 0.0, 1.0); }
vec3  saturate(vec3 x){ return clamp(x, 0.0, 1.0); }
float remap(float x, float a, float b, float c, float d){
  return c + (d - c) * saturate((x - a) / max(b - a, EPS));
}
float sqr(float x){ return x * x; }

// Analytic ray/sphere. Returns (near, far); near > far means a miss.
vec2 raySphere(vec3 ro, vec3 rd, vec3 ce, float ra){
  vec3 oc = ro - ce;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - ra * ra;
  float h = b * b - c;
  if (h < 0.0) return vec2(1.0, -1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

// Henyey-Greenstein phase function — forward scattering in atmospheres, dust
// and cloud decks. g>0 pushes light forward (haloes around the sun).
float hgPhase(float cosTheta, float g){
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * cosTheta, EPS), 1.5));
}
float rayleighPhase(float cosTheta){
  return (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
}

// Interleaved gradient noise — the right dither for breaking up banding in
// gradients on an OLED, where 8-bit steps in near-black are painfully visible.
float ign(vec2 p){
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

mat3 rotAxis(vec3 axis, float a){
  float s = sin(a), c = cos(a), t = 1.0 - c;
  vec3 n = normalize(axis);
  return mat3(
    t*n.x*n.x + c,      t*n.x*n.y - s*n.z,  t*n.x*n.z + s*n.y,
    t*n.x*n.y + s*n.z,  t*n.y*n.y + c,      t*n.y*n.z - s*n.x,
    t*n.x*n.z - s*n.y,  t*n.y*n.z + s*n.x,  t*n.z*n.z + c);
}
#endif
`;

/** Everything, in dependency order. Most shaders just want this. */
export const GLSL_LIB = GLSL_CONST + GLSL_MATH + GLSL_HASH + GLSL_NOISE + GLSL_COLOR;
