import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { fileURLToPath } from 'node:url';
import { normalizeSpec } from '../src/spec/schema.js';
import { buildAll } from '../src/adapters/index.js';
import { runExecCases, runnerAvailable, DEFAULT_CASE_TIMEOUT } from '../src/eval/exec.js';

/**
 * G4.4: the live measurement proving an agent actually surfaces a peer's overlapping in-flight work rather
 * than silently duplicating it — the one property in this milestone that cannot be checked without a real
 * model, since it depends on what a model DOES with the grid-awareness skill's instructions, not on what
 * fleetsmith compiles.
 *
 * Scoped exactly like `src/eval/exec.js` says every case should be: this exercises ONE skill's methodology,
 * not the whole fleet orchestrator, so it stays well inside `DEFAULT_CASE_TIMEOUT`'s "single skill" budget
 * (bumped somewhat here since the task involves real file writes, not just a Q&A reply).
 *
 * Runs in a subdirectory of THIS project, not a temp directory: Claude Code will not honor a compiled
 * fleet's `.claude/settings.json` (the permission allowlist, the SubagentStop gate) in a workspace that has
 * never been trusted interactively, and a fresh temp directory never has been — `src/eval/exec.js`'s own doc
 * comment says exactly this. This project IS already trusted, so a scratch subdirectory of it inherits that
 * without an interactive prompt a headless run could never answer. The scratch directory is deleted after
 * every test, pass or fail.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRATCH_ROOT = path.join(REPO_ROOT, '.grid-eval-scratch');
const CASE_TIMEOUT = 180_000;

/**
 * Opt-in, not auto-detected: `runnerAvailable('claude-code')` alone would make these two tests spawn a real,
 * costly, ~1-2 minute coding-agent session on every plain `node --test` on any machine that happens to have
 * `claude` on PATH — exactly the automatic-gate behavior `src/eval/exec.js`'s own design deliberately
 * forbids ("invoked only by `fleetsmith eval --exec`, never by `runEval`"). `FLEETSMITH_GRID_EVAL_LIVE=1`
 * is the explicit human decision this milestone's own live-instance tests already require elsewhere
 * (e.g. `RELATA_TEST_URL` for the RelataDB suites) — availability of the binary is necessary, not sufficient.
 */
const LIVE_OPT_IN = process.env.FLEETSMITH_GRID_EVAL_LIVE === '1';

function loadFixtureSpec() {
  const raw = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, 'test/eval-fleets/grid-two-actor.yaml'), 'utf8'));
  const expect = raw.expect;
  delete raw.expect;
  return { spec: normalizeSpec(raw), expect };
}

/** The real materialize.js (G3.4) rollup shape — mallory in-progress on exactly the file/symbol this scenario's query is about to touch. */
function gridMdWithOverlap() {
  return [
    '# Grid',
    '',
    '_Synced: 2026-08-16T12:00:00Z_ · Cortex: reachable · Active actors: 1',
    '',
    '## mallory',
    '_(active — last seen 2026-08-16T11:58:00Z)_',
    '- #3: add date formatting helper for the reports export — files: src/utils/date.js; symbols: formatDate',
    '',
    '## Cross-actor dependencies',
    '(none)',
    '',
  ].join('\n');
}

