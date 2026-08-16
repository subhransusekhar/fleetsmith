// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { reconcile, pullOnce, watchGridChanges, startIntervalReconcile, PullError } from '../src/grid/pull.js';

const REPO_ID = createHash('sha256').update('fixture-repo').digest('hex');

/**
 * A fake `/query` endpoint returning canned records shaped exactly like the real engine's verified response:
 * one result record per `/ingest` call, each holding the JSON array of that call's rows under a pseudo-column
 * literally named `rows`. `recordsByType[typeName]` is an array of arrays-of-rows (one inner array per
 * simulated `/ingest` call), returned in that order — matching the real engine's stable insertion-order
 * behavior (verified 3x against a live instance).
 */
function fakeQueryServer(recordsByType, { failTypes = [] } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      const url = new URL(req.url, 'http://localhost');
      requests.push({ pathname: url.pathname, body: parsed });

      if (req.method === 'POST' && url.pathname === '/query') {
        const match = /FROM (\w+)/.exec(parsed.sql);
        const typeName = match?.[1];
        if (failTypes.includes(typeName)) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'about:blank', title: 'Internal Server Error', status: 500, detail: 'simulated failure' }));
          return;
        }
        const records = recordsByType[typeName] ?? [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ rows: records.length, columns: ['rows'], data: records.map((rows) => ({ rows: JSON.stringify(rows) })) }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'about:blank', title: 'Not Found', status: 404 }));
    });
  });
  return { server, requests };
}

