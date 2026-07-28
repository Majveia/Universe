/**
 * The Codex: a discovery journal that is mostly typography.
 *
 * This is the one screen in UNIVERSE that is allowed to be a document. Every
 * other surface is an instrument reflected in glass; this is the notebook you
 * open when the instrument told you something worth writing down. So it is set
 * like a page — a 34px hairline-weight name, a mono designation under it, a rule,
 * then facts in a measured grid — and it obeys the same OLED rule as everything
 * else: no panels, no fills, structure drawn at one pixel and 8% alpha.
 *
 * What goes in it is real. The numbers are not flavour text: mass is in Earth
 * masses because that is the unit a person can feel, gravity is derived from
 * GM/r² by the catalog and merely divided by 9.80665 here, and temperature is
 * the equilibrium temperature plus the greenhouse term the atmosphere actually
 * earns. Nothing in this file invents a quantity; it formats quantities that
 * already exist and refuses to display the ones that do not apply.
 *
 * Species entries are the exception, and they are generated *here* rather than
 * in the catalog on purpose: a species is only ever observed, never simulated,
 * so it has no reason to exist until something looks at a world and asks what
 * lives on it. `describeSpecies` derives one deterministically from the planet's
 * own seed, which means the same world always has the same biosphere without a
 * byte of it being stored.
 *
 * Navigation is a listbox, properly. Arrow keys move the selection, Home/End
 * jump, the tabs filter, Escape closes, and focus is restored to whatever had it
 * before the panel opened. The whole thing is reachable with a keyboard because
 * a journal you cannot read without a mouse is not a journal.
 */

import { Rng, hashString } from '../core/Rng.js';

const el = (tag, cls, parent) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
};

const GROUPS = [
  { id: 'system', label: 'Systems' },
  { id: 'world', label: 'Worlds' },
  { id: 'life', label: 'Life' },
  { id: 'site', label: 'Sites' },
];
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'system', label: 'Systems' },
  { id: 'world', label: 'Worlds' },
  { id: 'life', label: 'Life' },
];

const PLANET_KIND = {
  molten: 'Molten', barren: 'Barren', desert: 'Desert', temperate: 'Temperate',
  jungle: 'Jungle', ocean: 'Oceanic', frozen: 'Frozen', toxic: 'Toxic',
  irradiated: 'Irradiated', gasgiant: 'Gas Giant', icegiant: 'Ice Giant',
  exotic: 'Anomalous', ringworld: 'Ringworld',
};

const STORE_KEY = 'universe.codex';
const STORE_LIMIT = 400;

export class Codex {
  constructor(ctx) {
    this.ctx = ctx || {};
    this.isOpen = false;

    // Panels mount at the document root, not inside `#ui`. `#ui` is
    // `pointer-events: none` by design and a full-screen modal that needs real
    // clicks should not be punching a hole back through it.
    this.root = el('div', 'panel codex-panel', document.body);
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', 'Codex');
    this.root.setAttribute('aria-hidden', 'true');

    const inner = el('div', 'panel-inner', this.root);
    const head = el('div', 'panel-head', inner);
    const title = el('div', 'panel-title', head);
    title.textContent = 'CODEX';

    const headRight = el('div', 'panel-head-right', head);
    this.tabs = el('div', 'seg panel-tabs', headRight);
    this.tabs.setAttribute('role', 'group');
    this.tabs.setAttribute('aria-label', 'Filter');
    this._tabNodes = FILTERS.map((f) => {
      const b = el('button', null, this.tabs);
      b.type = 'button';
      b.textContent = f.label;
      b.dataset.filter = f.id;
      b.addEventListener('click', () => this.setFilter(f.id));
      return b;
    });
    this.hint = el('div', 'panel-hint', headRight);
    this.hint.textContent = 'ESC — CLOSE';

    const body = el('div', 'panel-body', inner);
    const grid = el('div', 'codex-grid', body);

    this.list = el('div', 'codex-list scroll', grid);
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', 'Discoveries');
    this.list.tabIndex = 0;
    this.count = el('div', 'codex-count', this.list);
    this.listBody = el('div', null, this.list);

    this.detail = el('div', 'codex-detail scroll', grid);
    this._buildDetail();

    this.entries = [];
    this._byId = new Map();
    this._filter = 'all';
    this._selected = null;
    this._visible = [];
    this._returnFocus = null;

    this._onKey = (e) => this._key(e);
    this.list.addEventListener('keydown', this._onKey);
    this.tabs.addEventListener('keydown', (e) => this._tabKey(e));

    this._load();
    this._render();
  }

