// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { findOverlaps, OVERLAP_KINDS } from '../src/grid/overlaps.js';

function task(overrides) {
  return {
    repo_id: 'r1',
    task_seq: 1,
    task: 't',
    status: 'in-progress',
    depends_on: [],
    artifact: '',
    files_declared: [],
    symbols_declared: [],
    ...overrides,
  };
}

function findKind(overlaps, kind) {
  return overlaps.filter((o) => o.kind === kind);
}

// --- each kind, targeted ---------------------------------------------------------

test('detects a file overlap between two actors declaring the same file', () => {
  const overlaps = findOverlaps([
    task({ actor: 'alice', task_seq: 1, files_declared: ['src/a.js', 'src/shared.js'] }),
    task({ actor: 'bob', task_seq: 1, files_declared: ['src/shared.js', 'src/b.js'] }),
  ]);
  const hits = findKind(overlaps, 'file');
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].evidence, ['src/shared.js']);
  assert.deepEqual(hits[0].actors, ['alice', 'bob']);
  assert.deepEqual(hits[0].tasks, ['@alice#1', '@bob#1']);
});

test('detects a symbol overlap, case-insensitively, without needing identical casing', () => {
  const overlaps = findOverlaps([
    task({ actor: 'alice', task_seq: 1, symbols_declared: ['FormatDate', 'Helper'] }),
    task({ actor: 'bob', task_seq: 1, symbols_declared: ['formatdate', 'Other'] }),
  ]);
  const hits = findKind(overlaps, 'symbol');
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].evidence, ['formatdate']);
});

test('detects an artifact overlap when two tasks declare the same artifact path', () => {
  const overlaps = findOverlaps([
    task({ actor: 'alice', task_seq: 1, artifact: 'docs/report.md' }),
    task({ actor: 'bob', task_seq: 1, artifact: 'docs/report.md' }),
  ]);
  const hits = findKind(overlaps, 'artifact');
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].evidence, ['docs/report.md']);
});

test('detects a length-2 dependency cycle (@a#1 -> @b#2 -> @a#1)', () => {
  const overlaps = findOverlaps([
    task({ actor: 'alice', task_seq: 1, depends_on: ['@bob#2'] }),
    task({ actor: 'bob', task_seq: 2, depends_on: ['@alice#1'] }),
  ]);
  const hits = findKind(overlaps, 'dependency-cycle');
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].actors, ['alice', 'bob']);
  assert.deepEqual(hits[0].tasks, ['@alice#1', '@bob#2'].sort());
});

test('detects a length-4 dependency cycle spanning four actors', () => {
  const overlaps = findOverlaps([
    task({ actor: 'alice', task_seq: 1, depends_on: ['@bob#1'] }),
    task({ actor: 'bob', task_seq: 1, depends_on: ['@carol#1'] }),
    task({ actor: 'carol', task_seq: 1, depends_on: ['@dave#1'] }),
    task({ actor: 'dave', task_seq: 1, depends_on: ['@alice#1'] }),
  ]);
  const hits = findKind(overlaps, 'dependency-cycle');
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].actors, ['alice', 'bob', 'carol', 'dave']);
  assert.equal(hits[0].tasks.length, 4);
});

test('does not report a cycle for a same-actor dependency chain (bare #seq is never @-prefixed)', () => {
  const overlaps = findOverlaps([
    task({ actor: 'alice', task_seq: 1, depends_on: ['2'] }),
    task({ actor: 'alice', task_seq: 2, depends_on: ['1'] }),
  ]);
  assert.deepEqual(findKind(overlaps, 'dependency-cycle'), []);
});

test('a dependency reference to a task not present among active tasks is ignored, not a false cycle', () => {
  const overlaps = findOverlaps([task({ actor: 'alice', task_seq: 1, depends_on: ['@bob#99'] })]);
  assert.deepEqual(findKind(overlaps, 'dependency-cycle'), []);
});

// --- same-actor exclusion ----------------------------------------------------------

