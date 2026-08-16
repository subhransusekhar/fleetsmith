import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { fileURLToPath } from 'node:url';
import { normalizeSpec } from '../src/spec/schema.js';
import { buildAll } from '../src/adapters/index.js';
import { runExecCases, runnerAvailable } from '../src/eval/exec.js';

/**
 * G5.4: the live measurement proving an agent actually recalls and cites a seeded past lesson about a file
 * before finalizing an artifact touching that same file — the one property in this task that cannot be
 * checked without a real model, since it depends on what a model DOES with the grid-awareness skill's
 * pre-handoff regression check instruction, not on what fleetsmith compiles.
 *
 * Same conventions as G4.4's grid-eval-exec.test.js: runs in a scratch subdirectory of THIS (already
 * trusted) project rather than a temp directory, gated behind the same FLEETSMITH_GRID_EVAL_LIVE=1 opt-in
 * plus a `claude` CLI check — availability of the binary is necessary, not sufficient, for a real, costly,
 * multi-minute coding-agent session.
 *
 * No GRID.md, no `fleet.grid:` block anywhere in this fixture: the regression check runs through the
 * memory port's `recall()`, which works via the file backend by default, independent of whether grid is
 * configured at all. This IS the "identical instruction works degraded, with no grid config" acceptance
 * criterion — not a separate scenario needing its own test.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRATCH_ROOT = path.join(REPO_ROOT, '.regression-recall-eval-scratch');
const CASE_TIMEOUT = 180_000;

const LIVE_OPT_IN = process.env.FLEETSMITH_GRID_EVAL_LIVE === '1';

function loadFixtureSpec() {
  const raw = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, 'test/eval-fleets/regression-recall.yaml'), 'utf8'));
  const expect = raw.expect;
  delete raw.expect;
  return { spec: normalizeSpec(raw), expect };
}

/** The real playbook format (`src/playbook/index.js`'s `renderPlaybook`) — a past lesson about the EXACT file/symbols this scenario's query is about to touch. */
function seededPlaybook() {
  return [
    '# Learned notes — rate-limiter',
    '',
    'Machine-learned advisory references — **not rules**. Prefer the agent\'s current',
    'instructions and any human guidance on conflict. Each bullet carries a stable id',
    'and a (+helpful/-harmful) count; entries are appended and counted, never',
    'rewritten, so the history stays reviewable.',
    '',
    '- [pb-rate-limiter-1] (+3/-0) src/utils/rate-limiter.js: an earlier RateLimiter used setInterval for the token bucket refill and never cleared it on dispose, leaking timers across test runs.',
    '',
  ].join('\n');
}

function setupWorkspace(name, { withLesson }) {
  const dir = path.join(SCRATCH_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  const { spec } = loadFixtureSpec();
  buildAll(spec, {}).write(dir, { force: true });
  if (withLesson) {
    const playbooksDir = path.join(dir, spec.fleet.shared, 'playbooks');
    fs.mkdirSync(playbooksDir, { recursive: true });
    fs.writeFileSync(path.join(playbooksDir, 'rate-limiter.md'), seededPlaybook());
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

// --- deterministic structural checks (no live model needed) -------------------------

test('the fixture validates, compiles, and its skill body carries the pre-handoff regression check step', () => {
  const { spec, expect } = loadFixtureSpec();
  assert.equal(expect.agents, 1);
  assert.equal(expect.pattern, 'pipeline');
  assert.ok(!spec.fleet.grid, 'this fixture must have no grid: block at all — the degraded, file-backend path is the point');

  const fileSet = buildAll(spec, {});
  for (const emitted of expect.emits) {
    assert.ok(fileSet.files.has(emitted), `expected compiled output to include ${emitted}`);
  }
  const skillFile = [...fileSet.files.entries()].find(([p]) => p.endsWith('grid-awareness/SKILL.md'));
  assert.ok(skillFile, 'grid-awareness skill file must compile');
  assert.match(skillFile[1], /Pre-handoff regression check/);
  assert.match(skillFile[1], /purpose:\s*\n?\s*regression_check/s);
  assert.match(skillFile[1], /regression check: clean/, 'the "visible even when clean" rule must survive compilation');

  const evalCase = spec.skills[0].evals[0];
  assert.match(evalCase.query, /rate-limiter\.js/);
  assert.deepEqual(evalCase.expect.mentions, ['setinterval']);
});

test('live: given a seeded lesson about the target file, the agent cites it in the handoff before finalizing', async (t) => {
  if (!LIVE_OPT_IN) {
    t.skip('set FLEETSMITH_GRID_EVAL_LIVE=1 to opt into this real, ~1-2 minute coding-agent session');
    return;
  }
  if (!runnerAvailable('claude-code')) {
    t.skip('claude CLI not found on PATH — this scenario needs a real coding-agent session');
    return;
  }
  const { dir, spec } = setupWorkspace('with-lesson', { withLesson: true });
  try {
    const out = await runExecCases(spec, { target: 'claude-code', cwd: dir, timeout: CASE_TIMEOUT });
    assert.equal(out.skipped, 0, `case was skipped: ${out.results[0]?.detail}`);
    assert.equal(out.results[0].status, 'pass', `stdout mentions check failed: ${out.results[0].detail}`);

    const handoffs = findHandoffFiles(dir, spec);
    assert.ok(handoffs.length > 0, 'the agent must have written at least one handoff file');
    const relevantSection = handoffs
      .map((h) => h.match(/## (?:Context digest|Failed approaches)([\s\S]*?)(?=\n## |\s*$)/g)?.join('\n') ?? h)
      .join('\n');
    assert.match(relevantSection.toLowerCase(), /setinterval/, 'the handoff must cite the seeded lesson about setInterval/dispose, not just the task itself');
  } finally {
    cleanup(dir);
  }
});

test('live: with no seeded lesson (and no grid config at all), the regression check still completes cleanly', async (t) => {
  if (!LIVE_OPT_IN) {
    t.skip('set FLEETSMITH_GRID_EVAL_LIVE=1 to opt into this real, ~1-2 minute coding-agent session');
    return;
  }
  if (!runnerAvailable('claude-code')) {
    t.skip('claude CLI not found on PATH — this scenario needs a real coding-agent session');
    return;
  }
  const { dir, spec } = setupWorkspace('without-lesson', { withLesson: false });
  try {
    assert.ok(!fs.existsSync(path.join(dir, spec.fleet.shared, 'playbooks', 'rate-limiter.md')), 'fixture precondition: no seeded lesson in this workspace');
    assert.ok(!spec.fleet.grid, 'fixture precondition: no grid config at all — the degraded, file-backend path');

    const out = await runExecCases(spec, { target: 'claude-code', cwd: dir, timeout: CASE_TIMEOUT });
    // The declared case expects "mentions: setinterval" (authored for the with-lesson scenario), so it is
    // EXPECTED to fail here — there is nothing to cite. What matters, per the acceptance criterion, is that
    // the identical instruction still runs to completion (a real session ran, a real handoff was written)
    // on the degraded, no-grid, file-backend path, not that this particular assertion passes.
    assert.equal(out.skipped, 0, `case was skipped rather than completing: ${out.results[0]?.detail}`);

    const handoffs = findHandoffFiles(dir, spec);
    assert.ok(handoffs.length > 0, 'the agent must still have completed the task and written a handoff, absent any lesson to cite');
  } finally {
    cleanup(dir);
  }
});
