// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { actorFromBranch, tasksFromGitOnly, listCandidateBranches } from '../src/grid/git-only.js';
import { findOverlaps } from '../src/grid/overlaps.js';
import { renderOverlaps } from '../src/grid/overlaps-render.js';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** A repo with NO remote configured at all — the strongest possible proof that this module never needs one. */
function initRepoNoRemote() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-git-only-test-'));
  // `-b main`: an explicit initial branch name, independent of the environment's `init.defaultBranch`
  // config — a test asserting exact branch-name behavior must not depend on ambient git config.
  git(['init', '-q', '-b', 'main'], repoDir);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  return repoDir;
}

function commitAll(repoDir, message) {
  git(['add', '-A'], repoDir);
  git(['commit', '-q', '-m', message], repoDir);
  return git(['rev-parse', 'HEAD'], repoDir).trim();
}

function branchFrom(repoDir, base, name) {
  git(['checkout', '-q', '-b', name, base], repoDir);
}

// --- actorFromBranch heuristic ------------------------------------------------------

test('actorFromBranch strips a conventional prefix segment and takes the leading name', () => {
  assert.equal(actorFromBranch('feat/alice-retry-helper'), 'alice');
  assert.equal(actorFromBranch('fix/bob-null-check'), 'bob');
  assert.equal(actorFromBranch('hotfix/carol'), 'carol');
});

test('actorFromBranch handles a bare, slash-free branch name', () => {
  assert.equal(actorFromBranch('alice-retry-helper'), 'alice');
  assert.equal(actorFromBranch('dave'), 'dave');
});

test('actorFromBranch falls back to a per-branch-unique "unknown:<branch>", never a bare shared "unknown"', () => {
  assert.equal(actorFromBranch('main'), 'unknown:main');
  assert.equal(actorFromBranch('feat/wip'), 'unknown:feat/wip'); // "wip" itself is a non-actor token
  const a = actorFromBranch('123-numeric-start');
  const b = actorFromBranch('---no-letters---');
  assert.notEqual(a, b, 'two different unresolvable branches must never collide on one shared actor identity');
  assert.ok(a.startsWith('unknown:') && b.startsWith('unknown:'));
});

test('actorFromBranch is case-insensitive on the extracted name', () => {
  assert.equal(actorFromBranch('feat/ALICE-thing'), 'alice');
});

// --- tasksFromGitOnly: real git, zero network -------------------------------------

test('tasksFromGitOnly detects a real file overlap between two local branches, with no remote configured at all', () => {
  const repoDir = initRepoNoRemote();
  writeFile(repoDir, 'shared.js', 'one\n');
  const base = commitAll(repoDir, 'base'); // committed directly on 'main' (initRepoNoRemote's explicit initial branch)

  branchFrom(repoDir, base, 'feat/alice-thing');
  writeFile(repoDir, 'shared.js', 'ALICE\n');
  writeFile(repoDir, 'alice-only.js', 'alice work\n');
  commitAll(repoDir, 'alice work');

  branchFrom(repoDir, base, 'feat/bob-thing');
  writeFile(repoDir, 'shared.js', 'BOB\n');
  writeFile(repoDir, 'bob-only.js', 'bob work\n');
  commitAll(repoDir, 'bob work');

  const { tasks, warnings } = tasksFromGitOnly(repoDir, ['feat/alice-thing', 'feat/bob-thing'], 'main');
  assert.deepEqual(warnings, []);
  assert.equal(tasks.length, 2);

  const alice = tasks.find((t) => t.branch === 'feat/alice-thing');
  const bob = tasks.find((t) => t.branch === 'feat/bob-thing');
  assert.equal(alice.actor, 'alice');
  assert.equal(bob.actor, 'bob');
  assert.deepEqual(alice.files_declared, ['alice-only.js', 'shared.js']);
  assert.deepEqual(bob.files_declared, ['bob-only.js', 'shared.js']);
  // The whole point of a git-only row: only files_declared is ever populated.
  for (const t of tasks) {
    assert.equal(t.artifact, '');
    assert.deepEqual(t.symbols_declared, []);
    assert.deepEqual(t.depends_on, []);
    assert.equal(t.status, 'in-progress');
  }

  const overlaps = findOverlaps(tasks);
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0].kind, 'file');
  assert.deepEqual(overlaps[0].evidence, ['shared.js']);
  assert.deepEqual(overlaps[0].actors, ['alice', 'bob']);

  // structurally absent, not merely empty by chance — no dependency/symbol/artifact data was ever fed in
  assert.deepEqual(findOverlaps(tasks).filter((o) => o.kind !== 'file'), []);
});

