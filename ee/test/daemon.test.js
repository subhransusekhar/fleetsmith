// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInit, syncOnce, runWatch, gridCliHandler, loadSpecFile, onRunStart, onRunEnd, DaemonError } from '../src/grid/daemon.js';
import { request } from '../src/memory/relatadb.js';
import { resolveActor } from '../src/actor.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURES = path.join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'projection');
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function setupRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-daemon-test-'));
  git(['init', '-q'], repoDir);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  git(['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], repoDir);
  writeFile(repoDir, '.gitignore', '_fleet/local/\n');
  writeFile(repoDir, 'README.md', '# test\n');
  git(['add', '.'], repoDir);
  git(['commit', '-q', '-m', 'base'], repoDir);
  const baseSha = git(['rev-parse', 'HEAD'], repoDir).trim();
  git(['update-ref', 'refs/remotes/origin/main', baseSha], repoDir);

  writeFile(repoDir, 'fleet.yaml', 'fleet:\n  name: daemon-test-fleet\n');
  const localDir = path.join(repoDir, '_fleet', 'local');
  writeFile(localDir, 'LEDGER.md', readFixture('ledger.md'));
  writeFile(localDir, 'handoffs/01-analyst-to-builder.md', readFixture('01-analyst-to-builder.md'));

  return { repoDir, localDir };
}

function fakeRelata({ failInit = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      const url = new URL(req.url, 'http://localhost');
      requests.push({ method: req.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), body: parsed });

      if (req.method === 'POST' && url.pathname === '/query') {
        if (failInit && parsed.sql === 'SELECT 1') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'unauthorized' }));
          return;
        }
        const match = /FROM (\w+)/.exec(parsed.sql);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ rows: 0, columns: ['rows'], data: [] }));
        void match;
        return;
      }
      if (req.method === 'GET' && url.pathname === '/tokens/self') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ present: false }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/ingest') {
        const rows = parsed?.rows ?? [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ rows_ingested: rows.length, rows_queued: rows.length, rows_rejected: 0, connector: 'direct', errors: [] }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/graph/changes') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        return; // never emits — matches the real, verified engine behavior (G3.3)
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'about:blank', title: 'Not Found', status: 404 }));
    });
  });
  return { server, requests };
}

async function withFakeRelata(opts, fn) {
  const { server, requests } = fakeRelata(opts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  process.env.RELATA_URL = `http://127.0.0.1:${port}`;
  process.env.RELATA_TOKEN = 'test-token';
  try {
    await fn({ url: `http://127.0.0.1:${port}`, token: 'test-token' }, requests);
  } finally {
    delete process.env.RELATA_URL;
    delete process.env.RELATA_TOKEN;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- gate isolation (hard requirement) -----------------------------------------

test('gate isolation: no file under ee/src/ references validate-handoff, and no grid code touches .claude/settings.json', () => {
  // Scoped to ee/src/ (the actual product) — ee/test/ legitimately needs to reference these exact strings
  // to check for them, and this file itself would otherwise flag as its own offender.
  const srcDir = path.join(REPO_ROOT, 'ee', 'src');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|md|json)$/.test(entry.name)) {
        const content = fs.readFileSync(full, 'utf8');
        if (content.includes('validate-handoff')) offenders.push(full);
        if (content.includes('.claude/settings.json')) offenders.push(full);
      }
    }
  };
  walk(srcDir);
  assert.deepEqual(offenders, []);
});

// --- gridCliHandler dispatch -----------------------------------------------------

test('gridCliHandler returns 1 for an unknown subcommand', async () => {
  assert.equal(await gridCliHandler([]), 1);
  assert.equal(await gridCliHandler(['bogus']), 1);
});

test('gridCliHandler returns 1 when the fleet.yaml file does not exist', async () => {
  assert.equal(await gridCliHandler(['sync', '/definitely/not/a/real/path/fleet.yaml']), 1);
});

test('gridCliHandler returns 1 (user error) when grid is not configured', async () => {
  const { repoDir } = setupRepo();
  const cwd = process.cwd();
  process.chdir(repoDir);
  try {
    assert.equal(await gridCliHandler(['sync', 'fleet.yaml']), 1);
  } finally {
    process.chdir(cwd);
  }
});

// --- loadSpecFile ------------------------------------------------------------------

test('loadSpecFile parses and normalizes a real fleet.yaml', () => {
  const { repoDir } = setupRepo();
  const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
  assert.equal(spec.fleet.name, 'daemon-test-fleet');
  assert.equal(spec.fleet.local, '_fleet/local');
});