  _buildDetail() {
    this.dKind = el('div', 'cd-kind', this.detail);
    this.dName = el('div', 'cd-name', this.detail);
    this.dDesig = el('div', 'cd-desig', this.detail);
    el('div', 'cd-rule', this.detail);
    this.dStats = el('div', 'cd-stats', this.detail);
    this._statPool = [];

    this.dHab = el('div', 'cd-hab', this.detail);
    const habHead = el('div', 'cd-hab-head', this.dHab);
    const habK = el('div', 'k', habHead);
    habK.textContent = 'Habitability';
    this.dHabVal = el('div', 'v', habHead);
    this.dHabBar = el('div', 'cd-hab-bar', this.dHab);
    this.dHabFill = el('i', null, this.dHabBar);

    this.dNote = el('div', 'cd-note', this.detail);
    this.dTags = el('div', 'cd-tags', this.detail);
    this._tagPool = [];
  }

  // --------------------------------------------------------------- contents --

  /**
   * Accepts a Catalog star, a Catalog planet, a `makeSystem` result, a species
   * from `describeSpecies`, or a plain `{kind, name, stats, note}`. Returns the
   * normalised entry, or the existing one if this is a re-scan — finding the
   * same world twice is not a new discovery and must not create a second page.
   */
  add(record) {
    if (!record) return null;
    const entry = normalise(record);
    if (!entry) return null;
    const existing = this._byId.get(entry.id);
    if (existing) return existing;

    this.entries.push(entry);
    this._byId.set(entry.id, entry);
    // A system implies its star; adding one should not require the caller to
    // remember to add the other.
    if (record.star && record.planets) {
      for (const p of record.planets) if (p.hasLife) this.add(p);
    }
    this._save();
    if (this.isOpen) this._render();
    else this._dirty = true;
    return entry;
  }

  has(id) {
    return this._byId.has(id);
  }

  get size() {
    return this.entries.length;
  }

  setFilter(id) {
    if (id === this._filter) return;
    this._filter = id;
    this._render();
  }