test('tasksFromGitOnly never calls fetch, pull, or clone — this module has zero network access by construction', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(fileURLToPath(new URL('../src/grid/git-only.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /['"]fetch['"]/);
  assert.doesNotMatch(src, /['"]pull['"]/);
  assert.doesNotMatch(src, /['"]clone['"]/);
  assert.doesNotMatch(src, /from\s+['"]node:(http|https|net|dgram|dns)['"]/);
});

test('tasksFromGitOnly skips a branch it cannot resolve, with a warning, never a throw', () => {
  const repoDir = initRepoNoRemote();
  writeFile(repoDir, 'README.md', 'base\n');
  const base = commitAll(repoDir, 'base');

  branchFrom(repoDir, base, 'feat/alice-thing');
  writeFile(repoDir, 'x.js', 'alice\n');
  commitAll(repoDir, 'alice work');

  const { tasks, warnings } = tasksFromGitOnly(repoDir, ['feat/alice-thing', 'feat/does-not-exist'], 'main');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].branch, 'feat/alice-thing');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /feat\/does-not-exist/);
});

test('tasksFromGitOnly skips a branch with no changes relative to baseRef — not a phantom empty task', () => {
  const repoDir = initRepoNoRemote();
  writeFile(repoDir, 'README.md', 'base\n');
  const base = commitAll(repoDir, 'base');
  branchFrom(repoDir, base, 'feat/nothing-changed');

  const { tasks, warnings } = tasksFromGitOnly(repoDir, ['feat/nothing-changed'], 'main');
  assert.deepEqual(tasks, []);
  assert.deepEqual(warnings, []);
});

// --- listCandidateBranches ---------------------------------------------------------

test('listCandidateBranches excludes the current branch, the baseRef, trunk names, and symbolic HEAD refs', () => {
  const repoDir = initRepoNoRemote();
  writeFile(repoDir, 'README.md', 'base\n');
  const base = commitAll(repoDir, 'base');
  branchFrom(repoDir, base, 'feat/alice-thing');
  git(['branch', 'feat/bob-thing', base], repoDir);
  git(['branch', 'develop', base], repoDir);

  const branches = listCandidateBranches(repoDir, { currentBranch: 'feat/alice-thing', baseRef: 'main' });
  assert.ok(branches.includes('feat/bob-thing'));
  assert.ok(!branches.includes('feat/alice-thing'), 'the currently checked-out branch must be excluded');
  assert.ok(!branches.includes('main'), 'baseRef must be excluded');
  assert.ok(!branches.includes('develop'), 'a trunk-name branch must be excluded');
});

// --- renderOverlaps with the git-only banner ---------------------------------------

test('rendering git-only findings includes the banner and structurally omits symbol/cycle/artifact sections', () => {
  const repoDir = initRepoNoRemote();
  writeFile(repoDir, 'shared.js', 'one\n');
  const base = commitAll(repoDir, 'base');

  branchFrom(repoDir, base, 'feat/alice-thing');
  writeFile(repoDir, 'shared.js', 'ALICE\n');
  commitAll(repoDir, 'alice work');

  branchFrom(repoDir, base, 'feat/bob-thing');
  writeFile(repoDir, 'shared.js', 'BOB\n');
  commitAll(repoDir, 'bob work');

  const { tasks } = tasksFromGitOnly(repoDir, ['feat/alice-thing', 'feat/bob-thing'], 'main');
  const overlaps = findOverlaps(tasks);
  const banner = 'git-only mode — file-level overlaps from fetched branches; task metadata unavailable';
  const md = renderOverlaps(overlaps, [], { syncedAt: '2026-08-16T00:00:00.000Z', banner });

  assert.match(md, /git-only mode — file-level overlaps/);
  assert.match(md, /\| file \|/);
  assert.doesNotMatch(md, /\| artifact \|/);
  assert.doesNotMatch(md, /\| symbol \|/);
  assert.doesNotMatch(md, /\| dependency-cycle \|/);
  assert.match(md, /## Merge risks\n\n\(none\)/, 'no merge-risk analysis in git-only mode — out of this task\'s scope');
});
