/**
 * Biomes: turning four scalars into a world you can name.
 *
 * A biome system that assigns "grassland" or "tundra" from a lookup table reads
 * as a lookup table. What actually convinces the eye is the *cause*: grass grows
 * where it is warm enough and wet enough and the slope is shallow enough to hold
 * soil; snow sits where the air is below freezing and the face is not so steep
 * that it sloughs off; sand collects in basins downwind of nothing. So this file
 * computes temperature, moisture and slope from physics, and lets the material
 * fall out.
 *
 * Temperature uses a real lapse rate. Air cools as it rises because it expands
 * against falling pressure, at Γ = g/c_p — about 9.8 K/km dry, ~6.5 K/km once
 * latent heat from condensing water is returned to the parcel. Scaling Γ by the
 * planet's own gravity is why a heavy world has its snow line crushed down near
 * sea level and a light one keeps green valleys three kilometres up. Latitude
 * contributes a cos-of-declination term; the axial tilt shifts it with season.
 *
 * The output is four *splat weights*, not a biome index. Indices produce hard
 * edges; weights let the shader interlock materials by height so a rock/grass
 * boundary looks like scree fingering into turf rather than a stencil cut. The
 * four channels are fixed roles — cliff, ground, accent, cap — and each planet
 * type fills those roles with wildly different matter. That is what makes a
 * toxic world and a temperate one share one shader and share no visual DNA.
 */

import { clamp, lerp, saturate, smoothstep } from '../core/Noise.js';
import { PlanetType } from '../universe/Catalog.js';
import { Rng } from '../core/Rng.js';

/** Surface descriptors handed to the locomotion motor. Friction is felt, not decorative. */
export const SURFACES = {
  rock: { material: 'rock', friction: 1.05, dust: 0.25, colour: 0x76736e },
  regolith: { material: 'regolith', friction: 1.0, dust: 0.7, colour: 0x9a8f7e },
  sand: { material: 'sand', friction: 0.86, dust: 1.0, colour: 0xc2a878 },
  grass: { material: 'grass', friction: 0.98, dust: 0.35, colour: 0x63805a },
  snow: { material: 'snow', friction: 0.72, dust: 0.9, colour: 0xe8f0f6 },
  ice: { material: 'ice', friction: 0.16, dust: 0.1, colour: 0xbfe3ef },
  ash: { material: 'ash', friction: 0.8, dust: 1.0, colour: 0x3a3632 },
  mud: { material: 'mud', friction: 0.9, dust: 0.15, colour: 0x54452f },
  crystal: { material: 'crystal', friction: 1.0, dust: 0.05, colour: 0x8fd6e0 },
  salt: { material: 'salt', friction: 0.94, dust: 0.6, colour: 0xd8d2c4 },
};

/**
 * Layer roles, in the order the shader expects them:
 *   0 CLIFF  — what is exposed where gravity strips everything loose away
 *   1 GROUND — the dominant flat-lying material of the world
 *   2 ACCENT — the second lowland material, selected by moisture/heat
 *   3 CAP    — what accumulates where it is cold or high
 */
export const Layer = { CLIFF: 0, GROUND: 1, ACCENT: 2, CAP: 3 };

/**
 * `color` is linear-light, not sRGB — these feed a physically-composited shader
 * and go through AgX at the end of the chain, so picking them in gamma space
 * would wash every world out. `macro`/`micro` are detail wavelengths in metres.
 * `emissive` is HDR: values above 1 are intentional and bloom.
 */
function L(color, rough, macro, micro, bump, sparkle, emissive) {
  return {
    color, rough, macro, micro, bump,
    sparkle: sparkle || 0,
    emissive: emissive || [0, 0, 0],
  };
}

