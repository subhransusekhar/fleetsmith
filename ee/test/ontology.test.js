// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { request } from '../src/memory/relatadb.js';
import {
  GRID_TYPES,
  OntologyError,
  normalizeRemoteUrl,
  resolveRepoId,
  validateRow,
  ingestRows,
  ontologyMigrate,
} from '../src/grid/ontology.js';

// --- GRID_TYPES: the reviewable data file ----------------------------------

test('GRID_TYPES defines exactly the four ontology types, each with a key and fields', () => {
  assert.deepEqual(Object.keys(GRID_TYPES).sort(), ['ActorPresence', 'FleetTask', 'HandoffPointer', 'RunEventSummary']);
  for (const [name, type] of Object.entries(GRID_TYPES)) {
    assert.ok(Array.isArray(type.key) && type.key.length > 0, `${name}.key must be a non-empty array`);
    assert.ok(type.fields && typeof type.fields === 'object', `${name}.fields must be an object`);
    for (const keyField of type.key) assert.ok(keyField in type.fields, `${name}.key field "${keyField}" must also be a declared field`);
  }
  assert.deepEqual(GRID_TYPES.FleetTask.statuses, ['pending', 'in-progress', 'done', 'blocked', 'dropped']);
});

// --- normalizeRemoteUrl / resolveRepoId -------------------------------------

test('normalizeRemoteUrl folds every real remote URL form to the same identity', () => {
  const forms = [
    'git@github.com:acme/widgets.git',
    'https://github.com/acme/widgets.git',
    'https://github.com/acme/widgets',
    'https://github.com/acme/widgets/',
    'HTTPS://GITHUB.COM/ACME/WIDGETS.GIT',
    'https://user@github.com/acme/widgets.git',
    'ssh://git@github.com/acme/widgets.git',
  ];
  const normalized = forms.map(normalizeRemoteUrl);
  for (const n of normalized) assert.equal(n, normalized[0], `"${n}" should normalize the same as "${normalized[0]}"`);
});

test('normalizeRemoteUrl distinguishes different repos', () => {
  assert.notEqual(normalizeRemoteUrl('git@github.com:acme/widgets.git'), normalizeRemoteUrl('git@github.com:acme/gadgets.git'));
});

function withTempGitRepo(remoteUrl, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-ontology-test-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    if (remoteUrl) execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: dir });
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveRepoId hashes the normalized remote URL, stable across equivalent remote forms', () => {
  const a = withTempGitRepo('git@github.com:acme/widgets.git', (dir) => resolveRepoId(dir));
  const b = withTempGitRepo('https://github.com/acme/widgets.git', (dir) => resolveRepoId(dir));
  const c = withTempGitRepo('https://github.com/acme/gadgets.git', (dir) => resolveRepoId(dir));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('resolveRepoId throws OntologyError when the repo has no origin remote', () => {
  withTempGitRepo(null, (dir) => {
    assert.throws(() => resolveRepoId(dir), OntologyError);
  });
});

// --- validateRow -------------------------------------------------------------

test('validateRow accepts a row carrying every required key field', () => {
  const row = { repo_id: 'r1', actor: 'alice', task_seq: 1, task: 'do the thing', status: 'pending' };
  assert.equal(validateRow('FleetTask', row), row);
});

test('validateRow rejects an unknown type name', () => {
  assert.throws(() => validateRow('NotAType', {}), OntologyError);
});

test('validateRow rejects a row missing a key field', () => {
  assert.throws(() => validateRow('ActorPresence', { repo_id: 'r1' }), (e) => {
    assert.ok(e instanceof OntologyError);
    assert.match(e.message, /actor/);
    return true;
  });
});

test('validateRow rejects an off-vocabulary FleetTask status', () => {
  assert.throws(
    () => validateRow('FleetTask', { repo_id: 'r1', actor: 'alice', task_seq: 1, status: 'not-a-real-status' }),
    /not one of/
  );
});

// --- ingestRows / ontologyMigrate against a fake server ---------------------

