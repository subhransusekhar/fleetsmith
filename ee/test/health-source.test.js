// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readGridHealthSummaries } from '../src/grid/health-source.js';
import { materialize } from '../src/grid/materialize.js';

function tempLocalDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-health-source-test-'));
}

test('readGridHealthSummaries returns [] when the grid directory does not exist at all', () => {
  const localDir = tempLocalDir();
  assert.deepEqual(readGridHealthSummaries({}, localDir), []);
});

test('readGridHealthSummaries returns [] when peers exist but none have a health.json (no RunEventSummary rows ever pushed)', () => {
  const localDir = tempLocalDir();
  fs.mkdirSync(path.join(localDir, 'grid', 'peers', 'bob'), { recursive: true });
  assert.deepEqual(readGridHealthSummaries({}, localDir), []);
});

test('readGridHealthSummaries reads one row per peer, exactly what materialize() wrote', () => {
  const localDir = tempLocalDir();
  materialize(
    [
      { typeName: 'RunEventSummary', row: { repo_id: 'r', actor: 'bob', run_id: 'r1', gate_pass: 3, gate_block: 1, execute_tool_error: 0 } },
      { typeName: 'RunEventSummary', row: { repo_id: 'r', actor: 'carol', run_id: 'r2', gate_pass: 5, gate_block: 0, execute_tool_error: 2 } },
    ],
    localDir
  );
  const rows = readGridHealthSummaries({}, localDir);
  assert.deepEqual(
    rows.map((r) => r.actor).sort(),
    ['bob', 'carol']
  );
  assert.deepEqual(
    rows.find((r) => r.actor === 'bob'),
    { actor: 'bob', runs: 1, gate_pass: 3, gate_block: 1, execute_tool_error: 0 }
  );
});

test('readGridHealthSummaries tolerates a corrupt health.json — skips it, does not throw', () => {
  const localDir = tempLocalDir();
  fs.mkdirSync(path.join(localDir, 'grid', 'peers', 'dave'), { recursive: true });
  fs.writeFileSync(path.join(localDir, 'grid', 'peers', 'dave', 'health.json'), '{not valid json');
  assert.doesNotThrow(() => readGridHealthSummaries({}, localDir));
  assert.deepEqual(readGridHealthSummaries({}, localDir), []);
});

test('readGridHealthSummaries never touches the network — a plain fs read, no config/spec dependency needed', () => {
  const localDir = tempLocalDir();
  materialize([{ typeName: 'RunEventSummary', row: { repo_id: 'r', actor: 'bob', run_id: 'r1', gate_pass: 1, gate_block: 0, execute_tool_error: 0 } }], localDir);
  // Passing `undefined` for `spec` (the param this fn deliberately ignores) must not throw.
  assert.equal(readGridHealthSummaries(undefined, localDir).length, 1);
});
