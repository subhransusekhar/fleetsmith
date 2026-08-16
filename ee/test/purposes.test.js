// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { STANDARD_PURPOSES, seedPurposes, assertPurpose, PurposeError } from '../src/grid/purposes.js';
import { request, relatadbBackend } from '../src/memory/relatadb.js';

const SIX = ['cross_dev_reuse', 'regression_check', 'product_context', 'client_commitment', 'decision_rationale', 'grid_sync'];

// --- STANDARD_PURPOSES: the vocabulary itself -----------------------------------------

test('STANDARD_PURPOSES defines exactly the six standard purposes, each with a non-empty one-line meaning', () => {
  assert.deepEqual(Object.keys(STANDARD_PURPOSES).sort(), [...SIX].sort());
  for (const [purpose, meaning] of Object.entries(STANDARD_PURPOSES)) {
    assert.ok(typeof meaning === 'string' && meaning.trim().length > 0, `${purpose} must have a real meaning`);
  }
});

// --- seedPurposes ----------------------------------------------------------------------

test('seedPurposes seeds all six standard purposes, idempotently, with no network call', () => {
  const config = { purposes: [] };
  const first = seedPurposes(config);
  const second = seedPurposes(config);
  assert.deepEqual(first, second);
  for (const p of SIX) assert.ok(first.purposes.includes(p));
  assert.equal(first.registered, false);
  assert.match(first.note, /no purpose-registration endpoint exists/);
});

test('seedPurposes merges a fleet\'s own declared extras, deduplicated against the standard six', () => {
  const result = seedPurposes({ purposes: ['grid_sync', 'my_custom_purpose'] });
  assert.equal(result.purposes.filter((p) => p === 'grid_sync').length, 1, 'a spec-declared purpose already in the standard six must not duplicate');
  assert.ok(result.purposes.includes('my_custom_purpose'));
  assert.equal(result.purposes.length, SIX.length + 1);
});

test('seedPurposes tolerates a config with no purposes field at all', () => {
  const result = seedPurposes({});
  assert.deepEqual(result.purposes.sort(), [...SIX].sort());
});

test('seedPurposes tolerates a completely absent config object', () => {
  const result = seedPurposes(undefined);
  assert.deepEqual(result.purposes.sort(), [...SIX].sort());
});

// --- assertPurpose -----------------------------------------------------------------------

test('assertPurpose accepts every standard purpose', () => {
  for (const p of SIX) assert.doesNotThrow(() => assertPurpose(p));
});

test('assertPurpose rejects an unknown purpose, listing every known one in the error', () => {
  assert.throws(() => assertPurpose('produtc_context' /* typo */), (e) => {
    assert.ok(e instanceof PurposeError);
    assert.match(e.message, /produtc_context/);
    for (const p of SIX) assert.match(e.message, new RegExp(p));
    return true;
  });
});

test('assertPurpose accepts a fleet-declared extra purpose when passed as extraPurposes', () => {
  assert.doesNotThrow(() => assertPurpose('my_custom_purpose', ['my_custom_purpose']));
});

test('assertPurpose still rejects an extra purpose that was never declared', () => {
  assert.throws(() => assertPurpose('undeclared_purpose', ['my_custom_purpose']), PurposeError);
});

// --- live: an audited recall's purpose reaches /audit/entries --------------------------

/**
 * Skips loudly, never passes silently, when no live instance is configured. Unlike G7.1's ACL endpoint (a
 * confirmed non-existent mechanism), `/audit/entries` IS named directly in this project's own milestone doc
 * (`docs/milestones/v0.7.0-intelligence-grid.md`'s architecture section: "`fleetsmith grid audit ... wraps
 * /audit/entries + justify`") — it has simply never been independently exercised against a real instance in
 * any of this project's own prior work (G7.4, the actual `grid audit` CLI wrapper, hasn't been built yet).
 * This test is therefore the FIRST real-instance check of this endpoint's existence and shape — best-effort,
 * not built on an already-verified contract the way most of this milestone's other live tests are. If the
 * endpoint's actual shape differs from what's tried here, that is itself a finding worth recording for G7.4.
 */
test('live: a recall\'s purpose is visible somewhere in /audit/entries, proving the audit chain actually carries it', async (t) => {
  if (!process.env.RELATA_TEST_URL) {
    t.skip('RELATA_TEST_URL not set — no live RelataDB configured for this run');
    return;
  }
  const config = { url: process.env.RELATA_TEST_URL, token: process.env.RELATA_TEST_TOKEN ?? '', purposes: ['fleetsmith_g7_2_live'], fleetName: 'g7-2-audit-test' };
  const backend = relatadbBackend(config);
  const auditPurpose = `fleetsmith_g7_2_audit_probe_${process.pid}`;

  await backend.remember({ kind: 'note', text: 'a note to make a recall meaningful for the audit probe', origin: 'human' });
  await backend.recall('audit probe', { purpose: auditPurpose });
  await new Promise((resolve) => setTimeout(resolve, 3000)); // async ingest/audit settle — verified ~2-3s elsewhere in this milestone

  let auditResult;
  try {
    auditResult = await request(config, { method: 'GET', path: '/audit/entries' });
  } catch (e) {
    t.diagnostic(`GET /audit/entries failed outright: ${e.message} — recording this as a real finding for G7.4, not silently passing`);
    throw e;
  }

  const serialized = JSON.stringify(auditResult);
  assert.match(serialized, new RegExp(auditPurpose), 'the purpose declared on the recall call must appear somewhere in /audit/entries\' response');
});
