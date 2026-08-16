// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines } from '../server/diff.js';

test('diffLines: identical text is all "same"', () => {
  assert.deepEqual(diffLines('a\nb\nc', 'a\nb\nc'), [
    { type: 'same', line: 'a' },
    { type: 'same', line: 'b' },
    { type: 'same', line: 'c' },
  ]);
});

test('diffLines: a single changed line in the middle shows removed-then-added, with unchanged context preserved', () => {
  assert.deepEqual(diffLines('a\nb\nc', 'a\nx\nc'), [
    { type: 'same', line: 'a' },
    { type: 'removed', line: 'b' },
    { type: 'added', line: 'x' },
    { type: 'same', line: 'c' },
  ]);
});

test('diffLines: null/undefined old text (no prior version) produces zero lines, not a phantom empty removed line', () => {
  assert.deepEqual(diffLines(null, 'a\nb'), [
    { type: 'added', line: 'a' },
    { type: 'added', line: 'b' },
  ]);
  assert.deepEqual(diffLines(undefined, undefined), []);
});

test('diffLines: an appended line at the end shows only that line as added, not a full rewrite', () => {
  assert.deepEqual(diffLines('a\nb', 'a\nb\nc'), [
    { type: 'same', line: 'a' },
    { type: 'same', line: 'b' },
    { type: 'added', line: 'c' },
  ]);
});

test('diffLines: a removed line at the end shows only that line as removed', () => {
  assert.deepEqual(diffLines('a\nb\nc', 'a\nb'), [
    { type: 'same', line: 'a' },
    { type: 'same', line: 'b' },
    { type: 'removed', line: 'c' },
  ]);
});

test('diffLines: completely disjoint text is all removed-then-added, never a false "same"', () => {
  const ops = diffLines('one\ntwo', 'three\nfour');
  assert.deepEqual(ops.map((o) => o.type).sort(), ['added', 'added', 'removed', 'removed']);
  assert.ok(!ops.some((o) => o.type === 'same'));
});
