// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderOverlaps } from '../src/grid/overlaps-render.js';

const FIXED_TIME = '2026-08-16T05:00:00.000Z';

function overlap(overrides) {
  return {
    kind: 'artifact',
    severity: 0,
    actors: ['alice', 'bob'],
    tasks: ['@alice#1', '@bob#1'],
    evidence: ['docs/report.md'],
    note: 'both actors declare the same artifact: "docs/report.md"',
    ...overrides,
  };
}

function risk(overrides) {
  return {
    kind: 'same-file',
    actors: ['alice', 'bob'],
    branches: ['feat/a', 'feat/b'],
    files: ['shared.js'],
    detail: 'git merge-tree reports a same-file conflict',
    ...overrides,
  };
}

test('an empty result (no overlaps, no risks) renders an explicit "no overlaps detected" file, not a blank one', () => {
  const md = renderOverlaps([], [], { syncedAt: FIXED_TIME });
  assert.match(md, /no overlaps detected as of 2026-08-16T05:00:00\.000Z/);
  assert.doesNotMatch(md, /\|.*Kind.*\|/); // no table at all when there is genuinely nothing to show
});

test('renders a severity-ranked table of overlaps with a suggested response per kind', () => {
  const overlaps = [
    overlap({ kind: 'artifact', severity: 0 }),
    overlap({ kind: 'dependency-cycle', severity: 1, evidence: ['@alice#1 → @bob#2 → @alice#1'] }),
    overlap({ kind: 'symbol', severity: 2, evidence: ['formatdate'] }),
    overlap({ kind: 'file', severity: 3, evidence: ['src/shared.js'] }),
  ];
  const md = renderOverlaps(overlaps, [], { syncedAt: FIXED_TIME });

  assert.match(md, /## Declared overlaps/);
  assert.match(md, /\| artifact \|/);
  assert.match(md, /coordinate on the shared artifact/);
  assert.match(md, /\| dependency-cycle \|/);
  assert.match(md, /break the cycle/);
  assert.match(md, /\| symbol \|/);
  assert.match(md, /reuse the existing symbol/);
  assert.match(md, /\| file \|/);
  assert.match(md, /same file, different symbols/);

  // preserves the given order (already severity-ranked by findOverlaps) rather than re-sorting
  const order = ['artifact', 'dependency-cycle', 'symbol', 'file'];
  const positions = order.map((kind) => md.indexOf(`| ${kind} |`));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test('renders a merge-risk table with a suggested response per kind', () => {
  const risks = [
    risk({ kind: 'delete-modify', files: ['doomed.js'] }),
    risk({ kind: 'same-file', files: ['shared.js'] }),
    risk({ kind: 'adjacent', files: ['nearby.js'] }),
    risk({ kind: 'unverified', files: ['x.js'], branches: ['feat/a', 'feat/never-pushed'] }),
  ];
  const md = renderOverlaps([], risks, { syncedAt: FIXED_TIME });

  assert.match(md, /## Merge risks/);
  assert.match(md, /\| delete-modify \|/);
  assert.match(md, /work disappears silently/);
  assert.match(md, /\| same-file \|/);
  assert.match(md, /git will conflict here/);
  assert.match(md, /\| adjacent \|/);
  assert.match(md, /hide a semantic conflict/);
  assert.match(md, /\| unverified \|/);
  assert.match(md, /fetch the peer branch/);
});

test('an empty overlaps section (but real risks) renders "(none)" for overlaps, not the fully-empty placeholder', () => {
  const md = renderOverlaps([], [risk()], { syncedAt: FIXED_TIME });
  assert.match(md, /## Declared overlaps\n\n\(none\)/);
  assert.match(md, /## Merge risks/);
  assert.match(md, /\| same-file \|/);
  assert.doesNotMatch(md, /no overlaps detected as of/);
});

test('an empty risks section (but real overlaps) renders "(none)" for risks', () => {
  const md = renderOverlaps([overlap()], [], { syncedAt: FIXED_TIME });
  assert.match(md, /## Merge risks\n\n\(none\)/);
  assert.match(md, /\| artifact \|/);
});

test('surfaces merge-risk warnings (e.g. a too-old git) in a dedicated Warnings section', () => {
  const md = renderOverlaps([], [], { syncedAt: FIXED_TIME, warnings: ['git is too old for `merge-tree --write-tree`'] });
  // the fully-empty-result short-circuit wins even with warnings present, since there is still nothing to show
  assert.match(md, /no overlaps detected/);

  const mdWithFindings = renderOverlaps([overlap()], [], { syncedAt: FIXED_TIME, warnings: ['reconcile: query for FleetTask failed: timeout'] });
  assert.match(mdWithFindings, /## Warnings/);
  assert.match(mdWithFindings, /reconcile: query for FleetTask failed: timeout/);
});

test('output is byte-identical across calls given the same inputs — deterministic for snapshot tests', () => {
  const overlaps = [overlap({ kind: 'artifact' }), overlap({ kind: 'file', evidence: ['a.js', 'b.js'] })];
  const risks = [risk({ kind: 'delete-modify' })];
  const a = renderOverlaps(overlaps, risks, { syncedAt: FIXED_TIME });
  const b = renderOverlaps(overlaps, risks, { syncedAt: FIXED_TIME });
  assert.equal(a, b);
});

test('multiple actors/tasks/evidence entries render joined by comma, not one row per entry', () => {
  const md = renderOverlaps(
    [overlap({ actors: ['alice', 'bob', 'carol'], tasks: ['@alice#1', '@bob#1', '@carol#2'], evidence: ['a.js', 'b.js'] })],
    [],
    { syncedAt: FIXED_TIME }
  );
  assert.match(md, /\| alice, bob, carol \|/);
  assert.match(md, /\| @alice#1, @bob#1, @carol#2 \|/);
  assert.match(md, /\| a\.js, b\.js \|/);
});
