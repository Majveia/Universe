/**
 * Device profiling and quality tiers.
 *
 * The same universe has to run on a desktop with a discrete GPU and on a phone.
 * Rather than one global "quality" slider we derive a tier at boot and let each
 * subsystem read the specific budget it cares about, so degradation is graceful
 * and targeted instead of uniformly muddy.
 */

export const Tier = { POTATO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, ULTRA: 4 };

const TIER_NAMES = ['Potato', 'Low', 'Medium', 'High', 'Ultra'];

function detectGpu() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return { renderer: 'none', webgl2: false, maxTexture: 2048 };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    const info = {
      renderer,
      webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxVaryings: gl.getParameter(gl.MAX_VARYING_VECTORS),
      floatBlend: !!gl.getExtension('EXT_float_blend'),
      colorFloat: !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float')),
      anisotropy: (() => {
        const ext = gl.getExtension('EXT_texture_filter_anisotropic');
        return ext ? gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;
      })(),
    };
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return info;
  } catch (e) {
    return { renderer: 'unknown', webgl2: false, maxTexture: 2048 };
  }
}

function guessTier(gpu) {
  const r = (gpu.renderer || '').toLowerCase();
  const mobile = /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /mac/i.test(navigator.platform) === false && window.innerWidth < 1100);
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;

  if (!gpu.webgl2) return Tier.POTATO;

  // Apple silicon and recent discrete parts handle the full pipeline.
  if (/apple m[1-9]/.test(r)) return mobile ? Tier.HIGH : Tier.ULTRA;
  if (/rtx\s*(30|40|50)|rx\s*(6[89]|7[0-9])00|arc\s*a7/.test(r)) return Tier.ULTRA;
  if (/rtx|radeon rx|geforce gtx 1[06]|arc /.test(r)) return Tier.HIGH;
  if (/apple gpu|adreno\s*(7|8)\d\d|mali-g7[1-9]|mali-g[89]\d/.test(r)) return Tier.MEDIUM;
  if (mobile) return Tier.LOW;
  if (/intel|uhd|iris/.test(r)) return cores >= 8 && mem >= 8 ? Tier.MEDIUM : Tier.LOW;
  return cores >= 8 ? Tier.HIGH : Tier.MEDIUM;
}

const PRESETS = {
  [Tier.POTATO]: {
    pixelRatio: 1.0, renderScale: 0.7, shadows: false, shadowSize: 512, shadowCascades: 0,
    bloom: true, bloomIterations: 3, dof: false, motionBlur: false, ssao: false,
    volumetrics: 0, atmosphereSteps: 6, cloudSteps: 0, terrainLod: 4, terrainRes: 33,
    cosmicParticles: 150000, starCount: 30000, vegetationDensity: 0.15, cityDetail: 0.35,
    anisotropy: 2, maxLights: 2, waterQuality: 0, aa: 'none',
  },
  [Tier.LOW]: {
    pixelRatio: 1.25, renderScale: 0.8, shadows: true, shadowSize: 1024, shadowCascades: 1,
    bloom: true, bloomIterations: 4, dof: false, motionBlur: false, ssao: false,
    volumetrics: 0.4, atmosphereSteps: 8, cloudSteps: 12, terrainLod: 5, terrainRes: 33,
    cosmicParticles: 400000, starCount: 60000, vegetationDensity: 0.35, cityDetail: 0.5,
    anisotropy: 4, maxLights: 3, waterQuality: 1, aa: 'fxaa',
  },
  [Tier.MEDIUM]: {
    pixelRatio: 1.5, renderScale: 0.9, shadows: true, shadowSize: 1536, shadowCascades: 2,
    bloom: true, bloomIterations: 5, dof: true, motionBlur: false, ssao: true,
    volumetrics: 0.7, atmosphereSteps: 12, cloudSteps: 24, terrainLod: 6, terrainRes: 49,
    cosmicParticles: 900000, starCount: 120000, vegetationDensity: 0.6, cityDetail: 0.75,
    anisotropy: 8, maxLights: 4, waterQuality: 2, aa: 'smaa',
  },
  [Tier.HIGH]: {
    pixelRatio: 2.0, renderScale: 1.0, shadows: true, shadowSize: 2048, shadowCascades: 3,
    bloom: true, bloomIterations: 6, dof: true, motionBlur: true, ssao: true,
    volumetrics: 1.0, atmosphereSteps: 16, cloudSteps: 40, terrainLod: 7, terrainRes: 65,
    cosmicParticles: 1700000, starCount: 250000, vegetationDensity: 1.0, cityDetail: 1.0,
    anisotropy: 16, maxLights: 6, waterQuality: 3, aa: 'smaa',
  },
  [Tier.ULTRA]: {
    pixelRatio: 2.0, renderScale: 1.0, shadows: true, shadowSize: 3072, shadowCascades: 4,
    bloom: true, bloomIterations: 7, dof: true, motionBlur: true, ssao: true,
    volumetrics: 1.0, atmosphereSteps: 24, cloudSteps: 64, terrainLod: 8, terrainRes: 65,
    cosmicParticles: 2700000, starCount: 400000, vegetationDensity: 1.35, cityDetail: 1.25,
    anisotropy: 16, maxLights: 8, waterQuality: 3, aa: 'smaa',
  },
};