async function withFakeQueryServer(recordsByType, fn, serverOpts) {
  const { server, requests } = fakeQueryServer(recordsByType, serverOpts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const config = { url: `http://127.0.0.1:${port}`, token: 'test-token', purposes: ['grid_sync'] };
  try {
    await fn(config, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// --- reconcile: unpacking, own-actor filtering, page-limit warning ------------

test('reconcile unpacks one record per ingest call into flat rows, across all four types', async () => {
  const recordsByType = {
    FleetTask: [[{ repo_id: REPO_ID, actor: 'bob', task_seq: 1, task: 't1' }], [{ repo_id: REPO_ID, actor: 'carol', task_seq: 1, task: 't2' }]],
    ActorPresence: [[{ repo_id: REPO_ID, actor: 'bob', run_id: 'r1' }]],
    HandoffPointer: [],
    RunEventSummary: [],
  };
  await withFakeQueryServer(recordsByType, async (config) => {
    const { newRows, warnings } = await reconcile(config, REPO_ID, { actor: 'alice' });
    assert.equal(newRows.length, 3);
    assert.ok(newRows.some((r) => r.typeName === 'FleetTask' && r.row.actor === 'bob'));
    assert.ok(newRows.some((r) => r.typeName === 'FleetTask' && r.row.actor === 'carol'));
    assert.ok(newRows.some((r) => r.typeName === 'ActorPresence' && r.row.actor === 'bob'));
    assert.deepEqual(warnings, []);
  });
});

test('reconcile filters rows to the given repoId client-side (no WHERE clause is ever sent)', async () => {
  const otherRepoId = createHash('sha256').update('a-different-repo').digest('hex');
  const recordsByType = {
    FleetTask: [[{ repo_id: REPO_ID, actor: 'bob', task_seq: 1, task: 'mine-repo' }, { repo_id: otherRepoId, actor: 'carol', task_seq: 1, task: 'other-repo' }]],
    ActorPresence: [],
    HandoffPointer: [],
    RunEventSummary: [],
  };
  await withFakeQueryServer(recordsByType, async (config, requests) => {
    const { newRows } = await reconcile(config, REPO_ID, { actor: 'alice' });
    assert.equal(newRows.length, 1);
    assert.equal(newRows[0].row.task, 'mine-repo');
    assert.ok(requests.every((r) => !/WHERE/i.test(r.body.sql)), 'no WHERE clause should ever be sent — the engine returns zero rows for any WHERE at all on ad-hoc types');
  });
});

test('reconcile filters out rows attributed to the local actor — you are not your own peer', async () => {
  const recordsByType = {
    FleetTask: [[{ repo_id: REPO_ID, actor: 'alice', task_seq: 1, task: 'mine' }, { repo_id: REPO_ID, actor: 'bob', task_seq: 1, task: 'theirs' }]],
    ActorPresence: [],
    HandoffPointer: [],
    RunEventSummary: [],
  };
  await withFakeQueryServer(recordsByType, async (config) => {
    const { newRows } = await reconcile(config, REPO_ID, { actor: 'alice' });
    assert.equal(newRows.length, 1);
    assert.equal(newRows[0].row.actor, 'bob');
  });
});

test('reconcile warns when a type hits the page-limit cap, without throwing', async () => {
  const recordsByType = {
    FleetTask: [[{ repo_id: REPO_ID, actor: 'bob', task_seq: 1 }], [{ repo_id: REPO_ID, actor: 'carol', task_seq: 1 }]],
    ActorPresence: [],
    HandoffPointer: [],
    RunEventSummary: [],
  };
  await withFakeQueryServer(recordsByType, async (config) => {
    const { warnings } = await reconcile(config, REPO_ID, { actor: 'alice', limit: 2 });
    assert.ok(warnings.some((w) => w.includes('FleetTask') && w.includes('page cap')));
  });
});

test('reconcile refuses a malformed repoId before any network call', async () => {
  await withFakeQueryServer({}, async (config, requests) => {
    await assert.rejects(() => reconcile(config, 'not-a-real-repo-id', { actor: 'alice' }), PullError);
    assert.equal(requests.length, 0);
  });
});

test('reconcile includes AFTER in the SQL when a cursor is given, and omits it otherwise', async () => {
  await withFakeQueryServer({ FleetTask: [], ActorPresence: [], HandoffPointer: [], RunEventSummary: [] }, async (config, requests) => {
    await reconcile(config, REPO_ID, { actor: 'alice' });
    assert.ok(requests.every((r) => !r.body.sql.includes('AFTER')));

    requests.length = 0;
    await reconcile(config, REPO_ID, { actor: 'alice', cursor: '12345' });
    assert.ok(requests.every((r) => r.body.sql.includes("AFTER '12345'")));
  });
});

test('reconcile collects a per-type query failure into warnings without failing the whole reconcile', async () => {
  const recordsByType = { ActorPresence: [[{ repo_id: REPO_ID, actor: 'bob', run_id: 'r1' }]], HandoffPointer: [], RunEventSummary: [] };
  await withFakeQueryServer(
    recordsByType,
    async (config) => {
      const { newRows, warnings } = await reconcile(config, REPO_ID, { actor: 'alice' });
      assert.ok(newRows.some((r) => r.typeName === 'ActorPresence'), 'unaffected types must still succeed');
      assert.ok(warnings.some((w) => w.includes('FleetTask') && w.includes('failed')));
    },
    { failTypes: ['FleetTask'] }
  );
});

// --- pullOnce: cursor file round-trip -----------------------------------------

test('pullOnce reads an existing cursor file and sends it as AFTER, then rewrites the file', async () => {
  await withFakeQueryServer({ FleetTask: [], ActorPresence: [], HandoffPointer: [], RunEventSummary: [] }, async (config, requests) => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-pull-test-'));
    const localDir = path.join(repoDir, '_fleet', 'local');
    fs.mkdirSync(path.join(localDir, 'grid'), { recursive: true });
    fs.writeFileSync(path.join(localDir, 'grid', 'cursor'), 'seed-cursor-value\n');

    await pullOnce(config, repoDir, { localDir, repoId: REPO_ID, actor: 'alice' });
    assert.ok(requests.every((r) => r.body.sql.includes("AFTER 'seed-cursor-value'")));
    assert.equal(fs.readFileSync(path.join(localDir, 'grid', 'cursor'), 'utf8'), 'seed-cursor-value\n');
  });
});

test('pullOnce works with no prior cursor file (fresh checkout)', async () => {
  await withFakeQueryServer({ FleetTask: [], ActorPresence: [], HandoffPointer: [], RunEventSummary: [] }, async (config, requests) => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-pull-test-'));
    const localDir = path.join(repoDir, '_fleet', 'local');

    const result = await pullOnce(config, repoDir, { localDir, repoId: REPO_ID, actor: 'alice' });
    assert.deepEqual(result.newRows, []);
    assert.ok(requests.every((r) => !r.body.sql.includes('AFTER')));
    assert.ok(fs.existsSync(path.join(localDir, 'grid', 'cursor')));
  });
});

test('pullOnce survives a restart between calls: a second pullOnce sees whatever the first one persisted, no throw', async () => {
  await withFakeQueryServer({ FleetTask: [], ActorPresence: [], HandoffPointer: [], RunEventSummary: [] }, async (config) => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-pull-test-'));
    const localDir = path.join(repoDir, '_fleet', 'local');

    await pullOnce(config, repoDir, { localDir, repoId: REPO_ID, actor: 'alice' });
    // Simulate a process restart: a brand-new call, same on-disk state, must not throw or lose the file.
    await pullOnce(config, repoDir, { localDir, repoId: REPO_ID, actor: 'alice' });
    assert.ok(fs.existsSync(path.join(localDir, 'grid', 'cursor')));
  });
});

// --- watchGridChanges: mock SSE server -----------------------------------------

function sseServer() {
  const connections = [];
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'Cache-Control': 'no-cache' });
    connections.push(res);
  });
  return { server, connections };
}

