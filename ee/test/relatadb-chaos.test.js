// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { relatadbBackend } from '../src/memory/relatadb.js';
import { withDegradation } from '../src/memory/degrade.js';
import { fileBackend } from 'fleetsmith/memory/file';
import { normalizeSpec } from 'fleetsmith/spec';

const execFileAsync = promisify(execFile);

/**
 * The chaos half of the acceptance gate: kill the RelataDB CONTAINER, for
 * real, mid-sequence, and prove the degrade wrapper (G1.4) survives it —
 * exactly one warning, every subsequent verb still succeeds, nothing throws
 * out of this process.
 *
 * HONEST GAP, stated because everything else in this adapter was proven
 * against reality and this one piece could not be: `ghcr.io/relatadb/relata`
 * is registry-gated (`docker pull` → `denied`, verified 2026-08-16 even
 * authenticated with a real GitHub token — see `fixtures/relata-compose.yml`
 * and the relatadb-local-instance-and-v2-api-shapes project memory). Without
 * a pullable image there is no real container for `docker stop` to kill, so
 * the DOCKER-SPECIFIC kill mechanism this test performs has not been run
 * end-to-end in this session. What HAS been verified for real, independently
 * (`ee/src/memory/degrade.js`'s own doc comment and manual verification):
 * pointing the adapter at a genuinely unreachable address produces exactly
 * one warning and every subsequent call succeeds via the file backend — the
 * same degrade LOGIC this test exercises, just triggered by an unreachable
 * port rather than a live `docker stop`. This test proves the CONTAINER
 * lifecycle specifically once someone with registry access can run it;
 * `degrade.test.js`'s scripted suite and the manual verification already
 * prove the degrade behavior itself.
 *
 * Gated on BOTH `RELATA_TEST_URL` (where the instance answers) and
 * `RELATA_TEST_CONTAINER` (the container name/id `docker stop` targets) —
 * a URL alone does not imply there is a container behind it to kill (it
 * could just as well be a natively-running `relata serve`, which this test
 * is not equipped to stop).
 */
test('chaos: stopping the RelataDB container mid-sequence degrades cleanly — one warning, every later verb still succeeds', async (t) => {
  if (!process.env.RELATA_TEST_URL || !process.env.RELATA_TEST_CONTAINER) {
    t.skip(
      'RELATA_TEST_URL and RELATA_TEST_CONTAINER must both be set — this test stops a real docker container by name/id ' +
        '(see fixtures/relata-compose.yml for how to bring one up)'
    );
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-chaos-'));
  const spec = normalizeSpec({ fleet: { name: 'chaos-test' }, agents: [{ name: 'a', role: 'r' }] });
  const file = fileBackend({ spec, cwd: dir });
  const relata = relatadbBackend({
    url: process.env.RELATA_TEST_URL,
    token: process.env.RELATA_TEST_TOKEN ?? '',
    purposes: ['fleetsmith_g1_5_chaos'],
    fleetName: `fleetsmith-g1.5-chaos-${process.pid}`,
  });
  const warnings = [];
  const wrapped = withDegradation(relata, file, { onDegrade: (reason) => warnings.push(reason) });

  try {
    // A memory-heavy sequence while the container is still up. `decision`,
    // not `note`: the file backend's own `readAll()` (src/memory/file.js)
    // only indexes `lesson` and `decision` kinds — a `note` is written but
    // never read back by recall/justify/forget on ANY file-backend instance,
    // a real pre-existing core gap discovered while verifying this suite
    // (confirmed directly: remember({kind:'note', ...}) then recall() on a
    // fresh file backend returns empty). Asserting recall on a `note` here
    // would fail once this test actually runs against a container, not
    // because degradation is broken but because of that unrelated core gap.
    for (let i = 0; i < 5; i++) {
      const { id } = await wrapped.remember({ kind: 'decision', text: `pre-kill item ${i}`, origin: 'human' });
      assert.ok(id);
    }
    assert.equal(warnings.length, 0, 'no warning should fire before anything has failed');

    await execFileAsync('docker', ['stop', process.env.RELATA_TEST_CONTAINER]);

    // Every verb after the kill must still succeed — served by the file
    // backend, with no error surfacing to this caller.
    for (let i = 0; i < 5; i++) {
      const { id } = await wrapped.remember({ kind: 'decision', text: `post-kill item ${i}`, origin: 'human' });
      assert.ok(id);
    }
    const found = await wrapped.recall('post-kill', { purpose: 'fleetsmith_g1_5_chaos' });
    assert.ok(found.length > 0, 'recall must also work post-kill, via the file backend');

    assert.equal(warnings.length, 1, 'exactly one warning across the whole sequence, not one per post-kill call');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
