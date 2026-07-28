/**
 * Scale director.
 *
 * A universe spans ~27 orders of magnitude, from a boot print in regolith to
 * the cosmic web. No single float32 scene graph survives that. So UNIVERSE is
 * built as a set of *realms*, each internally consistent at its own scale, with
 * cinematic transitions between them that hide the handoff.
 *
 *   COSMOS  10^24 m   filaments, voids, clusters, expansion
 *   GALAXY  10^21 m   spiral arms, nebulae, star formation
 *   SYSTEM  10^12 m   Keplerian orbits, a star you can fly around
 *   PLANET  10^7  m   orbital approach through atmosphere to the ground
 *   SURFACE 10^3  m   terrain, weather, cities, a body with legs
 *
 * Realms are asked to `prepare()` before they are entered, so the transition
 * covers generation cost instead of a hitch. The director owns the camera; a
 * realm positions it but never replaces it.
 */

import * as THREE from 'three';

export const Scale = {
  COSMOS: 'cosmos',
  GALAXY: 'galaxy',
  SYSTEM: 'system',
  PLANET: 'planet',
  SURFACE: 'surface',
};

/** Realm contract. Subclass this; every hook is optional except `build`. */
export class Realm {
  constructor(ctx) {
    this.ctx = ctx;
    this.scene = new THREE.Scene();
    this.ready = false;
    this.active = false;
    /** Camera near/far this realm needs. The director applies them on enter. */
    this.near = 0.1;
    this.far = 1e7;
    /** Ambient audio bed id the audio engine should crossfade to. */
    this.ambience = null;
  }

  /** Async construction. Called once, possibly long before `enter`. */
  async build() {}

  /** Called when this realm becomes visible. `params` comes from the caller. */
  enter(_params = {}) {}

  /** Called when the director moves away. Keep state; do not dispose. */
  exit() {}

  /** Per-frame. `dt` seconds. */
  update(_dt, _time) {}

  /** Free GPU resources. Called only on teardown. */
  dispose() {}
}

export class Director {
  constructor(engine, camera) {
    this.engine = engine;
    this.camera = camera;
    this.realms = new Map();
    this.current = null;
    this.currentKey = null;
    this.transition = null;
    this.listeners = new Set();
    this.history = [];
  }

  register(key, realm) {
    this.realms.set(key, realm);
    return realm;
  }

  get(key) {
    return this.realms.get(key);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async ensureBuilt(key) {
    const realm = this.realms.get(key);
    if (!realm) throw new Error(`Unknown realm: ${key}`);
    if (!realm.ready) {
      await realm.build();
      realm.ready = true;
    }
    return realm;
  }

  /**
   * Move to a realm with a cinematic wipe.
   *
   * `style` shapes the transition:
   *   'warp'  — barrel-warp + white bloom flash. Used for descending a scale.
   *   'fade'  — plain crossfade to black. Used for menu-ish jumps.
   *   'bloom' — bloom blows out, then settles. Used for stellar approach.
   */
  async goTo(key, params = {}, style = 'warp', duration = 1.6) {
    if (this.transition) return;
    const post = this.engine.postfx;
    const from = this.current;

    this.transition = { t: 0, duration, style, phase: 'out' };

    // Phase 1: blow out.
    await this._animate(duration * 0.45, (t) => {
      const e = t * t;
      if (style === 'warp') {
        post.set('warpAmount', e * 1.4);
        post.set('flashAmount', Math.pow(t, 3) * 0.95);
        post.bloomStrength = 0.6 + e * 3.0;
      } else if (style === 'bloom') {
        post.set('flashAmount', Math.pow(t, 2.2) * 0.9);
        post.bloomStrength = 0.6 + e * 5.0;
      } else {
        post.set('flashAmount', t);
        post.set('flashColor', [0, 0, 0]);
      }
    });

    // Swap under cover of the flash.
    const realm = await this.ensureBuilt(key);
    if (from) from.exit();
    this.current = realm;
    if (this.currentKey) this.history.push(this.currentKey);
    this.currentKey = key;
    this.camera.near = realm.near;
    this.camera.far = realm.far;
    this.camera.updateProjectionMatrix();
    realm.active = true;
    realm.enter(params);
    for (const fn of this.listeners) fn(key, realm, params);

    // Give the new realm one frame to populate before we reveal it.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    // Phase 2: settle in.
    this.transition.phase = 'in';
    await this._animate(duration * 0.55, (t) => {
      const e = 1 - Math.pow(1 - t, 3);
      post.set('warpAmount', (1 - e) * 1.4);
      post.set('flashAmount', (1 - e) * 0.95);
      post.bloomStrength = 0.6 + (1 - e) * 3.0;
    });

    post.set('warpAmount', 0);
    post.set('flashAmount', 0);
    post.set('flashColor', [1, 1, 1]);
    post.bloomStrength = 0.6;
    this.transition = null;
  }

  async back() {
    const key = this.history.pop();
    if (key) {
      this.history.pop(); // goTo will re-push the one we are leaving
      await this.goTo(key, {}, 'warp');
    }
  }

  _animate(seconds, fn) {
    return new Promise((resolve) => {
      const start = performance.now();
      const step = () => {
        const t = Math.min(1, (performance.now() - start) / (seconds * 1000));
        fn(t);
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  update(dt, time) {
    if (this.current) this.current.update(dt, time);
  }

  render() {
    if (this.current) this.engine.render(this.current.scene, this.camera);
  }
}