  // ------------------------------------------------------------------ panel --

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this._returnFocus = document.activeElement;
    this.root.classList.add('open');
    this.root.setAttribute('aria-hidden', 'false');
    if (this._dirty) { this._dirty = false; this._render(); }
    // Focus the selected row if there is one so the arrow keys work
    // immediately; otherwise the list itself, which is still a valid tab stop.
    (this._selectedNode || this.list).focus({ preventScroll: true });
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.classList.remove('open');
    this.root.setAttribute('aria-hidden', 'true');
    const back = this._returnFocus;
    this._returnFocus = null;
    if (back && back.isConnected && back !== document.body) back.focus({ preventScroll: true });
  }

  // ----------------------------------------------------------------- render --

  _render() {
    const list = this._filter === 'all'
      ? this.entries
      : this.entries.filter((e) => e.group === this._filter);

    // Newest first inside each group: the journal is read from the last thing
    // that happened backwards, not from the first thing you ever saw.
    const byGroup = new Map();
    for (const e of list) {
      if (!byGroup.has(e.group)) byGroup.set(e.group, []);
      byGroup.get(e.group).push(e);
    }

    this.count.textContent = this.entries.length
      ? `${this.entries.length} CATALOGUED`
      : '';

    this.listBody.textContent = '';
    this._visible = [];

    if (!list.length) {
      const empty = el('div', 'codex-empty', this.listBody);
      empty.textContent = this.entries.length ? 'nothing of this kind yet' : 'nothing catalogued yet';
      this._selected = null;
      this._selectedNode = null;
      this._paintDetail(null);
      for (const b of this._tabNodes) b.setAttribute('aria-pressed', String(b.dataset.filter === this._filter));
      return;
    }

    for (const g of GROUPS) {
      const items = byGroup.get(g.id);
      if (!items || !items.length) continue;
      const h = el('div', 'codex-group', this.listBody);
      h.textContent = g.label;
      for (let i = items.length - 1; i >= 0; i--) this._row(items[i]);
    }

    for (const b of this._tabNodes) b.setAttribute('aria-pressed', String(b.dataset.filter === this._filter));

    const keep = this._selected && this._visible.includes(this._selected)
      ? this._selected
      : this._visible[0];
    this._select(keep, false);
  }

  _row(entry) {
    const b = el('button', 'codex-item', this.listBody);
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.id = `cx-${++rowSeq}`;
    b.tabIndex = -1;
    const name = el('div', 'ci-name', b);
    name.textContent = entry.name;
    const meta = el('div', 'ci-meta', b);
    meta.textContent = entry.meta;
    b.addEventListener('click', () => this._select(entry, true));
    entry._node = b;
    this._visible.push(entry);
  }

  _select(entry, focus) {
    if (this._selectedNode) this._selectedNode.setAttribute('aria-selected', 'false');
    this._selected = entry || null;
    this._selectedNode = entry?._node || null;
    if (this._selectedNode) {
      this._selectedNode.setAttribute('aria-selected', 'true');
      this.list.setAttribute('aria-activedescendant', this._selectedNode.id || '');
      if (focus) this._selectedNode.focus({ preventScroll: true });
      // `nearest` rather than `center`: the list should shuffle by one row when
      // you walk off the end, not jump under your eye on every keypress.
      this._selectedNode.scrollIntoView({ block: 'nearest' });
    }
    this._paintDetail(entry);
  }

  _paintDetail(entry) {
    if (!entry) {
      this.detail.style.visibility = 'hidden';
      return;
    }
    this.detail.style.visibility = '';
    this.dKind.textContent = entry.kind;
    this.dName.textContent = entry.name;
    this.dDesig.textContent = entry.desig || '';
    this.dDesig.style.display = entry.desig ? '' : 'none';

    const stats = entry.stats || [];
    while (this._statPool.length < stats.length) {
      const node = el('div', 'cd-stat', this.dStats);
      const k = el('div', 'k', node);
      const v = el('div', 'v', node);
      // Value first as a bare text node, unit second as a span: the unit is set
      // at two thirds the size and half the alpha, so "1.04" reads as a number
      // while "1.04 g" reads as a sentence — and the grid wants numbers.
      const value = document.createTextNode('');
      v.appendChild(value);
      const u = el('span', 'u', v);
      this._statPool.push({ node, k, value, u });
    }
    this._statPool.forEach((slot, i) => {
      const s = stats[i];
      if (!s) { slot.node.style.display = 'none'; return; }
      slot.node.style.display = '';
      slot.k.textContent = s.k;
      slot.value.nodeValue = s.v;
      slot.u.textContent = s.u || '';
    });

    const hab = entry.habitability;
    if (typeof hab === 'number') {
      this.dHab.style.display = '';
      this.dHabVal.textContent = `${Math.round(hab * 100)}%`;
      // One transform write. The bar is a hairline and the fill is a scaleX, so
      // the meter animating in costs nothing and never reflows the page.
      requestAnimationFrame(() => { this.dHabFill.style.transform = `scaleX(${hab.toFixed(3)})`; });
      this.dHabFill.style.transform = 'scaleX(0)';
    } else {
      this.dHab.style.display = 'none';
    }

    this.dNote.textContent = entry.note || '';
    this.dNote.style.display = entry.note ? '' : 'none';

    const tags = entry.tags || [];
    while (this._tagPool.length < tags.length) this._tagPool.push(el('div', 'tag', this.dTags));
    this._tagPool.forEach((node, i) => {
      const t = tags[i];
      if (!t) { node.style.display = 'none'; return; }
      node.style.display = '';
      node.className = `tag${t.tone ? ` ${t.tone}` : ''}`;
      node.textContent = t.label;
    });
    this.detail.scrollTop = 0;
  }

  // -------------------------------------------------------------- keyboard --

  _key(e) {
    const n = this._visible.length;
    if (!n) return;
    const i = this._visible.indexOf(this._selected);
    let next = -1;
    switch (e.code) {
      case 'ArrowDown': next = Math.min(n - 1, i + 1); break;
      case 'ArrowUp': next = Math.max(0, i - 1); break;
      case 'PageDown': next = Math.min(n - 1, i + 8); break;
      case 'PageUp': next = Math.max(0, i - 8); break;
      case 'Home': next = 0; break;
      case 'End': next = n - 1; break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (next >= 0 && next !== i) this._select(this._visible[next], true);
  }

  _tabKey(e) {
    if (e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;
    e.preventDefault();
    const i = FILTERS.findIndex((f) => f.id === this._filter);
    const d = e.code === 'ArrowRight' ? 1 : -1;
    const next = (i + d + FILTERS.length) % FILTERS.length;
    this.setFilter(FILTERS[next].id);
    this._tabNodes[next].focus();
  }

  // ------------------------------------------------------------ persistence --

  _save() {
    try {
      const slim = this.entries.slice(-STORE_LIMIT).map((e) => ({
        id: e.id, group: e.group, kind: e.kind, name: e.name, desig: e.desig,
        meta: e.meta, stats: e.stats, note: e.note, tags: e.tags,
        habitability: e.habitability,
      }));
      localStorage.setItem(STORE_KEY, JSON.stringify(slim));
    } catch (err) { /* private browsing, or quota — the journal is not worth an exception */ }
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return;
      for (const e of list) {
        if (!e || !e.id || this._byId.has(e.id)) continue;
        this.entries.push(e);
        this._byId.set(e.id, e);
      }
    } catch (err) { /* corrupt store; start a fresh journal rather than fail to boot */ }
  }

  dispose() {
    this.list.removeEventListener('keydown', this._onKey);
    this.root.remove();
  }
}

