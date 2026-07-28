/**
 * Architectural languages.
 *
 * A city reads as *authored* when every building on a street obeys the same
 * handful of rules and then breaks them slightly. Randomising building shapes
 * gives you noise; randomising *within a style* gives you a place. So this file
 * is the vocabulary — a small number of coherent architectural languages, each
 * with its own massing logic, roofline, opening rhythm, material and ornament —
 * and everything downstream draws from exactly one of them per settlement.
 *
 * The parameters are deliberately perceptual rather than physical. `verticality`
 * is not a height in metres, it is how strongly this culture answers the
 * question "we need more space" with "build up" instead of "build out". `taper`
 * is not a draft angle, it is how much the silhouette narrows as it rises. Those
 * are the knobs a concept artist actually turns, and they are what makes a
 * skyline recognisable from a kilometre away in silhouette alone.
 *
 * Colours are authored in sRGB because that is how anyone reasoning about a
 * palette thinks, and converted once at read time — the renderer works in
 * linear space and vertex colours are consumed as linear.
 */

// --- enums -------------------------------------------------------------------

export const Footprint = {
  RECT: 'rect',     // orthogonal, alley-aligned
  HEX: 'hex',       // hexagonal — packs without the tyranny of the right angle
  ROUND: 'round',   // 14-gon, reads as a cylinder
  BLOB: 'blob',     // irregular closed curve, no two alike
  CROSS: 'cross',   // plus-shaped, deep light wells
  TRI: 'tri',       // triangular prism, faceted
};

export const Roof = {
  FLAT: 'flat',       // mechanical plant, water tanks, aerials
  TERRACE: 'terrace', // planted step-back with a parapet
  SPIRE: 'spire',     // needle
  DOME: 'dome',       // hemisphere or half-ellipsoid
  CANOPY: 'canopy',   // tensile fabric on masts
  RIDGE: 'ridge',     // pitched, thatched or tiled
  STEPPED: 'stepped', // stacked slabs, each smaller
  ORGANIC: 'organic', // rounded cap, grown
  SHATTER: 'shatter', // splintered crystal cluster
  MAST: 'mast',       // slender tower with a beacon
};

export const WindowMode = {
  GRID: 'grid',           // regular punched openings
  BAND: 'band',           // continuous ribbon glazing
  SLIT: 'slit',           // narrow vertical arrow-slits
  IRREGULAR: 'irregular', // scattered, no rhythm
  FACET: 'facet',         // full-height glazed slivers between mullions
  APERTURE: 'aperture',   // sparse round openings
  NONE: 'none',
};

// --- colour helper -----------------------------------------------------------

/** sRGB triple in [0,1] -> linear. Authoring is sRGB; rendering is linear. */
export function srgb(c) {
  const f = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return [f(c[0]), f(c[1]), f(c[2])];
}

/** Emissive triples are authored as (hue colour, HDR multiplier). */
function hdr(c, k) {
  const l = srgb(c);
  return [l[0] * k, l[1] * k, l[2] * k];
}

// --- the styles --------------------------------------------------------------
//
// `suits` is a soft scoring hint, not a hard gate: a style scores against the
// planet record and the best few are drawn from. That way a desert world usually
// gets nomadic canopies but can occasionally surprise you with crystal spires,
// which is exactly the sort of exception that makes a galaxy feel real.

