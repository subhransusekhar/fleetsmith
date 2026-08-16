// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { syncOnce, loadSpecFile } from '../src/grid/daemon.js';
import { pushOnce } from '../src/grid/push.js';
import { pullOnce } from '../src/grid/pull.js';
import { materialize } from '../src/grid/materialize.js';
import { resolveRepoId } from '../src/grid/ontology.js';

/**
 * Two-actor end-to-end (G3.7): the epic-accept proof for the whole G3 daemon, against a real, reachable
 * RelataDB — everything else in G3 was verified in isolation (fake servers, mocks); this is the one test
 * that runs the real push → real ingest → real reconcile → real materialize loop between two independent
 * checkouts and checks what actually lands on disk.
 *
 * Two adaptations from the issue's literal wording, both forced by G3.3's real-instance findings, not by
 * this test cutting corners:
 *
 *  - **"Cursors monotonic"**: there is no real, resumable `_system_from`-based cursor to assert monotonicity
 *    of (verified in G3.3 — the value is never populated for ad-hoc ingested types). What this test asserts
 *    instead is the guarantee that actually holds: `reconcile()` does a full bounded re-scan every cycle, so
 *    the concurrency proof here is "the final state, after every write has landed, is correct and undamaged"
 *    — not "the incremental position only ever moves forward," which was never a real property of this
 *    engine surface to begin with.
 *  - **"Kill B's daemon between SSE receipt and cursor persist"**: `/graph/changes` never emits a frame at
 *    all on this engine profile (G3.3's other real finding), so there is no SSE-receipt moment to crash
 *    between. The restart-resilience proof here instead crashes between `reconcile()`'s fetch and
 *    `materialize()`'s write — the actual two-step boundary this architecture has — and asserts exactly-once
 *    *materialized* effect (a re-run after the simulated crash produces correct, non-duplicated files),
 *    which is the property G3.3/G3.4's design (at-least-once delivery + idempotent, keyed writes) actually
 *    promises.
 */

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const SHARED_REMOTE_URL = 'git@github.com:acme/grid-e2e-fixture.git';

/** An independent temp git repo — NOT a clone of the other actor's, just sharing the same remote URL string, which is all `resolveRepoId()` actually keys on. */
function setupActorRepo(actorLabel) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), `fleetsmith-e2e-${actorLabel}-`));
  git(['init', '-q'], repoDir);
  git(['config', 'user.email', `${actorLabel}@example.com`], repoDir);
  git(['config', 'user.name', actorLabel], repoDir);
  git(['remote', 'add', 'origin', SHARED_REMOTE_URL], repoDir);
  writeFile(repoDir, '.gitignore', '_fleet/local/\n');
  writeFile(repoDir, 'README.md', `# ${actorLabel}'s checkout\n`);
  git(['add', '.'], repoDir);
  git(['commit', '-q', '-m', 'base'], repoDir);
  // declaredFiles()'s default baseRef is origin/main; this repo has no real remote to fetch, so the ref
  // must be created manually or `git diff --name-only origin/main` fails (a real, warn-not-throw condition
  // elsewhere, but noise this test doesn't need).
  git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD'], repoDir)], repoDir);
  writeFile(repoDir, 'fleet.yaml', 'fleet:\n  name: grid-e2e-fleet\n');
  const localDir = path.join(repoDir, '_fleet', 'local');
  return { repoDir, localDir, spec: loadSpecFile(path.join(repoDir, 'fleet.yaml')) };
}