// --- normalisation ------------------------------------------------------------

function normalise(r) {
  if (r.codexKind === 'species' || r.kind === 'species') return speciesEntry(r);
  if (r.star && Array.isArray(r.planets)) return systemEntry(r);
  if (typeof r.massEarth === 'number') return planetEntry(r);
  if (typeof r.massSolar === 'number') return starEntry(r);
  if (r.name) return plainEntry(r);
  return null;
}

function plainEntry(r) {
  return {
    id: r.id || `x:${hashString(r.name + (r.kind || ''))}`,
    group: r.group || 'site',
    kind: (r.kind || 'Record').toUpperCase(),
    name: r.name,
    desig: r.desig || '',
    meta: r.meta || (r.kind || '').toUpperCase(),
    stats: r.stats || [],
    note: r.note || '',
    tags: r.tags || [],
    habitability: r.habitability,
  };
}

function systemEntry(sys) {
  const s = sys.star;
  const live = sys.planets.filter((p) => p.hasLife).length;
  const civ = sys.planets.filter((p) => p.hasCivilization).length;
  const base = starEntry(s);
  base.group = 'system';
  base.kind = 'STAR SYSTEM';
  base.stats = [
    { k: 'Class', v: s.label },
    { k: 'Mass', v: s.massSolar.toFixed(2), u: 'M☉' },
    { k: 'Luminosity', v: lum(s.lumSolar), u: 'L☉' },
    { k: 'Photosphere', v: Math.round(s.temp).toLocaleString('en-US'), u: 'K' },
    { k: 'Age', v: s.age.toFixed(1), u: 'Gyr' },
    { k: 'Planets', v: String(sys.planets.length) },
    { k: 'Habitable zone', v: `${(s.hzInner / 1.495978707e11).toFixed(2)}–${(s.hzOuter / 1.495978707e11).toFixed(2)}`, u: 'au' },
  ];
  base.meta = `${s.label} · ${sys.planets.length} WORLDS`;
  base.tags = [
    ...(base.tags || []),
    live ? { label: `${live} biospheres`, tone: 'live' } : null,
    civ ? { label: `${civ} civilisations`, tone: 'hot' } : null,
  ].filter(Boolean);
  return base;
}

function starEntry(s) {
  const tags = [];
  if (s.isExotic) tags.push({ label: s.label, tone: 'hot' });
  if (s.kind === 'binary') tags.push({ label: 'binary' });
  if (s.flareActivity > 0.6) tags.push({ label: 'flare star', tone: 'hot' });
  if (s.metallicity < -0.5) tags.push({ label: 'metal poor' });

  return {
    id: `s:${s.seed}`,
    group: 'system',
    kind: 'STAR',
    name: s.name,
    desig: `${s.label}  ·  seed ${s.seed}`,
    meta: `${s.label} · ${Math.round(s.temp).toLocaleString('en-US')} K`,
    stats: [
      { k: 'Class', v: s.label },
      { k: 'Mass', v: s.massSolar.toFixed(2), u: 'M☉' },
      { k: 'Radius', v: s.radiusSolar < 0.01 ? s.radiusSolar.toExponential(1) : s.radiusSolar.toFixed(2), u: 'R☉' },
      { k: 'Luminosity', v: lum(s.lumSolar), u: 'L☉' },
      { k: 'Photosphere', v: Math.round(s.temp).toLocaleString('en-US'), u: 'K' },
      { k: 'Age', v: s.age.toFixed(1), u: 'Gyr' },
    ],
    note: starNote(s),
    tags,
  };
}

