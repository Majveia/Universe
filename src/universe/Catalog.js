/**
 * The catalog: deterministic generation of everything that exists.
 *
 * Nothing is stored. A galaxy, a star, a planet, the name of a moon and the
 * layout of the city on it are all pure functions of an integer seed. Visit the
 * same coordinates a year apart and you get the same world, byte for byte,
 * without a single kilobyte of save data.
 *
 * Physical values are real and in SI where it matters (masses in kg, radii in
 * m, temperatures in K, luminosities in W), then mapped to render units by the
 * realm that draws them. Keeping the physics honest is what makes the derived
 * quantities — habitable zone, surface gravity, escape velocity, atmospheric
 * scale height, tidal locking — fall out correctly instead of being hand-tuned.
 */

import { Rng, hashString, hash3, hashInt } from '../core/Rng.js';
import { clamp, lerp, smoothstep } from '../core/Noise.js';

// --- physical constants ------------------------------------------------------
export const G = 6.6743e-11;            // m^3 kg^-1 s^-2
export const AU = 1.495978707e11;       // m
export const LY = 9.4607e15;            // m
export const PC = 3.0857e16;            // m
export const SOLAR_MASS = 1.98892e30;   // kg
export const SOLAR_RADIUS = 6.957e8;    // m
export const SOLAR_LUM = 3.828e26;      // W
export const EARTH_MASS = 5.9722e24;    // kg
export const EARTH_RADIUS = 6.371e6;    // m
export const SIGMA_SB = 5.670374419e-8; // W m^-2 K^-4

// --- stellar taxonomy --------------------------------------------------------
// Weights approximate the real initial mass function: the galaxy is
// overwhelmingly red dwarfs, and that is exactly what makes an O-type feel rare.
export const STAR_CLASSES = [
  { c: 'M', w: 0.7645, tMin: 2400, tMax: 3700, mMin: 0.08, mMax: 0.45 },
  { c: 'K', w: 0.121, tMin: 3700, tMax: 5200, mMin: 0.45, mMax: 0.8 },
  { c: 'G', w: 0.076, tMin: 5200, tMax: 6000, mMin: 0.8, mMax: 1.04 },
  { c: 'F', w: 0.03, tMin: 6000, tMax: 7500, mMin: 1.04, mMax: 1.4 },
  { c: 'A', w: 0.006, tMin: 7500, tMax: 10000, mMin: 1.4, mMax: 2.1 },
  { c: 'B', w: 0.0013, tMin: 10000, tMax: 30000, mMin: 2.1, mMax: 16 },
  { c: 'O', w: 0.0000003, tMin: 30000, tMax: 52000, mMin: 16, mMax: 90 },
];

export const EXOTIC = [
  { c: 'WD', w: 0.05, label: 'White Dwarf' },
  { c: 'NS', w: 0.012, label: 'Neutron Star' },
  { c: 'PSR', w: 0.004, label: 'Pulsar' },
  { c: 'BH', w: 0.0025, label: 'Black Hole' },
  { c: 'RG', w: 0.03, label: 'Red Giant' },
  { c: 'BIN', w: 0.28, label: 'Binary' },
];

export const PlanetType = {
  MOLTEN: 'molten',
  BARREN: 'barren',
  DESERT: 'desert',
  TEMPERATE: 'temperate',
  JUNGLE: 'jungle',
  OCEAN: 'ocean',
  FROZEN: 'frozen',
  TOXIC: 'toxic',
  IRRADIATED: 'irradiated',
  GASGIANT: 'gasgiant',
  ICEGIANT: 'icegiant',
  EXOTIC: 'exotic',
  RINGWORLD: 'ringworld',
};

// --- naming ------------------------------------------------------------------
// A three-layer name generator: catalogue designations for the mundane,
// phonotactically-constrained invented words for the notable, and a small set
// of evocative epithets for the rare. Names carry information — you learn to
// read "Kepler-" as ordinary and a two-word name as worth the fuel.