function setupWorkspace(name, { withGrid }) {
  const dir = path.join(SCRATCH_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  const { spec } = loadFixtureSpec();
  buildAll(spec, {}).write(dir, { force: true });
  if (withGrid) {
    const gridDir = path.join(dir, spec.fleet.local, 'grid');
    fs.mkdirSync(gridDir, { recursive: true });
    fs.writeFileSync(path.join(gridDir, 'GRID.md'), gridMdWithOverlap());
  }
  return { dir, spec };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function findHandoffFiles(dir, spec) {
  const handoffsDir = path.join(dir, spec.handover.dir);
  if (!fs.existsSync(handoffsDir)) return [];
  return fs
    .readdirSync(handoffsDir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('HANDOFF.template'))
    .map((f) => fs.readFileSync(path.join(handoffsDir, f), 'utf8'));
}

function ledgerContent(dir, spec) {
  const p = path.join(dir, spec.fleet.local, 'LEDGER.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

/** No file anywhere in the workspace other than a legitimate reuse of mallory's own src/utils/date.js defines a competing `formatDate` — the concrete "did not silently duplicate a declared symbol" proof. */
function competingFormatDateFiles(dir) {
  const offenders = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(js|ts|mjs)$/.test(entry.name) && path.relative(dir, full) !== 'src/utils/date.js') {
        const content = fs.readFileSync(full, 'utf8');
        if (/\b(function|const)\s+formatDate\b/.test(content)) offenders.push(path.relative(dir, full));
      }
    }
  };
  if (fs.existsSync(path.join(dir, 'src'))) walk(path.join(dir, 'src'));
  return offenders;
}

test('live: with a GRID.md overlap fixture, the agent surfaces mallory\'s overlap and does not duplicate formatDate', async (t) => {
  if (!LIVE_OPT_IN) {
    t.skip('set FLEETSMITH_GRID_EVAL_LIVE=1 to opt into this real, ~1-2 minute coding-agent session');
    return;
  }
  if (!runnerAvailable('claude-code')) {
    t.skip('claude CLI not found on PATH — this scenario needs a real coding-agent session');
    return;
  }
  const { dir, spec } = setupWorkspace('with-grid', { withGrid: true });
  try {
    const out = await runExecCases(spec, { target: 'claude-code', cwd: dir, timeout: CASE_TIMEOUT });
    assert.equal(out.skipped, 0, `case was skipped: ${out.results[0]?.detail}`);
    assert.equal(out.results[0].status, 'pass', `stdout mentions check failed: ${out.results[0].detail}`);

    const handoffs = findHandoffFiles(dir, spec);
    assert.ok(handoffs.length > 0, 'the agent must have written at least one handoff file');
    const digestSection = handoffs.map((h) => h.match(/## Context digest([\s\S]*?)(?=\n## |\s*$)/)?.[1] ?? h).join('\n');
    assert.match(digestSection.toLowerCase(), /mallory/, "the handoff's Context digest must mention the overlapping peer");

    const ledger = ledgerContent(dir, spec);
    assert.match(ledger, /@mallory#\d+/, 'the ledger row must declare a dependency on mallory\'s task via @mallory#<seq>');

    assert.deepEqual(competingFormatDateFiles(dir), [], 'no file besides src/utils/date.js may define a competing formatDate');
  } finally {
    cleanup(dir);
  }
});

test('live: without the GRID.md fixture, the scenario still completes and the overlap assertions are correctly inapplicable', async (t) => {
  if (!LIVE_OPT_IN) {
    t.skip('set FLEETSMITH_GRID_EVAL_LIVE=1 to opt into this real, ~1-2 minute coding-agent session');
    return;
  }
  if (!runnerAvailable('claude-code')) {
    t.skip('claude CLI not found on PATH — this scenario needs a real coding-agent session');
    return;
  }
  const { dir, spec } = setupWorkspace('without-grid', { withGrid: false });
  try {
    assert.ok(!fs.existsSync(path.join(dir, spec.fleet.local, 'grid', 'GRID.md')), 'fixture precondition: no GRID.md exists in this workspace');

    const out = await runExecCases(spec, { target: 'claude-code', cwd: dir, timeout: CASE_TIMEOUT });
    // The declared case still expects "mentions: mallory" (authored for the with-grid scenario), so it is
    // EXPECTED to fail here — mallory does not exist in this workspace's story. What actually matters, and
    // what the acceptance criterion asks for, is that the scenario still COMPLETES (a real session ran, real
    // files were produced) rather than erroring or hanging — i.e. "not skipped", regardless of that
    // particular assertion's pass/fail.
    assert.equal(out.skipped, 0, `case was skipped rather than completing: ${out.results[0]?.detail}`);

    const handoffs = findHandoffFiles(dir, spec);
    assert.ok(handoffs.length > 0, 'the agent must still have completed the task and written a handoff, absent any overlap to report');
    const ledger = ledgerContent(dir, spec);
    assert.doesNotMatch(ledger, /@mallory#\d+/, 'with no GRID.md, there is nothing for the ledger to declare a dependency on');
  } finally {
    cleanup(dir);
  }
});

// --- drift check: grid-disabled compile of the same fixture is stable -----------

const SNAPSHOT_PATH = path.join(REPO_ROOT, 'test/eval-fleets/grid-two-actor.nogrid.snapshot.json');

function gridDisabledVariant() {
  const { spec } = loadFixtureSpec();
  const withoutGrid = { ...spec, fleet: { ...spec.fleet, grid: null } };
  return withoutGrid;
}

test('drift: compiling the fixture with grid: removed matches the committed snapshot exactly', () => {
  const fileSet = buildAll(gridDisabledVariant(), {});
  const actual = Object.fromEntries([...fileSet.files.entries()].sort());
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  assert.deepEqual(actual, snapshot);
});

test('drift: the grid-disabled variant compiles no grid-conditional artifacts (G4.1/G4.3), even though the user-authored grid-awareness skill itself still compiles unchanged', () => {
  const fileSet = buildAll(gridDisabledVariant(), {});
  const combined = [...fileSet.files.values()].join('\n');
  // The skill is a first-class, user-authored spec element — it compiles regardless of fleet.grid, exactly
  // like any other skill would (nothing conditions skill inclusion on an unrelated field). What IS
  // conditional (G4.1's protocol section, G4.3's status-command line and script emission) must be absent.
  assert.ok([...fileSet.files.keys()].some((p) => p.includes('grid-awareness')), 'the skill itself is unaffected by fleet.grid and still compiles');
  assert.doesNotMatch(combined, /\*\*Grid awareness\*\* \(multi-developer sync is enabled/, "G4.1's conditional protocol section must not appear");
  assert.doesNotMatch(combined, /grid-status\.mjs/, "G4.3's conditional status-command script must not be emitted or referenced");
  assert.ok(!fileSet.files.has('_fleet/local/scripts/grid-status.mjs'));
});
