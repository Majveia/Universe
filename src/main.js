/**
 * UNIVERSE — entry point.
 *
 * Boots the renderer, registers every realm with the director, and runs the
 * frame loop. Deliberately thin: this file wires, it does not implement.
 */

import * as THREE from 'three';
import './ui/styles.css';

import { Engine } from './core/Engine.js';
import { Input } from './core/Input.js';
import { Director, Scale } from './core/Director.js';
import { settings } from './core/Settings.js';

import { CosmosRealm } from './cosmos/CosmosRealm.js';
import { SystemRealm } from './system/SystemRealm.js';
import { SurfaceRealm } from './planet/SurfaceRealm.js';
import { TouchControls } from './ui/TouchControls.js';

const bootEl = document.getElementById('boot');
const bootSub = document.getElementById('boot-sub');
const bootBar = document.getElementById('boot-bar-fill');

let bootStep = 0;
const BOOT_STEPS = 6;
function boot(msg) {
  bootStep++;
  if (bootSub) bootSub.textContent = msg;
  if (bootBar) bootBar.style.width = `${Math.min(100, (bootStep / BOOT_STEPS) * 100)}%`;
  // Yield so the browser can actually paint the progress.
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

async function main() {
  const canvas = document.getElementById('viewport');

  await boot('initialising renderer');
  const engine = new Engine(canvas);

  await boot('binding input');
  const input = new Input(canvas);

  const camera = new THREE.PerspectiveCamera(settings.fov, engine.aspect, 0.1, 1e7);
  engine.onResize((w, h, aspect) => {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  });

  const director = new Director(engine, camera);

  /** Shared context handed to every realm and system. */
  const ctx = {
    engine,
    input,
    camera,
    director,
    settings,
    scale: Scale.COSMOS,
    // Populated by later systems; realms must tolerate these being null.
    hud: null,
    audio: null,
    player: null,
    save: { visited: new Set(), scanned: new Set(), discoveries: [] },
  };
  window.__universe = ctx;

  await boot('seeding structure formation');
  director.register(Scale.COSMOS, new CosmosRealm(ctx));
  director.register(Scale.SYSTEM, new SystemRealm(ctx));
  director.register(Scale.SURFACE, new SurfaceRealm(ctx));

  // Descending a scale is the core verb of the whole thing, so it gets a key,
  // a gesture and a programmatic hook rather than being buried in a menu.
  // A transition is seconds long and a thumb is faster than that. Without a
  // latch, a second tap lands mid-warp and starts a transition out of a realm
  // the director is still moving into.
  let travelling = false;
  const travel = (fn) => async (...args) => {
    if (travelling) return;
    travelling = true;
    try { await fn(...args); } finally { travelling = false; }
  };

  ctx.descend = travel(async (seed) => {
    if (director.currentKey === Scale.COSMOS) {
      await director.goTo(Scale.SYSTEM, { seed: seed ?? (Math.floor(Date.now() / 1000) & 0xffff) }, 'warp', 1.8);
      ctx.scale = Scale.SYSTEM;
      return;
    }
    // System -> ground. Land on whatever the system view is currently framing,
    // so the world you arrive on is the one you were looking at rather than an
    // arbitrary one re-rolled from the seed.
    if (director.currentKey === Scale.SYSTEM) {
      const sys = director.get(Scale.SYSTEM);
      const target = sys?.followTarget ?? sys?.planets?.find((p) => !p.record.isGiant);
      if (!target) return;
      await director.goTo(Scale.SURFACE, { record: target.record }, 'warp', 2.0);
      ctx.scale = Scale.SURFACE;
    }
  });
  ctx.ascend = travel(async () => {
    if (director.currentKey === Scale.SURFACE) {
      await director.goTo(Scale.SYSTEM, { seed: ctx.lastSystemSeed }, 'warp', 1.6);
      ctx.scale = Scale.SYSTEM;
      return;
    }
    if (director.currentKey !== Scale.COSMOS) {
      await director.goTo(Scale.COSMOS, {}, 'warp', 1.6);
      ctx.scale = Scale.COSMOS;
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Enter') ctx.descend();
    if (e.code === 'Backspace') ctx.ascend();
  });

  // --- touch ------------------------------------------------------------------
  //
  // Until now Enter and Backspace were the ONLY way to change scale anywhere in
  // the project, which meant a phone could look at the cosmic web and never
  // leave it. Input has implemented the whole touch layer since the beginning —
  // floating stick, swipe-look, pinch, virtual buttons — and TouchControls has
  // been sitting unreferenced next to it; all that was missing was the two of
  // them being introduced, and something to put in the button cluster.
  //
  // Scale changes go through the same virtual-button path as every other
  // action, so there is one code path for "the player asked to descend" whether
  // it arrived from a thumb, a key or a gamepad.
  const touch = new TouchControls(document.getElementById('ui'), ctx);
  ctx.touch = touch;
  touch.setVisible(settings.isTouch);

  const ACTIONS = {
    [Scale.COSMOS]: [
      { id: 'descend', label: 'Enter system', icon: '▼' },
    ],
    [Scale.SYSTEM]: [
      { id: 'descend', label: 'Land', icon: '▼' },
      { id: 'ascend', label: 'Leave system', icon: '▲' },
    ],
  };

  /**
   * Rebuild the cluster for wherever we are.
   *
   * On the ground the player owns the list — it already publishes exactly the
   * shape TouchControls wants, and it is the only thing that knows whether you
   * are near a door or sitting in a vehicle. Everywhere else the only verb is
   * changing scale, so the realm key alone decides.
   */
  function touchActions() {
    if (director.currentKey === Scale.SURFACE && ctx.player) {
      return [...(ctx.player.contextActions || []),
        { id: 'ascend', label: 'To orbit', icon: '▲' }];
    }
    return ACTIONS[director.currentKey] || [];
  }

  await boot('collapsing dark matter');
  await director.ensureBuilt(Scale.COSMOS);
  director.current = director.get(Scale.COSMOS);
  director.currentKey = Scale.COSMOS;
  director.current.active = true;
  camera.near = director.current.near;
  camera.far = director.current.far;
  camera.updateProjectionMatrix();
  director.current.enter();

  await boot('warming shaders');
  // Compile everything before the first visible frame so nothing hitches.
  engine.renderer.compile(director.current.scene, camera);

  await boot('ready');

  engine.start((dt, time) => {
    input.update(dt);
    // One path for "the player asked to change scale", whatever pressed it.
    if (input.pressed('descend')) ctx.descend();
    if (input.pressed('ascend')) ctx.ascend();
    touch.setActions(touchActions());
    director.update(dt, time);
    director.render();
    touch.update(dt);
    input.endFrame();
  });

  ctx.ready = true;

  // Reveal. `revealed` is a separate signal from `ready` because the capture
  // rig needs to know the boot overlay is actually gone, not merely that the
  // engine is alive.
  requestAnimationFrame(() => {
    setTimeout(() => {
      bootEl?.classList.add('done');
      setTimeout(() => {
        bootEl?.remove();
        ctx.revealed = true;
      }, 1000);
    }, 260);
  });

  canvas.addEventListener('click', () => {
    if (!settings.isTouch && !input.pointerLocked && ctx.scale !== Scale.COSMOS) {
      input.requestPointerLock();
    }
  });
}

main().catch((err) => {
  console.error(err);
  if (bootSub) {
    bootSub.textContent = 'failed to initialise';
    bootSub.style.color = 'rgb(255,114,118)';
  }
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;left:16px;bottom:16px;right:16px;color:#ff9aa0;font:11px ui-monospace;white-space:pre-wrap;z-index:200;opacity:.8';
  pre.textContent = String(err && err.stack ? err.stack : err);
  document.body.appendChild(pre);
});