const SETS = {
  [PlanetType.TEMPERATE]: {
    layers: [
      L([0.088, 0.082, 0.076], 0.90, 14, 0.9, 1.10, 0.02),   // weathered granite
      L([0.052, 0.086, 0.032], 0.86, 9, 0.55, 0.65, 0.0),    // meadow turf
      L([0.115, 0.094, 0.058], 0.92, 11, 0.7, 0.80, 0.0),    // dry soil / duff
      L([0.640, 0.700, 0.780], 0.42, 18, 1.4, 0.55, 0.30),   // snow
    ],
    surfaces: [SURFACES.rock, SURFACES.grass, SURFACES.regolith, SURFACES.snow],
    beach: SURFACES.sand,
    beachColor: [0.180, 0.152, 0.110],
    capFreeze: 273, tempSpan: 46, moistBias: 0.06, vegetated: true,
  },
  [PlanetType.JUNGLE]: {
    layers: [
      L([0.052, 0.055, 0.048], 0.80, 12, 0.8, 1.25, 0.04),   // wet basalt
      L([0.030, 0.078, 0.024], 0.78, 7, 0.45, 0.75, 0.0),    // canopy floor
      L([0.126, 0.062, 0.036], 0.88, 9, 0.6, 0.85, 0.0),     // red laterite
      L([0.190, 0.230, 0.180], 0.70, 16, 1.1, 0.60, 0.05),   // cloud-forest moss
    ],
    surfaces: [SURFACES.rock, SURFACES.grass, SURFACES.mud, SURFACES.grass],
    beach: SURFACES.sand,
    beachColor: [0.150, 0.135, 0.100],
    capFreeze: 268, tempSpan: 28, moistBias: 0.34, vegetated: true,
  },
  [PlanetType.OCEAN]: {
    layers: [
      L([0.060, 0.062, 0.066], 0.85, 13, 0.8, 1.15, 0.03),   // sea-cliff basalt
      L([0.230, 0.205, 0.160], 0.88, 8, 0.5, 0.55, 0.06),    // coral sand
      L([0.048, 0.082, 0.058], 0.82, 10, 0.6, 0.70, 0.0),    // salt scrub
      L([0.600, 0.660, 0.740], 0.45, 18, 1.4, 0.55, 0.28),   // snow
    ],
    surfaces: [SURFACES.rock, SURFACES.sand, SURFACES.grass, SURFACES.snow],
    beach: SURFACES.sand,
    beachColor: [0.245, 0.220, 0.170],
    capFreeze: 272, tempSpan: 34, moistBias: 0.40, vegetated: true,
  },
  [PlanetType.DESERT]: {
    layers: [
      L([0.148, 0.098, 0.058], 0.92, 15, 1.0, 1.20, 0.02),   // sandstone
      L([0.290, 0.205, 0.116], 0.94, 7, 0.35, 0.40, 0.10),   // dune sand
      L([0.098, 0.074, 0.056], 0.95, 12, 0.8, 0.90, 0.01),   // desert pavement
      L([0.480, 0.455, 0.400], 0.70, 20, 1.2, 0.45, 0.12),   // caliche / salt crust
    ],
    surfaces: [SURFACES.rock, SURFACES.sand, SURFACES.regolith, SURFACES.salt],
    beach: SURFACES.sand,
    beachColor: [0.300, 0.230, 0.140],
    capFreeze: 258, tempSpan: 52, moistBias: -0.38, vegetated: true,
  },
  [PlanetType.FROZEN]: {
    layers: [
      L([0.070, 0.076, 0.086], 0.88, 14, 0.9, 1.25, 0.03),   // dark slate
      L([0.560, 0.620, 0.700], 0.38, 16, 1.2, 0.50, 0.40),   // firn snow
      L([0.220, 0.330, 0.400], 0.24, 22, 1.6, 0.35, 0.55),   // glacial blue ice
      L([0.780, 0.840, 0.920], 0.30, 20, 1.5, 0.45, 0.55),   // fresh snow
    ],
    surfaces: [SURFACES.rock, SURFACES.snow, SURFACES.ice, SURFACES.snow],
    beach: SURFACES.ice,
    beachColor: [0.400, 0.470, 0.540],
    capFreeze: 240, tempSpan: 40, moistBias: 0.10, vegetated: false,
  },
  [PlanetType.BARREN]: {
    layers: [
      L([0.086, 0.082, 0.076], 0.94, 16, 1.0, 1.20, 0.02),   // fractured bedrock
      L([0.128, 0.120, 0.108], 0.96, 8, 0.4, 0.55, 0.03),    // regolith
      L([0.062, 0.058, 0.054], 0.96, 12, 0.7, 0.80, 0.02),   // mare basalt
      L([0.200, 0.196, 0.188], 0.90, 20, 1.3, 0.50, 0.06),   // highland anorthosite
    ],
    surfaces: [SURFACES.rock, SURFACES.regolith, SURFACES.rock, SURFACES.regolith],
    beach: SURFACES.regolith,
    beachColor: [0.120, 0.114, 0.104],
    capFreeze: 150, tempSpan: 90, moistBias: -0.9, vegetated: false,
  },
  [PlanetType.MOLTEN]: {
    layers: [
      L([0.030, 0.026, 0.024], 0.70, 12, 0.7, 1.35, 0.05),   // obsidian
      L([0.052, 0.042, 0.038], 0.92, 9, 0.5, 0.70, 0.02),    // ash plain
      L([0.140, 0.052, 0.020], 0.55, 6, 0.4, 0.90, 0.04, [3.4, 0.62, 0.10]), // lava
      L([0.086, 0.070, 0.062], 0.86, 18, 1.1, 0.60, 0.02),   // cooled crust
    ],
    surfaces: [SURFACES.rock, SURFACES.ash, SURFACES.rock, SURFACES.rock],
    beach: SURFACES.ash,
    beachColor: [0.060, 0.048, 0.042],
    capFreeze: 0, tempSpan: 60, moistBias: -1.0, vegetated: false,
  },
  [PlanetType.TOXIC]: {
    layers: [
      L([0.096, 0.092, 0.040], 0.90, 13, 0.9, 1.15, 0.03),   // sulfur-stained rock
      L([0.150, 0.160, 0.048], 0.88, 8, 0.5, 0.60, 0.05),    // sulfur flats
      L([0.062, 0.086, 0.030], 0.82, 10, 0.6, 0.75, 0.0),    // slime mat
      L([0.320, 0.330, 0.180], 0.60, 18, 1.2, 0.50, 0.30, [0.10, 0.14, 0.02]), // crystalline sulfur
    ],
    surfaces: [SURFACES.rock, SURFACES.regolith, SURFACES.mud, SURFACES.salt],
    beach: SURFACES.mud,
    beachColor: [0.110, 0.115, 0.050],
    capFreeze: 200, tempSpan: 36, moistBias: 0.16, vegetated: true,
  },
  [PlanetType.IRRADIATED]: {
    layers: [
      L([0.078, 0.056, 0.090], 0.86, 13, 0.9, 1.25, 0.06),   // violet mineral
      L([0.130, 0.086, 0.140], 0.90, 8, 0.5, 0.60, 0.08),    // magenta dust
      L([0.028, 0.024, 0.036], 0.72, 11, 0.7, 0.95, 0.10),   // fused black glass
      L([0.320, 0.140, 0.420], 0.35, 16, 1.1, 0.55, 0.65, [0.60, 0.10, 0.90]), // glowing crystal
    ],
    surfaces: [SURFACES.rock, SURFACES.regolith, SURFACES.crystal, SURFACES.crystal],
    beach: SURFACES.regolith,
    beachColor: [0.120, 0.080, 0.130],
    capFreeze: 210, tempSpan: 44, moistBias: -0.30, vegetated: true,
  },
  [PlanetType.EXOTIC]: {
    layers: [
      L([0.040, 0.062, 0.070], 0.72, 12, 0.8, 1.30, 0.10),   // banded chitinous rock
      L([0.086, 0.130, 0.126], 0.78, 7, 0.45, 0.70, 0.14),   // teal regolith
      L([0.150, 0.038, 0.086], 0.68, 10, 0.6, 0.85, 0.08),   // magenta salt
      L([0.240, 0.560, 0.600], 0.28, 15, 1.0, 0.50, 0.80, [0.20, 1.10, 1.30]), // living crystal
    ],
    surfaces: [SURFACES.rock, SURFACES.regolith, SURFACES.salt, SURFACES.crystal],
    beach: SURFACES.sand,
    beachColor: [0.140, 0.150, 0.130],
    capFreeze: 230, tempSpan: 38, moistBias: 0.05, vegetated: true,
  },
};

