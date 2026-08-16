// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';
import { fakeRelata } from './fake-relata.js';
import { repoIdFromRemote } from '../server/repo.js';
import { storageStatus, licenseStatus } from '../server/routes/health.js';

async function withConsole(consoleEnv, relataOpts, fn) {
  const { server: relataServer, requests } = fakeRelata(relataOpts);
  await new Promise((resolve) => relataServer.listen(0, '127.0.0.1', resolve));
  const relataUrl = `http://127.0.0.1:${relataServer.address().port}`;
  const { server } = createServer({ RELATA_URL: relataUrl, ...consoleEnv });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const consoleUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ consoleUrl, requests });
  } finally {
    server.closeAllConnections?.();
    relataServer.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => relataServer.close(resolve));
  }
}

function call(url, token) {
  return fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : {}).then(async (res) => ({ status: res.status, body: await res.json() }));
}

// --- pure functions ----------------------------------------------------------------------------------------

test('storageStatus parses the real relata_store_total_stored_bytes gauge and computes percentUsed against the 10 GB free-tier cap', () => {
  const metrics = 'relata_store_total_stored_bytes 5368709120\n'; // exactly 5 GiB
  const status = storageStatus(metrics, 'free');
  assert.equal(status.available, true);
  assert.equal(status.usedBytes, 5368709120);
  assert.equal(status.capBytes, 10 * 1024 ** 3);
  assert.equal(status.percentUsed, 50);
});

test('storageStatus reports no cap for a non-free profile — this console has no basis to guess one', () => {
  const status = storageStatus('relata_store_total_stored_bytes 1000\n', 'server');
  assert.equal(status.capBytes, null);
  assert.equal(status.percentUsed, null);
});

test('storageStatus is unavailable (not zero) when the metric is missing from the text entirely', () => {
  assert.deepEqual(storageStatus('# nothing relevant here\n', 'free'), { available: false });
});

test('licenseStatus is unconfigured (no warning, no error) when no expiry was ever set — the honest default', () => {
  assert.deepEqual(licenseStatus(null), { configured: false });
});

test('licenseStatus renders a warning exactly at the 14-day threshold (this task\'s own acceptance criterion, as a fixture)', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const exactlyFourteen = licenseStatus(new Date(now + 14 * 86_400_000).toISOString(), now);
  assert.equal(exactlyFourteen.daysRemaining, 14);
  assert.equal(exactlyFourteen.warning, true);
  assert.match(exactlyFourteen.message, /start reissue now/);

  const fifteen = licenseStatus(new Date(now + 15 * 86_400_000).toISOString(), now);
  assert.equal(fifteen.warning, false);
  assert.match(fifteen.message, /valid for 15 more day/);
});

test('licenseStatus reports a negative daysRemaining, not a crash, for an already-expired license', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const status = licenseStatus(new Date(now - 86_400_000).toISOString(), now);
  assert.equal(status.daysRemaining, -1);
  assert.equal(status.warning, true);
});

test('licenseStatus reports a clear error for an unparseable date, not a crash', () => {
  const status = licenseStatus('not-a-date');
  assert.equal(status.configured, false);
  assert.match(status.error, /not a valid date/);
});

// --- GET /api/health (public, unchanged) ------------------------------------------------------------------

test('GET /api/health requires no token — unchanged from G8.1', async () => {
  await withConsole({}, {}, async ({ consoleUrl }) => {
    const { status, body } = await call(`${consoleUrl}/api/health`);
    assert.equal(status, 200);
    assert.equal(body.reachable, true);
  });
});

// --- GET /api/health/detail (member, new) -------------------------------------------------------------------

test('GET /api/health/detail requires a token — /status and /metrics both need one', async () => {
  await withConsole({}, {}, async ({ consoleUrl }) => {
    const { status } = await fetch(`${consoleUrl}/api/health/detail`).then((res) => ({ status: res.status }));
    assert.equal(status, 401);
  });
});

test('GET /api/health/detail returns engineStatus and storage, using the caller\'s own token (never an admin secret)', async () => {
  await withConsole(
    {},
    { engineStatus: { profile: 'free', node_id: 'n1', role: 'coordinator', active_connections: 2, query_quota: 10000, ingested_rows: 5, uptime_secs: 900 }, metricsText: 'relata_store_total_stored_bytes 1073741824\n' },
    async ({ consoleUrl, requests }) => {
      const { status, body } = await call(`${consoleUrl}/api/health/detail`, 'member-token');
      assert.equal(status, 200);
      assert.equal(body.engineStatus.node_id, 'n1');
      assert.equal(body.storage.usedBytes, 1073741824);
      assert.equal(body.storage.capBytes, 10 * 1024 ** 3);
      const statusReq = requests.find((r) => r.pathname === '/status');
      const metricsReq = requests.find((r) => r.pathname === '/metrics');
      assert.equal(statusReq.token, 'member-token');
      assert.equal(metricsReq.token, 'member-token');
    }
  );
});

test('GET /api/health/detail surfaces license status from RELATA_LICENSE_EXPIRES_AT', async () => {
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
  await withConsole({ RELATA_LICENSE_EXPIRES_AT: soon }, {}, async ({ consoleUrl }) => {
    const { body } = await call(`${consoleUrl}/api/health/detail`, 'member-token');
    assert.equal(body.license.configured, true);
    assert.equal(body.license.warning, true);
  });
});