const SYL_A = ['ka', 've', 'thi', 'ora', 'sy', 'mel', 'ny', 'zar', 'lu', 'ae', 'ir', 'oph', 'ta', 'val', 'cy', 'dra', 'el', 'is', 'no', 'pha', 'qui', 'rho', 'se', 'ti', 'um', 'vel', 'xa', 'yn', 'zo', 'bel', 'cor', 'den'];
const SYL_B = ['ran', 'dis', 'mar', 'lyn', 'ques', 'thys', 'vane', 'dor', 'mira', 'sette', 'lios', 'reth', 'anth', 'ovar', 'ynne', 'aris', 'esse', 'urne', 'ixis', 'olan', 'ymir', 'aeon', 'ustra', 'ithe'];
const SYL_C = ['', '', '', 'a', 'is', 'or', 'ae', 'un', 'eth', 'ix', 'os', 'ai', 'ur'];
const EPITHETS = ['the Long Silence', 'the Weeping Glass', 'the Ninth Recursion', 'the Slow Dawn', 'the Amber Verdict', 'the Drowned Choir', 'the Patient Engine', 'the Last Cartographer', 'the Hollow Bloom', 'the Kindly Dark', 'the Salt Meridian', 'the Unfinished Argument', 'the Bright Fever', 'the Quiet Census', 'the Folded Hour'];
const GREEK = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron', 'Pi', 'Rho', 'Sigma', 'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega'];
const CATALOGS = ['HD', 'HIP', 'GJ', 'TYC', 'KOI', 'WASP', 'TRAPPIST', 'LHS', 'WISE', 'PSR'];

export function makeName(rng, kind = 'star') {
  const roll = rng.next();
  if (kind === 'star') {
    if (roll < 0.42) {
      return `${rng.pick(CATALOGS)}-${rng.int(100, 99999)}`;
    }
    if (roll < 0.62) {
      return `${rng.pick(GREEK)} ${cap(word(rng))}`;
    }
    if (roll < 0.97) return cap(word(rng));
    return `${cap(word(rng))}, ${rng.pick(EPITHETS)}`;
  }
  if (kind === 'planet') {
    if (roll < 0.3) return cap(word(rng));
    if (roll < 0.55) return `${cap(word(rng))} ${rng.pick(['Prime', 'Secundus', 'Tertius', 'Minor', 'Major', 'Reach', 'Rest', 'Gate', 'Anchorage', 'Verge'])}`;
    if (roll < 0.72) return `${cap(word(rng))}-${rng.int(2, 99)}`;
    if (roll < 0.94) return cap(word(rng)) + cap(SYL_C[rng.int(0, SYL_C.length - 1)] || '');
    return `${cap(word(rng))}, ${rng.pick(EPITHETS)}`;
  }
  return cap(word(rng));
}

function word(rng) {
  let s = rng.pick(SYL_A) + rng.pick(SYL_B);
  if (rng.bool(0.35)) s += rng.pick(SYL_C);
  return s;
}
function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --- stars -------------------------------------------------------------------

/**
 * Full stellar record from a seed. Mass drives everything else through
 * main-sequence relations, so the population is internally consistent:
 * bright stars are massive, massive stars are short-lived and rare, and
 * habitable zones scale with the square root of luminosity.
 */
