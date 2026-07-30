/**
 * Civilisations — the layer that makes a planet's cities belong to each other.
 *
 * A city generated straight from a seed is a pile of buildings. A city
 * generated from a *culture* is a place, because every decision downstream
 * answers to the same small set of prior commitments: this people builds in
 * fired clay because their world has no forest; they write in strokes pulled
 * downward because they read on hanging banners; their lamps are cold blue
 * because their sun is red and blue is what a red-lit eye finds legible. None
 * of that is visible as a fact. All of it is visible as coherence.
 *
 * So this file derives, from one planet record, a culture: what it builds with,
 * what colour its night is, how it writes, how it lays out ground, what it can
 * lift into orbit, and what has happened to it. Everything else in src/civ
 * reads that record and never re-rolls a decision it could have inherited.
 *
 * The history matters more than it looks. A city that is merely "generated"
 * has no reason for its ruins to be on one side, its lights to be out in one
 * quarter, its walls to have been extended twice. A city with a founding, a
 * war and a bad decade has all three for free, and the player reads them
 * without ever being told.
 *
 * Deliberately free of any WebGL dependency: this whole module runs in Node,
 * which is what makes it testable and what lets the layout stage run in a
 * worker later without dragging three.js across the boundary.
 */

import { Rng, hashString, hashInt } from '../core/Rng.js';
import { clamp, lerp, smoothstep } from '../core/Noise.js';
import { STYLES, STYLE_BY_ID, styleScore } from './CivStyles.js';

// --- phonology ---------------------------------------------------------------
//
// Names inside one culture have to rhyme with each other or the illusion dies
// instantly. So rather than draw from a global syllable pool, each culture is
// given its own small inventory — a handful of onsets, nuclei and codas — and
// every name it will ever produce is built from that. Two cultures on the same
// planet then sound related without sounding identical, which is exactly the
// relationship real neighbouring languages have.

const ONSETS = ['k', 't', 'p', 's', 'm', 'n', 'l', 'r', 'v', 'th', 'sh', 'kh', 'dr', 'tr', 'br', 'gl', 'z', 'y', 'h', 'ph', 'st', 'sk', 'ng', 'q', 'x', 'j', 'w', 'chr', 'vl', 'zh'];
const NUCLEI = ['a', 'e', 'i', 'o', 'u', 'ae', 'ei', 'ou', 'ia', 'uo', 'ai', 'y', 'aa', 'ee', 'eu', 'oa'];
const CODAS = ['', '', '', 'n', 'r', 's', 'l', 'th', 'k', 'm', 'sh', 'nd', 'st', 'rn', 'ng', 'x', 'ph'];

/** Draws a culture-sized slice out of each inventory. Small is the point. */
function makePhonology(rng) {
  const take = (pool, n) => rng.shuffle(pool.slice()).slice(0, n);
  return {
    onsets: take(ONSETS, rng.int(4, 8)),
    nuclei: take(NUCLEI, rng.int(3, 6)),
    codas: take(CODAS, rng.int(3, 6)),
    // How readily this language stacks syllables. Agglutinative cultures get
    // long compound place-names; isolating ones get sharp monosyllables.
    syllables: [rng.int(1, 2), rng.int(2, 4)],
    // A per-culture orthographic habit — apostrophes, doubled vowels, hyphens.
    mark: rng.weighted(["'", '-', '', '', 'ʼ'], [0.2, 0.15, 0.4, 0.2, 0.05]),
    markChance: rng.range(0, 0.35),
  };
}