// Giants have no surface worth standing on, but a moon-of-a-giant or a cloud-deck
// platform still has to render something. Reuse the exotic palette, drained.
SETS[PlanetType.GASGIANT] = SETS[PlanetType.EXOTIC];
SETS[PlanetType.ICEGIANT] = SETS[PlanetType.FROZEN];
SETS[PlanetType.RINGWORLD] = SETS[PlanetType.TEMPERATE];

/** Per-type flora silhouettes. Shape is what sells "alien", not colour. */
const FLORA = {
  [PlanetType.TEMPERATE]: ['conifer', 'broadleaf', 'shrub'],
  [PlanetType.JUNGLE]: ['palm', 'broadleaf', 'fern'],
  [PlanetType.OCEAN]: ['palm', 'shrub'],
  [PlanetType.DESERT]: ['spire', 'shrub'],
  [PlanetType.TOXIC]: ['spire', 'fern'],
  [PlanetType.IRRADIATED]: ['spire', 'crystal'],
  [PlanetType.EXOTIC]: ['crystal', 'spire', 'fern'],
  [PlanetType.FROZEN]: ['conifer'],
  [PlanetType.RINGWORLD]: ['conifer', 'broadleaf'],
};

const DRY_ADIABAT = 1 / 1005; // K per metre per (m/s^2) — Γ = g/c_p