export const STYLES = [
  {
    id: 'brutalist',
    name: 'Terraced Monolith',
    blurb: 'State-planned mega-terraces. Concrete poured in place, weathered by fifty winters, planted where the planners remembered people.',
    footprint: Footprint.RECT,
    floorHeight: [3.0, 3.6],
    floors: [4, 34],
    verticality: 0.55,
    taper: 0.06,
    setbackEvery: 4,
    setbackAmount: 0.13,
    twist: 0.0,
    jitter: 0.02,
    ringBudget: 7,
    roof: Roof.STEPPED,
    roofClutter: 0.85,
    parapet: 1.0,
    window: {
      mode: WindowMode.BAND, cols: [3, 9], size: [1.5, 1.5], gap: 0.9,
      inset: 0.45, litFraction: 0.42, warmth: [0.25, 0.7], colorVariance: 0.15,
      skipFloors: 0.06,
    },
    mat: {
      color: [0.44, 0.43, 0.41], roughness: 0.93, metalness: 0.0,
      trim: [0.30, 0.29, 0.28], accent: [0.52, 0.26, 0.16], grime: 0.75,
    },
    emissive: hdr([1.0, 0.62, 0.28], 2.4),   // sodium vapour
    ornament: { buttress: 0.7, balcony: 0.85, fins: 0.1, pipes: 0.55, greeble: 0.45, banners: 0.15, vines: 0.25, sails: 0, crystals: 0, ruin: 0.1, stilts: 0 },
    lotFill: 0.80, gapChance: 0.06, streetWidth: 20, densityFalloff: 1.15,
    suits: { types: ['temperate', 'barren', 'frozen', 'toxic', 'irradiated'], gravity: [0.7, 2.2], tech: [0.25, 0.85], water: 0 },
  },

  {
    id: 'mycelial',
    name: 'Grown Reef',
    blurb: 'Nothing here was built. It was seeded, fed and pruned. Load paths follow the grain of a living material, so the whole quarter branches like coral.',
    footprint: Footprint.BLOB,
    floorHeight: [3.4, 4.6],
    floors: [2, 14],
    verticality: 0.30,
    taper: 0.22,
    setbackEvery: 0,
    setbackAmount: 0,
    twist: 0.055,
    jitter: 0.16,
    bulge: 0.35,          // mid-height swell — a stalk, not a cone
    ringBudget: 9,
    roof: Roof.ORGANIC,
    roofClutter: 0.1,
    parapet: 0.0,
    window: {
      mode: WindowMode.APERTURE, cols: [2, 5], size: [1.4, 1.9], gap: 2.6,
      inset: 0.3, litFraction: 0.62, warmth: [0.55, 0.95], colorVariance: 0.35,
      skipFloors: 0.2,
    },
    mat: {
      color: [0.76, 0.70, 0.55], roughness: 0.58, metalness: 0.0,
      trim: [0.42, 0.46, 0.34], accent: [0.30, 0.52, 0.42], grime: 0.3,
    },
    emissive: hdr([0.32, 1.0, 0.72], 3.6),   // bioluminescence, deliberately hot
    ornament: { buttress: 0.9, balcony: 0.3, fins: 0.2, pipes: 0.05, greeble: 0.1, banners: 0.25, vines: 0.95, sails: 0.15, crystals: 0.1, ruin: 0.05, stilts: 0.2 },
    lotFill: 0.52, gapChance: 0.22, streetWidth: 11, densityFalloff: 0.85,
    suits: { types: ['jungle', 'temperate', 'ocean', 'toxic', 'exotic'], gravity: [0.4, 1.4], tech: [0.15, 0.9], water: 1 },
  },

  {
    id: 'crystalline',
    name: 'Refractive Spire',
    blurb: 'Grown from seed lattices under pressure. The whole district is one continuous mineral, cleaved into towers that catch the sun for an hour and hold it.',
    footprint: Footprint.HEX,
    floorHeight: [4.2, 5.4],
    floors: [8, 62],
    verticality: 0.95,
    taper: 0.30,
    setbackEvery: 0,
    setbackAmount: 0,
    twist: 0.030,
    jitter: 0.03,
    lean: 0.06,           // spires do not all agree on vertical
    ringBudget: 6,
    roof: Roof.SHATTER,
    roofClutter: 0.05,
    parapet: 0.0,
    window: {
      mode: WindowMode.FACET, cols: [4, 8], size: [1.1, 4.4], gap: 1.4,
      inset: 0.06, litFraction: 0.55, warmth: [0.0, 0.35], colorVariance: 0.28,
      skipFloors: 0.0,
    },
    mat: {
      color: [0.60, 0.68, 0.82], roughness: 0.14, metalness: 0.18,
      trim: [0.80, 0.86, 1.0], accent: [0.55, 0.42, 0.90], grime: 0.05,
    },
    emissive: hdr([0.62, 0.72, 1.0], 3.0),
    ornament: { buttress: 0.2, balcony: 0.05, fins: 0.55, pipes: 0, greeble: 0.08, banners: 0, vines: 0, sails: 0, crystals: 1.0, ruin: 0, stilts: 0 },
    lotFill: 0.44, gapChance: 0.18, streetWidth: 26, densityFalloff: 1.4,
    suits: { types: ['frozen', 'barren', 'exotic', 'irradiated', 'desert'], gravity: [0.2, 1.1], tech: [0.5, 1.0], water: 0 },
  },

  {
    id: 'nomadic',
    name: 'Tensile Encampment',
    blurb: 'Everything can be struck in an hour. Masts, cable, and shade — the only permanent things are the cisterns and the dead.',
    footprint: Footprint.ROUND,
    floorHeight: [2.6, 3.2],
    floors: [1, 3],
    verticality: 0.05,
    taper: 0.10,
    setbackEvery: 0,
    setbackAmount: 0,
    twist: 0,
    jitter: 0.10,
    ringBudget: 3,
    roof: Roof.CANOPY,
    roofClutter: 0.15,
    parapet: 0.0,
    window: {
      mode: WindowMode.IRREGULAR, cols: [1, 3], size: [1.0, 1.2], gap: 2.2,
      inset: 0.15, litFraction: 0.75, warmth: [0.8, 1.0], colorVariance: 0.2,
      skipFloors: 0.1,
    },
    mat: {
      color: [0.80, 0.72, 0.57], roughness: 0.85, metalness: 0.02,
      trim: [0.34, 0.26, 0.19], accent: [0.66, 0.24, 0.16], grime: 0.55,
    },
    emissive: hdr([1.0, 0.74, 0.42], 2.6),   // oil lamp
    ornament: { buttress: 0.05, balcony: 0.1, fins: 0, pipes: 0.1, greeble: 0.2, banners: 0.9, vines: 0.05, sails: 1.0, crystals: 0, ruin: 0.05, stilts: 0.15 },
    lotFill: 0.30, gapChance: 0.34, streetWidth: 14, densityFalloff: 0.55,
    suits: { types: ['desert', 'barren', 'temperate'], gravity: [0.3, 1.6], tech: [0.0, 0.5], water: -1 },
  },

  {
    id: 'stack',
    name: 'Vertical Accretion',
    blurb: 'No plot was ever surveyed. Each floor was added by whoever could afford the steel, cantilevered a little further out than the one below, and the alleys never see the sky.',
    footprint: Footprint.RECT,
    floorHeight: [2.6, 3.1],
    floors: [6, 54],
    verticality: 0.82,
    taper: -0.05,         // negative: it widens as it rises
    setbackEvery: 0,
    setbackAmount: 0,
    twist: 0.006,
    jitter: 0.11,
    ringBudget: 8,
    roof: Roof.FLAT,
    roofClutter: 1.0,
    parapet: 0.4,
    window: {
      mode: WindowMode.GRID, cols: [4, 12], size: [1.0, 1.25], gap: 0.55,
      inset: 0.18, litFraction: 0.78, warmth: [0.0, 1.0], colorVariance: 0.75,
      skipFloors: 0.02,
    },
    mat: {
      color: [0.36, 0.35, 0.33], roughness: 0.86, metalness: 0.06,
      trim: [0.46, 0.28, 0.20], accent: [0.16, 0.34, 0.36], grime: 1.0,
    },
    emissive: hdr([1.0, 0.28, 0.62], 4.2),   // neon, the loudest signature in the set
    ornament: { buttress: 0.15, balcony: 1.0, fins: 0.1, pipes: 1.0, greeble: 1.0, banners: 1.0, vines: 0.35, sails: 0.3, crystals: 0, ruin: 0.15, stilts: 0.05 },
    lotFill: 0.94, gapChance: 0.02, streetWidth: 8, densityFalloff: 1.55,
    suits: { types: ['temperate', 'jungle', 'ocean', 'toxic', 'desert', 'irradiated'], gravity: [0.6, 1.5], tech: [0.35, 1.0], water: 0 },
  },

  {
    id: 'ziggurat',
    name: 'Monolithic Tier',
    blurb: 'Cut, dragged, stacked. Gold in the joints because gold does not corrode and the dead are watching. Two of the seven tiers have already come down.',
    footprint: Footprint.RECT,
    floorHeight: [9.0, 14.0],   // "floors" here are tiers, not storeys
    floors: [2, 7],
    verticality: 0.35,
    taper: 0.0,
    setbackEvery: 1,
    setbackAmount: 0.19,
    twist: 0,
    jitter: 0.02,
    ringBudget: 8,
    roof: Roof.TERRACE,
    roofClutter: 0.2,
    parapet: 0.9,
    window: {
      mode: WindowMode.SLIT, cols: [2, 6], size: [0.6, 3.0], gap: 4.5,
      inset: 0.7, litFraction: 0.5, warmth: [0.9, 1.0], colorVariance: 0.12,
      skipFloors: 0.25,
    },
    mat: {
      color: [0.64, 0.55, 0.41], roughness: 0.78, metalness: 0.0,
      trim: [1.0, 0.79, 0.34], trimMetalness: 0.95, trimRoughness: 0.3,
      accent: [0.30, 0.24, 0.18], grime: 0.85,
    },
    emissive: hdr([1.0, 0.55, 0.20], 2.2),   // torch and brazier
    ornament: { buttress: 0.6, balcony: 0.2, fins: 0.05, pipes: 0, greeble: 0.1, banners: 0.7, vines: 0.5, sails: 0.1, crystals: 0, ruin: 0.65, stilts: 0 },
    lotFill: 0.58, gapChance: 0.16, streetWidth: 24, densityFalloff: 0.7,
    suits: { types: ['desert', 'temperate', 'jungle', 'barren'], gravity: [0.8, 2.4], tech: [0.0, 0.45], water: 0 },
  },

  {
    id: 'arcology',
    name: 'Ring Arcology',
    blurb: 'One structure holding two hundred thousand people, its services stacked like an organ system. The maglev spine is the street; the ground is a park nobody has to cross.',
    footprint: Footprint.ROUND,
    floorHeight: [3.8, 4.4],
    floors: [10, 78],
    verticality: 0.98,
    taper: 0.16,
    setbackEvery: 9,
    setbackAmount: -0.16,   // negative setback: galleries flare outward
    twist: 0.004,
    jitter: 0.01,
    ringBudget: 9,
    roof: Roof.MAST,
    roofClutter: 0.3,
    parapet: 0.2,
    window: {
      mode: WindowMode.BAND, cols: [8, 18], size: [2.4, 2.0], gap: 0.5,
      inset: 0.12, litFraction: 0.66, warmth: [0.05, 0.45], colorVariance: 0.2,
      skipFloors: 0.03,
    },
    mat: {
      color: [0.87, 0.87, 0.85], roughness: 0.34, metalness: 0.12,
      trim: [0.20, 0.22, 0.25], accent: [0.30, 0.72, 0.86], grime: 0.12,
    },
    emissive: hdr([0.52, 0.88, 1.0], 3.4),
    ornament: { buttress: 0.3, balcony: 0.5, fins: 0.85, pipes: 0.1, greeble: 0.25, banners: 0.1, vines: 0.3, sails: 0, crystals: 0, ruin: 0, stilts: 0 },
    lotFill: 0.40, gapChance: 0.20, streetWidth: 34, densityFalloff: 1.7,
    suits: { types: ['temperate', 'ocean', 'barren', 'frozen', 'desert'], gravity: [0.5, 1.3], tech: [0.6, 1.0], water: 0 },
  },

  {
    id: 'stilt',
    name: 'Lantern Stilt',
    blurb: 'Built above the tide line out of what grows locally, and lit by what glows locally. The walkways are the town; the water underneath is the road.',
    footprint: Footprint.ROUND,
    floorHeight: [2.8, 3.4],
    floors: [1, 4],
    verticality: 0.12,
    taper: 0.08,
    setbackEvery: 0,
    setbackAmount: 0,
    twist: 0.02,
    jitter: 0.14,
    ringBudget: 4,
    roof: Roof.RIDGE,
    roofClutter: 0.1,
    parapet: 0,
    stiltHeight: [3.0, 8.0],
    window: {
      mode: WindowMode.IRREGULAR, cols: [2, 4], size: [1.1, 1.4], gap: 1.6,
      inset: 0.22, litFraction: 0.85, warmth: [0.6, 1.0], colorVariance: 0.4,
      skipFloors: 0.05,
    },
    mat: {
      color: [0.33, 0.24, 0.17], roughness: 0.9, metalness: 0.0,
      trim: [0.55, 0.47, 0.30], accent: [0.20, 0.46, 0.40], grime: 0.6,
    },
    emissive: hdr([0.40, 0.92, 1.0], 4.0),   // lantern-fungus blue
    ornament: { buttress: 0.15, balcony: 0.75, fins: 0, pipes: 0.15, greeble: 0.35, banners: 0.65, vines: 0.8, sails: 0.4, crystals: 0.05, ruin: 0.1, stilts: 1.0 },
    lotFill: 0.36, gapChance: 0.28, streetWidth: 9, densityFalloff: 0.6,
    suits: { types: ['ocean', 'jungle', 'temperate'], gravity: [0.3, 1.3], tech: [0.0, 0.6], water: 1 },
  },

  {
    id: 'hive',
    name: 'Chitin Hive',
    blurb: 'Extruded, not assembled. The species that made this does not use doors at ground level, and the towers taper to points because that is how a secretion dries.',
    footprint: Footprint.HEX,
    floorHeight: [2.4, 3.0],
    floors: [5, 46],
    verticality: 0.75,
    taper: 0.34,
    setbackEvery: 0,
    setbackAmount: 0,
    twist: 0.045,
    jitter: 0.07,
    bulge: 0.22,
    ringBudget: 7,
    roof: Roof.SPIRE,
    roofClutter: 0.05,
    parapet: 0,
    window: {
      mode: WindowMode.APERTURE, cols: [3, 7], size: [1.0, 1.0], gap: 1.9,
      inset: 0.35, litFraction: 0.48, warmth: [0.7, 0.95], colorVariance: 0.18,
      skipFloors: 0.12,
    },
    mat: {
      color: [0.22, 0.18, 0.16], roughness: 0.42, metalness: 0.30,
      trim: [0.42, 0.28, 0.12], accent: [0.62, 0.34, 0.06], grime: 0.4,
    },
    emissive: hdr([1.0, 0.48, 0.10], 3.2),
    ornament: { buttress: 0.85, balcony: 0.1, fins: 0.35, pipes: 0.05, greeble: 0.2, banners: 0, vines: 0.15, sails: 0, crystals: 0.15, ruin: 0.1, stilts: 0.1 },
    lotFill: 0.72, gapChance: 0.10, streetWidth: 12, densityFalloff: 1.3,
    suits: { types: ['toxic', 'jungle', 'irradiated', 'desert', 'exotic'], gravity: [0.6, 2.6], tech: [0.2, 0.8], water: 0 },
  },

  {
    id: 'dome',
    name: 'Pressure Colony',
    blurb: 'A hostile sky costs money. Every cubic metre is bought, so the domes are squat, the corridors between them are the only public space, and the hazard stripes are not decorative.',
    footprint: Footprint.ROUND,
    floorHeight: [3.2, 3.8],
    floors: [1, 6],
    verticality: 0.18,
    taper: 0.30,
    setbackEvery: 0,
    setbackAmount: 0,
    twist: 0,
    jitter: 0.03,
    ringBudget: 5,
    roof: Roof.DOME,
    roofClutter: 0.6,
    parapet: 0,
    window: {
      mode: WindowMode.BAND, cols: [4, 10], size: [1.8, 1.3], gap: 0.7,
      inset: 0.3, litFraction: 0.9, warmth: [0.1, 0.5], colorVariance: 0.15,
      skipFloors: 0.0,
    },
    mat: {
      color: [0.80, 0.79, 0.76], roughness: 0.5, metalness: 0.25,
      trim: [0.92, 0.52, 0.08], accent: [0.24, 0.26, 0.30], grime: 0.5,
    },
    emissive: hdr([0.86, 0.94, 1.0], 3.0),
    ornament: { buttress: 0.4, balcony: 0.05, fins: 0.2, pipes: 0.9, greeble: 0.8, banners: 0.1, vines: 0.05, sails: 0, crystals: 0, ruin: 0.05, stilts: 0.1 },
    lotFill: 0.55, gapChance: 0.14, streetWidth: 16, densityFalloff: 0.9,
    suits: { types: ['barren', 'frozen', 'molten', 'toxic', 'irradiated', 'exotic'], gravity: [0.1, 2.8], tech: [0.4, 1.0], water: -1 },
  },

  {
    id: 'wreck',
    name: 'Hull Salvage',
    blurb: 'Somebody came down hard here and never left. The plate is off a lander; the roof is off a cargo pod; the light is off a reactor that should have been scrapped.',
    footprint: Footprint.RECT,
    floorHeight: [2.4, 3.4],
    floors: [1, 9],
    verticality: 0.28,
    taper: 0.02,
    setbackEvery: 0,
    setbackAmount: 0,
    twist: 0.02,
    jitter: 0.26,        // the defining parameter: nothing is square to anything
    ringBudget: 6,
    roof: Roof.FLAT,
    roofClutter: 1.0,
    parapet: 0.25,
    window: {
      mode: WindowMode.IRREGULAR, cols: [1, 5], size: [0.9, 1.1], gap: 1.1,
      inset: 0.25, litFraction: 0.55, warmth: [0.4, 1.0], colorVariance: 0.6,
      skipFloors: 0.18,
    },
    mat: {
      color: [0.40, 0.31, 0.24], roughness: 0.92, metalness: 0.35,
      trim: [0.52, 0.20, 0.10], accent: [0.60, 0.58, 0.52], grime: 1.0,
    },
    emissive: hdr([1.0, 0.42, 0.14], 3.0),
    ornament: { buttress: 0.5, balcony: 0.6, fins: 0.3, pipes: 0.9, greeble: 1.0, banners: 0.5, vines: 0.2, sails: 0.6, crystals: 0, ruin: 0.8, stilts: 0.3 },
    lotFill: 0.75, gapChance: 0.12, streetWidth: 7, densityFalloff: 1.0,
    suits: { types: ['barren', 'desert', 'frozen', 'toxic', 'irradiated', 'molten'], gravity: [0.2, 2.4], tech: [0.1, 0.7], water: 0 },
  },
];