function planetEntry(p) {
  const g = p.gravity / 9.80665;
  const stats = [
    { k: 'Type', v: PLANET_KIND[p.type] || p.type },
    { k: 'Mass', v: p.massEarth < 10 ? p.massEarth.toFixed(2) : Math.round(p.massEarth).toLocaleString('en-US'), u: 'M⊕' },
    { k: 'Radius', v: p.radiusEarth.toFixed(2), u: 'R⊕' },
    { k: 'Gravity', v: g.toFixed(2), u: 'g' },
    { k: 'Surface', v: celsius(p.surfaceTemp), u: '°C' },
    { k: 'Atmosphere', v: p.atmosphere > 0.02 ? p.atmosphere.toFixed(2) : '—', u: p.atmosphere > 0.02 ? 'atm' : '' },
    { k: 'Day', v: hours(p.rotationPeriod), u: 'h' },
    orbitalPeriod(p.period),
    { k: 'Orbit', v: p.orbitRadiusAU.toFixed(2), u: 'au' },
    { k: 'Escape', v: (p.escapeVelocity / 1000).toFixed(1), u: 'km/s' },
  ];
  if (p.oceanCoverage > 0.01) stats.push({ k: 'Ocean', v: `${Math.round(p.oceanCoverage * 100)}`, u: '%' });
  if (p.moonCount) stats.push({ k: 'Moons', v: String(p.moonCount) });

  const tags = [];
  if (p.hasCivilization) tags.push({ label: 'inhabited', tone: 'hot' });
  else if (p.hasLife) tags.push({ label: 'biosphere', tone: 'live' });
  if (p.tidallyLocked) tags.push({ label: 'tidally locked' });
  if (p.hasRings) tags.push({ label: 'ringed' });
  if (p.weather?.hasDustStorms) tags.push({ label: 'dust storms' });
  if (p.weather?.auroraStrength > 0.7) tags.push({ label: 'aurorae' });
  if (p.type === 'irradiated') tags.push({ label: 'radiation', tone: 'hot' });
  if (p.type === 'toxic') tags.push({ label: 'toxic atmosphere', tone: 'hot' });

  return {
    id: `p:${p.seed}`,
    group: 'world',
    kind: (PLANET_KIND[p.type] || p.type).toUpperCase(),
    name: p.name,
    desig: p.designation,
    meta: `${PLANET_KIND[p.type] || p.type} · ${g.toFixed(2)}g · ${celsius(p.surfaceTemp)}°C`,
    stats,
    note: planetNote(p),
    tags,
    habitability: p.isGiant ? undefined : p.habitability,
  };
}

function speciesEntry(sp) {
  return {
    id: sp.id,
    group: 'life',
    kind: sp.tier.toUpperCase(),
    name: sp.name,
    desig: sp.binomial,
    meta: `${sp.tier} · ${sp.home}`,
    stats: [
      { k: 'Body plan', v: sp.plan },
      { k: 'Symmetry', v: sp.symmetry },
      { k: 'Mass', v: sp.massKg < 1 ? (sp.massKg * 1000).toFixed(0) : sp.massKg.toFixed(1), u: sp.massKg < 1 ? 'g' : 'kg' },
      { k: 'Height', v: sp.heightM < 1 ? (sp.heightM * 100).toFixed(0) : sp.heightM.toFixed(1), u: sp.heightM < 1 ? 'cm' : 'm' },
      { k: 'Metabolism', v: sp.metabolism },
      { k: 'Locomotion', v: sp.locomotion },
      { k: 'Sociality', v: sp.sociality },
      { k: 'Sensory', v: sp.sense },
    ],
    note: sp.note,
    tags: sp.tags,
  };
}

