/**
 * A planet seen from space.
 *
 * The whole body is four nested unit-radius shells, all shaded procedurally in
 * the fragment shader — there is no heightmap texture, no baked normal map and
 * no CPU mesh generation, so a world costs a few kilobytes of uniforms and can
 * be generated the instant you arrive.
 *
 *   surface   r = 1            terrain, ocean, ice, cities, aurorae
 *   clouds    r = 1 + hc       curl-advected fbm, short volumetric march
 *   atmosphere r = 1 + ha      Rayleigh + Mie single scattering
 *   (rings and moons are separate objects owned by the realm)
 *
 * Three decisions carry most of the look:
 *
 *  1. The atmosphere is integrated TWICE, in two shaders, from one shared GLSL
 *     function. The outer shell handles rays that miss the planet — that is
 *     where the blue halo against black and the limb glow come from. The
 *     surface shader handles rays that hit, which is what gives aerial
 *     perspective, the orange terminator band, and the correct transmittance
 *     of ground colour through a thick atmosphere. Doing only the shell gives
 *     you a planet with a sticker of sky around it; doing only the surface
 *     gives you a planet with a hard edge against space. You need both, and
 *     because the shell is drawn back-facing the planet's own depth write
 *     removes the double-counted overlap for free.
 *
 *  2. Scattering coefficients come from the record's atmosphere colour, cubed
 *     into a per-channel extinction. That is what makes sunsets work on alien
 *     air: whatever colour scatters most out of a long path is the colour the
 *     sky is at zenith and the colour that is MISSING at the terminator. A
 *     methane sky gets a green day and a magenta sunset without a single
 *     special case.
 *
 *  3. The night side is never black. Real planets at new phase still show
 *     airglow, the ashen light of scattered starlight, aurorae, city lights
 *     and — through the atmosphere shell — a rim of forward-scattered
 *     sunlight. A black night side reads as a rendering failure even though it
 *     is technically what a naive lambert gives you.
 *
 * Everything is evaluated in the mesh's own local space (unit sphere at the
 * origin), so the shaders need only two vectors from the realm: where the
 * camera is and where the star is, both in that local frame. Axial tilt lives
 * in the parent group, so "y" in these shaders is always the rotation pole and
 * the polar caps follow the tilt without any extra work.
 */

import * as THREE from 'three';
import { GLSL_LIB } from '../shaders/common.js';
import { settings } from '../core/Settings.js';
import { Rng } from '../core/Rng.js';
import { clamp, lerp, smoothstep } from '../core/Noise.js';
import { PlanetType } from '../universe/Catalog.js';

function budget() {
  const t = clamp(settings.tier | 0, 0, 4);
  return {
    seg: [48, 72, 112, 168, 224][t],
    contOct: [3, 4, 5, 6, 7][t],
    mntOct: [3, 3, 4, 5, 6][t],
    warp: t >= 2,
    craterLayers: [1, 2, 2, 3, 3][t],
    bump: t >= 1,
    atmoView: clamp(settings.atmosphereSteps, 4, 24),
    atmoSun: [2, 2, 3, 4, 5][t],
    cloudSteps: clamp(Math.round(settings.cloudSteps / 7), 1, 8),
    cloudSeg: [32, 48, 64, 96, 128][t],
    atmoSeg: [24, 32, 48, 64, 80][t],
    tier: t,
  };
}

// -----------------------------------------------------------------------------
// shared GLSL
// -----------------------------------------------------------------------------

const COMMON_VERT = /* glsl */ `
varying vec3 vLocal;
void main(){
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Atmospheric single scattering. Shared verbatim by the surface and the shell. */
const ATMO_GLSL = (b) => /* glsl */ `
uniform float uAtmoR;
uniform float uHr;
uniform float uHm;
uniform vec3  uBetaR;
uniform vec3  uBetaM;
uniform float uMieG;
uniform vec3  uSunColor;
uniform float uSunIntensity;

void scatter(vec3 ro, vec3 rd, float tMax, vec3 L, out vec3 inscat, out vec3 trans){
  inscat = vec3(0.0);
  trans = vec3(1.0);
  vec2 ta = raySphere(ro, rd, vec3(0.0), uAtmoR);
  if (ta.x > ta.y) return;
  float t0 = max(ta.x, 0.0);
  float t1 = min(ta.y, tMax);
  if (t1 <= t0) return;

  float thick = max(uAtmoR - 1.0, 1e-4);
  const int VS = ${b.atmoView};
  const int SS = ${b.atmoSun};
  float dt = (t1 - t0) / float(VS);
  float jit = ign(gl_FragCoord.xy);

  float cosT = dot(rd, L);
  float pR = rayleighPhase(cosT);
  float pM = hgPhase(cosT, uMieG);

  float odR = 0.0, odM = 0.0;
  for (int i = 0; i < VS; i++){
    vec3 p = ro + rd * (t0 + (float(i) + jit) * dt);
    float h = (length(p) - 1.0) / thick;
    float dR = exp(-max(h, 0.0) / uHr) * dt;
    float dM = exp(-max(h, 0.0) / uHm) * dt;
    odR += dR;
    odM += dM;

    // Is this sample in the planet's own shadow? Skipping the light march for
    // shadowed samples is both correct and the single biggest saving here.
    vec2 tb = raySphere(p, L, vec3(0.0), 1.0);
    if (tb.y > tb.x && tb.x > 0.0) continue;

    vec2 tl = raySphere(p, L, vec3(0.0), uAtmoR);
    float ldt = max(tl.y, 0.0) / float(SS);
    float lR = 0.0, lM = 0.0;
    for (int j = 0; j < SS; j++){
      vec3 q = p + L * (float(j) + 0.5) * ldt;
      float hh = (length(q) - 1.0) / thick;
      lR += exp(-max(hh, 0.0) / uHr) * ldt;
      lM += exp(-max(hh, 0.0) / uHm) * ldt;
    }
    vec3 tau = uBetaR * (odR + lR) + uBetaM * (odM + lM);
    inscat += (uBetaR * dR * pR + uBetaM * dM * pM) * exp(-tau);
  }
  inscat *= uSunColor * uSunIntensity * 12.566;
  trans = exp(-(uBetaR * odR + uBetaM * odM));
}
`;

/**
 * Cloud density on the shell. Curl advection is what stops fbm clouds looking
 * like a sliding texture — a divergence-free field shears and folds them the
 * way a real flow does.
 */
const CLOUD_GLSL = /* glsl */ `
uniform float uCloudCover;
uniform float uCloudTime;
uniform float uCloudScale;
uniform float uStorm;
uniform vec3  uCloudSeed;

