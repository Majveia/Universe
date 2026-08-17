#!/usr/bin/env node
/**
 * Walk the import graph from the entry point and report what never runs.
 *
 * The bundler only parses what is reachable from `main.js`, so an unreferenced
 * file can carry a syntax error, a stale API, or a whole unfinished subsystem
 * and the build stays green. `Nebula.js` sat broken for four rounds that way.
 *
 * This answers the question that costs the most time to answer by hand: of the
 * files in src/, which ones does the app actually load?
 *
 *   node tools/import-graph.mjs
 *   node tools/import-graph.mjs --entry src/main.js --json
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const ENTRY = resolve(argOf('entry', 'src/main.js'));
const ROOT = resolve('.');

// Static imports, dynamic import(), and re-exports all pull a file in.
const SPEC = /(?:^|[^.\w])(?:import|export)\s+(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]|(?:^|[^.\w])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Resolve a specifier the way Vite would, or return null for a bare package. */
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
  const base = spec.startsWith('/') ? join(ROOT, spec) : resolve(dirname(fromFile), spec);
  const tries = [base, `${base}.js`, `${base}.mjs`, join(base, 'index.js')];
  for (const t of tries) {
    if (existsSync(t) && statSync(t).isFile()) return t;
  }
  return undefined; // looked like a path but did not resolve
}

const reached = new Set();
const edges = new Map();
const broken = [];
const workers = [];

function walk(file) {
  if (reached.has(file)) return;
  reached.add(file);
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    return;
  }

  // Workers are separate entry points; `new Worker(new URL('./x.js', import.meta.url))`
  // is a real edge the plain import scan would miss entirely.
  for (const m of src.matchAll(/new\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) {
    const r = resolveSpec(file, m[1]);
    if (r) { workers.push(relative(ROOT, r)); walk(r); }
  }

  const out = [];
  for (const m of src.matchAll(SPEC)) {
    const spec = m[1] || m[2];
    if (!spec) continue;
    const r = resolveSpec(file, spec);
    if (r === null) continue;          // bare package, e.g. three
    if (r === undefined) {
      broken.push(`${relative(ROOT, file)} -> ${spec}`);
      continue;
    }
    out.push(relative(ROOT, r));
    walk(r);
  }
  edges.set(relative(ROOT, file), out);
}

walk(ENTRY);

const all = execSync("find src -name '*.js'", { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean).sort();
const live = new Set([...reached].map((f) => relative(ROOT, f)));
const dead = all.filter((f) => !live.has(f));

if (args.includes('--json')) {
  console.log(JSON.stringify({ live: [...live].sort(), dead, broken, workers }, null, 2));
  process.exit(0);
}

const lines = (f) => readFileSync(f, 'utf8').split('\n').length;
const liveLines = [...live].reduce((s, f) => s + lines(f), 0);
const deadLines = dead.reduce((s, f) => s + lines(f), 0);

console.log(`entry: ${relative(ROOT, ENTRY)}`);
console.log(`\nREACHABLE  ${live.size}/${all.length} files, ${liveLines} lines`);
if (workers.length) console.log(`  worker entry points: ${[...new Set(workers)].join(', ')}`);

console.log(`\nNEVER LOADED  ${dead.length} files, ${deadLines} lines`);
// Group by directory: a whole unreferenced subsystem is a different fact from
// a few stray files, and the grouping makes which one it is obvious at a glance.
const byDir = new Map();
for (const f of dead) {
  const d = dirname(f);
  if (!byDir.has(d)) byDir.set(d, []);
  byDir.get(d).push(f);
}
for (const [d, fs] of [...byDir].sort((a, b) => b[1].length - a[1].length)) {
  const n = fs.reduce((s, f) => s + lines(f), 0);
  console.log(`  ${d}/  (${fs.length} files, ${n} lines)`);
  for (const f of fs.sort()) console.log(`      ${f.replace(d + '/', '')}  ${lines(f)} lines`);
}

if (broken.length) {
  console.log(`\nUNRESOLVED IMPORTS  ${broken.length}`);
  for (const b of broken) console.log(`  ${b}`);
}
