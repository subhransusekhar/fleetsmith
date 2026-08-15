import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The license-boundary gate (v0.7.0 G0.4).
 *
 * `ee/` is AGPL-3.0-only; everything else in this repo is MIT. The whole
 * open-core promise — "install `fleetsmith-ee` for the enterprise tier,
 * `rm -rf ee/` for exactly v0.6 back" — only holds if three things are true on
 * every commit, none of which a human reliably catches by eye across a large
 * diff:
 *
 *  1. Core (`src/`) never imports from `ee/`, by any path form. The ONE
 *     reference core is allowed to make is the loader's bare package specifier
 *     `import('fleetsmith-ee')` (`src/cli.js`) — a package name resolved
 *     through node_modules, not a path that can structurally point at the
 *     local `ee/` directory, so it needs no explicit whitelist entry: the
 *     check below only resolves specifiers that already look like paths.
 *  2. Every file under `ee/src/` (and later `ee/console/`) declares its
 *     license up front, so a file cannot end up under the wrong term by a
 *     copy-paste that dropped the header.
 *  3. No RelataDB engine source or binary is ever vendored — the whole
 *     integration is BYOL over REST, and a stray `.rs` file or `Cargo.toml`
 *     is the first sign that rule quietly slipped.
 *
 * Each check is a plain function over a directory, tested twice: once against
 * the real tree (must be clean) and once against a seeded temp fixture (must
 * catch the violation). A check that has never been proven to fail is not
 * known to work — it may just never have had anything to find.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = path.join(ROOT, 'src');
const EE = path.join(ROOT, 'ee');

function walk(dir, filter = () => true) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

const isJs = (f) => f.endsWith('.js');

/**
 * Every import/export-from/require specifier in a JS source, static or
 * dynamic. Regex-based, not a full parse: the specifier grammar is narrow
 * enough that a targeted pattern is the honest tool here, and this repo takes
 * no parser dependency to lean on instead.
 */
function specifiers(source) {
  const out = [];
  const patterns = [
    /\bimport\s+(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source))) out.push(m[1]);
  }
  return out;
}

/** A local path (relative or absolute) vs. a bare package name resolved through node_modules. */
function isPathSpecifier(spec) {
  return spec.startsWith('.') || spec.startsWith('/');
}

/** Every `srcDir` file whose import/export/require specifier resolves inside `forbiddenDir`. */
function findImportViolations(srcDir, forbiddenDir) {
  const offenders = [];
  for (const file of walk(srcDir, isJs)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const spec of specifiers(source)) {
      if (!isPathSpecifier(spec)) continue; // bare names can never locally resolve into forbiddenDir
      const resolved = path.resolve(path.dirname(file), spec);
      if (resolved === forbiddenDir || resolved.startsWith(forbiddenDir + path.sep)) {
        offenders.push({ file, spec });
      }
    }
  }
  return offenders;
}

/** Every `.js` file under `dir` missing the SPDX header in its first two lines. */
function findMissingSpdx(dir) {
  const missing = [];
  for (const file of walk(dir, isJs)) {
    const head = fs.readFileSync(file, 'utf8').split('\n').slice(0, 2).join('\n');
    if (!/SPDX-License-Identifier:\s*AGPL-3\.0-only/.test(head)) missing.push(file);
  }
  return missing;
}

/** RelataDB is Rust, shipped as a single binary — these are the shapes vendoring would leave behind. */
const VENDOR_EXTENSIONS = new Set(['.rs', '.so', '.dylib', '.dll', '.exe', '.a']);
const VENDOR_FILENAMES = new Set(['Cargo.toml', 'Cargo.lock']);

function findVendoredFiles(dir) {
  const hits = [];
  const stack = fs.existsSync(dir) ? [dir] : [];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (VENDOR_FILENAMES.has(entry.name) || VENDOR_EXTENSIONS.has(path.extname(entry.name))) hits.push(full);
    }
  }
  return hits;
}

