#!/usr/bin/env node
/**
 * Fast syntax check over the source tree, with a shader-specific hint.
 *
 * Shader source lives in tagged template strings, so a backtick anywhere inside
 * one — almost always someone quoting an identifier in a comment — closes the
 * template early. What comes back is a JavaScript parse error reported wherever
 * the parser finally gave up, usually nowhere near the backtick and reading as
 * "Expected a semicolon". That misdirection has cost this project four build
 * failures.
 *
 * Parsing is delegated to node itself rather than to a hand-rolled scanner. An
 * earlier version of this file tried to track template nesting with regexes and
 * produced 28 false positives on clean source — it could not tell a closing
 * backtick sharing a line with a brace from an opening one, and lost track
 * entirely inside `${...}` interpolation. A linter that is wrong every run
 * teaches you to ignore it, which is worse than not having one.
 *
 * Usage: node tools/lint-shaders.mjs
 */

import { execFileSync, execSync } from 'node:child_process';

const files = execSync("find src -name '*.js'", { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);

let bad = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    bad++;
    const msg = String(e.stderr || e.message);
    console.error(`\n${file}`);
    console.error(msg.split('\n').slice(0, 6).join('\n'));
    if (/Unexpected end of input|Invalid or unexpected token|missing \) after|Unexpected token/.test(msg)) {
      console.error('  hint: a stray backtick in a /* glsl */ template closes the'
        + ' shader string early. Check recent comments for quoted identifiers.');
    }
  }
}

if (bad) {
  console.error(`\n${bad} file(s) failed to parse.`);
  process.exit(1);
}
console.log(`[lint] ${files.length} source files parse cleanly`);