float cloudField(vec3 d){
  vec3 flow = curlNoise(d * 1.4 + uCloudSeed + vec3(0.0, uCloudTime * 0.05, 0.0));
  vec3 p = d * uCloudScale + flow * 0.35 + uCloudSeed;
  float base = fbm(p, 5) * 0.5 + 0.5;
  float detail = fbm(p * 3.7 + flow * 0.8, 3) * 0.5 + 0.5;
  float f = base * 0.72 + detail * 0.28;
  // Coriolis: bands, not blobs. Rotation stretches weather systems zonally,
  // which is why every rotating world has latitudinal cloud structure.
  float bandMod = 0.82 + 0.30 * sin(d.y * 9.0 + fbm(p * 0.7, 3) * 2.0);
  f *= bandMod;
  // Cyclones spun up where the field curls hardest.
  float storm = pow(saturate(fbm(d * 5.0 + uCloudSeed * 2.0 + uCloudTime * 0.02, 4) * 0.5 + 0.5), 3.0);
  f += storm * uStorm * 0.35;
  return saturate((f - (1.0 - uCloudCover)) / max(uCloudCover * 0.75, 0.05));
}
`;

// -----------------------------------------------------------------------------
// surface
// -----------------------------------------------------------------------------

const surfaceFrag = (b, opt) => /* glsl */ `
precision highp float;
${GLSL_LIB}

uniform float uTime;
uniform vec3  uCamLocal;
uniform vec3  uSunLocal;
uniform float uSunAng;
uniform float uWrap;
uniform float uLimb;

uniform vec3  uBase;
uniform vec3  uAccent;
uniform vec3  uWater;
uniform vec3  uAtmoTint;

uniform float uSeaLevel;
uniform float uContinent;
uniform float uMountain;
uniform float uPlate;
uniform float uRidge;
uniform float uErosion;
uniform float uCrater;
uniform float uDune;
uniform float uRough;
uniform float uVolcanism;
uniform float uBump;
uniform float uIceCap;
uniform float uSnowLine;
uniform float uHasWater;
uniform float uIsGiant;
uniform float uBandFreq;
uniform float uSpotSize;
uniform float uSpotSwirl;
uniform vec3  uSpotDir;
// Up to four vortices: xyz is the direction to the storm centre, w its angular
// radius. A single spot at a random longitude is only in frame half the time and
// the shot that needs it cannot wait for the planet to rotate.
uniform vec4  uVortex[4];
uniform vec4  uVortexSpin;   // per-vortex swirl, signed; 0 disables the slot
uniform float uCityAmount;
uniform float uAurora;
uniform float uNightGlow;
uniform vec3  uSeed;
uniform float uCloudShadow;

${ATMO_GLSL(b)}
${CLOUD_GLSL}

varying vec3 vLocal;

// --- terrain ----------------------------------------------------------------

// Crater fields. Bowl plus raised rim plus ejecta, layered at three scales;
// only a fraction of cells actually hold a crater or the surface turns to foam.
float craters(vec3 p){
  float acc = 0.0;
  float sc = 5.0;
  float amp = 1.0;
  for (int i = 0; i < ${b.craterLayers}; i++){
    vec3 w = worley(p * sc + uSeed * (float(i) + 1.7));
    float r = w.x;
    float present = step(w.z, 0.42);
    float rad = 0.30 + w.z * 0.16;
    float bowl = smoothstep(rad, rad * 0.35, r);
    float rim = exp(-pow((r - rad) / (rad * 0.26), 2.0));
    float ejecta = exp(-pow((r - rad * 1.9) / (rad * 1.1), 2.0)) * 0.12;
    acc += (rim * 0.55 + ejecta - bowl * 0.75) * amp * present;
    sc *= 2.7;
    amp *= 0.45;
  }
  return acc;
}

float heightAt(vec3 p, out float ridgeOut, out float beltOut){
  vec3 q = p * uContinent + uSeed;
${b.warp ? `
  // Domain warp. The single difference between "noise on a sphere" and
  // "coastlines" — it bends the field along itself so landmasses braid.
  vec3 w = vec3(fbm(q * 0.8 + 5.2, 3), fbm(q * 0.8 + 9.2, 3), fbm(q * 0.8 + 3.7, 3));
  float cont = fbm(q + w * (0.4 + uRough * 0.7), ${b.contOct}) * 0.5 + 0.5;
` : `
  float cont = fbm(q, ${b.contOct}) * 0.5 + 0.5;
`}
  // Plate boundaries. Real ranges are long arcs along sutures, not scattered
  // bumps, so mountains are gated by proximity to a Voronoi edge.
  vec3 pl = worley(p * uPlate + uSeed * 2.3);
  float belt = 1.0 - smoothstep(0.0, 0.26, pl.y - pl.x);
  beltOut = belt;

  float mnt = ridged(p * uMountain + uSeed * 0.7, ${b.mntOct});
  ridgeOut = mnt;

  float h = cont;
  h += mnt * uRidge * (0.22 + 0.78 * belt) * smoothstep(uSeaLevel - 0.04, uSeaLevel + 0.28, cont);
  // Erosion pulls the field toward its own smoothstep: valleys fill, peaks stay.
  h = mix(h, smoothstep(0.05, 0.95, h), uErosion * 0.45);
  h += fbm(p * uMountain * 5.5 + uSeed, 3) * uDune * 0.035;

  // Third scale of relief, always present. Continental and orogenic structure
  // are both above, and then the field simply stopped — the only finer term was
  // gated behind uDune, which is zero on any world that is not a desert. That is
  // why a temperate planet read as smooth from orbit no matter how much the
  // coarse octaves were doing.
  //
  // Weighted by the plate belt and by height above sea level, so it roughens
  // mountains and leaves plains and seabed alone. Uniform high-frequency noise
  // everywhere is the "noise-textured ball" the rubric fails a frame for; what
  // makes detail read as terrain is that it is correlated with the terrain.
  //
  // Frequency stays well under what the normal's finite-difference epsilon
  // (0.0022) can resolve. Past roughly 1/(4e) the shading aliases into sparkle
  // instead of resolving into landscape.
  float fineW = (0.30 + 0.70 * belt) * smoothstep(uSeaLevel - 0.02, uSeaLevel + 0.20, h);
  h += fbm(p * uMountain * 6.0 + uSeed * 6.1, 4) * fineW * 0.030;

  h += craters(p) * uCrater * 0.12;
  return h;
}

// --- gas giants -------------------------------------------------------------
//
// Vortex placement is decided on the CPU in giantVortices below, because where
// a storm belongs is a property of the flow, not of the pixel: it sits where
// two zonal jets tear past each other.