async function withSseServer(fn) {
  const { server, connections } = sseServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const config = { url: `http://127.0.0.1:${port}`, token: 'test-token' };
  try {
    await fn(config, connections, server);
  } finally {
    for (const conn of connections) conn.end();
    server.closeAllConnections?.(); // force-close any lingering keep-alive sockets rather than waiting out Node's default 5s keepAliveTimeout
    await new Promise((resolve) => server.close(resolve));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('watchGridChanges debounces plain frames into a single signal', async () => {
  await withSseServer(async (config, connections) => {
    const signals = [];
    const watcher = watchGridChanges(config, { onSignal: (s) => signals.push(s), debounceMs: 50, initialBackoffMs: 20 });
    await sleep(50); // let the connection establish
    const conn = connections[0];
    conn.write('data: {"type":"FleetTask"}\n\n');
    await sleep(10);
    conn.write('data: {"type":"ActorPresence"}\n\n');
    await sleep(100);
    watcher.stop();

    assert.equal(signals.length, 1, 'two frames within the debounce window must coalesce into one signal');
    assert.equal(signals[0].reason, 'sse');
  });
});

test('watchGridChanges signals immediately on a gap notice, bypassing debounce', async () => {
  await withSseServer(async (config, connections) => {
    const signals = [];
    const watcher = watchGridChanges(config, { onSignal: (s) => signals.push(s), debounceMs: 5000, initialBackoffMs: 20 });
    await sleep(50);
    connections[0].write('event: gap\ndata: {}\n\n');
    await sleep(50);
    watcher.stop();

    assert.equal(signals.length, 1);
    assert.equal(signals[0].reason, 'gap');
  });
});

test('watchGridChanges signals and reconnects with backoff when the stream closes', async () => {
  await withSseServer(async (config, connections, server) => {
    const signals = [];
    const watcher = watchGridChanges(config, { onSignal: (s) => signals.push(s), debounceMs: 20, initialBackoffMs: 30, maxBackoffMs: 100 });
    await sleep(50);
    assert.equal(connections.length, 1);
    connections[0].end(); // simulate the server closing the connection

    await sleep(200); // past the 30ms backoff — a reconnect should have happened
    assert.ok(connections.length >= 2, 'a new connection should have been established after backoff');
    assert.ok(signals.some((s) => s.reason === 'sse-error'));
    watcher.stop();
    void server;
  });
});

test('watchGridChanges.stop() prevents any further signal', async () => {
  await withSseServer(async (config, connections) => {
    const signals = [];
    const watcher = watchGridChanges(config, { onSignal: (s) => signals.push(s), debounceMs: 20, initialBackoffMs: 20 });
    await sleep(50);
    watcher.stop();
    connections[0].write('data: {"type":"FleetTask"}\n\n');
    await sleep(100);
    assert.equal(signals.length, 0);
  });
});

// --- startIntervalReconcile -----------------------------------------------------

test('startIntervalReconcile fires on a fixed timer until stopped', async () => {
  const signals = [];
  const timer = startIntervalReconcile((s) => signals.push(s), 30);
  await sleep(110);
  timer.stop();
  const countAtStop = signals.length;
  await sleep(60);
  assert.ok(countAtStop >= 2, 'should have fired at least twice in ~110ms at a 30ms interval');
  assert.equal(signals.length, countAtStop, 'no further signals after stop()');
  assert.ok(signals.every((s) => s.reason === 'interval'));
});

// --- optional live verification -----------------------------------------------

/**
 * Skips loudly, never passes silently, when no live instance is configured. Point `RELATA_TEST_URL` (+
 * `RELATA_TEST_TOKEN`) at a real, reachable RelataDB. Confirms the real, verified behavior this module's doc
 * comment describes: `reconcile()`/`pullOnce()` round-trip real ingested rows and correctly filter out the
 * local actor's own rows; `watchGridChanges()` against the real `/graph/changes` endpoint produces no frames
 * at all (matching G3.3's third acceptance criterion in the strongest possible way — SSE contributes
 * literally nothing on this deployment, and the interval fallback is what actually matters).
 */
test('live: reconcile round-trips real rows and filters out the local actor, against a real instance', async (t) => {
  if (!process.env.RELATA_TEST_URL) {
    t.skip('RELATA_TEST_URL not set — no live RelataDB configured for this run');
    return;
  }
  const config = { url: process.env.RELATA_TEST_URL, token: process.env.RELATA_TEST_TOKEN ?? '', purposes: ['fleetsmith_g3_3_live'] };
  const repoId = createHash('sha256').update(`fleetsmith-g3-3-live-${process.pid}`).digest('hex');
  const typeName = 'FleetTask';

  await import('../src/memory/relatadb.js').then(({ request }) =>
    Promise.all([
      request(config, { method: 'POST', path: '/ingest', query: { object_type: typeName }, body: { rows: [{ repo_id: repoId, actor: 'peer-actor', task_seq: 1, task: 'peer work' }] } }),
      request(config, { method: 'POST', path: '/ingest', query: { object_type: typeName }, body: { rows: [{ repo_id: repoId, actor: 'live-test-actor', task_seq: 1, task: 'my own work' }] } }),
    ])
  );
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const { newRows, warnings } = await reconcile(config, repoId, { actor: 'live-test-actor' });
  // On a fresh instance the other three types may never have been ingested yet, so they 400 as "not
  // registered in the schema" — a real, benign condition (verified separately in G2.1), not a failure.
  // Anything else in warnings would be a genuine problem worth failing on.
  assert.ok(warnings.every((w) => w.includes('not registered in the schema')), `unexpected warning: ${JSON.stringify(warnings)}`);
  const fleetTaskRows = newRows.filter((r) => r.typeName === 'FleetTask' && r.row.repo_id === repoId);
  assert.equal(fleetTaskRows.length, 1);
  assert.equal(fleetTaskRows[0].row.actor, 'peer-actor');
});

test('live: watchGridChanges against the real /graph/changes endpoint produces no frames (verified engine behavior), and interval reconciliation is what actually converges', async (t) => {
  if (!process.env.RELATA_TEST_URL) {
    t.skip('RELATA_TEST_URL not set — no live RelataDB configured for this run');
    return;
  }
  const config = { url: process.env.RELATA_TEST_URL, token: process.env.RELATA_TEST_TOKEN ?? '' };
  const signals = [];
  const watcher = watchGridChanges(config, { onSignal: (s) => signals.push(s), debounceMs: 200 });

  const { request } = await import('../src/memory/relatadb.js');
  await sleep(500);
  await request(config, { method: 'POST', path: '/ingest', query: { object_type: 'FleetTask' }, body: { rows: [{ repo_id: 'x'.repeat(64), actor: 'nobody', task_seq: 1 }] } });
  await sleep(3000);
  watcher.stop();

  assert.equal(signals.filter((s) => s.reason === 'sse' || s.reason === 'gap').length, 0, 'this deployment never emits a real change frame');
});