export const STYLE_BY_ID = Object.fromEntries(STYLES.map((s) => [s.id, s]));

// --- selection ---------------------------------------------------------------

/**
 * How well a style fits a world. Deliberately soft — the highest score is not
 * guaranteed to win, it just weights the draw. Environment is the strongest
 * term because architecture is, above everything else, an answer to weather.
 */
export function styleScore(style, planet) {
  const s = style.suits;
  let score = 0.12;

  if (s.types.includes(planet.type)) score += 1.0;

  const g = (planet.gravity ?? 9.81) / 9.81;
  if (g >= s.gravity[0] && g <= s.gravity[1]) score += 0.55;
  else score *= 0.35;                        // wrong gravity is nearly disqualifying

  const t = planet.techLevel ?? 0.4;
  if (t >= s.tech[0] && t <= s.tech[1]) score += 0.7;
  else score *= 0.4;

  // Water preference: -1 wants it dry, +1 wants a coast, 0 does not care.
  const ocean = planet.oceanCoverage ?? 0.3;
  if (s.water > 0) score *= 0.25 + ocean * 1.8;
  else if (s.water < 0) score *= 1.5 - ocean * 1.2;

  // Vertical living needs low gravity or good structural tech; heavy worlds
  // stay low and wide whatever the culture would prefer.
  score *= 1.0 - Math.max(0, (g - 1.2)) * style.verticality * 0.55;

  return Math.max(0.001, score);
}

