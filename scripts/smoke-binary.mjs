// Run the built standalone binary and check it actually works.
//
// Why this exists: v0.7.0 shipped a binary that threw before executing any
// command. `createRequire(import.meta.url)` ran on the way into every
// invocation, and esbuild cannot fill `import.meta` in for the cjs output
// format the binary is bundled from, so the argument was `undefined`. Release
// CI built that binary, ran `npm test` against the SOURCE, and attached the
// artifact to a GitHub Release without ever executing it once. Every test
// passed and every published asset was dead.
//
// `npm test` cannot catch this by construction: it exercises the ESM sources,
// where `import.meta.url` is defined, so the bundled artifact is a genuinely
// different program with a failure mode the suite cannot reach. The only check
// that would have caught it is running the thing we are about to publish.
//
// Usage:  node scripts/smoke-binary.mjs [path-to-binary]
//         defaults to dist/bin/fleetsmith[.exe]

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const { version: EXPECTED_VERSION } = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
);

const defaultBin = path.join(
  REPO_ROOT,
  'dist',
  'bin',
  process.platform === 'win32' ? 'fleetsmith.exe' : 'fleetsmith'
);
const BIN = path.resolve(process.argv[2] ?? defaultBin);

if (!existsSync(BIN)) {
  console.error(`smoke: no binary at ${BIN} — run \`npm run build:binary\` first`);
  process.exit(1);
}

let failed = 0;

/** Run the binary and return its stdout, or throw with stderr attached. */
function bin(args, opts = {}) {
  return execFileSync(BIN, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function check(label, fn) {
  try {
    fn();
    console.log(`  ok    ${label}`);
  } catch (e) {
    failed++;
    // The stderr is the whole point of this script — print it, do not swallow it.
    const detail = e?.stderr?.toString().trim() || e?.message || String(e);
    console.error(`  FAIL  ${label}\n        ${detail.split('\n').join('\n        ')}`);
  }
}

console.log(`smoke-testing ${BIN}`);

// The single check that would have caught the v0.7.0 defect: the binary runs at
// all, and reports the version this repo says it is (the bundler injects it, so
// a wrong answer means a stale dist/ was attached rather than a fresh build).
check(`version prints ${EXPECTED_VERSION}`, () => {
  const out = bin(['version']).trim();
  if (out !== EXPECTED_VERSION) {
    throw new Error(`expected "${EXPECTED_VERSION}", got "${out}"`);
  }
});

check('patterns lists all five', () => {
  const out = bin(['patterns']);
  for (const p of ['pipeline', 'fanout', 'generate-verify', 'supervisor', 'expert-pool']) {
    if (!out.includes(p)) throw new Error(`"${p}" missing from patterns output`);
  }
});

// A real end-to-end pass. init/validate/build together exercise spec loading,
// the validator, all three adapters and the file writer — the paths that make
// the binary worth shipping rather than just a process that starts.
const work = mkdtempSync(path.join(tmpdir(), 'fleetsmith-smoke-'));
try {
  check('init → validate → build --target all', () => {
    bin(['init', 'smoke', '--pattern', 'pipeline', '--domain', 'smoke testing a release binary'], {
      cwd: work,
    });
    const spec = path.join(work, 'fleet.yaml');
    if (!existsSync(spec)) throw new Error('init produced no fleet.yaml');

    const valid = bin(['validate', 'fleet.yaml'], { cwd: work });
    if (!/^valid:/m.test(valid)) throw new Error(`validate did not report valid:\n${valid}`);

    bin(['build', 'fleet.yaml', '--target', 'all'], { cwd: work });
    for (const expected of ['CLAUDE.md', 'AGENTS.md', 'opencode.json', '_fleet']) {
      if (!existsSync(path.join(work, expected))) {
        throw new Error(`build --target all did not emit ${expected}`);
      }
    }
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

// An unknown command must fail loudly rather than exit 0 having done nothing —
// otherwise a binary that is broken in some new way still looks healthy above.
check('unknown command exits non-zero', () => {
  let exited = 0;
  try {
    bin(['definitely-not-a-command']);
  } catch (e) {
    exited = e.status ?? 1;
  }
  if (exited === 0) throw new Error('expected a non-zero exit for an unknown command');
});

if (failed) {
  console.error(`\nsmoke: ${failed} check(s) failed — do NOT publish this binary`);
  process.exit(1);
}
console.log('\nsmoke: binary is good');