// --- prose --------------------------------------------------------------------
//
// The notes are assembled from clauses rather than templated from one string,
// because a template produces the same sentence with different nouns and a
// clause list produces sentences of different *shapes*. Every clause below is
// conditional on a real quantity, so a world that is unremarkable simply gets a
// shorter note instead of a padded one.

function starNote(s) {
  const c = [];
  if (s.kind === 'BH') c.push('No light leaves it. Everything known about it is inferred from what falls in.');
  else if (s.kind === 'NS' || s.kind === 'PSR') c.push('A stellar core the size of a city, spinning at a rate that would tear a planet apart.');
  else if (s.kind === 'WD') c.push('A dead core cooling on a timescale longer than the present age of the universe.');
  else if (s.kind === 'RG') c.push('Swollen off the main sequence; whatever orbited close is already inside it.');
  else if (s.class === 'M') c.push('A red dwarf — the commonest kind of star there is, and the longest lived. It will still be burning long after the last massive star has gone.');
  else if (s.class === 'O' || s.class === 'B') c.push('Massive, blue, and short-lived. Stars like this die before their planets finish forming.');
  else if (s.class === 'G') c.push('A yellow dwarf of the kind that raised us.');

  if (s.flareActivity > 0.6) c.push('Flare activity is high enough to sterilise anything without a magnetosphere.');
  if (s.age > 9) c.push(`At ${s.age.toFixed(1)} billion years it predates most of the metals in its own planets.`);
  if (s.metallicity < -0.6) c.push('Metal-poor: an early-generation star, formed before much of the galaxy had been enriched.');
  return c.join(' ');
}

function planetNote(p) {
  const c = [];
  const g = p.gravity / 9.80665;

  if (p.isGiant) {
    c.push(p.type === 'icegiant'
      ? 'An ice giant: a mantle of water, ammonia and methane under a hydrogen envelope, with no surface to stand on.'
      : 'A gas giant. There is no ground here — pressure rises until hydrogen stops behaving like a gas.');
  } else if (p.habitability > 0.6) {
    c.push('Breathable, standable, survivable without a suit. Worlds like this are the rarest thing in the catalogue.');
  } else if (p.surfaceTemp > 700) {
    c.push('Surface rock is at the temperature of a foundry. Nothing volatile has survived here since the disc cleared.');
  } else if (p.surfaceTemp < 120) {
    c.push('Cold enough that the atmosphere itself is a candidate for freezing out onto the ground.');
  }

  if (p.tidallyLocked) c.push('Tidally locked — one hemisphere in permanent day, one in permanent night, and a ring of twilight between them where the weather never stops.');
  if (p.oceanCoverage > 0.9) c.push('Effectively a water world; land is limited to island arcs and storm-scoured shoals.');
  else if (p.hasWater && p.oceanCoverage > 0.2) c.push(`Liquid water covers ${Math.round(p.oceanCoverage * 100)}% of the surface.`);

  if (!p.isGiant) {
    if (g > 1.8) c.push(`At ${g.toFixed(1)}g, an unassisted human would not stand for long.`);
    else if (g < 0.35) c.push(`Surface gravity of ${g.toFixed(2)}g — a walk becomes a series of long, slow falls.`);
  }
  if (p.atmosphere < 0.05 && !p.isGiant) c.push('No meaningful atmosphere. The sky is black at noon and the craters have not eroded in three billion years.');
  else if (p.type === 'toxic') c.push('The envelope is thick and chemically hostile; a suit breach here is measured in seconds.');

  if (p.hasCivilization) {
    c.push(`Inhabited. Technology reads at roughly ${Math.round(p.techLevel * 100)}% of the catalogue's upper index — ${techPhrase(p.techLevel)}.`);
  } else if (p.hasLife) {
    c.push(p.lifeComplexity > 0.6
      ? 'Complex multicellular life, independently evolved, and entirely indifferent to being observed.'
      : 'Life is present but simple — microbial mats, chemosynthetic films, the long patient middle of a biosphere.');
  }

  if (p.weather?.stormIntensity > 0.8 && p.atmosphere > 0.3) c.push('Storm systems here persist for decades.');
  if (p.hasRings) c.push('A ring system throws a hard shadow across the equator once a year.');

  return c.join(' ');
}