function fakeRelata({ requireAdminToken = 'test-admin-token' } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      const url = new URL(req.url, 'http://localhost');
      requests.push({ method: req.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: parsed });

      if (req.method === 'POST' && url.pathname === '/ingest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ rows_ingested: 1, rows_queued: (parsed?.rows ?? []).length, rows_rejected: 0, connector: 'direct', errors: [] }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/ontology/migrate') {
        if (req.headers.authorization !== `Bearer ${requireAdminToken}`) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'about:blank', title: 'Forbidden', status: 403, detail: 'admin token required for ontology migration' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ from_version: 'v0', to_version: 'v0', requires_data_migration: false, steps: [], executed: false, applied: [] }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'about:blank', title: 'Not Found', status: 404, detail: `no route for ${req.url}` }));
    });
  });
  return { server, requests };
}

async function withFakeRelata(fn) {
  const { server, requests } = fakeRelata();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const config = { url: `http://127.0.0.1:${port}`, token: 'test-token', purposes: ['fleetsmith_grid'] };
  try {
    await fn(config, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('ingestRows validates every row before making any network call', async () => {
  await withFakeRelata(async (config, requests) => {
    await assert.rejects(() => ingestRows(config, 'FleetTask', [{ repo_id: 'r1', actor: 'alice', task_seq: 1 }, { repo_id: 'r1' }]), OntologyError);
    assert.equal(requests.length, 0, 'a batch containing one invalid row must never reach the network');
  });
});

test('ingestRows POSTs to /ingest?object_type=<Name> with the rows as the body', async () => {
  await withFakeRelata(async (config, requests) => {
    const rows = [{ repo_id: 'r1', actor: 'alice', task_seq: 1, task: 'do the thing', status: 'pending' }];
    const result = await ingestRows(config, 'FleetTask', rows);
    assert.equal(requests[0].pathname, '/ingest');
    assert.equal(requests[0].query.object_type, 'FleetTask');
    assert.deepEqual(requests[0].body.rows, rows);
    assert.equal(result.rows_ingested, 1);
  });
});

test('ontologyMigrate skips the network call and returns a clear reason when no admin token is configured', async () => {
  await withFakeRelata(async (config, requests) => {
    const result = await ontologyMigrate(config);
    assert.equal(result.engineMigrationRan, false);
    assert.match(result.reason, /admin token/);
    assert.equal(requests.length, 0);
  });
});

test('ontologyMigrate calls the real endpoint with the admin token when one is configured, and is idempotent', async () => {
  await withFakeRelata(async (config, requests) => {
    const withAdmin = { ...config, adminToken: 'test-admin-token' };
    const first = await ontologyMigrate(withAdmin);
    const second = await ontologyMigrate(withAdmin);
    assert.equal(first.engineMigrationRan, true);
    assert.deepEqual(first, second);
    assert.equal(requests[0].headers.authorization, 'Bearer test-admin-token');
    assert.equal(requests[0].headers.authorization !== `Bearer ${config.token}`, true, 'the admin call must not use the regular data-plane token');
  });
});

test('ontologyMigrate surfaces a real 403 as a RelataHttpError when the configured admin token is wrong', async () => {
  await withFakeRelata(async (config) => {
    await assert.rejects(() => ontologyMigrate({ ...config, adminToken: 'wrong-token' }), (e) => {
      assert.match(e.message, /403/);
      return true;
    });
  });
});

// --- optional live verification ----------------------------------------------

/**
 * Parses the one real, verified shape a `SELECT * FROM <Type>` returns against this engine: each matched row
 * arrives as a JSON-encoded one-element array nested under a pseudo-column literally named `rows` — direct
 * column projection (`SELECT actor, branch FROM …`) echoes the requested column names back but returns empty
 * data objects for a plain `/ingest`-registered type, so `SELECT *` plus this unwrap is the only verified way
 * to read a row back. Confirmed against a fresh, isolated instance, 2026-08-16 — not documented anywhere in
 * the milestone doc, which assumed ordinary relational column projection would just work.
 */
async function queryAll(config, typeName) {
  const result = await request(config, { method: 'POST', path: '/query', body: { sql: `SELECT * FROM ${typeName}`, purpose: config.purposes?.[0] ?? 'fleetsmith_grid' } });
  return (result.data ?? []).flatMap((cell) => JSON.parse(cell.rows ?? '[]'));
}

/**
 * Skips loudly, never passes silently, when no live instance is configured — CI has none. Point
 * `RELATA_TEST_URL` (+ `RELATA_TEST_TOKEN` if the instance requires one) at a real, reachable RelataDB (see
 * `fixtures/relata-compose.yml`, or run `relata serve` natively) to exercise the real `/ingest` → SQL
 * round trip and the two-actor no-contention claim for real.
 */
test('live: ingestRows round-trips through a real RelataDB — /ingest a row, SQL SELECT it back, identical fields', async (t) => {
  if (!process.env.RELATA_TEST_URL) {
    t.skip('RELATA_TEST_URL not set — no live RelataDB configured for this run');
    return;
  }
  const config = { url: process.env.RELATA_TEST_URL, token: process.env.RELATA_TEST_TOKEN ?? '', purposes: ['fleetsmith_g2_1_live'] };
  const typeName = `FleetTaskLiveTest${process.pid}`;
  const row = {
    repo_id: `repo-${process.pid}`,
    actor: 'live-test-actor',
    task_seq: 1,
    task: 'prove the round trip',
    status: 'pending',
    depends_on: [],
    files_declared: [],
    symbols_declared: [],
  };
  // A dedicated per-run type name (not one of the real GRID_TYPES names) so this test can validate against
  // the FleetTask shape without colliding with rows any other suite run leaves behind on a shared instance.
  await request(config, { method: 'POST', path: '/ingest', query: { object_type: typeName }, body: { rows: [row] } });
  await new Promise((resolve) => setTimeout(resolve, 3000)); // async ingest queue — verified to settle within ~2s

  const rows = await queryAll(config, typeName);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], row);
});

test('live: two rows differing only in actor ingest independently, with no contention, concurrently', async (t) => {
  if (!process.env.RELATA_TEST_URL) {
    t.skip('RELATA_TEST_URL not set — no live RelataDB configured for this run');
    return;
  }
  const config = { url: process.env.RELATA_TEST_URL, token: process.env.RELATA_TEST_TOKEN ?? '', purposes: ['fleetsmith_g2_1_live'] };
  const typeName = `ActorPresenceLiveTest${process.pid}`;
  const repoId = `repo-${process.pid}`;
  const [a, b] = await Promise.all([
    request(config, { method: 'POST', path: '/ingest', query: { object_type: typeName }, body: { rows: [{ repo_id: repoId, actor: 'alice', run_id: 'run-a', branch: 'main' }] } }),
    request(config, { method: 'POST', path: '/ingest', query: { object_type: typeName }, body: { rows: [{ repo_id: repoId, actor: 'bob', run_id: 'run-b', branch: 'main' }] } }),
  ]);
  assert.equal(a.rows_rejected, 0);
  assert.equal(b.rows_rejected, 0);

  await new Promise((resolve) => setTimeout(resolve, 3000));
  const rows = await queryAll(config, typeName);
  const actors = rows.map((r) => r.actor).sort();
  assert.deepEqual(actors, ['alice', 'bob']);
});

/**
 * Requires a real `RELATA_ADMIN_TOKEN` configured on the server process (unprovisioned by default — see the
 * module doc comment in `ontology.js`). Skips independently of the two tests above: a reachable instance with
 * no admin surface provisioned is the common case, not an error.
 */
test('live: ontologyMigrate() is idempotent against a fresh live instance, with an admin token configured', async (t) => {
  if (!process.env.RELATA_TEST_URL || !process.env.RELATA_TEST_ADMIN_TOKEN) {
    t.skip('RELATA_TEST_URL and RELATA_TEST_ADMIN_TOKEN must both be set — this exercises the admin-gated /ontology/migrate endpoint');
    return;
  }
  const config = { url: process.env.RELATA_TEST_URL, token: process.env.RELATA_TEST_TOKEN ?? '', adminToken: process.env.RELATA_TEST_ADMIN_TOKEN };
  const first = await ontologyMigrate(config);
  const second = await ontologyMigrate(config);
  assert.equal(first.engineMigrationRan, true);
  assert.deepEqual(first, second);
});