export function makeStar(seed) {
  const rng = new Rng(seed);
  const rSel = rng.next();

  let exotic = null;
  let acc = 0;
  const exoticRoll = rng.next();
  for (const e of EXOTIC) {
    acc += e.w;
    if (exoticRoll < acc * 0.16) { exotic = e; break; }
  }

  const cls = rng.weighted(STAR_CLASSES, STAR_CLASSES.map((s) => s.w));
  let massSolar = lerp(cls.mMin, cls.mMax, Math.pow(rng.next(), 1.8));
  let temp = lerp(cls.tMin, cls.tMax, rng.next());
  let radiusSolar = Math.pow(massSolar, massSolar < 1 ? 0.8 : 0.57);
  let label = `${cls.c}${Math.floor((1 - (temp - cls.tMin) / (cls.tMax - cls.tMin)) * 9)}V`;
  let kind = 'main';

  if (exotic) {
    kind = exotic.c;
    switch (exotic.c) {
      case 'WD':
        massSolar = rng.range(0.5, 1.2); radiusSolar = rng.range(0.008, 0.02);
        temp = rng.range(8000, 40000); label = 'DA'; break;
      case 'NS':
        massSolar = rng.range(1.3, 2.1); radiusSolar = 1.6e-5;
        temp = rng.range(500000, 1000000); label = 'Neutron Star'; break;
      case 'PSR':
        massSolar = rng.range(1.3, 2.1); radiusSolar = 1.6e-5;
        temp = rng.range(500000, 1200000); label = 'Pulsar'; break;
      case 'BH':
        massSolar = rng.range(4, 30); radiusSolar = 0;
        temp = 0; label = 'Black Hole'; break;
      case 'RG':
        massSolar = rng.range(0.8, 8); radiusSolar = rng.range(20, 180);
        temp = rng.range(3000, 4800); label = 'Red Giant'; break;
      case 'BIN':
        kind = 'binary'; label = `${cls.c} + ${rng.pick(STAR_CLASSES).c} binary`; break;
    }
  }

  const mass = massSolar * SOLAR_MASS;
  const radius = radiusSolar * SOLAR_RADIUS;
  // Stefan-Boltzmann. For a black hole this is zero, which is correct.
  const luminosity = radius > 0 ? 4 * Math.PI * radius * radius * SIGMA_SB * Math.pow(temp, 4) : 0;
  const lumSolar = luminosity / SOLAR_LUM;
  // Kasting habitable zone, scaled by sqrt(L).
  const hzInner = Math.sqrt(lumSolar / 1.1) * AU;
  const hzOuter = Math.sqrt(lumSolar / 0.53) * AU;

  return {
    seed,
    kind,
    class: cls.c,
    label,
    name: makeName(rng.fork('name'), 'star'),
    mass, massSolar,
    radius, radiusSolar,
    temp,
    luminosity, lumSolar,
    hzInner, hzOuter,
    age: rng.range(0.2, 12.5),                  // Gyr
    metallicity: rng.normal(0, 0.25),           // [Fe/H]
    rotationPeriod: rng.range(4, 45) * 86400,   // s
    flareActivity: cls.c === 'M' ? rng.range(0.2, 1) : rng.range(0, 0.3),
    isExotic: !!exotic && exotic.c !== 'BIN',
    _rSel: rSel,
  };
}

// --- planets -----------------------------------------------------------------

/**
 * Classifies a body from where it formed and how much stellar flux it gets.
 * The frost line (where water ice can condense) is the single most important
 * boundary in a real protoplanetary disc, so it is the one used here: rocky
 * inside, giants just outside, ice out beyond.
 */
function classify(rng, fluxRelEarth, massEarth, frostRatio) {
  if (massEarth > 40) return frostRatio > 1.8 ? PlanetType.ICEGIANT : PlanetType.GASGIANT;
  if (massEarth > 9) return rng.bool(0.6) ? PlanetType.ICEGIANT : PlanetType.GASGIANT;
  if (fluxRelEarth > 8) return PlanetType.MOLTEN;
  if (fluxRelEarth > 2.2) return rng.bool(0.55) ? PlanetType.DESERT : PlanetType.BARREN;
  if (fluxRelEarth > 0.32) {
    const r = rng.next();
    if (r < 0.2) return PlanetType.OCEAN;
    if (r < 0.46) return PlanetType.TEMPERATE;
    if (r < 0.62) return PlanetType.JUNGLE;
    if (r < 0.74) return PlanetType.DESERT;
    if (r < 0.84) return PlanetType.TOXIC;
    if (r < 0.9) return PlanetType.IRRADIATED;
    if (r < 0.96) return PlanetType.BARREN;
    return PlanetType.EXOTIC;
  }
  if (fluxRelEarth > 0.05) return rng.bool(0.7) ? PlanetType.FROZEN : PlanetType.BARREN;
  return PlanetType.FROZEN;
}