test('GET /api/health/detail without ?remote reports an empty harness panel, not an error', async () => {
  await withConsole({}, {}, async ({ consoleUrl }) => {
    const { status, body } = await call(`${consoleUrl}/api/health/detail`, 'member-token');
    assert.equal(status, 200);
    assert.deepEqual(body.harness, []);
  });
});

test('GET /api/health/detail?remote= reports per-actor harness state from ActorPresence.last_sync', async () => {
  const remote = 'git@github.com:acme/health-fixture.git';
  const repoId = repoIdFromRemote(remote);
  const now = Date.now();
  const healthy = new Date(now - 60_000).toISOString(); // 1 min ago — well inside the TTL
  const degraded = new Date(now - 20 * 60_000).toISOString(); // 20 min ago — past it

  await withConsole(
    {},
    {
      queryRows: {
        ActorPresence: [
          { repo_id: repoId, actor: 'ada', run_id: 'ada-sync', heartbeat_at: healthy, last_sync: healthy },
          { repo_id: repoId, actor: 'grace', run_id: 'grace-sync', heartbeat_at: healthy, last_sync: degraded },
          { repo_id: repoId, actor: 'bob', run_id: 'bob-daemon', heartbeat_at: healthy }, // heartbeating, but has NEVER completed a sync
        ],
      },
    },
    async ({ consoleUrl }) => {
      const { body } = await call(`${consoleUrl}/api/health/detail?remote=${encodeURIComponent(remote)}`, 'member-token');
      const byActor = Object.fromEntries(body.harness.map((h) => [h.actor, h]));
      assert.equal(byActor.ada.state, 'healthy');
      assert.equal(byActor.grace.state, 'degraded', 'a stale last_sync must show degraded even though heartbeat_at looks fine');
      assert.equal(byActor.bob.state, 'unknown', 'no last_sync at all is its own state, not folded into healthy or degraded');
    }
  );
});

// --- live-gated: a briefly-degraded harness freezes last_sync, visible through the console's own route ------
//
// "Shows as degraded within one sync cycle" is a TIME-based classification (harnessStatus's
// LAST_SYNC_DEGRADED_TTL_MS, ~2 missed cycles' worth of slack) — the fixture test above already proves that
// classification switches correctly at its threshold, fast and deterministically, without a real 10-minute
// wait. What a live test can prove that a fixture cannot: that a REAL syncOnce() failure against a REAL
// instance actually leaves last_sync frozen at its last real value rather than silently blanking or advancing
// it — the substantive behavior this task's whole harness-panel design depends on.

test('live: a real syncOnce failure leaves last_sync exactly where the last successful cycle left it — never blanked, never advanced', async (t) => {
  if (!process.env.RELATA_TEST_URL) {
    t.skip('RELATA_TEST_URL not set — no live RelataDB configured for this run');
    return;
  }
  const { syncOnce, loadSpecFile } = await import('../../src/grid/daemon.js');
  const { reconcile } = await import('../../src/grid/pull.js');
  const { resolveRepoId } = await import('../../src/grid/ontology.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-g8-7-live-'));
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'g8-7-live@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'g8-7-live'], { cwd: repoDir });
  execFileSync('git', ['remote', 'add', 'origin', `git@github.com:acme/g8-7-live-${Date.now()}.git`], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'fleet.yaml'), 'fleet:\n  name: g8-7-live-fleet\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repoDir });
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim()], { cwd: repoDir });

  const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
  const actor = `g8-7-live-actor-${Date.now()}`;
  process.env.RELATA_URL = process.env.RELATA_TEST_URL;
  process.env.RELATA_TOKEN = process.env.RELATA_TEST_TOKEN ?? '';
  process.env.FLEETSMITH_ACTOR = actor;
  try {
    const healthy = await syncOnce(spec, repoDir);
    assert.equal(healthy.degraded, false, 'a real, reachable cortex must complete a normal cycle first');
    assert.ok(healthy.lastSync, 'a successful cycle must return the timestamp it stamped');

    process.env.RELATA_URL = 'http://127.0.0.1:1'; // a real, briefly-unreachable cortex for this actor
    const degraded = await syncOnce(spec, repoDir);
    assert.equal(degraded.degraded, true);

    process.env.RELATA_URL = process.env.RELATA_TEST_URL; // restore, to actually read back the real row
    const config = { url: process.env.RELATA_URL, token: process.env.RELATA_TOKEN, purposes: ['fleetsmith_g8_7_live'] };
    const repoId = resolveRepoId(repoDir);
    const { newRows } = await reconcile(config, repoId, { actor: ' nobody-g8-7 ' });
    const presenceRow = newRows.find((r) => r.typeName === 'ActorPresence' && r.row.actor === actor)?.row;
    assert.ok(presenceRow, 'this actor\'s presence row must be visible via the same reconcile() the console uses');
    assert.equal(presenceRow.last_sync, healthy.lastSync, 'last_sync must be exactly the healthy cycle\'s value — the failed cycle must not have touched it at all');
  } finally {
    delete process.env.RELATA_URL;
    delete process.env.RELATA_TOKEN;
    delete process.env.FLEETSMITH_ACTOR;
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