// --- real tree: must be clean -----------------------------------------------

test('no file under src/ imports from ee/, by any path form', () => {
  const offenders = findImportViolations(SRC, EE);
  assert.deepEqual(
    offenders.map((o) => `${path.relative(ROOT, o.file)}: imports "${o.spec}"`),
    []
  );
});

test("the loader's ee reference is a bare package specifier, not a path", () => {
  // This is what makes the check above sound rather than accidental: the one
  // place core mentions ee at all resolves through node_modules, so it was
  // never a candidate for "resolves inside ee/" to begin with.
  const cli = fs.readFileSync(path.join(SRC, 'cli.js'), 'utf8');
  const specs = specifiers(cli).filter((s) => s.includes('fleetsmith-ee'));
  assert.ok(specs.length > 0, 'no reference to fleetsmith-ee found in cli.js — did the loader move?');
  for (const s of specs) assert.equal(isPathSpecifier(s), false, `"${s}" is a path form, not a bare package name`);
});

test('every file under ee/src/ carries the AGPL SPDX header', () => {
  const missing = findMissingSpdx(path.join(EE, 'src'));
  assert.deepEqual(
    missing.map((f) => path.relative(ROOT, f)),
    []
  );
});

test('no RelataDB engine source or binary is vendored under ee/', () => {
  const hits = findVendoredFiles(EE);
  assert.deepEqual(
    hits.map((f) => path.relative(ROOT, f)),
    []
  );
});

// --- seeded fixtures: each rule must be provably able to fail ---------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ee-boundary-'));
}

test('a seeded src/ -> ee/ import is caught, in every path form', () => {
  const root = tmpDir();
  const src = path.join(root, 'src');
  const ee = path.join(root, 'ee');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(ee, { recursive: true });
  fs.writeFileSync(path.join(ee, 'leaked.js'), 'export const x = 1;\n');
  fs.writeFileSync(
    path.join(src, 'bad.js'),
    [
      "import { x } from '../ee/leaked.js';",
      "export { y } from '../ee/leaked.js';",
      "const z = await import('../ee/leaked.js');",
      "const w = require('../ee/leaked.js');",
    ].join('\n')
  );
  const offenders = findImportViolations(src, ee);
  assert.equal(offenders.length, 4, 'expected one offender per specifier form (import, export-from, dynamic import, require)');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a clean src/ tree with no ee/ produces zero offenders (no false positives)', () => {
  const root = tmpDir();
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(src, 'fine.js'),
    ["import fs from 'node:fs';", "import { helper } from './helper.js';", "const mod = await import('fleetsmith-ee');"].join('\n')
  );
  const offenders = findImportViolations(src, path.join(root, 'ee'));
  assert.deepEqual(offenders, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a file missing the SPDX header is caught', () => {
  const root = tmpDir();
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'has-header.js'), '// SPDX-License-Identifier: AGPL-3.0-only\nexport function ok() {}\n');
  fs.writeFileSync(path.join(root, 'no-header.js'), '/** just a normal doc comment */\nexport function bad() {}\n');
  const missing = findMissingSpdx(root);
  assert.deepEqual(missing.map((f) => path.basename(f)), ['no-header.js']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a vendored Rust source file or Cargo manifest is caught', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'engine'), { recursive: true });
  fs.writeFileSync(path.join(root, 'engine', 'main.rs'), 'fn main() {}\n');
  fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname = "x"\n');
  fs.writeFileSync(path.join(root, 'engine', 'libcore.so'), 'not really a binary, just needs the extension');
  fs.writeFileSync(path.join(root, 'README.md'), 'this one must not be flagged\n');
  const hits = findVendoredFiles(root).map((f) => path.relative(root, f)).sort();
  assert.deepEqual(hits, ['Cargo.toml', path.join('engine', 'libcore.so'), path.join('engine', 'main.rs')].sort());
  fs.rmSync(root, { recursive: true, force: true });
});
