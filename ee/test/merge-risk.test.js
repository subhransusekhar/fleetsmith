// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mergeRisks, resolveMergeTreeSupport } from '../src/grid/merge-risk.js';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function initRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-merge-risk-test-'));
  git(['init', '-q'], repoDir);
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

function task(overrides) {
  return {
    repo_id: 'r1',
    actor: 'alice',
    task_seq: 1,
    task: 't',
    status: 'in-progress',
    branch: 'main',
    files_declared: [],
    ...overrides,
  };
}

test('git is new enough here for merge-tree --write-tree (sanity precondition for every other test)', () => {
  const repoDir = initRepo();
  assert.equal(resolveMergeTreeSupport(repoDir), true);
});

test('resolveMergeTreeSupport returns false when the usage text does not mention --write-tree (e.g. no git repo at all)', () => {
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-merge-risk-notrepo-'));
  assert.equal(resolveMergeTreeSupport(notARepo), false);
});

test('an unsupported git degrades the WHOLE batch to declared-file intersection with a warning, never a real merge-tree call', () => {
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-merge-risk-degraded-'));

  const { risks, warnings } = mergeRisks(
    [
      task({ actor: 'alice', branch: 'feat/a', files_declared: ['shared.js', 'a-only.js'] }),
      task({ actor: 'bob', branch: 'feat/b', files_declared: ['shared.js', 'b-only.js'] }),
    ],
    notARepo
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /too old for `merge-tree --write-tree`/);
  assert.equal(risks.length, 1);
  assert.equal(risks[0].kind, 'unverified');
  assert.deepEqual(risks[0].files, ['shared.js']);
  assert.match(risks[0].detail, /git too old for merge-tree/);
});

test('classifies a same-file content conflict (two branches edit the same line)', () => {
  const repoDir = initRepo();
  writeFile(repoDir, 'shared.js', 'line one\nline two\nline three\n');
  const base = commitAll(repoDir, 'base');

  branchFrom(repoDir, base, 'feat/a');
  writeFile(repoDir, 'shared.js', 'line one\nALICE CHANGED THIS\nline three\n');
  commitAll(repoDir, 'alice edits line two');

  branchFrom(repoDir, base, 'feat/b');
  writeFile(repoDir, 'shared.js', 'line one\nBOB CHANGED THIS\nline three\n');
  commitAll(repoDir, 'bob edits line two');

  const before = git(['status', '--porcelain'], repoDir);
  const { risks, warnings } = mergeRisks(
    [
      task({ actor: 'alice', branch: 'feat/a' }),
      task({ actor: 'bob', branch: 'feat/b' }),
    ],
    repoDir
  );
  const after = git(['status', '--porcelain'], repoDir);

  assert.equal(before, after, 'merge-tree analysis must leave the working tree and index untouched');
  assert.deepEqual(warnings, []);
  assert.equal(risks.length, 1);
  assert.equal(risks[0].kind, 'same-file');
  assert.deepEqual(risks[0].actors, ['alice', 'bob']);
  assert.deepEqual(risks[0].branches, ['feat/a', 'feat/b']);
  assert.deepEqual(risks[0].files, ['shared.js']);
});

test('classifies a delete/modify conflict (one branch deletes, the other edits)', () => {
  const repoDir = initRepo();
  writeFile(repoDir, 'doomed.js', 'line one\nline two\n');
  const base = commitAll(repoDir, 'base');

  branchFrom(repoDir, base, 'feat/a');
  fs.rmSync(path.join(repoDir, 'doomed.js'));
  commitAll(repoDir, 'alice deletes the file');

  branchFrom(repoDir, base, 'feat/b');
  writeFile(repoDir, 'doomed.js', 'line one\nline two\nline three\n');
  commitAll(repoDir, 'bob edits the file');

  const { risks, warnings } = mergeRisks(
    [
      task({ actor: 'alice', branch: 'feat/a' }),
      task({ actor: 'bob', branch: 'feat/b' }),
    ],
    repoDir
  );

  assert.deepEqual(warnings, []);
  assert.equal(risks.length, 1);
  assert.equal(risks[0].kind, 'delete-modify');
  assert.deepEqual(risks[0].files, ['doomed.js']);
});

test('classifies close-but-not-conflicting edits in the same file as adjacent', () => {
  const repoDir = initRepo();
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
  writeFile(repoDir, 'nearby.js', lines);
  const base = commitAll(repoDir, 'base');

  branchFrom(repoDir, base, 'feat/a');
  const aLines = lines.split('\n');
  aLines[4] = 'ALICE EDIT';
  writeFile(repoDir, 'nearby.js', aLines.join('\n'));
  commitAll(repoDir, 'alice edits line 5');

  branchFrom(repoDir, base, 'feat/b');
  const bLines = lines.split('\n');
  bLines[6] = 'BOB EDIT';
  writeFile(repoDir, 'nearby.js', bLines.join('\n'));
  commitAll(repoDir, 'bob edits line 7');

  const { risks, warnings } = mergeRisks(
    [
      task({ actor: 'alice', branch: 'feat/a' }),
      task({ actor: 'bob', branch: 'feat/b' }),
    ],
    repoDir
  );

  assert.deepEqual(warnings, []);
  const adjacent = risks.filter((r) => r.kind === 'adjacent');
  assert.equal(adjacent.length, 1);
  assert.deepEqual(adjacent[0].files, ['nearby.js']);
  assert.deepEqual(risks.filter((r) => r.kind === 'same-file' || r.kind === 'delete-modify'), []);
});