test('excludes same-actor pairs from file/symbol/artifact overlaps entirely', () => {
  const overlaps = findOverlaps([
    task({ actor: 'alice', task_seq: 1, files_declared: ['src/a.js'], symbols_declared: ['Foo'], artifact: 'x.md' }),
    task({ actor: 'alice', task_seq: 2, files_declared: ['src/a.js'], symbols_declared: ['Foo'], artifact: 'x.md' }),
  ]);
  assert.deepEqual(overlaps, []);
});

// --- only in-progress tasks participate --------------------------------------------

test('a done or pending task never participates in an overlap, even with identical declared work', () => {
  const overlaps = findOverlaps([
    task({ actor: 'alice', task_seq: 1, status: 'done', files_declared: ['src/a.js'] }),
    task({ actor: 'bob', task_seq: 1, status: 'pending', files_declared: ['src/a.js'] }),
  ]);
  assert.deepEqual(overlaps, []);
});

// --- severity ranking and ordering --------------------------------------------------

test('severity ranks artifact > dependency-cycle > symbol > file', () => {
  const overlaps = findOverlaps([
    task({ actor: 'alice', task_seq: 1, artifact: 'shared.md', files_declared: ['f.js'], symbols_declared: ['Foo'], depends_on: ['@bob#1'] }),
    task({ actor: 'bob', task_seq: 1, artifact: 'shared.md', files_declared: ['f.js'], symbols_declared: ['Foo'], depends_on: ['@alice#1'] }),
  ]);
  assert.deepEqual(
    overlaps.map((o) => o.kind),
    ['artifact', 'dependency-cycle', 'symbol', 'file']
  );
  assert.deepEqual(
    overlaps.map((o) => o.severity),
    overlaps.map((o) => OVERLAP_KINDS.indexOf(o.kind))
  );
});

test('within one kind, ties break by evidence count — more shared ground sorts first', () => {
  const overlaps = findOverlaps([
    task({ actor: 'alice', task_seq: 1, files_declared: ['a.js', 'b.js'] }),
    task({ actor: 'bob', task_seq: 1, files_declared: ['a.js', 'b.js'] }),
    task({ actor: 'carol', task_seq: 2, files_declared: ['c.js'] }),
    task({ actor: 'dave', task_seq: 2, files_declared: ['c.js'] }),
  ]);
  const fileHits = findKind(overlaps, 'file');
  assert.equal(fileHits.length, 2);
  assert.deepEqual(fileHits[0].evidence, ['a.js', 'b.js']); // 2 pieces of evidence, sorts before the 1-file pair
  assert.deepEqual(fileHits[1].evidence, ['c.js']);
});

test('output ordering is deterministic regardless of input task order (shuffle property)', () => {
  const tasks = [
    task({ actor: 'alice', task_seq: 1, artifact: 'shared.md' }),
    task({ actor: 'bob', task_seq: 1, artifact: 'shared.md' }),
    task({ actor: 'carol', task_seq: 1, files_declared: ['x.js'] }),
    task({ actor: 'dave', task_seq: 1, files_declared: ['x.js'] }),
    task({ actor: 'erin', task_seq: 1, symbols_declared: ['Widget'] }),
    task({ actor: 'frank', task_seq: 1, symbols_declared: ['widget'] }),
    task({ actor: 'grace', task_seq: 1, depends_on: ['@heidi#1'] }),
    task({ actor: 'heidi', task_seq: 1, depends_on: ['@grace#1'] }),
  ];
  const baseline = findOverlaps(tasks);

  for (let seed = 0; seed < 20; seed++) {
    const shuffled = deterministicShuffle(tasks, seed);
    const result = findOverlaps(shuffled);
    assert.deepEqual(result, baseline, `shuffle seed ${seed} produced a different result`);
  }
});

/** A fixed-seed shuffle (Fisher-Yates over a simple LCG), not Math.random — a failing shuffle test must be reproducible from its seed, not a one-off flake. */
function deterministicShuffle(array, seed) {
  const arr = [...array];
  let state = seed + 1;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// --- purity --------------------------------------------------------------------------

test('overlaps.js imports no fs/network modules and calls no Date.now', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('../src/grid/overlaps.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /from\s+['"]node:(fs|fs\/promises|http|https|net|dgram|dns|child_process)['"]/);
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.doesNotMatch(src, /Date\.now\s*\(/);
});