function ledgerWithTask(text, status) {
  return ['# Ledger', '', '| # | Task | Owner | Depends on | Status | Artifact |', '|---|------|-------|-----------|--------|----------|', `| 1 | ${text} | actor | - | ${status} | - |`, ''].join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const withEnv = async (key, value, fn) => {
  const prior = process.env[key];
  process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
};

test('two-actor e2e: cross-visibility, concurrent push, crash/restart resilience, and no git mutation, against a real RelataDB', async (t) => {
  if (!process.env.RELATA_TEST_URL) {
    t.skip('RELATA_TEST_URL not set — no live RelataDB configured for this run');
    return;
  }
  const config = { url: process.env.RELATA_TEST_URL, token: process.env.RELATA_TEST_TOKEN ?? '', purposes: ['fleetsmith_g3_7_e2e'] };
  // syncOnce() resolves its own config from RELATA_URL/RELATA_TOKEN (or fleet.grid) — neither fixture spec
  // declares a grid: block, so the env pair is what makes the syncOnce() calls below actually reach this
  // instance rather than degrading as "not configured".
  process.env.RELATA_URL = config.url;
  process.env.RELATA_TOKEN = config.token;
  t.after(() => {
    delete process.env.RELATA_URL;
    delete process.env.RELATA_TOKEN;
  });

  const alice = setupActorRepo('alice');
  const bob = setupActorRepo('bob');
  const repoId = resolveRepoId(alice.repoDir);
  assert.equal(repoId, resolveRepoId(bob.repoDir), 'both checkouts must resolve to the same repo_id — same remote URL, different working trees');

  const aliceHeadBefore = git(['rev-parse', 'HEAD'], alice.repoDir);
  const bobHeadBefore = git(['rev-parse', 'HEAD'], bob.repoDir);

  // --- cross-visibility, alice -> bob -----------------------------------------------
  writeFile(alice.localDir, 'LEDGER.md', ledgerWithTask('alice in-flight work', 'in-progress'));
  writeFile(alice.repoDir, 'src/alice-feature.js', 'export function AliceFeature() {}\n');
  await withEnv('FLEETSMITH_ACTOR', 'alice', () => syncOnce(alice.spec, alice.repoDir));
  await sleep(2500); // async ingest settle (verified ~2s elsewhere in this milestone)
  const bobSync1 = await withEnv('FLEETSMITH_ACTOR', 'bob', () => syncOnce(bob.spec, bob.repoDir));
  assert.equal(bobSync1.degraded, false);

  const aliceLedgerAtBob = fs.readFileSync(path.join(bob.localDir, 'grid', 'peers', 'alice', 'LEDGER.md'), 'utf8');
  assert.match(aliceLedgerAtBob, /alice in-flight work/);
  const gridMdAtBob = fs.readFileSync(path.join(bob.localDir, 'grid', 'GRID.md'), 'utf8');
  assert.match(gridMdAtBob, /## alice/);
  assert.match(gridMdAtBob, /AliceFeature/);

  // --- cross-visibility, bob -> alice (reverse direction) ---------------------------
  writeFile(bob.localDir, 'LEDGER.md', ledgerWithTask('bob in-flight work', 'in-progress'));
  await withEnv('FLEETSMITH_ACTOR', 'bob', () => syncOnce(bob.spec, bob.repoDir));
  await sleep(2500);
  await withEnv('FLEETSMITH_ACTOR', 'alice', () => syncOnce(alice.spec, alice.repoDir));

  const bobLedgerAtAlice = fs.readFileSync(path.join(alice.localDir, 'grid', 'peers', 'bob', 'LEDGER.md'), 'utf8');
  assert.match(bobLedgerAtAlice, /bob in-flight work/);
  const gridMdAtAlice = fs.readFileSync(path.join(alice.localDir, 'grid', 'GRID.md'), 'utf8');
  assert.match(gridMdAtAlice, /## bob/);

  // --- 20-iteration concurrent push: zero loss, zero cross-actor contention --------
  const ITERATIONS = 20;
  for (let i = 0; i < ITERATIONS; i++) {
    writeFile(alice.localDir, 'LEDGER.md', ledgerWithTask(`alice iteration ${i}`, 'in-progress'));
    writeFile(bob.localDir, 'LEDGER.md', ledgerWithTask(`bob iteration ${i}`, 'in-progress'));
    const [aliceResult, bobResult] = await Promise.all([
      pushOnce(config, alice.repoDir, { localDir: alice.localDir, actor: 'alice', repoId }),
      pushOnce(config, bob.repoDir, { localDir: bob.localDir, actor: 'bob', repoId }),
    ]);
    assert.deepEqual(aliceResult.warnings, [], `alice push must not warn on iteration ${i}`);
    assert.deepEqual(bobResult.warnings, [], `bob push must not warn on iteration ${i}`);
    // Every pushed row must be attributed to the actor that pushed it — proves no cross-actor contention
    // even under concurrent writes to the same repo_id.
    assert.ok(aliceResult.pushed.every((k) => !k.includes('|bob|')));
    assert.ok(bobResult.pushed.every((k) => !k.includes('|alice|')));
  }
  await sleep(3000); // settle the last iteration's async ingest

  const { newRows: finalRowsForAlice } = await pullOnce(config, alice.repoDir, { localDir: alice.localDir, repoId, actor: 'alice' });
  materialize(finalRowsForAlice, alice.localDir);
  const finalGridMd = fs.readFileSync(path.join(alice.localDir, 'grid', 'GRID.md'), 'utf8');
  assert.match(finalGridMd, new RegExp(`bob iteration ${ITERATIONS - 1}\\b`), 'the LAST bob iteration must be the one alice sees — no lost or stale write');
  assert.equal((finalGridMd.match(/bob iteration \d+/g) ?? []).length, 1, 'exactly one bob task line — deduped to the latest, not one per iteration ever pushed');

  // --- crash/restart resilience: crash between reconcile's fetch and materialize's write ---
  writeFile(alice.localDir, 'LEDGER.md', ledgerWithTask('alice post-crash-test work', 'in-progress'));
  await pushOnce(config, alice.repoDir, { localDir: alice.localDir, actor: 'alice', repoId });
  await sleep(2500);

  // "Crash": bob reconciles but the process dies before materialize() runs — nothing on disk changes yet.
  const { newRows: preCrashRows } = await pullOnce(config, bob.repoDir, { localDir: bob.localDir, repoId, actor: 'bob' });
  // (materialize() deliberately NOT called here — simulating the crash)

  // "Restart": a fresh reconcile + materialize, exactly as a restarted daemon would do.
  const { newRows: postRestartRows } = await pullOnce(config, bob.repoDir, { localDir: bob.localDir, repoId, actor: 'bob' });
  materialize(postRestartRows, bob.localDir);
  const aliceLedgerAtBobAfterRestart = fs.readFileSync(path.join(bob.localDir, 'grid', 'peers', 'alice', 'LEDGER.md'), 'utf8');
  assert.match(aliceLedgerAtBobAfterRestart, /alice post-crash-test work/, 'no missed materialization after the simulated crash+restart');
  assert.equal((aliceLedgerAtBobAfterRestart.match(/\| 1 \|/g) ?? []).length, 1, 'no duplicated row for the same task key after crash+restart');
  assert.equal(preCrashRows.length > 0, true, 'the pre-crash reconcile really did fetch real rows (the crash is simulated at the materialize boundary, not the fetch)');

  // --- no git mutation: HEADs must never move -----------------------------------------
  assert.equal(git(['rev-parse', 'HEAD'], alice.repoDir), aliceHeadBefore, "alice's HEAD must be unchanged — no commit was ever needed");
  assert.equal(git(['rev-parse', 'HEAD'], bob.repoDir), bobHeadBefore, "bob's HEAD must be unchanged — no commit was ever needed");
});