test('loadSpecFile throws DaemonError with no path given', () => {
  assert.throws(() => loadSpecFile(undefined), DaemonError);
});

// --- runInit / syncOnce against a fake server ------------------------------------

test('runInit surfaces a clear DaemonError when grid is not configured', async () => {
  const { repoDir } = setupRepo();
  const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
  await assert.rejects(() => runInit(spec, repoDir), DaemonError);
});

test('runInit succeeds against a fake server and reports token sanity', async () => {
  await withFakeRelata({}, async () => {
    const { repoDir } = setupRepo();
    const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
    const { summary } = await runInit(spec, repoDir);
    assert.match(summary, /token ok/);
  });
});

test('syncOnce pushes, reconciles, and materializes in one call, against a fake server', async () => {
  await withFakeRelata({}, async (config, requests) => {
    const { repoDir } = setupRepo();
    const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
    const { summary, written } = await syncOnce(spec, repoDir);

    assert.match(summary, /grid sync:/);
    assert.ok(requests.some((r) => r.pathname === '/ingest'), 'push should have ingested at least one type');
    assert.ok(requests.some((r) => r.pathname === '/query'), 'reconcile should have queried at least one type');
    assert.ok(written.some((p) => p.endsWith('GRID.md')));
    void config;
  });
});

test('syncOnce never throws for a per-cycle degraded condition — only resolveConfigOrThrow can throw', async () => {
  const { repoDir } = setupRepo();
  const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
  await assert.rejects(() => syncOnce(spec, repoDir), DaemonError); // no config at all — the one throwing case
});

// --- run lifecycle hooks (onRunStart/onRunEnd) — provisioned, tested directly ----

test('onRunStart/onRunEnd no-op silently when ctx.spec is absent', async () => {
  await assert.doesNotReject(() => onRunStart({}));
  await assert.doesNotReject(() => onRunEnd({}));
});

test('onRunStart/onRunEnd push a presence row, ended_at only on onRunEnd', async () => {
  await withFakeRelata({}, async (config, requests) => {
    const { repoDir } = setupRepo();
    const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
    await onRunStart({ spec, cwd: repoDir });
    const startReq = requests.find((r) => r.pathname === '/ingest' && r.query.object_type === 'ActorPresence');
    assert.ok(startReq);
    assert.ok(!('ended_at' in startReq.body.rows[0]));

    requests.length = 0;
    await onRunEnd({ spec, cwd: repoDir });
    const endReq = requests.find((r) => r.pathname === '/ingest' && r.query.object_type === 'ActorPresence');
    assert.ok(endReq);
    assert.ok('ended_at' in endReq.body.rows[0]);
  });
});

// --- runWatch: fs.watch triggers, debounce, run lifecycle -------------------------

test('runWatch triggers a push-carrying sync when the local ledger changes, debounced', async () => {
  await withFakeRelata({}, async (config, requests) => {
    const { repoDir, localDir } = setupRepo();
    const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
    const logs = [];
    const controller = runWatch(spec, repoDir, { log: (m) => logs.push(m), debounceMs: 30, heartbeatMs: 100_000, reconcileIntervalMs: 100_000 });
    try {
      await sleep(200); // let the startup sync land
      requests.length = 0;

      // A change that actually alters a row's content — appending whitespace alone wouldn't change any
      // parsed row's digest, and push.js correctly makes zero /ingest calls for unchanged content.
      const ledgerPath = path.join(localDir, 'LEDGER.md');
      fs.writeFileSync(ledgerPath, fs.readFileSync(ledgerPath, 'utf8').replace('| 1 | analyze requirements | analyst | - | done |', '| 1 | analyze requirements | analyst | - | blocked |'));
      await sleep(300);

      assert.ok(logs.some((l) => l.includes('local-ledger-change')));
      assert.ok(requests.some((r) => r.pathname === '/ingest'));
    } finally {
      controller.stop(); // must run even if an assertion above throws, or the daemon's timers/connections leak and hang the process
    }
  });
});