class SettingsStore {
  constructor() {
    this.gpu = detectGpu();
    this.isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    this.isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (this.isTouch && Math.min(window.innerWidth, window.innerHeight) < 820);
    this.tier = guessTier(this.gpu);
    this.autoTier = true;
    this.apply(this.tier);

    // User-facing toggles, independent of tier.
    this.invertY = false;
    this.sensitivity = 1.0;
    this.fov = 70;
    this.showHud = true;
    this.audio = true;
    this.audioVolume = 0.7;
    this.filmGrain = 1.0;
    this.chromaticAberration = 0.55;
    this.exposure = 1.0;
    this.reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    this._listeners = new Set();
    this._load();
    this._applyUrlOverrides();
  }

  /**
   * Query-string overrides. Primarily for the headless capture rig, which
   * renders on SwiftShader and needs to pin quality rather than let the
   * auto-tier heuristic mistake software rasterisation for a fast GPU.
   *   ?tier=4&scale=1&dpr=1&particles=250000&still=1
   */
  _applyUrlOverrides() {
    const q = new URLSearchParams(location.search);
    if (q.has('tier')) {
      this.autoTier = false;
      this.apply(parseInt(q.get('tier'), 10));
    }
    if (q.has('dpr')) this.pixelRatio = parseFloat(q.get('dpr'));
    if (q.has('scale')) this.renderScale = parseFloat(q.get('scale'));
    if (q.has('particles')) this.cosmicParticles = parseInt(q.get('particles'), 10);
    if (q.has('stars')) this.starCount = parseInt(q.get('stars'), 10);
    if (q.has('grain')) this.filmGrain = parseFloat(q.get('grain'));
    if (q.has('fov')) this.fov = parseFloat(q.get('fov'));
    // Force the touch UI on or off. Touch capability cannot be feature-detected
    // on a headless capture rig, and a control scheme nobody can test on the
    // machine that builds it is a control scheme that rots.
    if (q.has('touch')) this.isTouch = q.get('touch') === '1';
    // `still=1` freezes adaptive downgrades so a slow capture does not
    // silently degrade the very quality it is meant to be judging.
    this.stillMode = q.get('still') === '1';
    if (this.stillMode) this.autoTier = false;
    this.headless = q.has('tier') || this.stillMode;
  }

  apply(tier) {
    this.tier = Math.max(0, Math.min(4, tier | 0));
    Object.assign(this, PRESETS[this.tier]);
    // Never exceed the device's own pixel ratio; supersampling a phone is waste.
    this.pixelRatio = Math.min(this.pixelRatio, window.devicePixelRatio || 1);
  }

  get tierName() {
    return TIER_NAMES[this.tier];
  }

  setTier(tier) {
    this.autoTier = false;
    const keep = {
      invertY: this.invertY, sensitivity: this.sensitivity, fov: this.fov,
      showHud: this.showHud, audio: this.audio, audioVolume: this.audioVolume,
      filmGrain: this.filmGrain, chromaticAberration: this.chromaticAberration,
      exposure: this.exposure, reduceMotion: this.reduceMotion,
    };
    this.apply(tier);
    Object.assign(this, keep);
    this._emit();
    this._save();
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  set(key, value) {
    if (this[key] === value) return;
    this[key] = value;
    this._emit();
    this._save();
  }

  _emit() {
    for (const fn of this._listeners) fn(this);
  }

  _save() {
    try {
      localStorage.setItem(
        'universe.settings',
        JSON.stringify({
          tier: this.autoTier ? null : this.tier,
          invertY: this.invertY, sensitivity: this.sensitivity, fov: this.fov,
          audio: this.audio, audioVolume: this.audioVolume, exposure: this.exposure,
          filmGrain: this.filmGrain, chromaticAberration: this.chromaticAberration,
        })
      );
    } catch (e) { /* private browsing */ }
  }

  _load() {
    try {
      const raw = localStorage.getItem('universe.settings');
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.tier !== null && s.tier !== undefined) {
        this.autoTier = false;
        this.apply(s.tier);
      }
      for (const k of ['invertY', 'sensitivity', 'fov', 'audio', 'audioVolume', 'exposure', 'filmGrain', 'chromaticAberration']) {
        if (s[k] !== undefined) this[k] = s[k];
      }
    } catch (e) { /* corrupt or unavailable */ }
  }
}

export const settings = new SettingsStore();

/**
 * Watches frame time and steps quality down (never up, to avoid oscillation)
 * when the device clearly cannot hold the target. Only active in auto mode.
 */
export class AdaptiveQuality {
  constructor(targetFps = 55) {
    this.target = targetFps;
    this.samples = [];
    this.cooldown = 4;
    this.enabled = settings.autoTier && !settings.stillMode;
  }

  update(dt) {
    if (!this.enabled || settings.tier <= Tier.POTATO) return;
    this.cooldown -= dt;
    this.samples.push(dt);
    if (this.samples.length > 120) this.samples.shift();
    if (this.cooldown > 0 || this.samples.length < 90) return;

    const sorted = [...this.samples].sort((a, b) => a - b);
    const p80 = sorted[Math.floor(sorted.length * 0.8)];
    const fps = 1 / p80;
    if (fps < this.target * 0.62) {
      const wasAuto = settings.autoTier;
      settings.setTier(settings.tier - 1);
      settings.autoTier = wasAuto;
      this.samples.length = 0;
      this.cooldown = 8;
    }
  }
}