const TYPE_PALETTE = {
  [PlanetType.MOLTEN]: { base: [0.30, 0.07, 0.03], accent: [1.0, 0.42, 0.10], atmo: [1.0, 0.45, 0.22], water: null },
  [PlanetType.BARREN]: { base: [0.42, 0.40, 0.37], accent: [0.62, 0.58, 0.52], atmo: [0.6, 0.62, 0.66], water: null },
  [PlanetType.DESERT]: { base: [0.66, 0.44, 0.24], accent: [0.86, 0.68, 0.40], atmo: [0.86, 0.62, 0.38], water: [0.10, 0.24, 0.30] },
  [PlanetType.TEMPERATE]: { base: [0.24, 0.36, 0.18], accent: [0.52, 0.56, 0.34], atmo: [0.36, 0.58, 1.0], water: [0.02, 0.10, 0.22] },
  [PlanetType.JUNGLE]: { base: [0.10, 0.30, 0.12], accent: [0.42, 0.62, 0.22], atmo: [0.42, 0.70, 0.86], water: [0.03, 0.16, 0.20] },
  [PlanetType.OCEAN]: { base: [0.06, 0.20, 0.32], accent: [0.30, 0.52, 0.56], atmo: [0.34, 0.60, 1.0], water: [0.01, 0.07, 0.18] },
  [PlanetType.FROZEN]: { base: [0.72, 0.80, 0.88], accent: [0.90, 0.95, 1.0], atmo: [0.62, 0.78, 1.0], water: [0.14, 0.30, 0.44] },
  [PlanetType.TOXIC]: { base: [0.36, 0.38, 0.14], accent: [0.72, 0.78, 0.26], atmo: [0.72, 0.86, 0.30], water: [0.24, 0.30, 0.08] },
  [PlanetType.IRRADIATED]: { base: [0.32, 0.20, 0.34], accent: [0.78, 0.34, 0.86], atmo: [0.66, 0.32, 0.90], water: [0.20, 0.06, 0.26] },
  // Giants live or die on the spread between `base` and `accent`, because the
  // band shader mixes between them. Jupiter's belts are red-brown and its
  // zones are near-white ammonia cloud; two shades of the same tan renders a
  // monochrome ball with stripes on it. The gap here is deliberately wide.
  [PlanetType.GASGIANT]: { base: [0.52, 0.26, 0.14], accent: [0.94, 0.88, 0.74], atmo: [0.92, 0.80, 0.62], water: null },
  [PlanetType.ICEGIANT]: { base: [0.13, 0.34, 0.56], accent: [0.66, 0.90, 0.94], atmo: [0.40, 0.70, 0.95], water: null },
  [PlanetType.EXOTIC]: { base: [0.16, 0.10, 0.26], accent: [0.90, 0.28, 0.62], atmo: [0.70, 0.24, 0.90], water: [0.30, 0.02, 0.36] },
  [PlanetType.RINGWORLD]: { base: [0.30, 0.32, 0.36], accent: [0.80, 0.84, 0.90], atmo: [0.50, 0.70, 1.0], water: [0.02, 0.12, 0.24] },
};