function speak(phon, rng, min = 0, max = 0) {
  const lo = min || phon.syllables[0];
  const hi = max || phon.syllables[1];
  const n = rng.int(lo, hi);
  let s = '';
  for (let i = 0; i < n; i++) {
    if (i > 0 && rng.next() < phon.markChance) s += phon.mark;
    s += rng.pick(phon.onsets) + rng.pick(phon.nuclei);
    if (rng.next() < 0.45) s += rng.pick(phon.codas);
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --- vocabulary --------------------------------------------------------------
//
// Place-names are almost never arbitrary. They are a noun plus a qualifier, and
// the nouns a culture uses tell you what it cares about. Splitting the pools by
// district function means the market quarter gets named after trade and the
// necropolis after the dead, so a map legend reads like a map legend.

const TOPO = ['Reach', 'Hollow', 'Shelf', 'Crossing', 'Ridge', 'Basin', 'Verge', 'Span', 'Fold', 'Terrace', 'Shallows', 'Rise', 'Bight', 'Cut', 'Scarp'];
const CIVIC = ['Assembly', 'Concord', 'Chancery', 'Ledger', 'Quorum', 'Charter', 'Column', 'Convocation', 'Registry'];
const TRADE = ['Exchange', 'Weighhouse', 'Long Market', 'Freight', 'Bourse', 'Caravanserai', 'Warehouse Row', 'Toll'];
const WORK = ['Foundry', 'Stacks', 'Refinery', 'Kilns', 'Yards', 'Reclamation', 'Cooling Row', 'Slag Walk'];
const SACRED = ['Ossuary', 'Reliquary', 'Silence', 'Vigil', 'Ash Garden', 'Nine Names', 'Long Sleep', 'Threshold'];
const POOR = ['Undercut', 'Warrens', 'Runoff', 'Backslope', 'Tin Row', 'The Lean', 'Culvert', 'Shadow Side'];
const PORT = ['Gantry', 'Downwell', 'High Apron', 'Ascension Field', 'Cradle', 'Beacon Flats'];
const GREEN = ['Terraces', 'Croft', 'Water Steps', 'Green Ladder', 'Rains', 'Long Field'];
const EPITHET = ['the Elder', 'the Drowned', 'the Second', 'the Quiet', 'the Burnt', 'the Wide', 'the Patient', 'the Unfinished', 'the Bright', 'the Cold'];

const DISTRICT_NOUNS = {
  civic: CIVIC, market: TRADE, industrial: WORK, temple: SACRED, necropolis: SACRED,
  slums: POOR, spaceport: PORT, agricultural: GREEN, residential: TOPO, docks: PORT,
  academy: CIVIC, garrison: CIVIC,
};

// --- writing systems ---------------------------------------------------------
//
// Alien typography fails when it is drawn as "squiggles". What makes an unknown
// script read as *language* is that it obeys constraints: a consistent stroke
// count, a consistent baseline relationship, a consistent aspect ratio, and a
// small number of recurring motifs. Those constraints are what this descriptor
// carries; Signage.js turns them into actual strokes.

const SCRIPT_FAMILIES = [
  { id: 'cuneal', angularity: 0.95, curvature: 0.05, strokes: [3, 6], aspect: 1.15, baseline: 'centred', serif: 0.7 },
  { id: 'flowing', angularity: 0.1, curvature: 0.9, strokes: [1, 3], aspect: 0.8, baseline: 'hanging', serif: 0.1 },
  { id: 'radial', angularity: 0.4, curvature: 0.5, strokes: [4, 8], aspect: 1.0, baseline: 'centred', serif: 0.0 },
  { id: 'boxed', angularity: 1.0, curvature: 0.0, strokes: [4, 9], aspect: 1.0, baseline: 'boxed', serif: 0.35 },
  { id: 'ladder', angularity: 0.8, curvature: 0.15, strokes: [3, 7], aspect: 0.55, baseline: 'stacked', serif: 0.2 },
  { id: 'sigil', angularity: 0.55, curvature: 0.45, strokes: [2, 5], aspect: 1.3, baseline: 'floating', serif: 0.0 },
  { id: 'thread', angularity: 0.2, curvature: 0.75, strokes: [1, 2], aspect: 2.2, baseline: 'hanging', serif: 0.0 },
];

/**
 * Reading direction is a surprisingly strong visual signature. A culture that
 * writes top-to-bottom hangs its signs as vertical banners and its streets fill
 * with falling columns of light; one that writes left-to-right gets horizontal
 * fascia boards. Same city, entirely different night.
 */
const DIRECTIONS = ['ltr', 'rtl', 'ttb', 'boustrophedon'];

// --- palettes ----------------------------------------------------------------

/**
 * The colour signature of a civilisation's night.
 *
 * Derived rather than picked: what a species uses for artificial light depends
 * on what its star gives it for free. Under a red dwarf, blue-white light is
 * the expensive, high-status, legible choice; under a hot blue star, warm light
 * is. Then a single dominant neon hue is chosen and *held* across the whole
 * settlement, because the reason Blade Runner and Chungking Express read as
 * places rather than lightshows is that each has one or two hues and commits.
 */
function deriveLightSignature(planet, rng) {
  const temp = planet.starTemp ?? planet.star?.temp ?? 5400;
  // Compensatory preference: cool light under a warm sun, and the reverse.
  const cool = clamp(smoothstep(6500, 3200, temp), 0, 1);
  const bias = clamp(cool * 0.8 + rng.range(-0.25, 0.25), 0, 1);

  // Neon families, authored in sRGB. Kept few and far apart in hue so two
  // cities never end up in the same ambiguous teal.
  const FAMILIES = [
    { id: 'sodium', hue: [1.0, 0.55, 0.16], warm: 1.0, k: 3.0 },
    { id: 'magenta', hue: [1.0, 0.16, 0.62], warm: 0.55, k: 4.4 },
    { id: 'cyan', hue: [0.20, 0.90, 1.0], warm: 0.1, k: 4.0 },
    { id: 'jade', hue: [0.25, 1.0, 0.60], warm: 0.25, k: 3.6 },
    { id: 'ultraviolet', hue: [0.55, 0.30, 1.0], warm: 0.0, k: 3.8 },
    { id: 'ember', hue: [1.0, 0.30, 0.10], warm: 0.95, k: 3.2 },
    { id: 'bone', hue: [1.0, 0.94, 0.82], warm: 0.6, k: 2.6 },
    { id: 'signal-red', hue: [1.0, 0.10, 0.14], warm: 0.9, k: 4.0 },
  ];
  const w = FAMILIES.map((f) => Math.pow(1.0 - Math.abs(f.warm - (1 - bias)), 2.4) + 0.06);
  const primary = rng.weighted(FAMILIES, w);
  // The secondary is chosen to *contrast*, not to harmonise — the accent light
  // has to be findable across a street or it contributes nothing.
  const w2 = FAMILIES.map((f, i) => (FAMILIES[i].id === primary.id ? 0 : Math.abs(f.warm - primary.warm) + 0.15));
  const secondary = rng.weighted(FAMILIES, w2);

  return { primary, secondary, coolBias: bias, starTemp: temp };
}

/** sRGB triple scaled past 1.0 so the post chain's 1.15 bloom threshold bites. */
function hdrFrom(rgb, k) {
  const f = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return [f(rgb[0]) * k, f(rgb[1]) * k, f(rgb[2]) * k];
}

// --- settlement patterns -----------------------------------------------------

const PATTERNS = [
  { id: 'radial', blurb: 'Everything answers to one centre; the rings are the ages of the city.', ring: 1.0, grid: 0.15, organic: 0.2 },
  { id: 'grid', blurb: 'Surveyed before it was settled, and it shows.', ring: 0.1, grid: 1.0, organic: 0.05 },
  { id: 'organic', blurb: 'Cow-paths hardened into streets and nobody ever straightened them.', ring: 0.3, grid: 0.05, organic: 1.0 },
  { id: 'linear', blurb: 'Strung along one line of transport, three blocks deep and eleven kilometres long.', ring: 0.05, grid: 0.6, organic: 0.35 },
  { id: 'terraced', blurb: 'The contour is the street. Nothing crosses a slope that does not have to.', ring: 0.6, grid: 0.2, organic: 0.7 },
  { id: 'scattered', blurb: 'A dozen small settlements that have not yet admitted they are one.', ring: 0.2, grid: 0.15, organic: 0.85 },
  { id: 'spoke', blurb: 'Arterials first, everything else filled in between them afterwards.', ring: 0.7, grid: 0.5, organic: 0.25 },
];

// --- tech signature ----------------------------------------------------------

const POWER = [
  { id: 'wood-and-wind', tech: [0.0, 0.25], smoke: 1.0, glow: 0.2 },
  { id: 'coal-and-steam', tech: [0.15, 0.45], smoke: 1.0, glow: 0.5 },
  { id: 'fission', tech: [0.35, 0.7], smoke: 0.4, glow: 0.7 },
  { id: 'geothermal tap', tech: [0.3, 0.8], smoke: 0.5, glow: 0.8 },
  { id: 'orbital solar', tech: [0.55, 1.0], smoke: 0.05, glow: 0.9 },
  { id: 'fusion', tech: [0.65, 1.0], smoke: 0.1, glow: 1.0 },
  { id: 'vacuum lattice', tech: [0.85, 1.0], smoke: 0.0, glow: 1.0 },
];

const TRANSPORT = [
  { id: 'foot and beast', tech: [0.0, 0.3], flyers: 0, ground: 0.3, rail: 0 },
  { id: 'wheeled', tech: [0.2, 0.6], flyers: 0, ground: 1.0, rail: 0.3 },
  { id: 'rail spine', tech: [0.3, 0.8], flyers: 0.05, ground: 0.8, rail: 1.0 },
  { id: 'maglev', tech: [0.55, 1.0], flyers: 0.35, ground: 0.5, rail: 1.0 },
  { id: 'antigrav lanes', tech: [0.7, 1.0], flyers: 1.0, ground: 0.35, rail: 0.5 },
  { id: 'tube and drop', tech: [0.85, 1.0], flyers: 0.8, ground: 0.15, rail: 0.8 },
];

const MATERIALS = [
  { id: 'rammed earth', tech: [0, 0.3] }, { id: 'cut stone', tech: [0, 0.45] },
  { id: 'fired brick', tech: [0.05, 0.5] }, { id: 'poured concrete', tech: [0.3, 0.85] },
  { id: 'rolled steel', tech: [0.35, 0.9] }, { id: 'grown chitin', tech: [0.1, 0.9] },
  { id: 'spun basalt', tech: [0.5, 1.0] }, { id: 'diamond weave', tech: [0.75, 1.0] },
  { id: 'salvaged hull plate', tech: [0.15, 0.8] },
];

function pickByTech(pool, tech, rng) {
  const w = pool.map((p) => (tech >= p.tech[0] && tech <= p.tech[1] ? 1 : 0.04));
  return rng.weighted(pool, w);
}

// --- history -----------------------------------------------------------------
//
// A chronology, not a paragraph. Each entry leaves a physical trace that the
// city generator can act on — a wall means an old boundary the street grid still
// remembers, a fire means one quarter is newer than the rest, a plague means an
// entire district is empty and unlit. The prose is there for the player; the
// `effect` field is there for the geometry.

const EVENTS = [
  { kind: 'boom', w: 1.0, tech: [0.0, 1.0], effect: { growth: 0.35 },
    text: (c, r) => `${c.name} doubled in a generation; the ${r.pick(['second ring', 'outer terraces', 'high quarter'])} is all one decade of building.` },
  { kind: 'wall', w: 0.7, tech: [0.0, 0.6], effect: { wall: 1 },
    text: (c, r) => `A wall was raised, and then outgrown ${r.pick(['twice', 'within forty years', 'before it was finished'])}. Its line is still the widest street.` },
  { kind: 'fire', w: 0.6, tech: [0.0, 0.75], effect: { rebuilt: 0.3, ruin: 0.05 },
    text: (c, r) => `${r.pick(['A dry season', 'A refinery fault', 'An unattended kiln'])} took ${r.pick(['a third', 'the whole low quarter', 'nine blocks'])}. What replaced it is straighter than what burned.` },
  { kind: 'plague', w: 0.5, tech: [0.0, 0.8], effect: { abandonment: 0.25, dark: 0.3 },
    text: (c, r) => `The ${r.pick(['grey fever', 'sleeping sickness', 'salt cough'])} emptied the ${r.pick(['warrens', 'dock quarter', 'undercity'])}. It was never fully reoccupied.` },
  { kind: 'war', w: 0.75, tech: [0.1, 1.0], effect: { ruin: 0.22, garrison: 1, dark: 0.12 },
    text: (c, r) => `${r.pick(['A siege', 'An orbital bombardment', 'A neighbour with better artillery'])} took ${r.pick(['the eastern face', 'the high district', 'everything above the fourth terrace'])}. Some of it is still down.` },
  { kind: 'quake', w: 0.45, tech: [0.0, 1.0], effect: { ruin: 0.12, terraceShift: 1 },
    text: (c, r) => `The ground moved. Everything built after leans ${r.pick(['on deeper piles', 'against the slope', 'a little apart from its neighbour'])}.` },
  { kind: 'flood', w: 0.4, tech: [0.0, 1.0], effect: { stilts: 1, ruin: 0.06 },
    text: (c, r) => `The water came up ${r.pick(['four metres', 'to the second storey', 'and stayed'])}. The lower town is on piles now, or is not there.` },
  { kind: 'contact', w: 0.35, tech: [0.45, 1.0], effect: { foreign: 1, growth: 0.2 },
    text: (c, r) => `Someone landed who was not from here. The ${r.pick(['spaceport', 'high apron', 'trade quarter'])} is built in a language ${c.name} does not otherwise speak.` },
  { kind: 'schism', w: 0.5, tech: [0.0, 0.9], effect: { secondStyle: 1 },
    text: (c, r) => `A doctrinal split. Half the city stopped building the way the other half builds, and neither has relented.` },
  { kind: 'exodus', w: 0.3, tech: [0.55, 1.0], effect: { abandonment: 0.35, dark: 0.4 },
    text: (c, r) => `Most of them left ${r.pick(['for the outer system', 'on the last hulls', 'and did not say where'])}. The lights that remain are a fraction of the sockets.` },
  { kind: 'megaproject', w: 0.4, tech: [0.6, 1.0], effect: { mega: 1 },
    text: (c, r) => `They committed everything to one structure, and it is the only thing you will remember about ${c.name}.` },
  { kind: 'renewal', w: 0.5, tech: [0.2, 1.0], effect: { growth: 0.2, ruin: -0.08 },
    text: (c, r) => `A long, unglamorous restoration. Old stone, new joints, and every gutter re-cut.` },
  { kind: 'famine', w: 0.4, tech: [0.0, 0.55], effect: { abandonment: 0.15, agri: 1 },
    text: (c, r) => `Three bad harvests. Every flat surface within a day's walk is terraced now, and the terraces are older than the walls around them.` },
];

const STATES = [
  { id: 'thriving', w: 1.0, lights: 1.0, crowds: 1.0, traffic: 1.0, ruin: 0.0, growth: 1.0,
    blurb: 'Cranes on the skyline and light in every socket.' },
  { id: 'ascendant', w: 0.5, lights: 1.0, crowds: 1.15, traffic: 1.3, ruin: 0.02, growth: 1.4,
    blurb: 'Building faster than it can pave. Half the upper city is scaffold.' },
  { id: 'declining', w: 0.8, lights: 0.62, crowds: 0.55, traffic: 0.5, ruin: 0.12, growth: 0.4,
    blurb: 'More sockets than lamps. The outer quarters went first.' },
  { id: 'at war', w: 0.45, lights: 0.45, crowds: 0.5, traffic: 0.75, ruin: 0.3, growth: 0.5,
    blurb: 'Blackout discipline in the core, fires on the perimeter, and the traffic is all one direction.' },
  { id: 'quarantined', w: 0.25, lights: 0.35, crowds: 0.15, traffic: 0.2, ruin: 0.08, growth: 0.1,
    blurb: 'Sealed at the gates. Automated light, nobody under it.' },
  { id: 'abandoned', w: 0.35, lights: 0.06, crowds: 0.0, traffic: 0.04, ruin: 0.55, growth: 0.0,
    blurb: 'Nothing runs here but the things that were built not to need anyone.' },
];

// --- the generator -----------------------------------------------------------

/**
 * Derives a full culture from a planet record.
 *
 * `planet` needs `type`, `gravity`, `techLevel`, `lifeComplexity`, `palette`,
 * `weather`, `resources`, `oceanCoverage` — i.e. exactly what Catalog.makePlanet
 * produces. Anything missing gets a defensible default so a hand-written stub
 * (like the demo's) still works.
 */
export function makeCivilization(planet, seedOverride = null) {
  const seed = seedOverride ?? planet.seed ?? hashString(planet.name || 'unnamed');
  const rng = new Rng(hashInt(seed ^ 0x1c1f11a));

  const tech = clamp(planet.techLevel ?? 0.4, 0, 1);
  const gravity = (planet.gravity ?? 9.81) / 9.81;
  const ocean = planet.oceanCoverage ?? 0.3;
  const life = planet.lifeComplexity ?? 0.5;

  const phon = makePhonology(rng.fork('phon'));
  const name = speak(phon, rng, 2, 3);
  const demonym = name + rng.pick(['i', 'an', 'ic', 'ese', 'ai', 'en']);

  // --- species ---------------------------------------------------------------
  // Body plan feeds crowd geometry and door heights; nocturnality feeds how much
  // of the city is lit and when the streets are full.
  const nocturnal = rng.bool(clamp(0.25 + smoothstep(6500, 3400, planet.starTemp ?? 5400) * 0.4, 0, 0.8));
  const species = {
    form: rng.weighted(['bipedal', 'bipedal', 'bipedal', 'quadrupedal', 'serpentine', 'radial', 'arthropod'],
      [1, 1, 1, 0.25, 0.12, 0.1, 0.28]),
    // Heavy worlds breed short, wide bodies; low gravity breeds tall thin ones.
    sizeRel: clamp(rng.normal(1, 0.16) * Math.pow(gravity, -0.32), 0.45, 2.1),
    nocturnal,
    aquatic: ocean > 0.75 && rng.bool(0.55),
    // Eye count is pure flavour but it drives window aperture counts and how
    // many lamps a lamp-post carries, which is the sort of consistency nobody
    // consciously notices and everybody feels.
    eyes: rng.weighted([2, 2, 2, 3, 4, 1, 6], [1, 1, 1, 0.3, 0.25, 0.12, 0.1]),
  };

  // --- architecture ----------------------------------------------------------
  // Score every style against the world, take the best few, and let the draw be
  // weighted rather than deterministic. That way a desert usually gets tensile
  // canopies and occasionally, memorably, does not.
  const scored = STYLES.map((s) => ({ s, k: Math.pow(styleScore(s, planet), 2.4) }));
  const primary = rng.weighted(scored.map((x) => x.s), scored.map((x) => x.k));
  const secondaryPool = scored.filter((x) => x.s.id !== primary.id);
  const secondary = rng.weighted(secondaryPool.map((x) => x.s), secondaryPool.map((x) => x.k * 0.6 + 0.05));

  // --- light and colour ------------------------------------------------------
  const light = deriveLightSignature(planet, rng);
  const pal = planet.palette || { base: [0.4, 0.4, 0.4], accent: [0.6, 0.6, 0.6], atmo: [0.5, 0.6, 0.8] };
  // Local materials borrow the planet's own ground colour: a city built out of
  // the hill it stands on is the single cheapest way to make it look native.
  const localStone = [
    lerp(pal.base[0], primary.mat.color[0], 0.55),
    lerp(pal.base[1], primary.mat.color[1], 0.55),
    lerp(pal.base[2], primary.mat.color[2], 0.55),
  ];

  const palette = {
    stone: localStone,
    trim: primary.mat.trim,
    accent: pal.accent,
    cloth: [rng.range(0.2, 0.9), rng.range(0.15, 0.8), rng.range(0.15, 0.8)],
    neon: light.primary.hue,
    neonHDR: hdrFrom(light.primary.hue, light.primary.k),
    neon2: light.secondary.hue,
    neon2HDR: hdrFrom(light.secondary.hue, light.secondary.k * 0.85),
    // Interior light: what people live under, which is almost never the same
    // colour as what they advertise with.
    interior: hdrFrom(
      light.coolBias > 0.5 ? [0.86, 0.93, 1.0] : [1.0, 0.80, 0.52],
      lerp(1.5, 2.4, rng.next())
    ),
    windowWarmth: light.coolBias > 0.55 ? [0.0, 0.4] : [0.5, 1.0],
    signage: hdrFrom(light.primary.hue, light.primary.k * 1.25),
    lightFamily: light.primary.id,
    lightFamily2: light.secondary.id,
  };

  // --- writing ---------------------------------------------------------------
  const family = rng.pick(SCRIPT_FAMILIES);
  const glyphs = {
    family: family.id,
    seed: hashInt(seed ^ 0x91a7b),
    // A real alphabet has a size a reader can hold. Fewer than ~14 reads as
    // decoration; more than ~64 reads as noise at signage resolution.
    count: rng.int(18, 46),
    strokes: family.strokes,
    curvature: clamp(family.curvature + rng.range(-0.15, 0.15), 0, 1),
    angularity: clamp(family.angularity + rng.range(-0.15, 0.15), 0, 1),
    aspect: family.aspect * rng.range(0.85, 1.2),
    baseline: family.baseline,
    serif: family.serif,
    // Diacritics are what stop a made-up script from looking like a font: they
    // recur, they attach at consistent places, and they are optional.
    diacritics: rng.bool(0.55),
    diacriticRate: rng.range(0.15, 0.5),
    direction: rng.weighted(DIRECTIONS, [1.0, 0.4, family.baseline === 'stacked' ? 1.2 : 0.35, 0.12]),
    strokeWidth: rng.range(0.10, 0.22),
    wordLength: [rng.int(2, 3), rng.int(3, 6)],
  };

  // --- settlement ------------------------------------------------------------
  // Pattern is chosen against terrain habit and technology: surveyed grids need
  // instruments, terracing needs slope, scatter needs nobody in charge.
  const patternW = PATTERNS.map((p) => {
    let w = 0.4;
    if (p.id === 'grid') w += tech * 1.2;
    if (p.id === 'radial') w += 0.8 - Math.abs(tech - 0.45);
    if (p.id === 'organic') w += 1.1 - tech * 0.8;
    if (p.id === 'terraced') w += 0.6;
    if (p.id === 'linear') w += tech * 0.5;
    if (p.id === 'scattered') w += (1 - tech) * 0.7;
    if (p.id === 'spoke') w += tech * 0.8;
    return w;
  });
  const pattern = rng.weighted(PATTERNS, patternW);

  // --- technology ------------------------------------------------------------
  const techSig = {
    level: tech,
    era: tech < 0.2 ? 'pre-industrial' : tech < 0.4 ? 'industrial' : tech < 0.62 ? 'atomic'
      : tech < 0.82 ? 'interplanetary' : 'post-scarcity',
    power: pickByTech(POWER, tech, rng),
    transport: pickByTech(TRANSPORT, tech, rng),
    material: pickByTech(MATERIALS, tech, rng),
    orbital: tech > 0.6,
    aerial: tech > 0.55,
    holograms: tech > 0.62,
    // How much the culture advertises. A theocracy in stone puts up banners; a
    // late-capitalist stack-city puts up a hundred metres of animated glyph.
    signageDensity: clamp(Math.pow(tech, 1.4) * rng.range(0.6, 1.5), 0.05, 1.5),
  };

  // --- history ---------------------------------------------------------------
  const nowYear = Math.round(lerp(180, 4200, Math.pow(rng.next(), 1.6)) * (0.5 + tech));
  const eventCount = rng.int(2, 5);
  const pool = EVENTS.filter((e) => tech >= e.tech[0] - 0.1 && tech <= e.tech[1] + 0.1);
  const chosen = [];
  const effect = { growth: 0, wall: 0, ruin: 0, dark: 0, abandonment: 0, rebuilt: 0, garrison: 0, foreign: 0, secondStyle: 0, mega: 0, stilts: 0, agri: 0, terraceShift: 0 };
  const usedKinds = new Set();
  for (let i = 0; i < eventCount; i++) {
    const w = pool.map((e) => (usedKinds.has(e.kind) ? e.w * 0.12 : e.w));
    const e = rng.weighted(pool, w);
    usedKinds.add(e.kind);
    const year = Math.round(lerp(nowYear * 0.08, nowYear * 0.95, (i + rng.range(0.1, 0.9)) / eventCount));
    chosen.push({ year, kind: e.kind, text: e.text({ name }, rng) });
    for (const k in e.effect) effect[k] = (effect[k] || 0) + e.effect[k];
  }
  chosen.sort((a, b) => a.year - b.year);

  // State is weighted by what already happened. Three ruinous events do not
  // leave a thriving city, and a megaproject rarely coexists with abandonment.
  const stateW = STATES.map((s) => {
    let w = s.w;
    if (s.id === 'abandoned') w *= 1 + effect.abandonment * 2.5 - effect.growth;
    if (s.id === 'declining') w *= 1 + effect.abandonment * 1.4 + effect.ruin;
    if (s.id === 'thriving' || s.id === 'ascendant') w *= Math.max(0.05, 1 + effect.growth * 1.6 - effect.ruin * 2 - effect.abandonment * 2);
    if (s.id === 'at war') w *= 1 + effect.garrison * 1.8;
    if (s.id === 'quarantined') w *= 1 + (usedKinds.has('plague') ? 2.2 : 0);
    return Math.max(0.01, w);
  });
  const state = rng.weighted(STATES, stateW);

  const population = Math.round(
    lerp(400, 4.2e6, Math.pow(rng.next(), 2.2)) *
    (0.3 + tech) * (0.4 + life) * clamp(state.growth, 0.05, 1.5)
  );

  const civ = {
    seed,
    id: `civ-${(seed >>> 0).toString(36)}`,
    name,
    demonym,
    phon,
    species,
    styles: {
      primary,
      // A schism in the history is the licence for a genuinely different second
      // language of building inside one city. Without it the secondary is used
      // sparingly, as the older or richer stock.
      secondary,
      secondaryShare: effect.secondStyle ? rng.range(0.28, 0.45) : rng.range(0.06, 0.18),
      ruinBias: clamp(state.ruin + effect.ruin * 0.6, 0, 0.8),
    },
    palette,
    light,
    glyphs,
    settlement: {
      pattern: pattern.id,
      patternBlurb: pattern.blurb,
      ring: pattern.ring, grid: pattern.grid, organic: pattern.organic,
      // Block scale is the most legible cultural signature in plan view and one
      // of the strongest in first person: a 40 m block is a bazaar, a 180 m
      // block is a planned capital.
      blockScale: lerp(38, 165, rng.next()) * clamp(1.15 - tech * 0.25, 0.7, 1.2),
      streetWidth: primary.streetWidth * lerp(0.8, 1.3, rng.next()),
      plazaFrequency: rng.range(0.1, 0.45),
      walled: effect.wall > 0,
      terracing: clamp(pattern.id === 'terraced' ? 1 : rng.range(0, 0.5) + effect.terraceShift * 0.3, 0, 1),
      stilts: effect.stilts > 0 || primary.id === 'stilt',
      preferredSite: rng.weighted(
        ['coast', 'river', 'ridge', 'basin', 'plain', 'crater', 'canyon-rim'],
        [ocean * 2.2 + 0.2, 1.2, 0.7, 0.9, 1.0, planet.atmosphere < 0.2 ? 1.2 : 0.15, 0.5]
      ),
    },
    tech: techSig,
    history: {
      foundedYear: 0,
      nowYear,
      events: chosen,
      state: state.id,
      stateBlurb: state.blurb,
      // Everything downstream reads these three numbers rather than the state
      // string, so a new state can be added without touching the geometry code.
      lights: clamp(state.lights * (1 - effect.dark * 0.5), 0.02, 1.2),
      crowds: clamp(state.crowds * (1 - effect.abandonment * 0.6), 0, 1.3),
      traffic: clamp(state.traffic * (1 - effect.abandonment * 0.5), 0, 1.4),
      ruinFraction: clamp(state.ruin + effect.ruin * 0.5, 0, 0.75),
      growth: state.growth,
      population,
      effect,
    },
    // Naming closures, bound to this culture's phonology so every label in the
    // city belongs to the same language.
    naming: null,
    lore: '',
  };

  civ.naming = makeNaming(civ);
  civ.lore = writeLore(civ, rng.fork('lore'));
  return civ;
}

/** Name factories bound to one culture. All take an Rng so they stay pure. */
function makeNaming(civ) {
  const p = civ.phon;
  return {
    place: (rng) => speak(p, rng, 1, 3),
    person: (rng) => speak(p, rng, 2, 3),
    district: (rng, kind) => {
      const nouns = DISTRICT_NOUNS[kind] || TOPO;
      const proper = speak(p, rng, 1, 2);
      const roll = rng.next();
      if (roll < 0.42) return `${proper} ${rng.pick(nouns)}`;
      if (roll < 0.7) return `${rng.pick(nouns)} of ${proper}`;
      if (roll < 0.86) return `${proper}, ${rng.pick(EPITHET)}`;
      return rng.pick(nouns);
    },
    landmark: (rng, kind) => {
      const proper = speak(p, rng, 1, 2);
      const forms = {
        spire: ['Spire', 'Needle', 'Mast', 'Pillar of Ascent'],
        ring: ['Ring', 'Halo', 'Wheel', 'Girdle'],
        arch: ['Arch', 'Gate', 'Span', 'Threshold'],
        statue: ['Colossus', 'Watcher', 'Standing Figure', 'Effigy'],
        ziggurat: ['Ziggurat', 'Great Tier', 'Stepped House', 'Ascension'],
        monolith: ['Monolith', 'Slab', 'Unmarked Stone', 'The Object'],
        cradle: ['Cradle', 'Anchorage', 'Downwell', 'Tether Root'],
      }[kind] || ['Monument'];
      return rng.bool(0.55) ? `The ${rng.pick(forms)} of ${proper}` : `${proper} ${rng.pick(forms)}`;
    },
    // Short strings for signage. Kept meaningless on purpose — the point is the
    // shape of the writing, not a translation.
    word: (rng) => {
      const n = rng.int(civ.glyphs.wordLength[0], civ.glyphs.wordLength[1]);
      const out = [];
      for (let i = 0; i < n; i++) out.push(rng.int(0, civ.glyphs.count - 1));
      return out;
    },
  };
}

/** Two or three sentences a UI panel can print without further formatting. */
function writeLore(civ, rng) {
  const h = civ.history;
  const era = civ.tech.era;
  const last = h.events[h.events.length - 1];
  const s1 = `${civ.name} has stood for ${h.nowYear.toLocaleString()} local years, ${h.population > 1e6
    ? `${(h.population / 1e6).toFixed(1)} million` : h.population.toLocaleString()} strong at its height, an ${era} people who build in ${civ.styles.primary.name.toLowerCase()}.`;
  const s2 = `${civ.settlement.patternBlurb} ${civ.tech.power.id.charAt(0).toUpperCase() + civ.tech.power.id.slice(1)} under everything, ${civ.tech.transport.id} above it.`;
  const s3 = last ? `${last.text} ${h.stateBlurb}` : h.stateBlurb;
  return `${s1} ${s2} ${s3}`;
}

// --- district mix ------------------------------------------------------------

/**
 * Which district types this culture's cities contain, and in what proportion.
 *
 * Returned as weights rather than a list so CityGen can draw as many cells as
 * the site supports without this file knowing the city's size. The gating is
 * the interesting part: a pre-industrial culture has no spaceport and a
 * post-scarcity one has no slums worth the name, and both facts are visible
 * from a kilometre up.
 */
export function districtMix(civ, opts = {}) {
  const t = civ.tech.level;
  const coastal = !!opts.coastal;
  const pop = civ.history.population;
  const mix = [
    { kind: 'civic', w: 1.0, min: 1, max: 1 },
    { kind: 'residential', w: 3.4 + pop / 8e5, min: 1, max: 9 },
    { kind: 'market', w: 1.2 + (1 - t) * 0.6, min: 0, max: 2 },
    { kind: 'industrial', w: t > 0.22 ? 1.4 + t : 0.15, min: 0, max: 3 },
    { kind: 'temple', w: 0.9 + (1 - t) * 0.9, min: 0, max: 2 },
    { kind: 'necropolis', w: 0.5 + (1 - t) * 0.5, min: 0, max: 1 },
    { kind: 'slums', w: clamp(1.5 - Math.abs(t - 0.45) * 2.2, 0.05, 1.6) * (civ.history.state === 'abandoned' ? 0.2 : 1), min: 0, max: 3 },
    { kind: 'spaceport', w: t > 0.62 ? 1.1 : 0.02, min: 0, max: 1 },
    { kind: 'agricultural', w: t < 0.8 ? 1.0 + civ.history.effect.agri * 0.8 : 0.25, min: 0, max: 3 },
    { kind: 'docks', w: coastal ? 1.6 : 0.02, min: 0, max: 2 },
    { kind: 'academy', w: t > 0.35 ? 0.8 : 0.1, min: 0, max: 1 },
    { kind: 'garrison', w: 0.4 + civ.history.effect.garrison * 1.2, min: 0, max: 1 },
  ];
  return mix;
}

/**
 * Per-district character. This is the table that stops every quarter of the
 * city from being the same quarter: it changes how tall things get, how tightly
 * they pack, how bright and how populated they are, and which style leaks in.
 */
export const DISTRICT_CHARACTER = {
  civic:        { height: 1.35, density: 0.85, lot: 1.5, lights: 1.0, crowd: 0.9,  signage: 0.7, plaza: 0.9,  ruin: 0.4, green: 0.5, industry: 0.0 },
  residential:  { height: 0.85, density: 0.9,  lot: 0.8, lights: 1.1, crowd: 0.8,  signage: 0.4, plaza: 0.35, ruin: 0.8, green: 0.6, industry: 0.0 },
  market:       { height: 0.55, density: 1.15, lot: 0.5, lights: 1.25, crowd: 1.5, signage: 1.6, plaza: 0.8,  ruin: 0.6, green: 0.15, industry: 0.1 },
  industrial:   { height: 0.7,  density: 0.7,  lot: 2.2, lights: 0.7, crowd: 0.35, signage: 0.35, plaza: 0.1, ruin: 1.2, green: 0.05, industry: 1.0 },
  temple:       { height: 1.1,  density: 0.5,  lot: 2.0, lights: 0.8, crowd: 0.6,  signage: 0.5, plaza: 1.0,  ruin: 0.7, green: 0.7, industry: 0.0 },
  necropolis:   { height: 0.45, density: 0.55, lot: 1.1, lights: 0.35, crowd: 0.1, signage: 0.15, plaza: 0.5, ruin: 1.4, green: 0.5, industry: 0.0 },
  slums:        { height: 0.5,  density: 1.35, lot: 0.32, lights: 0.85, crowd: 1.3, signage: 0.9, plaza: 0.2, ruin: 1.6, green: 0.1, industry: 0.2 },
  spaceport:    { height: 0.6,  density: 0.35, lot: 3.4, lights: 1.15, crowd: 0.7, signage: 0.8, plaza: 0.6,  ruin: 0.3, green: 0.05, industry: 0.6 },
  agricultural: { height: 0.25, density: 0.3,  lot: 2.8, lights: 0.4, crowd: 0.3,  signage: 0.1, plaza: 0.15, ruin: 0.6, green: 1.5, industry: 0.1 },
  docks:        { height: 0.5,  density: 0.75, lot: 1.8, lights: 0.9, crowd: 0.8,  signage: 0.7, plaza: 0.3,  ruin: 1.1, green: 0.1, industry: 0.7 },
  academy:      { height: 0.95, density: 0.6,  lot: 1.7, lights: 0.95, crowd: 0.7, signage: 0.4, plaza: 0.8,  ruin: 0.4, green: 0.9, industry: 0.0 },
  garrison:     { height: 0.6,  density: 0.7,  lot: 1.9, lights: 0.6, crowd: 0.4,  signage: 0.2, plaza: 0.4,  ruin: 0.5, green: 0.2, industry: 0.3 },
};

export { speak as speakName, STATES, PATTERNS };