function techPhrase(t) {
  if (t < 0.35) return 'pre-industrial, and unaware of us';
  if (t < 0.6) return 'industrial, radio-loud, and looking outward';
  if (t < 0.85) return 'interplanetary, with permanent presence off-world';
  return 'post-scarcity by any measure we have';
}

// --- species ------------------------------------------------------------------

const PLANS = ['Bilaterian', 'Radial', 'Colonial', 'Vermiform', 'Crystalline', 'Filamentous', 'Chitinous', 'Cephalised', 'Segmented', 'Sessile'];
const LOCO = ['Bipedal', 'Quadrupedal', 'Hexapodal', 'Undulatory', 'Brachiating', 'Buoyant', 'Jet-propelled', 'Burrowing', 'Gliding', 'Rooted'];
const METAB = ['Photosynthetic', 'Chemosynthetic', 'Heterotrophic', 'Lithotrophic', 'Methanogenic', 'Radiotrophic'];
const SOCIAL = ['Solitary', 'Pair-bonded', 'Small troop', 'Herd', 'Eusocial', 'Hive', 'Distributed'];
const SENSE = ['Trichromatic', 'Infrared', 'Echolocating', 'Electroreceptive', 'Magnetoreceptive', 'Chemotactic', 'Polarisation-sensitive', 'Blind'];
const SYMM = ['Bilateral', 'Radial (5)', 'Radial (8)', 'Spiral', 'Asymmetric'];
const GENUS_A = ['Cryo', 'Thermo', 'Litho', 'Pelago', 'Aero', 'Xantho', 'Melano', 'Chryso', 'Steno', 'Macro', 'Micro', 'Halo', 'Noct', 'Helio'];
const GENUS_B = ['pod', 'phyte', 'therm', 'saur', 'form', 'ptera', 'derm', 'cyte', 'gnath', 'nema'];
const EPITHET = ['profundus', 'vagans', 'silens', 'gravis', 'lucens', 'tenuis', 'ferox', 'placidus', 'obscurus', 'sapiens', 'gelidus', 'aestivus'];

/**
 * A biosphere derived from the world it lives on, not sampled from a bag.
 *
 * Every trait is conditioned on a physical fact the catalog already computed:
 * high gravity produces low, wide, many-limbed body plans; a thick atmosphere
 * permits flight at larger masses; a tidally locked world pushes life toward
 * infrared vision because half of it never sees its star. That coupling is what
 * makes a species read as *from* somewhere rather than as a random creature with
 * a random name.
 *
 * @param {object} planet a Catalog planet record
 * @param {number} [index] which species on that world; same index, same animal
 */
export function describeSpecies(planet, index = 0) {
  const rng = new Rng(hashString(`species:${planet.seed}:${index}`));
  const g = planet.gravity / 9.80665;
  const thick = planet.atmosphere;
  const cold = planet.surfaceTemp < 250;
  const dark = planet.tidallyLocked || planet.flux < 0.25;

  // Gravity sets the body plan budget. A 2.4g world does not grow tall things.
  const plan = g > 1.6 ? rng.pick(['Segmented', 'Chitinous', 'Vermiform', 'Radial'])
    : g < 0.4 ? rng.pick(['Filamentous', 'Colonial', 'Radial', 'Bilaterian'])
    : rng.pick(PLANS);
  const locomotion = g > 1.6 ? rng.pick(['Hexapodal', 'Undulatory', 'Burrowing', 'Quadrupedal'])
    : thick > 0.9 && g < 1.1 ? rng.pick(['Gliding', 'Buoyant', 'Brachiating', 'Bipedal'])
    : planet.oceanCoverage > 0.85 ? rng.pick(['Undulatory', 'Jet-propelled', 'Buoyant'])
    : rng.pick(LOCO);
  const metabolism = dark ? rng.pick(['Chemosynthetic', 'Lithotrophic', 'Methanogenic'])
    : planet.type === 'irradiated' ? 'Radiotrophic'
    : rng.pick(METAB);
  const sense = dark ? rng.pick(['Infrared', 'Echolocating', 'Electroreceptive', 'Chemotactic'])
    : rng.pick(SENSE);

  // Mass scales inversely with gravity and with the metabolic ceiling. The
  // exponent is not physics, but the direction is: big animals need low weight.
  const massKg = Math.max(0.002, Math.pow(10, rng.range(-2.2, 3.4)) / Math.pow(Math.max(g, 0.2), 1.35));
  const heightM = Math.max(0.02, Math.pow(massKg, 0.33) * rng.range(0.28, 0.62) / Math.max(g, 0.3) ** 0.4);

  const complexity = planet.lifeComplexity;
  const tier = planet.hasCivilization && index === 0 ? 'Sapient'
    : complexity > 0.7 ? 'Fauna'
    : complexity > 0.4 ? 'Macrofauna'
    : complexity > 0.2 ? 'Flora'
    : 'Microbiota';

  const genus = rng.pick(GENUS_A) + rng.pick(GENUS_B);
  const name = `${cap(genus)} ${rng.pick(EPITHET)}`;

  const tags = [];
  if (tier === 'Sapient') tags.push({ label: 'sapient', tone: 'hot' });
  if (metabolism === 'Radiotrophic') tags.push({ label: 'radiotrophic', tone: 'hot' });
  if (cold) tags.push({ label: 'cryophile' });
  if (planet.oceanCoverage > 0.85) tags.push({ label: 'pelagic' });
  if (g > 1.6) tags.push({ label: 'high-g endemic' });
  tags.push({ label: planet.name, tone: 'live' });

  const note = speciesNote({ tier, plan, locomotion, metabolism, sense, massKg, g, dark, cold, planet });

  return {
    kind: 'species',
    id: `l:${planet.seed}:${index}`,
    name: cap(genus),
    binomial: name,
    tier,
    home: planet.name,
    plan, locomotion, metabolism, sense,
    symmetry: rng.pick(SYMM),
    sociality: tier === 'Microbiota' ? 'Distributed' : rng.pick(SOCIAL),
    massKg, heightM,
    tags, note,
  };
}