test('runWatch detects a run starting and ending via the CURRENT-<actor> marker, superseding presence with ended_at', async () => {
  await withFakeRelata({}, async (config, requests) => {
    const { repoDir, localDir } = setupRepo();
    const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
    const logs = [];
    const controller = runWatch(spec, repoDir, { log: (m) => logs.push(m), debounceMs: 30, heartbeatMs: 100_000, reconcileIntervalMs: 100_000 });
    try {
      await sleep(200);
      requests.length = 0;

      // resolveActor() has no cwd of its own — it reads THIS process's ambient git config, not repoDir's
      // (correct in real usage, where process.cwd() already IS the target repo; a testing-only mismatch to
      // account for here, not a production bug).
      const actor = resolveActor();
      const markerPath = path.join(localDir, 'runs', `CURRENT-${actor}`);
      fs.writeFileSync(markerPath, 'test-run-id');
      await sleep(300);
      assert.ok(logs.some((l) => l.includes('run-start')));

      fs.rmSync(markerPath);
      await sleep(300);

      assert.ok(logs.some((l) => l.includes('run-end')));
      const endedReq = requests.find((r) => r.pathname === '/ingest' && r.query.object_type === 'ActorPresence' && r.body.rows.some((row) => row.ended_at));
      assert.ok(endedReq, 'a presence row with ended_at must have been pushed on run-end');
    } finally {
      controller.stop();
    }
  });
});

test('runWatch.stop() halts everything — no further requests after stopping', async () => {
  await withFakeRelata({}, async (config, requests) => {
    const { repoDir } = setupRepo();
    const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
    const controller = runWatch(spec, repoDir, { log: () => {}, debounceMs: 30, heartbeatMs: 50, reconcileIntervalMs: 100_000 });
    try {
      await sleep(150);
    } finally {
      controller.stop();
    }
    requests.length = 0;
    await sleep(200);
    assert.equal(requests.length, 0);
  });
});

// --- optional live verification -----------------------------------------------

/** Skips loudly, never passes silently, when no live instance is configured. */
test('live: syncOnce round-trips against a real, reachable RelataDB', async (t) => {
  if (!process.env.RELATA_TEST_URL) {
    t.skip('RELATA_TEST_URL not set — no live RelataDB configured for this run');
    return;
  }
  process.env.RELATA_URL = process.env.RELATA_TEST_URL;
  process.env.RELATA_TOKEN = process.env.RELATA_TEST_TOKEN ?? '';
  try {
    const { repoDir } = setupRepo();
    const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
    const { summary, warnings, pushResult, written } = await syncOnce(spec, repoDir);
    assert.match(summary, /grid sync:/);
    assert.ok(pushResult.pushed.length > 0, 'the fixture ledger/handoff should have pushed at least one row');
    assert.ok(written.length > 0, 'materialize should have written at least GRID.md');
    // The fixture ledger has deliberately malformed rows (shared with G2.2's golden tests) that legitimately
    // warn regardless of RelataDB — and on a fresh instance, types this run never ingests (ActorPresence,
    // RunEventSummary — no CURRENT-<actor> marker exists in this fixture) 400 as "not registered", a real,
    // benign condition (G2.1). Anything else would be a genuine problem worth failing on.
    const unexpected = warnings.filter((w) => !w.includes('not registered in the schema') && !w.includes('ledger row'));
    assert.deepEqual(unexpected, []);
  } finally {
    delete process.env.RELATA_URL;
    delete process.env.RELATA_TOKEN;
  }
});

test('live: run_end supersedes presence, and a bare SELECT * still shows both versions (history preserved, no AS OF needed)', async (t) => {
  if (!process.env.RELATA_TEST_URL) {
    t.skip('RELATA_TEST_URL not set — no live RelataDB configured for this run');
    return;
  }
  process.env.RELATA_URL = process.env.RELATA_TEST_URL;
  process.env.RELATA_TOKEN = process.env.RELATA_TEST_TOKEN ?? '';
  try {
    const config = { url: process.env.RELATA_TEST_URL, token: process.env.RELATA_TEST_TOKEN ?? '', purposes: ['fleetsmith_g3_5_live'] };
    const { repoDir } = setupRepo();
    const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));

    await onRunStart({ spec, cwd: repoDir });
    await sleep(2000);
    await onRunEnd({ spec, cwd: repoDir });
    await sleep(2000);

    const result = await request(config, { method: 'POST', path: '/query', body: { sql: 'SELECT * FROM ActorPresence', purpose: 'fleetsmith_g3_5_live' } });
    const allRows = (result.data ?? []).flatMap((r) => JSON.parse(r.rows ?? '[]'));
    const actor = resolveActor();
    const mine = allRows.filter((r) => r.actor === actor && r.repo_id);
    assert.ok(mine.some((r) => !r.ended_at), 'the run-start version must still be present in history');
    assert.ok(mine.some((r) => r.ended_at), 'the run-end (superseded) version must also be present');
  } finally {
    delete process.env.RELATA_URL;
    delete process.env.RELATA_TOKEN;
  }
});