/**
 * Build the profile for one planet. Colours get a small deterministic push from
 * the seed so that two temperate worlds are recognisably the same *kind* of
 * place without being the same place.
 */
export function biomeProfile(planet) {
  const set = SETS[planet.type] || SETS[PlanetType.BARREN];
  const rng = new Rng((planet.terrain?.seed ?? planet.seed ?? 1) ^ 0x51ab3);

  const layers = set.layers.map((l) => {
    // Hue drift is applied per channel with a shared magnitude, which shifts the
    // tint without dragging the value around — a world can be bluer or warmer
    // than the archetype without becoming brighter or muddier.
    const k = 0.14;
    const m = [1 + rng.range(-k, k), 1 + rng.range(-k, k), 1 + rng.range(-k, k)];
    const lumBefore = l.color[0] * 0.2126 + l.color[1] * 0.7152 + l.color[2] * 0.0722;
    const c = [l.color[0] * m[0], l.color[1] * m[1], l.color[2] * m[2]];
    const lumAfter = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
    const fix = lumAfter > 1e-5 ? lumBefore / lumAfter : 1;
    return {
      color: [c[0] * fix, c[1] * fix, c[2] * fix],
      rough: clamp(l.rough + rng.range(-0.05, 0.05), 0.06, 1),
      macro: l.macro * rng.range(0.82, 1.22),
      micro: l.micro * rng.range(0.85, 1.18),
      bump: l.bump * rng.range(0.85, 1.15),
      sparkle: l.sparkle,
      emissive: l.emissive.slice(),
    };
  });

  const g = planet.gravity || 9.81;
  // Moist lapse where there is water to condense, dry where there is not.
  const lapse = DRY_ADIABAT * g * (planet.hasWater ? 0.66 : 0.95);
  const tempSpan = set.tempSpan * clamp(0.4 + planet.atmosphere * 0.9, 0.35, 1.6);

  const surfaceTemp = planet.surfaceTemp ?? 288;
  const freeze = set.capFreeze;
  // Altitude at which the mean temperature crosses the cap threshold at the
  // equator. Negative means the whole world is already past it.
  const snowLine = lapse > 1e-9 ? (surfaceTemp - freeze) / lapse : 1e9;
  const treeLine = snowLine * 0.72 - 250;

  const life = planet.hasLife ? clamp(0.25 + planet.lifeComplexity, 0, 1.4) : 0;
  const vegetated = set.vegetated && life > 0.2;

  const maxElev = planet.terrain?.maxElevation ?? 6000;

  return {
    type: planet.type,
    layers,
    surfaces: set.surfaces,
    beach: set.beach,
    beachColor: set.beachColor,
    snowLine,
    treeLine,
    lapse,
    tempSpan,
    surfaceTemp,
    freeze,
    moistBias: set.moistBias + (planet.oceanCoverage - 0.4) * 0.5,
    vegetated,
    life,
    flora: FLORA[planet.type] || [],
    maxElev,
    /** Height band over which shoreline sand is deposited. Wave energy scales with gravity. */
    beachBand: clamp(3.5 + 18 / Math.sqrt(Math.max(g, 0.4)), 4, 34),

    /**
     * The classifier. Deliberately allocation-free — it runs once per terrain
     * vertex, tens of millions of times over a session.
     *
     * `out` receives [cliff, ground, accent, cap]; the caller normalises.
     */
    classify(out, h, slope, absLat, moisture, temperature, flow, snowFactor) {
      const relief = clamp(h / Math.max(maxElev, 1), -1.5, 1.5);

      // Cliff: slope is the dominant term, but altitude helps — high ground is
      // young ground, still shedding its mantle of soil.
      const cliff =
        smoothstep(0.30, 0.72, slope) * 0.92 +
        smoothstep(0.55, 0.95, relief) * 0.25 +
        smoothstep(0.12, 0.45, slope) * 0.18;

      // Cap: everything below the freezing isotherm that is flat enough to hold
      // it. The slope term is not cosmetic — above about 50 degrees snow
      // avalanches off and you see the black rock beneath, which is most of what
      // makes a real mountain read as a mountain.
      const cold = smoothstep(freeze + 6, freeze - 8, temperature);
      const cap = cold * (1 - smoothstep(0.42, 0.78, slope)) * snowFactor;

      // Ground vs accent is the moisture axis. Wet ground grows the primary
      // material; dry ground exposes the accent.
      const wet = saturate(moisture);
      let ground = (0.35 + 0.65 * wet) * (1 - smoothstep(0.30, 0.66, slope));
      let accent = (0.75 - 0.6 * wet) * (1 - smoothstep(0.38, 0.80, slope));

      // River corridors: sediment and vegetation collect along drainage.
      if (flow > 0.02) {
        ground += flow * 0.75;
        accent += flow * 0.25;
      }

      // Below the beach band, waves keep the accent (sand/shingle) exposed.
      if (h < this.beachBand && h > -this.beachBand * 2.5) {
        const b = 1 - smoothstep(0, this.beachBand, Math.max(h, 0));
        accent += b * 1.4;
        ground *= 1 - b * 0.85;
      }

      out[0] = Math.max(cliff, 0);
      out[1] = Math.max(ground, 0);
      out[2] = Math.max(accent, 0);
      out[3] = Math.max(cap, 0);
      // Cap wins outright where it is deep; otherwise everything shares.
      const total = out[0] + out[1] + out[2] + out[3] + 1e-5;
      out[0] /= total; out[1] /= total; out[2] /= total; out[3] /= total;
      return out;
    },

    /**
     * Temperature at a point. Latitude, altitude and season, in that order of
     * importance for anything you can actually see from the ground.
     */
    temperatureAt(absLat, h, season) {
      const solar = Math.cos(absLat) + (season || 0) * 0.35 * Math.sin(absLat * 2);
      return surfaceTemp - tempSpan * (1 - clamp(solar, -0.2, 1.2)) - lapse * Math.max(h, 0);
    },

    /** Plant cover potential in [0,1] — what Vegetation.js turns into instances. */
    vegetationAt(h, slope, moisture, temperature) {
      if (!vegetated) return 0;
      const warm = smoothstep(freeze - 12, freeze + 22, temperature) *
        (1 - smoothstep(surfaceTemp + 34, surfaceTemp + 62, temperature));
      const flat = 1 - smoothstep(0.30, 0.62, slope);
      const damp = smoothstep(0.14, 0.55, moisture);
      const dry = h > 1 ? 1 : smoothstep(-1.5, 2.5, h);
      return saturate(warm * flat * damp * dry * life);
    },

    /** Locomotion's surface descriptor, chosen by the winning splat channel. */
    surfaceFor(w0, w1, w2, w3, h) {
      let best = 0, bw = w0;
      if (w1 > bw) { best = 1; bw = w1; }
      if (w2 > bw) { best = 2; bw = w2; }
      if (w3 > bw) { best = 3; bw = w3; }
      if (h < this.beachBand * 0.6 && h > -0.5 && best !== 0) return set.beach;
      return set.surfaces[best];
    },
  };
}

/** Flat arrays for the shader, in layer order. Called once per material build. */
export function layerUniformArrays(profile) {
  const color = [];
  const emissive = [];
  const rough = [0, 0, 0, 0];
  const macro = [0, 0, 0, 0];
  const micro = [0, 0, 0, 0];
  const bump = [0, 0, 0, 0];
  const sparkle = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const l = profile.layers[i];
    color.push(l.color);
    emissive.push(l.emissive);
    rough[i] = l.rough;
    macro[i] = l.macro;
    micro[i] = l.micro;
    bump[i] = l.bump;
    sparkle[i] = l.sparkle;
  }
  return { color, emissive, rough, macro, micro, bump, sparkle };
}

export { lerp, clamp, saturate, smoothstep };