function speciesNote(d) {
  const c = [];
  if (d.tier === 'Sapient') c.push('Tool-using, symbol-using, and aware that the sky has other things in it.');
  if (d.dark) c.push('Evolved without a reliable day: its primary sense is not sight, and its rhythms track tide and heat rather than light.');
  if (d.g > 1.6) c.push(`Built for ${d.g.toFixed(1)}g — short limbs, dense bone analogue, and a gait that never leaves the ground.`);
  else if (d.g < 0.4) c.push('Low gravity permits a body this large to be this thin; on Earth it would collapse under its own weight.');
  if (d.metabolism === 'Chemosynthetic') c.push('Draws energy from mineral chemistry rather than from starlight, which is why it can live where nothing else does.');
  if (d.metabolism === 'Radiotrophic') c.push('Metabolises ionising radiation directly. The pigment doing it is not chlorophyll and not melanin.');
  if (d.cold) c.push('Cell chemistry runs on antifreeze; it is active at temperatures that would flash-freeze terrestrial tissue.');
  if (d.massKg > 400) c.push(`At roughly ${Math.round(d.massKg)} kg it is the largest thing moving on ${d.planet.name}.`);
  else if (d.massKg < 0.05) c.push('Small enough that surface tension, not gravity, is the dominant force in its life.');
  return c.join(' ');
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

let rowSeq = 0;

// --- number formatting --------------------------------------------------------

function celsius(k) {
  const c = k - 273.15;
  return `${c >= 0 ? '' : '−'}${Math.abs(c) < 10 ? Math.abs(c).toFixed(1) : Math.round(Math.abs(c))}`;
}
function lum(l) {
  if (l >= 1000) return Math.round(l).toLocaleString('en-US');
  if (l >= 0.01) return l.toFixed(2);
  return l.toExponential(1);
}
function hours(seconds) {
  const h = seconds / 3600;
  return h < 100 ? h.toFixed(1) : Math.round(h).toLocaleString('en-US');
}
/** A hot Jupiter's year is measured in days and Neptune's in centuries, so the
 *  unit has to move with the number rather than force one of them into a silly
 *  string like "0.00 yr". */
function orbitalPeriod(seconds) {
  const days = seconds / 86400;
  if (days < 400) return { k: 'Year', v: days < 10 ? days.toFixed(1) : Math.round(days).toLocaleString('en-US'), u: 'd' };
  const y = days / 365.25;
  return { k: 'Year', v: y < 100 ? y.toFixed(1) : Math.round(y).toLocaleString('en-US'), u: 'yr' };
}