/** Weighted pick over the whole set, using `styleScore` sharpened by `bias`. */
export function pickStyle(planet, rng, bias = 2.2, exclude = null) {
  const pool = exclude ? STYLES.filter((s) => s.id !== exclude) : STYLES;
  const w = pool.map((s) => Math.pow(styleScore(s, planet), bias));
  return rng.weighted(pool, w);
}

// --- per-building variation --------------------------------------------------

/**
 * Jitters a style's palette for one building.
 *
 * Real streets are not one colour: they are one colour *family*, weathered
 * unevenly. Keeping the hue locked and moving only value and a little saturation
 * is what reads as "same material, different decade of maintenance" instead of
 * "someone randomised the albedo".
 */
export function variantColor(base, rng, amount = 0.12, grime = 0.5) {
  const v = 1 + rng.range(-amount, amount);
  // Grime is a desaturating pull toward a warm-neutral soot, weighted downward
  // because dirt darkens far more often than it lightens.
  const soot = grime * rng.range(0, 0.55);
  const out = [0, 0, 0];
  const target = [0.09, 0.082, 0.075];
  for (let i = 0; i < 3; i++) {
    const c = base[i] * v;
    out[i] = c + (target[i] - c) * soot;
  }
  return out;
}

/** Style-aware storey count for a lot, given the radial density gradient. */
export function floorsFor(style, rng, density) {
  const [lo, hi] = style.floors;
  // Density in [0,1] biases toward the top of the range, but the exponent means
  // even a dense core keeps a long tail of low buildings — a skyline made only
  // of towers has no scale reference and reads as a toy.
  const t = Math.pow(rng.next(), 1.0 + (1.0 - density) * 2.6);
  const reach = Math.pow(density, 1.0 / Math.max(0.25, style.verticality + 0.35));
  return Math.max(1, Math.round(lo + (hi - lo) * t * reach));
}