export function makePlanet(star, index, seed, orbitRadius) {
  const rng = new Rng(seed);
  const frostLine = 2.7 * Math.sqrt(star.lumSolar || 0.001) * AU;
  const frostRatio = orbitRadius / Math.max(frostLine, 1);

  // Mass distribution: log-uniform, biased small (super-Earths dominate real surveys).
  const massEarth = Math.pow(10, lerp(-1.3, 3.0, Math.pow(rng.next(), 1.55)));
  const flux = star.luminosity / (4 * Math.PI * orbitRadius * orbitRadius) / 1361; // relative to Earth
  const type = classify(rng, flux, massEarth, frostRatio);

  const isGiant = type === PlanetType.GASGIANT || type === PlanetType.ICEGIANT;
  // Mass-radius relations differ sharply either side of the rocky/gas divide.
  const radiusEarth = isGiant
    ? clamp(Math.pow(massEarth, 0.16) * 3.6, 3.5, 13.5)
    : clamp(Math.pow(massEarth, 0.27), 0.3, 2.4);

  const mass = massEarth * EARTH_MASS;
  const radius = radiusEarth * EARTH_RADIUS;
  const gravity = (G * mass) / (radius * radius);
  const escapeVelocity = Math.sqrt((2 * G * mass) / radius);

  const albedo = {
    [PlanetType.MOLTEN]: 0.08, [PlanetType.BARREN]: 0.13, [PlanetType.DESERT]: 0.30,
    [PlanetType.TEMPERATE]: 0.29, [PlanetType.JUNGLE]: 0.22, [PlanetType.OCEAN]: 0.16,
    [PlanetType.FROZEN]: 0.62, [PlanetType.TOXIC]: 0.36, [PlanetType.IRRADIATED]: 0.24,
    [PlanetType.GASGIANT]: 0.34, [PlanetType.ICEGIANT]: 0.30, [PlanetType.EXOTIC]: 0.20,
    [PlanetType.RINGWORLD]: 0.28,
  }[type];

  // Equilibrium temperature, then a greenhouse offset scaled by atmosphere.
  const tEq = star.luminosity > 0
    ? Math.pow((star.luminosity * (1 - albedo)) / (16 * Math.PI * SIGMA_SB * orbitRadius * orbitRadius), 0.25)
    : 4;

  let atmosphere = 0;
  if (isGiant) atmosphere = 1;
  else if (type === PlanetType.BARREN || type === PlanetType.MOLTEN) atmosphere = rng.range(0, 0.18);
  else if (type === PlanetType.TOXIC) atmosphere = rng.range(0.7, 1.6);
  else atmosphere = rng.range(0.25, 1.15);
  // A low-gravity body cannot hold a thick envelope. Scale by escape velocity.
  atmosphere *= clamp(escapeVelocity / 11200, 0.05, 1.6);

  const greenhouse = atmosphere * (type === PlanetType.TOXIC ? 260 : 55);
  const surfaceTemp = tEq + greenhouse;

  const rotationPeriod = rng.range(6, 90) * 3600 * (isGiant ? 0.25 : 1);
  // Tidal locking timescale, crudely: close-in low-mass worlds lock.
  const tidallyLocked = orbitRadius < 0.15 * AU && star.massSolar < 0.7 && rng.bool(0.8);

  const hasWater = surfaceTemp > 250 && surfaceTemp < 380 && atmosphere > 0.15 && !isGiant;
  const oceanCoverage = hasWater
    ? clamp(type === PlanetType.OCEAN ? rng.range(0.82, 0.98)
      : type === PlanetType.DESERT ? rng.range(0.0, 0.14)
      : rng.range(0.25, 0.72), 0, 1)
    : (type === PlanetType.MOLTEN ? rng.range(0.1, 0.5) : 0);

  // Habitability drives whether life and civilisation appear at all.
  const habitability = clamp(
    smoothstep(180, 275, surfaceTemp) * (1 - smoothstep(315, 360, surfaceTemp)) *
    smoothstep(0.1, 0.5, atmosphere) *
    (1 - smoothstep(1.4, 2.6, gravity / 9.81)) *
    (isGiant ? 0 : 1) *
    (type === PlanetType.IRRADIATED ? 0.15 : 1) *
    (type === PlanetType.TOXIC ? 0.25 : 1),
    0, 1
  );

  const lifeRoll = rng.next();
  const hasLife = lifeRoll < habitability * 0.85 + 0.02;
  const lifeComplexity = hasLife ? clamp(habitability * rng.range(0.4, 1.25), 0, 1) : 0;
  const hasCivilization = hasLife && lifeComplexity > 0.55 && rng.bool(0.55);
  const techLevel = hasCivilization ? clamp(rng.range(0.2, 1.0) * (0.5 + lifeComplexity * 0.7), 0, 1) : 0;

  const axialTilt = Math.abs(rng.normal(0, 0.42)); // radians, most worlds modest
  const eccentricity = clamp(Math.abs(rng.normal(0, 0.09)), 0, 0.6);
  const inclination = rng.normal(0, 0.035);

  const hasRings = isGiant ? rng.bool(0.55) : rng.bool(0.06);
  const moonCount = isGiant ? rng.int(2, 14) : rng.int(0, 3);

  const pal = TYPE_PALETTE[type];

  return {
    seed, index, type,
    name: makeName(rng.fork('pname'), 'planet'),
    designation: `${star.name} ${romanize(index + 1)}`,
    orbitRadius,
    orbitRadiusAU: orbitRadius / AU,
    period: 2 * Math.PI * Math.sqrt(Math.pow(orbitRadius, 3) / (G * star.mass)),
    eccentricity, inclination,
    argPeriapsis: rng.range(0, Math.PI * 2),
    meanAnomaly0: rng.range(0, Math.PI * 2),
    mass, massEarth, radius, radiusEarth,
    gravity, escapeVelocity,
    albedo, tEq, surfaceTemp, atmosphere, greenhouse,
    rotationPeriod, tidallyLocked, axialTilt,
    oceanCoverage, hasWater,
    habitability, hasLife, lifeComplexity, hasCivilization, techLevel,
    hasRings, moonCount,
    isGiant,
    flux,
    palette: pal,
    // Surface-generation parameters, consumed by the terrain system.
    terrain: {
      seed: hashInt(seed ^ 0x5f3759df),
      continentScale: rng.range(0.6, 2.2),
      mountainScale: rng.range(1.0, 4.0),
      ridgeStrength: rng.range(0.25, 1.0),
      erosion: rng.range(0.2, 0.9),
      craterDensity: atmosphere < 0.2 ? rng.range(0.4, 1.0) : rng.range(0.0, 0.25),
      duneStrength: type === PlanetType.DESERT ? rng.range(0.5, 1.0) : rng.range(0, 0.2),
      volcanism: type === PlanetType.MOLTEN ? rng.range(0.7, 1) : rng.range(0, 0.4),
      seaLevel: oceanCoverage,
      maxElevation: lerp(1200, 14000, rng.next()) * clamp(1.4 - gravity / 9.81 * 0.4, 0.4, 1.6),
      plateCount: rng.int(6, 22),
      // Fractal dimension of the coastline; low = smooth ice, high = fjords.
      roughness: rng.range(0.35, 0.85),
    },
    weather: {
      windSpeed: rng.range(2, 40) * (isGiant ? 6 : 1),
      cloudCoverage: hasWater ? rng.range(0.2, 0.85) : rng.range(0, 0.3),
      stormIntensity: rng.range(0, 1),
      auroraStrength: rng.range(0, 1) * clamp(1 - Math.abs(axialTilt), 0.2, 1),
      hasDustStorms: type === PlanetType.DESERT || type === PlanetType.BARREN,
      precipitation: hasWater ? rng.range(0.1, 1) : 0,
    },
    resources: {
      ferrite: rng.next(), silicate: rng.next(), carbon: rng.next(),
      exotic: Math.pow(rng.next(), 3), organic: hasLife ? rng.next() : 0,
    },
  };
}