test('edits far apart in the same file merge clean and produce no risk at all', () => {
  const repoDir = initRepo();
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
  writeFile(repoDir, 'far.js', lines);
  const base = commitAll(repoDir, 'base');

  branchFrom(repoDir, base, 'feat/a');
  const aLines = lines.split('\n');
  aLines[2] = 'ALICE EDIT';
  writeFile(repoDir, 'far.js', aLines.join('\n'));
  commitAll(repoDir, 'alice edits near the top');

  branchFrom(repoDir, base, 'feat/b');
  const bLines = lines.split('\n');
  bLines[35] = 'BOB EDIT';
  writeFile(repoDir, 'far.js', bLines.join('\n'));
  commitAll(repoDir, 'bob edits near the bottom');

  const { risks, warnings } = mergeRisks(
    [
      task({ actor: 'alice', branch: 'feat/a' }),
      task({ actor: 'bob', branch: 'feat/b' }),
    ],
    repoDir
  );

  assert.deepEqual(warnings, []);
  assert.deepEqual(risks, []);
});

test('a branch that cannot be resolved locally degrades to declared-file intersection, tagged unverified', () => {
  const repoDir = initRepo();
  writeFile(repoDir, 'README.md', 'base\n');
  const base = commitAll(repoDir, 'base');

  branchFrom(repoDir, base, 'feat/a');
  writeFile(repoDir, 'a-only.js', 'alice work\n');
  commitAll(repoDir, 'alice work');

  const { risks, warnings } = mergeRisks(
    [
      task({ actor: 'alice', branch: 'feat/a', files_declared: ['shared.js', 'a-only.js'] }),
      task({ actor: 'bob', branch: 'feat/never-pushed', files_declared: ['shared.js', 'b-only.js'] }),
    ],
    repoDir
  );

  assert.deepEqual(warnings, []);
  assert.equal(risks.length, 1);
  assert.equal(risks[0].kind, 'unverified');
  assert.deepEqual(risks[0].files, ['shared.js']);
  assert.match(risks[0].detail, /peer branch not fetched/);
});

test('a declared-file intersection that turns out empty produces no unverified risk', () => {
  const repoDir = initRepo();
  writeFile(repoDir, 'README.md', 'base\n');
  commitAll(repoDir, 'base');

  const { risks } = mergeRisks(
    [
      task({ actor: 'alice', branch: 'feat/missing-a', files_declared: ['only-alice.js'] }),
      task({ actor: 'bob', branch: 'feat/missing-b', files_declared: ['only-bob.js'] }),
    ],
    repoDir
  );

  assert.deepEqual(risks, []);
});

test('same-actor pairs are excluded even across two branches for the same person', () => {
  const repoDir = initRepo();
  writeFile(repoDir, 'shared.js', 'one\ntwo\n');
  const base = commitAll(repoDir, 'base');

  branchFrom(repoDir, base, 'feat/x');
  writeFile(repoDir, 'shared.js', 'ONE\ntwo\n');
  commitAll(repoDir, 'x edit');

  branchFrom(repoDir, base, 'feat/y');
  writeFile(repoDir, 'shared.js', 'one\nTWO\n');
  commitAll(repoDir, 'y edit');

  const { risks } = mergeRisks(
    [
      task({ actor: 'alice', branch: 'feat/x' }),
      task({ actor: 'alice', branch: 'feat/y' }),
    ],
    repoDir
  );

  assert.deepEqual(risks, []);
});

test('only in-progress tasks with a branch participate', () => {
  const repoDir = initRepo();
  writeFile(repoDir, 'README.md', 'base\n');
  commitAll(repoDir, 'base');

  const { risks } = mergeRisks(
    [
      // excluded: not in-progress, and no branch at all — neither should ever reach a pairwise comparison
      task({ actor: 'alice', branch: 'feat/a', status: 'done', files_declared: ['x.js'] }),
      task({ actor: 'carol', status: 'in-progress', branch: undefined, files_declared: ['x.js'] }),
      // the only genuinely eligible pair
      task({ actor: 'dave', branch: 'feat/dave-never-pushed', files_declared: ['x.js'] }),
      task({ actor: 'erin', branch: 'feat/erin-never-pushed', files_declared: ['x.js'] }),
    ],
    repoDir
  );

  assert.equal(risks.length, 1);
  assert.equal(risks[0].kind, 'unverified');
  assert.deepEqual(risks[0].actors, ['dave', 'erin']);
  assert.deepEqual(risks[0].files, ['x.js']);
});