/** Footprint polygon in unit space (x,z in roughly [-0.5,0.5]). */
export function footprintPolygon(kind, rng, sides = 0) {
  const p = [];
  const push = (x, z) => p.push(x, z);
  switch (kind) {
    case Footprint.RECT:
      push(-0.5, -0.5); push(0.5, -0.5); push(0.5, 0.5); push(-0.5, 0.5);
      break;
    case Footprint.TRI: {
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
        push(Math.cos(a) * 0.55, Math.sin(a) * 0.55);
      }
      break;
    }
    case Footprint.HEX: {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        push(Math.cos(a) * 0.52, Math.sin(a) * 0.52);
      }
      break;
    }
    case Footprint.ROUND: {
      const n = sides || 14;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        push(Math.cos(a) * 0.5, Math.sin(a) * 0.5);
      }
      break;
    }
    case Footprint.CROSS: {
      const t = 0.19;
      const pts = [
        [-t, -0.5], [t, -0.5], [t, -t], [0.5, -t], [0.5, t], [t, t],
        [t, 0.5], [-t, 0.5], [-t, t], [-0.5, t], [-0.5, -t], [-t, -t],
      ];
      for (const q of pts) push(q[0], q[1]);
      break;
    }
    case Footprint.BLOB:
    default: {
      const n = sides || 11;
      // Two harmonics of radial noise: one low frequency for the overall lobe
      // shape, one higher for the wobble. Anything more just reads as circular.
      const a1 = rng.range(0, Math.PI * 2);
      const a2 = rng.range(0, Math.PI * 2);
      const k1 = rng.range(0.14, 0.30);
      const k2 = rng.range(0.04, 0.11);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const r = 0.5 * (1 + k1 * Math.sin(a * 2 + a1) + k2 * Math.sin(a * 5 + a2));
        push(Math.cos(a) * r, Math.sin(a) * r);
      }
      break;
    }
  }
  return p;
}
