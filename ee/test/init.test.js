// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gridInit, InitError } from '../src/grid/init.js';

function fakeRelata({ tokensSelf = { present: false }, queryStatus = 200 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      const url = new URL(req.url, 'http://localhost');
      requests.push({ method: req.method, pathname: url.pathname, headers: req.headers, body: parsed });

      if (req.method === 'POST' && url.pathname === '/query') {
        if (queryStatus !== 200) {
          res.writeHead(queryStatus, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'about:blank', title: 'Unauthorized', status: queryStatus, detail: 'unauthorized' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ rows: 1, columns: ['?column?'], data: [{ '?column?': 1 }] }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/tokens/self') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tokensSelf));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'about:blank', title: 'Not Found', status: 404, detail: `no route for ${req.url}` }));
    });
  });
  return { server, requests };
}

async function withFakeRelata(opts, fn) {
  const { server, requests } = fakeRelata(opts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const config = { url: `http://127.0.0.1:${port}`, token: 'test-token', purposes: ['fleetsmith_grid'] };
  try {
    await fn(config, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function tempLocalDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-grid-init-test-'));
}

// --- refusal without config --------------------------------------------------

test('gridInit throws InitError immediately when config is absent, before any network call', async () => {
  await assert.rejects(() => gridInit(null, { localDir: tempLocalDir() }), InitError);
  await assert.rejects(() => gridInit(undefined, { localDir: tempLocalDir() }), InitError);
});

// --- happy path ---------------------------------------------------------------

test('gridInit runs migrate, seeds purposes locally, checks token sanity, and writes the skeleton', async () => {
  await withFakeRelata({}, async (config) => {
    const localDir = tempLocalDir();
    const result = await gridInit(config, { localDir, actor: 'alice' });

    assert.equal(result.migration.engineMigrationRan, false, 'no adminToken configured in this test');
    assert.ok(result.purposeSeed.purposes.includes('grid_sync'));
    assert.ok(result.purposeSeed.purposes.includes('cross_dev_reuse'));
    assert.equal(result.purposeSeed.registered, false);

    assert.equal(result.tokenSanity.authenticated, true);
    assert.equal(result.tokenSanity.principal, null);
    assert.equal(result.tokenSanity.mismatch, false);

    assert.ok(fs.existsSync(path.join(localDir, 'grid', 'peers')));
    assert.ok(fs.existsSync(path.join(localDir, 'grid', 'cursor')));
    assert.ok(fs.existsSync(path.join(localDir, 'grid', 'pushed.json')));
    assert.ok(fs.existsSync(path.join(localDir, 'grid', 'GRID.md')));
    assert.match(fs.readFileSync(path.join(localDir, 'grid', 'GRID.md'), 'utf8'), /not yet synced/);
    assert.deepEqual(result.skeleton.created, { cursor: true, 'pushed.json': true, 'GRID.md': true });
  });
});

test('seedPurposes de-duplicates spec-declared purposes already in the standard list', async () => {
  await withFakeRelata({}, async (config) => {
    const withDupPurpose = { ...config, purposes: ['grid_sync', 'a_custom_purpose'] };
    const result = await gridInit(withDupPurpose, { localDir: tempLocalDir(), actor: 'alice' });
    const occurrences = result.purposeSeed.purposes.filter((p) => p === 'grid_sync');
    assert.equal(occurrences.length, 1);
    assert.ok(result.purposeSeed.purposes.includes('a_custom_purpose'));
  });
});

// --- idempotency: re-running never clobbers existing skeleton state ----------

test('gridInit re-run is a no-op on an already-initialized checkout — never overwrites GRID.md/pushed.json/cursor', async () => {
  await withFakeRelata({}, async (config) => {
    const localDir = tempLocalDir();
    await gridInit(config, { localDir, actor: 'alice' });

    // Simulate real state a prior sync would have produced.
    fs.writeFileSync(path.join(localDir, 'grid', 'GRID.md'), '# Grid\n\nreal materialized peer data, must survive re-init\n');
    fs.writeFileSync(path.join(localDir, 'grid', 'pushed.json'), '{"real":"digest-state"}\n');
    fs.writeFileSync(path.join(localDir, 'grid', 'cursor'), '12345\n');

    const second = await gridInit(config, { localDir, actor: 'alice' });
    assert.deepEqual(second.skeleton.created, { cursor: false, 'pushed.json': false, 'GRID.md': false });
    assert.match(fs.readFileSync(path.join(localDir, 'grid', 'GRID.md'), 'utf8'), /real materialized peer data/);
    assert.equal(fs.readFileSync(path.join(localDir, 'grid', 'pushed.json'), 'utf8'), '{"real":"digest-state"}\n');
    assert.equal(fs.readFileSync(path.join(localDir, 'grid', 'cursor'), 'utf8'), '12345\n');
  });
});

// --- token sanity: mismatch and auth failure ----------------------------------

test('gridInit reports a mismatch when the engine reports a token principal different from the local actor', async () => {
  await withFakeRelata({ tokensSelf: { present: true, principal: 'bob' } }, async (config) => {
    const result = await gridInit(config, { localDir: tempLocalDir(), actor: 'alice' });
    assert.equal(result.tokenSanity.principal, 'bob');
    assert.equal(result.tokenSanity.mismatch, true);
    assert.match(result.tokenSanity.note, /does not match/);
  });
});

test('gridInit reports no mismatch when the engine-reported principal equals the local actor', async () => {
  await withFakeRelata({ tokensSelf: { present: true, principal: 'alice' } }, async (config) => {
    const result = await gridInit(config, { localDir: tempLocalDir(), actor: 'alice' });
    assert.equal(result.tokenSanity.mismatch, false);
  });
});

test('gridInit throws InitError when the token does not authenticate', async () => {
  await withFakeRelata({ queryStatus: 401 }, async (config) => {
    await assert.rejects(() => gridInit(config, { localDir: tempLocalDir(), actor: 'alice' }), (e) => {
      assert.ok(e instanceof InitError);
      assert.match(e.message, /does not authenticate/);
      return true;
    });
  });
});

// --- optional live verification -----------------------------------------------

/**
 * Skips loudly, never passes silently, when no live instance is configured — CI has none. Point
 * `RELATA_TEST_URL` (+ `RELATA_TEST_TOKEN`) at a real, reachable RelataDB to exercise the real init flow,
 * including the two real-instance findings this module's doc comment describes: no purpose-registration
 * endpoint, and `/tokens/self` reporting `{"present": false}` even for the correctly-authenticating token.
 */
test('live: gridInit succeeds against a real instance, and re-init is a no-op', async (t) => {
  if (!process.env.RELATA_TEST_URL) {
    t.skip('RELATA_TEST_URL not set — no live RelataDB configured for this run');
    return;
  }
  const config = { url: process.env.RELATA_TEST_URL, token: process.env.RELATA_TEST_TOKEN ?? '', purposes: ['fleetsmith_g3_1_live'] };
  const localDir = tempLocalDir();

  const first = await gridInit(config, { localDir, actor: 'live-test-actor' });
  assert.equal(first.tokenSanity.authenticated, true);
  assert.equal(first.tokenSanity.principal, null, 'this engine reports no per-token principal in bearer auth mode');
  assert.equal(first.tokenSanity.mismatch, false);
  assert.deepEqual(first.skeleton.created, { cursor: true, 'pushed.json': true, 'GRID.md': true });

  const second = await gridInit(config, { localDir, actor: 'live-test-actor' });
  assert.deepEqual(second.skeleton.created, { cursor: false, 'pushed.json': false, 'GRID.md': false });
});
