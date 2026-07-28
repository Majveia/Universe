/**
 * Renderer ownership, the frame loop, and the render-scale/resize policy.
 *
 * Everything else in UNIVERSE receives an `Engine` and reads `engine.renderer`,
 * `engine.postfx`, `engine.dt`. Nothing else creates a WebGL context.
 */

import * as THREE from 'three';
import { settings, AdaptiveQuality } from './Settings.js';
import { PostFX } from '../render/PostFX.js';

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,          // we resolve via post; MSAA on an HDR target is expensive
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      preserveDrawingBuffer: true, // lets the photo mode / screenshot tooling read pixels
      logarithmicDepthBuffer: false,
    });
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping; // AgX happens in PostFX
    this.renderer.shadowMap.enabled = settings.shadows;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.info.autoReset = false;

    this.maxAnisotropy = Math.min(
      settings.anisotropy,
      this.renderer.capabilities.getMaxAnisotropy()
    );

    this.clock = new THREE.Clock();
    this.time = 0;
    this.dt = 1 / 60;
    this.frame = 0;
    this.fps = 60;
    this._fpsAccum = 0;
    this._fpsFrames = 0;

    this.postfx = new PostFX(this.renderer, null, null);
    this.adaptive = new AdaptiveQuality(settings.isMobile ? 45 : 55);

    this._resizeObserver = null;
    this._updaters = new Set();
    this._paused = false;
    this._bindResize();
    this.resize();
  }

  _bindResize() {
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);
    if ('ResizeObserver' in window) {
      this._resizeObserver = new ResizeObserver(() => this.resize());
      this._resizeObserver.observe(this.canvas.parentElement || document.body);
    }
    document.addEventListener('visibilitychange', () => {
      this._paused = document.hidden;
      if (!document.hidden) this.clock.getDelta(); // discard the gap
    });
  }

  resize() {
    const dpr = Math.min(settings.pixelRatio, window.devicePixelRatio || 1);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const scale = settings.renderScale;
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(dpr * scale);
    this.renderer.setSize(w, h, false);
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.postfx.setSize(buf.x, buf.y);
    this.aspect = w / h;
    for (const fn of this._updaters) fn(w, h, this.aspect);
  }

  onResize(fn) {
    this._updaters.add(fn);
    return () => this._updaters.delete(fn);
  }

  /** Drives the loop. `cb(dt, time)` runs once per frame before rendering. */
  start(cb) {
    let last = performance.now();
    const tick = (now) => {
      this._raf = requestAnimationFrame(tick);
      let dt = (now - last) / 1000;
      last = now;
      if (this._paused) return;
      // Clamp so a background tab or a long GC does not teleport the simulation.
      dt = Math.min(dt, 1 / 15);
      this.dt = dt;
      this.time += dt;
      this.frame++;

      this._fpsAccum += dt;
      this._fpsFrames++;
      if (this._fpsAccum > 0.5) {
        this.fps = this._fpsFrames / this._fpsAccum;
        this._fpsAccum = 0;
        this._fpsFrames = 0;
      }

      this.renderer.info.reset();
      cb(dt, this.time);
      this.adaptive.update(dt);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    cancelAnimationFrame(this._raf);
  }

  render(scene, camera) {
    this.postfx.render(scene, camera, this.time);
  }

  get drawCalls() {
    return this.renderer.info.render.calls;
  }
  get triangles() {
    return this.renderer.info.render.triangles;
  }
}