test('running the full analysis leaves the repo\'s working tree and index completely clean', () => {
  const repoDir = initRepo();
  writeFile(repoDir, 'shared.js', 'one\ntwo\nthree\n');
  const base = commitAll(repoDir, 'base');

  branchFrom(repoDir, base, 'feat/a');
  writeFile(repoDir, 'shared.js', 'ONE\ntwo\nthree\n');
  commitAll(repoDir, 'a edit');

  branchFrom(repoDir, base, 'feat/b');
  writeFile(repoDir, 'shared.js', 'one\ntwo\nTHREE\n');
  commitAll(repoDir, 'b edit');

  git(['checkout', '-q', base], repoDir);
  const statusBefore = git(['status', '--porcelain'], repoDir);
  const branchBefore = git(['rev-parse', 'HEAD'], repoDir);

  mergeRisks(
    [
      task({ actor: 'alice', branch: 'feat/a' }),
      task({ actor: 'bob', branch: 'feat/b' }),
    ],
    repoDir
  );

  assert.equal(git(['status', '--porcelain'], repoDir), statusBefore);
  assert.equal(git(['rev-parse', 'HEAD'], repoDir), branchBefore);
});

test('an explicit stagingBase actually changes the analysis, proving it is really passed through to git', () => {
  const repoDir = initRepo();
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
  writeFile(repoDir, 'far.js', lines);
  const base = commitAll(repoDir, 'base');

  // An unrelated commit that disagrees with `base` at line 19 only — never an ancestor of either branch below,
  // so passing it as `stagingBase` is a deliberately "wrong" merge-base, not just a redundant restatement of
  // the real one.
  const altLines = lines.split('\n');
  altLines[19] = 'ALT BASE EDIT';
  writeFile(repoDir, 'far.js', altLines.join('\n'));
  const altBase = commitAll(repoDir, 'alternate base, line 19 differs');
  git(['checkout', '-q', base], repoDir);

  branchFrom(repoDir, base, 'feat/a');
  const aLines = lines.split('\n');
  aLines[2] = 'ALICE EDIT'; // far from line 19
  writeFile(repoDir, 'far.js', aLines.join('\n'));
  commitAll(repoDir, 'a edits near the top');

  branchFrom(repoDir, base, 'feat/b');
  const bLines = lines.split('\n');
  bLines[37] = 'BOB EDIT'; // far from line 19 too
  writeFile(repoDir, 'far.js', bLines.join('\n'));
  commitAll(repoDir, 'b edits near the bottom');

  const tasks = [task({ actor: 'alice', branch: 'feat/a' }), task({ actor: 'bob', branch: 'feat/b' })];

  const withAutoBase = mergeRisks(tasks, repoDir);
  assert.deepEqual(withAutoBase.warnings, []);
  assert.deepEqual(withAutoBase.risks, []); // top and bottom edits, real merge-base: clean, no risk

  const withOverriddenBase = mergeRisks(tasks, repoDir, altBase);
  assert.deepEqual(withOverriddenBase.warnings, []);
  // Relative to `altBase`, both branches show a hunk at line 19 (each reverting it back to the same value) —
  // git's 3-way merge itself doesn't conflict there (both sides agree), but the diff-based proximity check
  // against this deliberately-wrong base now sees hunks at line 19 on both sides plus the real top/bottom
  // edits, so the closest pair is well within the adjacency threshold — a result that only appears because
  // the override actually changed which base the analysis diffed against.
  assert.equal(withOverriddenBase.risks.length, 1);
  assert.equal(withOverriddenBase.risks[0].kind, 'adjacent');
  assert.deepEqual(withOverriddenBase.risks[0].files, ['far.js']);
});

test('output is sorted by risk severity: delete-modify > same-file > adjacent > unverified', () => {
  const repoDir = initRepo();
  writeFile(repoDir, 'conflict.js', 'one\ntwo\n');
  writeFile(repoDir, 'doomed.js', 'one\ntwo\n');
  const base = commitAll(repoDir, 'base');

  branchFrom(repoDir, base, 'feat/a');
  writeFile(repoDir, 'conflict.js', 'ALICE\ntwo\n');
  fs.rmSync(path.join(repoDir, 'doomed.js'));
  commitAll(repoDir, 'a edits + deletes');

  branchFrom(repoDir, base, 'feat/b');
  writeFile(repoDir, 'conflict.js', 'BOB\ntwo\n');
  writeFile(repoDir, 'doomed.js', 'one\nTWO\n');
  commitAll(repoDir, 'b edits both');

  const { risks } = mergeRisks(
    [
      task({ actor: 'alice', branch: 'feat/a' }),
      task({ actor: 'bob', branch: 'feat/b' }),
    ],
    repoDir
  );

  const kinds = risks.map((r) => r.kind);
  const deleteModifyIdx = kinds.indexOf('delete-modify');
  const sameFileIdx = kinds.indexOf('same-file');
  assert.ok(deleteModifyIdx !== -1 && sameFileIdx !== -1);
  assert.ok(deleteModifyIdx < sameFileIdx, `expected delete-modify before same-file, got order: ${kinds}`);
});

test('merge-risk.js imports no network module and calls no Date.now', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('../src/grid/merge-risk.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /from\s+['"]node:(http|https|net|dgram|dns)['"]/);
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.doesNotMatch(src, /Date\.now\s*\(/);
});