function romanize(n) {
  const map = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out || 'I';
}

/**
 * Builds a full system from a star. Orbits follow a perturbed Titius-Bode
 * progression, which is what real discs approximate — geometric spacing with
 * gaps where resonances cleared material.
 */
export function makeSystem(star) {
  const rng = new Rng(hashInt(star.seed ^ 0xa5a5a5));
  const planets = [];
  if (star.kind === 'BH') {
    // Black holes keep a disc and a few scorched survivors.
    const n = rng.int(0, 3);
    let a = rng.range(4, 20) * AU;
    for (let i = 0; i < n; i++) {
      planets.push(makePlanet(star, i, hash3(star.seed, i, 71), a));
      a *= rng.range(1.6, 2.4);
    }
  } else {
    const count = clamp(Math.round(rng.normal(5.2, 2.4)), 1, 12);
    let a = rng.range(0.05, 0.45) * AU * Math.max(0.3, Math.sqrt(star.lumSolar || 0.02));
    for (let i = 0; i < count; i++) {
      planets.push(makePlanet(star, i, hash3(star.seed, i, 17), a));
      a *= rng.range(1.42, 2.15);
      if (a > 240 * AU) break;
    }
  }

  const belts = [];
  const beltCount = rng.int(0, 2);
  for (let i = 0; i < beltCount; i++) {
    const inner = rng.range(1.4, 40) * AU;
    belts.push({
      inner,
      outer: inner * rng.range(1.15, 1.8),
      density: rng.range(0.3, 1),
      seed: hash3(star.seed, i, 991),
      tilt: rng.normal(0, 0.06),
    });
  }

  const comets = rng.int(0, 5);

  return {
    star,
    planets,
    belts,
    comets,
    oortRadius: rng.range(2000, 100000) * AU,
    hasNebula: rng.bool(0.12),
    seed: star.seed,
  };
}

