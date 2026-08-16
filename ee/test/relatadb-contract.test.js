// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { runContract } from 'fleetsmith/memory/port';
import { relatadbBackend } from '../src/memory/relatadb.js';

/**
 * The acceptance gate for the whole adapter: the SAME `runContract()` suite
 * the file backend is held to (`test/fleetsmith.test.js`'s "the file backend
 * satisfies the memory contract"), run against a real, reachable RelataDB —
 * not a fake server built from this module's own assumptions about the wire
 * format, which cannot by construction catch a case where those assumptions
 * are wrong. It already did, once, during development: an early
 * `consolidate()` design called `recall` with an empty query string to
 * enumerate existing items, and the live engine rejected that outright
 * (`HTTP 400: missing required argument: q (or query)`) despite the query
 * param being schema-optional. That fix (`ee/src/memory/relatadb.js`,
 * `consolidate()`/`forget()`'s doc comments) is exactly what this suite exists
 * to keep proven, not just asserted in a commit message.
 *
 * `RELATA_TEST_URL` (+ optional `RELATA_TEST_TOKEN`, absent when the instance
 * is `RELATA_AUTH_MODE=none`) points this at either the compose fixture
 * (`fixtures/relata-compose.yml` — see that file for its own honest caveat
 * about being unverified, since the image is registry-gated) or any other
 * reachable instance, container or native. Skips loudly, never passes
 * silently, when unset — this is opt-in locally and explicit in CI, per the
 * milestone's own rule that a promotion gate must be reproducible with no
 * live dependency; this suite is deliberately NOT that gate, it is the
 * measurement that a human (or a CI job with real registry credentials)
 * chooses to run.
 */
test('relatadbBackend() satisfies the full memory port contract against a real, reachable RelataDB instance', async (t) => {
  if (!process.env.RELATA_TEST_URL) {
    t.skip('RELATA_TEST_URL not set — no live RelataDB configured for this run (see fixtures/relata-compose.yml, or run `relata serve` natively)');
    return;
  }
  const config = {
    url: process.env.RELATA_TEST_URL,
    token: process.env.RELATA_TEST_TOKEN ?? '',
    purposes: ['fleetsmith_g1_5_contract'],
    // Unique per run so a suite re-run never collides with a previous run's
    // session-scoped rows on a long-lived (non-throwaway) instance.
    fleetName: `fleetsmith-g1.5-contract-${process.pid}-${process.hrtime.bigint()}`,
  };
  await runContract(() => relatadbBackend(config), assert);
});