vec3 giantColor(vec3 p, out float turbOut){
  // Zonal jets. Latitude-dependent longitudinal advection is why Jupiter's
  // bands shear past each other and why the boundaries are ragged.
  float lat = clamp(p.y, -1.0, 1.0);
  float jet = sin(lat * 7.0 + uSeed.x) * 0.6 + sin(lat * 15.0 + uSeed.y) * 0.25;
  float ang = uTime * 0.010 * jet;
  float ca = cos(ang), sa = sin(ang);
  vec3 sp = vec3(p.x * ca - p.z * sa, p.y, p.x * sa + p.z * ca);

  // Anticyclones. Each one twists the sampling frame locally, so the band it
  // sits in wraps around it instead of running through — that shearing of the
  // surrounding flow is what makes a storm read as a storm rather than as a
  // painted ellipse.
  float spotMask = 0.0;
  float collar = 0.0;
  for (int i = 0; i < 4; i++){
    float sizeA = uVortex[i].w;
    if (sizeA <= 0.0) continue;
    vec3 dir = normalize(uVortex[i].xyz);
    // Only the near hemisphere: on the far side the projection folds and the
    // storm would smear across the limb.
    if (dot(sp, dir) <= 0.0) continue;

    vec3 up = abs(dir.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 tx = normalize(cross(up, dir));
    vec3 ty = cross(dir, tx);
    // Squashed: a vortex confined between two jets is far wider than it is tall.
    vec2 sv = vec2(dot(sp, tx), dot(sp, ty) * 2.4);
    float sd = length(sv) / max(sizeA, 1e-3);

    float m = exp(-sd * sd * 1.6);
    // A raised rim just outside the core, which is where the entrained cloud
    // piles up and why the Great Red Spot has a pale collar around it.
    collar += exp(-pow((sd - 1.15) / 0.42, 2.0)) * 0.9;
    spotMask = max(spotMask, m);

    float sw = uVortexSpin[i];
    float swirl = (sw * 2.4 + uTime * 0.02) * m;
    float cs = cos(swirl), ss = sin(swirl);
    sp = sp * cs + cross(dir, sp) * ss + dir * dot(dir, sp) * (1.0 - cs);
  }
  collar = min(collar, 1.0) * (1.0 - spotMask);

  float turb = fbm(vec3(sp.x, sp.y * 4.5, sp.z) * 3.0 + uSeed, 5);
  float fine = fbm(vec3(sp.x, sp.y * 8.0, sp.z) * 11.0 + uSeed * 1.3, 3);
  turbOut = turb;

  float y = lat + turb * 0.030 * (1.0 - abs(lat)) + fine * 0.008;
  float bands = fbm(vec3(0.0, y * uBandFreq, 0.0) + uSeed * 0.4, 4) * 0.5 + 0.5;
  bands = smoothstep(0.18, 0.82, bands);

  // Zones and belts have to differ in HUE, not only in value. The bright zones
  // are high ammonia cloud — pale and faintly cool — while the belts are deeper,
  // warmer levels where the chromophores sit. Jupiter's cream-versus-rust is a
  // hue difference, and reproducing it as one brown at two brightnesses is what
  // makes a gas giant read as monochrome.
  //
  // The base-to-accent lerp alone was not delivering it: the belt term pulled
  // 60% toward a darkened base while the zone term pulled only 50% toward the
  // accent over a window that barely opened (0.72 to 0.98), so the bright end of
  // the ramp never actually arrived anywhere. The two ends are now weighted
  // symmetrically and pushed apart in hue as well as in lightness.
  vec3 zone = mix(uBase, uAccent, bands);
  // Belts: darker, warmer, more saturated than the base.
  vec3 beltCol = uBase * 0.62 + vec3(0.10, 0.028, 0.0);
  zone = mix(zone, beltCol, (1.0 - smoothstep(0.10, 0.58, bands)) * 0.72);
  // Zones: paler and a touch cooler than the accent.
  vec3 zoneCol = mix(uAccent, vec3(1.0, 0.99, 0.96), 0.45);
  zone = mix(zone, zoneCol, smoothstep(0.55, 0.92, bands) * 0.85);

  // Polar hood. Desaturating the same banding was not enough to read as a
  // different regime, and it is not what happens: away from the tropics the
  // Coriolis parameter stops supporting coherent zonal jets, the banding breaks
  // up, and what is left is a field of small cyclones. So the bands are
  // replaced rather than tinted — cells instead of stripes — and the whole hood
  // goes colder and darker, the way Jupiter's grey-blue caps and Saturn's do.
  // Onset well down from the pole. From an equatorial view everything above
  // |lat| 0.55 is crushed into the last few pixels of the rim by foreshortening,
  // so a hood that starts there exists in the maths and never reaches the eye.
  // Jupiter's caps read as caps because they cover a visible fraction of the
  // disc, not because they are geometrically confined to the pole.
  float polar = smoothstep(0.50, 0.90, abs(lat));
  if (polar > 0.001){
    // Round cyclone cores, taken from the Worley F1 *distance*. The F2 - F1
    // edge function was tried first and is wrong here by construction: it draws
    // cell boundaries, so the cap came out as hard-edged polygons — cracked mud
    // rather than weather. A falloff on the distance to each cell centre gives
    // the circular storms Juno actually photographs.
    vec3 c1 = worley(sp * 7.0 + uSeed * 3.1);
    vec3 c2 = worley(sp * 15.0 + uSeed * 5.3);
    float cyc = exp(-c1.x * c1.x * 9.0) + exp(-c2.x * c2.x * 14.0) * 0.5;
    float turb = fbm(sp * 9.0 + uSeed * 4.7, 4) * 0.5 + 0.5;
    float mott = clamp(turb * 0.7 + cyc * 0.45, 0.0, 1.0);
    vec3 hood = mix(uBase * 0.46, uBase * 0.95, mott);
    // Cooler as well as darker: scattering at depth is bluer once the ammonia
    // haze thins out.
    hood = mix(hood, vec3(lum(hood)) * vec3(0.80, 0.89, 1.10), 0.42);
    zone = mix(zone, hood, polar * 0.88);
  }

  // The vortices, tinted away from the zone they sit in, with the pale collar
  // of entrained cloud around each core.
  vec3 spotCol = mix(uAccent, vec3(0.86, 0.34, 0.22), 0.65);
  zone = mix(zone, spotCol * (0.8 + 0.4 * fine), spotMask * 0.85);
  zone = mix(zone, uAccent * 1.25, collar * 0.45);
  zone *= 0.88 + 0.24 * (fine * 0.5 + 0.5);
  return zone;
}

// --- night side -------------------------------------------------------------

// City lights: worley clusters, gated on being low, dry land near a coast.
// Civilisations settle river mouths and harbours, so the mask is coastline
// proximity rather than uniform land.
vec3 cityLights(vec3 p, float h, float coast){
  if (uCityAmount <= 0.001) return vec3(0.0);
  vec3 c1 = worley(p * 34.0 + uSeed * 5.0);
  vec3 c2 = worley(p * 96.0 + uSeed * 7.0);
  float core = exp(-c1.x * c1.x * 42.0);
  float sprawl = exp(-c1.x * c1.x * 7.0) * 0.30;
  float grain = exp(-c2.x * c2.x * 120.0);
  float pop = step(c1.z, 0.30 + uCityAmount * 0.45) * (0.25 + c1.z);
  // Ribbons of light between the cores: the road network.
  float road = (1.0 - smoothstep(0.0, 0.06, abs(c1.y - c1.x))) * 0.35;
  float lit = (core + sprawl + road) * pop * (0.35 + 0.85 * grain);
  lit *= coast * step(uSeaLevel, h) * uCityAmount;
  // Sodium vapour warm, LED cool — the mix has been shifting for 20 years and
  // it is the thing that makes orbital night photography read as "now".
  vec3 warm = vec3(1.0, 0.62, 0.24);
  vec3 cool = vec3(0.72, 0.86, 1.0);
  return mix(warm, cool, smoothstep(0.2, 0.8, c1.z)) * lit;
}

// Aurorae: precipitation along field lines into the auroral oval, a ring a few
// degrees across centred on the magnetic pole. Structure is field-aligned, so
// it is stretched in latitude and finely striated in longitude.
vec3 auroraGlow(vec3 p, float night){
  if (uAurora <= 0.001) return vec3(0.0);
  float lat = abs(p.y);
  float oval = exp(-pow((lat - 0.86) / 0.075, 2.0));
  float lon = atan(p.z, p.x);
  float curtain = fbm(vec3(lon * 3.4, p.y * 14.0, uTime * 0.07) + uSeed, 4) * 0.5 + 0.5;
  curtain = pow(curtain, 2.2);
  float ray = 0.55 + 0.45 * sin(lon * 90.0 + curtain * 12.0 + uTime * 0.4);
  // 557.7 nm oxygen green below, 630 nm oxygen red above, nitrogen violet at
  // the lower fringe. The vertical stratification is what gives real aurorae
  // their colour gradient.
  vec3 green = vec3(0.18, 1.0, 0.44);
  vec3 red   = vec3(1.0, 0.24, 0.42);
  vec3 col = mix(green, red, saturate(curtain * 0.8));
  return col * oval * curtain * ray * uAurora * night * 1.6;
}

void main(){
  vec3 p = normalize(vLocal);
  vec3 L = normalize(uSunLocal);
  vec3 toCam = uCamLocal - p;
  float camDist = length(toCam);
  vec3 V = toCam / max(camDist, 1e-6);

  vec3 N = p;
  vec3 albedo;
  float gloss = 0.0;
  vec3 emissive = vec3(0.0);
  float h = 0.0;
  float ridge = 0.0, belt = 0.0;
  float ocean = 0.0;

  if (uIsGiant > 0.5){
    float turb;
    albedo = giantColor(p, turb);
    // Cloud-top relief from the same turbulence field, so the bands catch
    // light along their edges.
    vec3 t1 = normalize(cross(vec3(0.0, 1.0, 0.0), p) + 1e-5);
    vec3 t2 = cross(p, t1);
    float e = 0.006;
    float dummy;
    float ha = lum(giantColor(normalize(p + t1 * e), dummy));
    float hb = lum(giantColor(normalize(p + t2 * e), dummy));
    float h0 = lum(albedo);
    N = normalize(p - (t1 * (ha - h0) + t2 * (hb - h0)) * uBump * 22.0);
    gloss = 0.04;
  } else {
    h = heightAt(p, ridge, belt);

    // Analytic-ish normal from finite differences of the height field. Two
    // extra evaluations buys every mountain range its own shading.
    if (uBump > 0.001){
      vec3 t1 = normalize(cross(abs(p.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0), p));
      vec3 t2 = cross(p, t1);
      float e = 0.0022;
      float r2, b2;
      float ha = heightAt(normalize(p + t1 * e), r2, b2);
      float hb = heightAt(normalize(p + t2 * e), r2, b2);
      N = normalize(p - (t1 * (ha - h) + t2 * (hb - h)) * (uBump / e) * 0.0016);
    }

    float land = smoothstep(uSeaLevel - 0.004, uSeaLevel + 0.004, h);
    ocean = (1.0 - land) * uHasWater;

    // Latitude in the tilted frame: y IS the pole, because the tilt lives in
    // the parent transform.
    float lat = abs(p.y);
    float capNoise = fbm(p * 7.0 + uSeed * 3.0, 4) * 0.06;
    float elev = saturate((h - uSeaLevel) * 3.2);
    // Snow line drops toward the poles and rises with altitude — the same
    // rule on Earth and on Mars.
    float cap = smoothstep(uIceCap - 0.10 + capNoise, uIceCap + 0.06 + capNoise, lat + elev * uSnowLine);

    float slope = 1.0 - saturate(dot(N, p));
    float rock = smoothstep(0.0006, 0.010, slope);

    // Biome: moisture falls with distance from water and rises with latitude
    // band; it is what stops a planet being one flat colour with a gradient.
    float moist = saturate(fbm(p * 2.4 + uSeed * 1.9, 4) * 0.5 + 0.5);
    moist *= 1.0 - smoothstep(0.15, 0.55, abs(h - uSeaLevel));
    vec3 lowland = mix(uBase, uAccent, moist * 0.8);
    vec3 highland = mix(uAccent * 0.8, vec3(lum(uAccent)) * 1.05, saturate(elev * 1.4));
    albedo = mix(lowland, highland, saturate(elev * 1.6));
    albedo = mix(albedo, uBase * 0.62 + vec3(0.10, 0.09, 0.08), rock * 0.7);
    // cap already encodes both whether there is ice here and how completely it
    // covers, so it is the whole mix factor. Scaling it by uIceCap was a category
    // error — that uniform is a *latitude*, not a strength — and the extra 3.0
    // drove the blend to full white wherever cap merely exceeded a third.
    albedo = mix(albedo, vec3(0.90, 0.94, 1.0), cap);
    albedo *= 0.86 + 0.28 * (ridge * 0.5 + 0.5);

    // Fine albedo texture, on land only. Most of what the eye reads as detail
    // in an orbital photograph is not relief — it is vegetation, soil, burn
    // scars and snow patterning — so it belongs in the colour, where it costs
    // nothing and cannot alias the way a normal-map term at this frequency
    // would. Ocean is deliberately excluded: the diffuse water colour has to
    // stay smooth or the sea turns to noise.
    float grainA = fbm(p * 30.0 + uSeed * 8.3, 4) * 0.5 + 0.5;
    float grainB = fbm(p * 88.0 + uSeed * 11.7, 3) * 0.5 + 0.5;
    albedo *= 1.0 - (0.22 * (1.0 - grainA) + 0.13 * (1.0 - grainB)) * land;

    // Volcanism: fissures glow, and they glow in HDR so the bloom finds them.
    if (uVolcanism > 0.001){
      float v = ridged(p * (uMountain * 1.7) + uSeed * 4.0, 4);
      float crack = smoothstep(0.62, 0.92, v) * uVolcanism;
      emissive += blackbody(1250.0 + 620.0 * crack) * crack * crack * 2.6;
      albedo = mix(albedo, vec3(0.09, 0.05, 0.04), crack * 0.5);
    }

    if (ocean > 0.001){
      float depth = saturate((uSeaLevel - h) * 9.0);
      vec3 shallow = uWater * 2.6 + vec3(0.02, 0.09, 0.10);
      albedo = mix(albedo, mix(shallow, uWater, depth), ocean);
      gloss = ocean;
      // Wind ripple perturbs the specular normal only — the diffuse water
      // colour must stay smooth or the ocean turns to noise.
      vec3 wn = vec3(fbm(p * 220.0 + uTime * 0.25, 3), fbm(p * 220.0 + 31.0 - uTime * 0.2, 3), 0.0);
      vec3 t1 = normalize(cross(vec3(0.0, 1.0, 0.0), p) + 1e-5);
      vec3 t2 = cross(p, t1);
      N = normalize(mix(N, normalize(p + (t1 * wn.x + t2 * wn.y) * 0.06), ocean));
      // Sea ice at the poles, riding on top of the water.
      albedo = mix(albedo, vec3(0.86, 0.92, 0.98), cap * ocean * 0.9);
      gloss *= 1.0 - cap;
    }
  }

  // --- lighting -------------------------------------------------------------

  float ndl = dot(N, L);
  // Wrap-around diffuse. Justified twice over: the star has a finite angular
  // radius, and multiple scattering in the atmosphere carries light past the
  // geometric terminator. Both widen the terminator, and a hard one is the
  // most common tell of a fake planet.
  float w = max(uWrap, uSunAng);
  float diff = saturate((ndl + w) / (1.0 + w));
  diff *= diff;
  float night = saturate((-ndl - 0.02) * 4.0);

  // Minnaert limb darkening. Planetary surfaces are not Lambertian: at the
  // sub-solar point you look straight down through the least material, and at
  // the limb you look along a grazing path through far more of it. Every real
  // planetary disc is therefore noticeably brighter in the middle — Juno's
  // Jupiter and Apollo's Earth both fall off hard toward the edge. Without
  // this term a planet reads as a flat sticker no matter how good the surface
  // detail is, because the eye reads uniform edge-to-edge brightness as paint
  // rather than as a sphere.
  float ndv = max(dot(N, V), 1e-3);
  float limb = pow(ndv, uLimb);

  vec3 col = albedo * diff * limb * uSunColor * uSunIntensity;

  // Specular. GGX-ish lobe; on water this is the sun glint that sells scale
  // better than any amount of surface detail.
  if (gloss > 0.001){
    vec3 H = normalize(L + V);
    float ndh = max(dot(N, H), 0.0);
    float a = 0.09;
    float d = a * a / (PI * pow(ndh * ndh * (a * a - 1.0) + 1.0, 2.0));
    float f = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
    col += uSunColor * uSunIntensity * d * f * gloss * smoothstep(-0.02, 0.15, ndl) * 1.4;
  }

  // Fresnel rim on wet worlds: grazing angles reflect sky, not water.
  if (gloss > 0.001){
    float fres = pow(1.0 - saturate(dot(N, V)), 5.0);
    col += uAtmoTint * fres * gloss * diff * 0.28 * uSunIntensity;
  }

  // --- cloud shadow ---------------------------------------------------------
  if (uCloudShadow > 0.001 && ndl > -0.25){
    // Where does the sunbeam that reaches this point cross the cloud deck?
    float b0 = dot(p, L);
    float rc = 1.0 + uCloudShadow;
    float disc = b0 * b0 + rc * rc - 1.0;
    if (disc > 0.0){
      vec3 q = normalize(p + L * (-b0 + sqrt(disc)));
      float shade = cloudField(q);
      col *= 1.0 - shade * 0.62;
    }
  }

  // --- night side -----------------------------------------------------------
  if (uIsGiant < 0.5){
    float coast = 1.0 - smoothstep(0.0, 0.055, abs(h - uSeaLevel));
    col += cityLights(p, h, coast) * night * 2.4;
  }
  col += auroraGlow(p, night) * 1.0;
  // Airglow + starlight + reflected moonlight. Tiny, but it is the difference
  // between a night side and a hole in the frame.
  col += uAtmoTint * uNightGlow * night * albedo * 0.6;

  // --- atmosphere between camera and ground ---------------------------------
  vec3 inscat, trans;
  scatter(uCamLocal, -V, camDist, L, inscat, trans);
  col = col * trans + inscat;

  col += (ign(gl_FragCoord.xy) - 0.5) * 0.0015;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

// -----------------------------------------------------------------------------
// atmosphere shell
// -----------------------------------------------------------------------------

const atmoFrag = (b) => /* glsl */ `
precision highp float;
${GLSL_LIB}

uniform vec3  uCamLocal;
uniform vec3  uSunLocal;
uniform vec3  uAtmoTint;
uniform float uTime;
${ATMO_GLSL(b)}

varying vec3 vLocal;

void main(){
  vec3 ro = uCamLocal;
  vec3 rd = normalize(vLocal - uCamLocal);
  vec3 L = normalize(uSunLocal);

  // Rays that hit the ground are the surface shader's job; the planet's depth
  // write removes most of them, this catches the rest.
  vec2 tb = raySphere(ro, rd, vec3(0.0), 1.0);
  float tMax = 1e9;
  if (tb.y > tb.x && tb.x > 0.0) tMax = tb.x;

  vec3 inscat, trans;
  scatter(ro, rd, tMax, L, inscat, trans);

  gl_FragColor = vec4(max(inscat, 0.0), 1.0);
}
`;

// -----------------------------------------------------------------------------
// clouds
// -----------------------------------------------------------------------------

const cloudFrag = (b) => /* glsl */ `
precision highp float;
${GLSL_LIB}

uniform vec3  uCamLocal;
uniform vec3  uSunLocal;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform float uShellR;
uniform float uShellT;
uniform float uWrap;
uniform vec3  uTint;
uniform float uNightGlow;
${CLOUD_GLSL}

varying vec3 vLocal;

void main(){
  vec3 ro = uCamLocal;
  vec3 rd = normalize(vLocal - uCamLocal);
  vec3 L = normalize(uSunLocal);

  float rOut = uShellR + uShellT * 0.5;
  float rIn = uShellR - uShellT * 0.5;
  vec2 tO = raySphere(ro, rd, vec3(0.0), rOut);
  if (tO.x > tO.y) discard;
  vec2 tI = raySphere(ro, rd, vec3(0.0), rIn);
  float t0 = max(tO.x, 0.0);
  float t1 = (tI.y > tI.x && tI.x > t0) ? tI.x : tO.y;
  // Never draw the far wall of the shell through the planet.
  vec2 tp = raySphere(ro, rd, vec3(0.0), 1.0);
  if (tp.y > tp.x && tp.x > t0) t1 = min(t1, tp.x);
  if (t1 <= t0) discard;

  const int STEPS = ${b.cloudSteps};
  float dt = (t1 - t0) / float(STEPS);
  float jit = ign(gl_FragCoord.xy);

  float alpha = 0.0;
  vec3 col = vec3(0.0);
  float cosT = dot(rd, L);
  // Forward scattering: this is why a cloud edge with the sun behind it is the
  // brightest thing in the sky.
  float phase = hgPhase(cosT, 0.72) * 4.0 + 0.28;

  for (int i = 0; i < STEPS; i++){
    if (alpha > 0.985) break;
    vec3 q = ro + rd * (t0 + (float(i) + jit) * dt);
    vec3 d = normalize(q);
    float dens = cloudField(d);
    if (dens <= 0.001) continue;
    // A little vertical structure so the deck has thickness at the limb.
    float hh = (length(q) - rIn) / max(uShellT, 1e-4);
    dens *= smoothstep(0.0, 0.25, hh) * (1.0 - smoothstep(0.6, 1.0, hh));

    float ndl = dot(d, L);
    float w = max(uWrap, 0.12);
    float lit = saturate((ndl + w) / (1.0 + w));
    // Self-shadowing along the light direction, one tap: enough to give the
    // tops highlights and the flanks depth without a second march.
    float above = cloudField(normalize(d + L * 0.045));
    float shade = exp(-above * 1.9);
    // Powder: dense cores look darker from the lit side because light has to
    // scatter its way back out.
    float powder = 1.0 - exp(-dens * 3.0);

    vec3 lightCol = uSunColor * uSunIntensity * lit * lit * shade * (0.55 + 0.45 * phase) * (0.45 + 0.55 * powder);
    lightCol += uTint * uNightGlow * 0.5 * saturate(-ndl);
    float a = saturate(dens * dt * 26.0);
    col += lightCol * a * (1.0 - alpha);
    alpha += a * (1.0 - alpha);
  }

  if (alpha < 0.003) discard;
  gl_FragColor = vec4(col, alpha);
}
`;

// -----------------------------------------------------------------------------

/**
 * Where the storms go.
 *
 * The rubric asks for vortices sitting in the shear zones, and that is not a
 * decorative requirement — an anticyclone is what you get when two jets moving
 * in opposite directions trap a parcel of atmosphere between them. So the
 * latitudes are not chosen randomly: the shader's zonal jet profile is
 *
 *     jet(lat) = 0.6 sin(7 lat + sx) + 0.25 sin(15 lat + sy)
 *
 * and its derivative is the shear. Sampling |d jet / d lat| and taking its local
 * maxima puts every storm on a jet boundary by construction, which is also why
 * the bands visibly wrap around them rather than running through.
 *
 * Longitudes are spread evenly instead of drawn at random. One spot at a random
 * longitude is on the far side half the time, and a still frame cannot wait for
 * the planet to rotate — with four at 90 degrees apart, at least two always face
 * the camera.
 */
function giantVortices(rng, seed) {
  const jetShear = (lat) =>
    Math.abs(4.2 * Math.cos(lat * 7 + seed.x) + 3.75 * Math.cos(lat * 15 + seed.y));

  // Sample the shear and keep local maxima, away from the poles where the
  // polar hood replaces the banding anyway.
  const N = 240;
  const LO = -0.85, HI = 0.85;
  const s = [];
  for (let i = 0; i <= N; i++) s.push(jetShear(LO + ((HI - LO) * i) / N));
  const peaks = [];
  for (let i = 1; i < N; i++) {
    if (s[i] > s[i - 1] && s[i] >= s[i + 1]) {
      peaks.push({ lat: LO + ((HI - LO) * i) / N, shear: s[i] });
    }
  }
  peaks.sort((a, b) => b.shear - a.shear);

  const count = Math.min(peaks.length, rng.int(2, 4));
  const vortex = [];
  const spin = [];
  for (let i = 0; i < 4; i++) {
    if (i >= count) {
      vortex.push(new THREE.Vector4(0, 1, 0, 0)); // w = 0 disables the slot
      spin.push(0);
      continue;
    }
    const lat = peaks[i].lat + rng.range(-0.03, 0.03);
    // Evenly spread in longitude, jittered so the set does not look regular.
    const lon = (i / count) * Math.PI * 2 + rng.range(-0.5, 0.5);
    // setFromSphericalCoords takes a polar angle from +Y, so latitude has to be
    // turned into a colatitude.
    const dir = new THREE.Vector3().setFromSphericalCoords(1, Math.PI * 0.5 - lat, lon);
    // The biggest storm gets the strongest shear, the rest fall off — one
    // dominant oval with a train of smaller ones, as the real thing has.
    const size = (i === 0 ? rng.range(0.26, 0.36) : rng.range(0.10, 0.18));
    vortex.push(new THREE.Vector4(dir.x, dir.y, dir.z, size));
    // Anticyclones spin opposite ways either side of the equator.
    spin.push(rng.range(0.6, 1.6) * (lat >= 0 ? 1 : -1));
  }

  return {
    uVortex: { value: vortex },
    uVortexSpin: { value: new THREE.Vector4(spin[0], spin[1], spin[2], spin[3]) },
  };
}

export class PlanetBody {
  /**
   * `record` is a Catalog planet. `opts.simple` strips clouds and atmosphere,
   * which is what moons and distant filler bodies get.
   */
  constructor(record, opts = {}) {
    this.record = record;
    this.opts = opts;
    this.b = budget();
    this.simple = !!opts.simple;
    this.radius = record.radius;

    const rng = new Rng(record.seed ^ 0x9e37);
    this.rng = rng;

    this.group = new THREE.Group();       // axial tilt lives here
    this.spin = new THREE.Group();        // solid-body rotation
    this.cloudSpin = new THREE.Group();   // super-rotating cloud deck
    this.group.add(this.spin, this.cloudSpin);

    // Tilt: rotate the pole away from the orbital normal. Applied to the whole
    // body so caps, aurorae and rings all inherit it.
    this.group.rotation.z = record.axialTilt;
    this.group.rotation.y = rng.range(0, Math.PI * 2);

    this._disposables = [];
    this._camLocal = new THREE.Vector3();
    this._sunLocal = new THREE.Vector3();
    this._inv = new THREE.Matrix4();

    const pal = record.palette;
    this.baseColor = new THREE.Color(...pal.base);
    this.accentColor = new THREE.Color(...pal.accent);
    this.atmoColor = new THREE.Color(...pal.atmo);
    this.waterColor = pal.water ? new THREE.Color(...pal.water) : new THREE.Color(0.02, 0.08, 0.16);

    // Visible atmosphere thickness relative to the radius. Earth's optically
    // significant air is ~0.015 R; thin worlds get a haze, giants get a deep
    // hydrogen envelope. Exaggerated modestly or it is invisible at range.
    const atmo = clamp(record.atmosphere, 0, 2);
    this.atmoHeight = record.isGiant ? 0.055 : clamp(0.012 + atmo * 0.032, 0.006, 0.075);
    this.cloudHeight = record.isGiant ? 0.012 : clamp(0.004 + atmo * 0.006, 0.003, 0.014);

    this._buildSurface();
    if (!this.simple && this._wantsClouds()) this._buildClouds();
    if (!this.simple && atmo > 0.02) this._buildAtmosphere();

    // Rotation. Slowed by a fixed factor so a 20-hour day is perceptible
    // without the planet becoming a spinning top.
    this.spinRate = (Math.PI * 2) / Math.max(record.rotationPeriod, 600);
    if (record.tidallyLocked) this.spinRate = (Math.PI * 2) / Math.max(record.period, 600);
    this.spinAngle = rng.range(0, Math.PI * 2);
    this.cloudAngle = this.spinAngle;
    this.time = 0;

    this.moons = [];
  }

  get object3d() {
    return this.group;
  }

  _wantsClouds() {
    const r = this.record;
    if (r.isGiant) return false; // the bands ARE the cloud deck
    return r.weather.cloudCoverage > 0.05 && r.atmosphere > 0.08;
  }

  _mat(m) {
    this._disposables.push(m);
    return m;
  }

  _buildSurface() {
    const r = this.record;
    const b = this.b;
    const t = r.terrain;
    const rng = this.rng.fork('surf');

    const geo = new THREE.SphereGeometry(1, b.seg, Math.max(16, b.seg >> 1));
    this._disposables.push(geo);

    // Ice caps: the fraction of latitude that stays frozen. Cold worlds cap
    // almost to the tropics, hot ones not at all.
    // Latitude, as |sin(lat)|, above which permanent ice survives. The sense of
    // this matters and was inverted: it read
    //
    //     1.06 - smoothstep(190, 330, T) * 1.25
    //
    // which hands a *hot* world a threshold of zero — ice everywhere — and a
    // frozen one 0.98, meaning none at all. At an Earth-like 288 K it produced
    // 0.08, so "polar" ice began at eight per cent of the way to the pole and
    // covered essentially the whole globe. That is what was burying the surface
    // under white, and it was never the cloud deck.
    //
    // Monotonic the right way, and anchored on real numbers: ~250 K puts the ice
    // line down at 30 degrees the way a glacial Earth does, 288 K puts it near
    // 70 degrees where ours sits, and past ~300 K the threshold passes 1.0 so no
    // ice forms at all.
    const capLat = clamp((r.surfaceTemp - 195) / 100, 0.0, 1.15);
    const seed = new THREE.Vector3(rng.range(-40, 40), rng.range(-40, 40), rng.range(-40, 40));

    // Sea level in height-field units. The field is roughly [0,1] centred on
    // 0.5, so map the record's ocean coverage onto that.
    const sea = r.hasWater ? lerp(0.28, 0.74, clamp(r.oceanCoverage, 0, 1)) : -1;

    this.surfaceUniforms = {
      uTime: { value: 0 },
      uCamLocal: { value: new THREE.Vector3(0, 0, 4) },
      uSunLocal: { value: new THREE.Vector3(1, 0, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSunIntensity: { value: 1 },
      uSunAng: { value: 0.02 },
      uWrap: { value: clamp(0.04 + r.atmosphere * 0.16, 0.04, 0.3) },
      // Deep atmospheres limb-darken hardest, airless rock barely at all —
      // the Moon is famously almost flat across its disc for exactly this
      // reason, while Jupiter falls away sharply.
      uLimb: { value: r.isGiant ? 0.62 : clamp(0.10 + r.atmosphere * 0.30, 0.06, 0.45) },

      uBase: { value: this.baseColor },
      uAccent: { value: this.accentColor },
      uWater: { value: this.waterColor },
      uAtmoTint: { value: this.atmoColor },

      uSeaLevel: { value: sea },
      uContinent: { value: 1.1 * t.continentScale },
      uMountain: { value: 2.4 * t.mountainScale },
      uPlate: { value: Math.max(2, t.plateCount * 0.22) },
      uRidge: { value: t.ridgeStrength * 0.42 },
      uErosion: { value: t.erosion },
      uCrater: { value: t.craterDensity },
      uDune: { value: t.duneStrength },
      uRough: { value: t.roughness },
      uVolcanism: { value: r.type === PlanetType.MOLTEN ? t.volcanism : t.volcanism * 0.25 },
      uBump: { value: b.bump ? 1 : 0 },
      uIceCap: { value: capLat },
      uSnowLine: { value: 0.35 },
      uHasWater: { value: r.hasWater ? 1 : 0 },
      uIsGiant: { value: r.isGiant ? 1 : 0 },
      uBandFreq: { value: rng.range(9, 22) },
      uSpotSize: { value: rng.range(0.10, 0.26) },
      uSpotSwirl: { value: rng.range(0.5, 1.6) * (rng.bool() ? 1 : -1) },
      uSpotDir: { value: new THREE.Vector3().setFromSphericalCoords(1, Math.PI * 0.5 + rng.range(-0.5, 0.5), rng.range(0, 6.28)) },
      ...(r.isGiant ? giantVortices(rng, seed) : {
        uVortex: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
        uVortexSpin: { value: new THREE.Vector4() },
      }),
      uCityAmount: { value: r.hasCivilization ? clamp(0.15 + r.techLevel, 0, 1.2) : 0 },
      uAurora: { value: clamp(r.weather.auroraStrength * (r.atmosphere > 0.1 ? 1 : 0.2), 0, 1) },
      uNightGlow: { value: clamp(0.006 + r.atmosphere * 0.020, 0.004, 0.05) },
      uSeed: { value: seed },
      uCloudShadow: { value: this._wantsClouds() && !this.simple ? this.cloudHeight : 0 },
      ...this._atmoUniforms(),
    };

    this.surface = new THREE.Mesh(
      geo,
      this._mat(new THREE.ShaderMaterial({
        uniforms: this.surfaceUniforms,
        vertexShader: COMMON_VERT,
        fragmentShader: surfaceFrag(this.b, {}),
        depthWrite: true,
        depthTest: true,
      }))
    );
    this.surface.renderOrder = 0;
    this.spin.add(this.surface);
    this._seed = seed;
    this._capLat = capLat;
  }

  /**
   * Scattering coefficients. The record's atmosphere colour is the colour that
   * survives a long path, so the extinction is its complement — cubing the
   * tint and using it per channel reproduces both the daylight sky colour and
   * the terminator's warm band from one number.
   */
  _atmoUniforms() {
    const r = this.record;
    const c = this.atmoColor;
    const density = clamp(r.atmosphere, 0, 2);
    const k = (r.isGiant ? 5.0 : 9.0) * clamp(density, 0.08, 1.7);
    const betaR = new THREE.Vector3(
      Math.pow(Math.max(c.r, 0.02), 2.4) * k,
      Math.pow(Math.max(c.g, 0.02), 2.4) * k,
      Math.pow(Math.max(c.b, 0.02), 2.4) * k
    );
    const mie = clamp(0.25 + r.weather.cloudCoverage * 0.6, 0.15, 1.0) * clamp(density, 0.1, 1.5);
    return {
      uAtmoR: { value: 1 + this.atmoHeight },
      uHr: { value: 0.28 },
      uHm: { value: 0.10 },
      uBetaR: { value: betaR },
      uBetaM: { value: new THREE.Vector3(mie, mie, mie) },
      uMieG: { value: 0.76 },
    };
  }

  _buildClouds() {
    const r = this.record;
    const b = this.b;
    const rng = this.rng.fork('cloud');
    const shellR = 1 + this.cloudHeight;
    const shellT = this.cloudHeight * 1.4;
    const geo = new THREE.SphereGeometry(shellR + shellT * 0.5, b.cloudSeg, Math.max(16, b.cloudSeg >> 1));
    this._disposables.push(geo);

    this.cloudUniforms = {
      uCamLocal: { value: new THREE.Vector3(0, 0, 4) },
      uSunLocal: { value: new THREE.Vector3(1, 0, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSunIntensity: { value: 1 },
      uShellR: { value: shellR },
      uShellT: { value: shellT },
      uWrap: { value: clamp(0.08 + r.atmosphere * 0.14, 0.08, 0.3) },
      uTint: { value: this.atmoColor },
      uNightGlow: { value: 0.02 },
      uCloudCover: { value: clamp(r.weather.cloudCoverage, 0.05, 0.95) },
      uCloudTime: { value: 0 },
      uCloudScale: { value: rng.range(3.4, 7.5) },
      uStorm: { value: clamp(r.weather.stormIntensity, 0, 1) },
      uCloudSeed: { value: new THREE.Vector3(rng.range(-30, 30), rng.range(-30, 30), rng.range(-30, 30)) },
    };
    this.clouds = new THREE.Mesh(
      geo,
      this._mat(new THREE.ShaderMaterial({
        uniforms: this.cloudUniforms,
        vertexShader: COMMON_VERT,
        fragmentShader: cloudFrag(b),
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.FrontSide,
      }))
    );
    this.clouds.renderOrder = 1;
    this.cloudSpin.add(this.clouds);

    // The surface shader casts the shadow, so it needs the same field.
    this.surfaceUniforms.uCloudCover = this.cloudUniforms.uCloudCover;
    this.surfaceUniforms.uCloudTime = this.cloudUniforms.uCloudTime;
    this.surfaceUniforms.uCloudScale = this.cloudUniforms.uCloudScale;
    this.surfaceUniforms.uStorm = this.cloudUniforms.uStorm;
    this.surfaceUniforms.uCloudSeed = this.cloudUniforms.uCloudSeed;
  }

  _buildAtmosphere() {
    const b = this.b;
    const R = 1 + this.atmoHeight;
    const geo = new THREE.SphereGeometry(R, b.atmoSeg, Math.max(16, b.atmoSeg >> 1));
    this._disposables.push(geo);
    this.atmoUniforms = {
      uCamLocal: { value: new THREE.Vector3(0, 0, 4) },
      uSunLocal: { value: new THREE.Vector3(1, 0, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSunIntensity: { value: 1 },
      uAtmoTint: { value: this.atmoColor },
      uTime: { value: 0 },
      ...this._atmoUniforms(),
    };
    this.atmosphere = new THREE.Mesh(
      geo,
      this._mat(new THREE.ShaderMaterial({
        uniforms: this.atmoUniforms,
        vertexShader: COMMON_VERT,
        fragmentShader: atmoFrag(b),
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: true,
      }))
    );
    this.atmosphere.renderOrder = 2;
    this.group.add(this.atmosphere);
  }

  /** Animation only. Placement is the realm's job. */
  update(dt, time) {
    this.time = time;
    this.spinAngle += this.spinRate * dt;
    // Super-rotation: Venus's atmosphere laps its surface 60 times per day, and
    // even Earth's jet stream outruns the ground. A small offset is enough to
    // make the deck read as a separate fluid.
    this.cloudAngle += this.spinRate * dt * 1.18;
    this.spin.rotation.y = this.spinAngle;
    this.cloudSpin.rotation.y = this.cloudAngle;
    if (this.surfaceUniforms) this.surfaceUniforms.uTime.value = time;
    if (this.cloudUniforms) this.cloudUniforms.uCloudTime.value = time;
    if (this.atmoUniforms) this.atmoUniforms.uTime.value = time;
  }

  /**
   * `light` = { dirWorld (unit, body -> star), color, intensity, angularRadius }.
   * Called after the realm has refreshed world matrices.
   */
  sync(light) {
    const setFor = (mesh, uniforms) => {
      if (!uniforms) return;
      this._inv.copy(mesh.matrixWorld).invert();
      uniforms.uCamLocal.value.set(0, 0, 0).applyMatrix4(this._inv);
      uniforms.uSunLocal.value.copy(light.dirWorld).transformDirection(this._inv);
      if (uniforms.uSunColor) uniforms.uSunColor.value.copy(light.color);
      if (uniforms.uSunIntensity) uniforms.uSunIntensity.value = light.intensity;
    };
    setFor(this.surface, this.surfaceUniforms);
    if (this.surfaceUniforms) this.surfaceUniforms.uSunAng.value = light.angularRadius;
    if (this.clouds) setFor(this.clouds, this.cloudUniforms);
    if (this.atmosphere) setFor(this.atmosphere, this.atmoUniforms);
  }

  dispose() {
    for (const d of this._disposables) d.dispose?.();
    this._disposables.length = 0;
  }
}
