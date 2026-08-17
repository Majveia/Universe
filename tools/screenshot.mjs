#!/usr/bin/env node
/**
 * Headless capture rig.
 *
 * Boots the built app in Chromium with real WebGL2 (SwiftShader falls back
 * gracefully but is slow — we ask for GPU where available), waits for the app
 * to signal readiness, optionally drives it through a script of interactions,
 * and writes PNGs. This is the ground truth the review agents look at: nobody
 * gets to claim the render looks good without a frame on disk.
 *
 * Usage:
 *   node tools/screenshot.mjs --out shots/ --shot cosmos:0 --shot system:6
 *   node tools/screenshot.mjs --url http://127.0.0.1:5173 --w 2560 --h 1440
 */

import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}
function argAll(name) {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === `--${name}`) out.push(args[i + 1]);
  return out;
}

const has = (name) => args.includes(`--${name}`);

const OUT = resolve(arg('out', 'shots'));
const WIDTH = parseInt(arg('w', '1920'), 10);
const HEIGHT = parseInt(arg('h', '1080'), 10);
const DPR = parseFloat(arg('dpr', '1'));
const SETTLE = parseFloat(arg('settle', '3.5'));
const TIMEOUT = parseInt(arg('timeout', '120000'), 10);
let URL = arg('url', null);

mkdirSync(OUT, { recursive: true });

/** Shots are `name:seconds` or `name:seconds:script`. */
const shots = argAll('shot').length ? argAll('shot') : ['cosmos:0'];

let server = null;

/** Kill the preview server's whole process group, never just its wrapper. */
function stopServer() {
  if (!server) return;
  try {
    process.kill(-server.pid, 'SIGKILL');
  } catch {
    // Group already gone, or never became one — fall back to the direct handle.
    try { server.kill('SIGKILL'); } catch { /* already dead */ }
  }
  server = null;
}

async function ensureServer() {
  if (URL) return;
  const dist = resolve('dist');
  if (!existsSync(dist)) {
    console.error('[shot] dist/ not found — run `npm run build` first.');
    process.exit(2);
  }
  // Own the whole process group. `npx` forks vite as a child, so killing the
  // handle we hold reaps the wrapper and orphans the server still holding the
  // port — after which every later run dies on `Port 4173 is already in use`
  // before it captures anything. Detaching gives us a group id to signal.
  server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort', '--host', '127.0.0.1'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('preview server timeout')), 30000);
    server.stdout.on('data', (d) => {
      if (String(d).includes('4173')) { clearTimeout(t); setTimeout(res, 400); }
    });
    server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  });
  URL = 'http://127.0.0.1:4173';
}

async function run() {
  await ensureServer();

  // The container ships a pinned Chromium that may not match this Playwright
  // build's expected revision. Prefer the one that is actually on disk.
  const localChrome = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome']
    .find((p) => existsSync(p));

  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || localChrome || undefined,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--force-color-profile=srgb',
      '--disable-lcd-text',
      '--hide-scrollbars',
      '--mute-audio',
    ],
  });

  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: DPR,
    colorScheme: 'dark',
  });

  const logs = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') logs.push(`[${t}] ${m.text()}`);
  });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  const q = arg('q', 'tier=4&still=1&scale=1&dpr=1');
  const full = `${URL}${URL.includes('?') ? '&' : '?'}${q}`;
  console.log(`[shot] loading ${full}`);
  await page.goto(full, { waitUntil: 'load', timeout: TIMEOUT });

  // Wait for the app to expose its context — that is the readiness contract.
  await page.waitForFunction('window.__universe && window.__universe.revealed', { timeout: TIMEOUT });
  console.log('[shot] app ready');

  for (const spec of shots) {
    const [name, secsRaw, script] = spec.split(':');
    const secs = parseFloat(secsRaw ?? '0');

    if (script) {
      await page.evaluate(async (s) => {
        // eslint-disable-next-line no-new-func
        await new Function('ctx', `return (async()=>{${s}})()`)(window.__universe);
      }, decodeURIComponent(script));
    } else if (name && name !== 'cosmos') {
      // Named shots default to travelling to the realm of the same name.
      await page.evaluate(async (n) => {
        const d = window.__universe.director;
        if (d.realms.has(n) && d.currentKey !== n) await d.goTo(n, {}, 'warp', 0.6);
      }, name).catch(() => {});
    }

    const settle = Math.max(SETTLE, secs);
    await page.waitForTimeout(settle * 1000);

    const stats = await page.evaluate(() => {
      const e = window.__universe.engine;
      return {
        fps: Math.round(e.fps),
        calls: e.drawCalls,
        tris: e.triangles,
        tier: window.__universe.settings.tierName,
        realm: window.__universe.director.currentKey,
      };
    });

    const file = `${OUT}/${name}.png`;
    await page.screenshot({ path: file, type: 'png' });
    console.log(`[shot] ${file}  fps=${stats.fps} calls=${stats.calls} tris=${stats.tris} realm=${stats.realm}`);
  }

  if (logs.length) {
    console.log('\n[shot] console output:');
    for (const l of logs.slice(0, 40)) console.log('  ' + l);
    if (logs.length > 40) console.log(`  ... ${logs.length - 40} more`);
  }

  const failed = logs.some((l) => l.startsWith('[pageerror]') || l.includes('Shader Error'));
  await browser.close();
  stopServer();
  // Chromium's zygote and the vite child can both keep the loop alive; we are
  // done and have written our files, so leave decisively.
  process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error('[shot] FAILED:', e.message);
  stopServer();
  process.exit(1);
});

// A crash or a Ctrl-C must not leave the port held either.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopServer(); process.exit(130); });
}