/**
 * Star at an integer lattice cell. Cells are jittered so the sky does not
 * betray a grid, and density falls off with galactic radius and |z| the way a
 * real disc does.
 */
export function starAtCell(cx, cy, cz, cellSize, galaxySeed = 0) {
  const h = hash3(cx ^ galaxySeed, cy, cz);
  const rng = new Rng(h);
  // Disc profile: exponential in R, sech^2 in z.
  const R = Math.hypot(cx, cz) * cellSize;
  const z = cy * cellSize;
  const scaleLength = 3.5;
  const scaleHeight = 0.35;
  const density = Math.exp(-R / scaleLength) / Math.pow(Math.cosh(z / scaleHeight), 2);
  if (rng.next() > clamp(density * 1.6, 0.01, 0.95)) return null;

  const star = makeStar(h);
  star.cell = { x: cx, y: cy, z: cz };
  star.position = {
    x: (cx + rng.range(-0.45, 0.45)) * cellSize,
    y: (cy + rng.range(-0.45, 0.45)) * cellSize,
    z: (cz + rng.range(-0.45, 0.45)) * cellSize,
  };
  return star;
}

/** Solves Kepler's equation. Newton-Raphson; 6 iterations is plenty for e<0.6. */
export function solveKepler(M, e) {
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 6; i++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-10) break;
  }
  return E;
}

/** Position on an ellipse at time t (seconds), in the orbital plane frame. */
export function orbitalPosition(planet, t, out = { x: 0, y: 0, z: 0 }) {
  const n = (2 * Math.PI) / planet.period;
  const M = planet.meanAnomaly0 + n * t;
  const e = planet.eccentricity;
  const E = solveKepler(M % (Math.PI * 2), e);
  const a = planet.orbitRadius;
  const xv = a * (Math.cos(E) - e);
  const zv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const w = planet.argPeriapsis;
  const cw = Math.cos(w), sw = Math.sin(w);
  const x = xv * cw - zv * sw;
  const z = xv * sw + zv * cw;
  const i = planet.inclination;
  out.x = x;
  out.y = z * Math.sin(i);
  out.z = z * Math.cos(i);
  return out;
}

export { hashString, hash3, hashInt };
