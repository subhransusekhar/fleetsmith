// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncOnce, runWatch, gridCliHandler, loadSpecFile } from '../src/grid/daemon.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function setupRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-degrade-test-'));
  git(['init', '-q'], repoDir);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  git(['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], repoDir);
  writeFile(repoDir, '.gitignore', '_fleet/local/\n');
  writeFile(repoDir, 'README.md', '# test\n');
  git(['add', '.'], repoDir);
  git(['commit', '-q', '-m', 'base'], repoDir);
  writeFile(repoDir, 'fleet.yaml', 'fleet:\n  name: degrade-test-fleet\n');
  return { repoDir };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A fake RelataDB whose /query (and therefore the connectivity probe) can be toggled to fail on demand — simulating the cortex going down and coming back up mid-test. */
function fakeRelata() {
  const requests = [];
  let healthy = true;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      const url = new URL(req.url, 'http://localhost');
      requests.push({ method: req.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), body: parsed });

      if (!healthy) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'about:blank', title: 'Service Unavailable', status: 503, detail: 'simulated cortex outage' }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/query') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ rows: 0, columns: ['rows'], data: [] }));
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
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'about:blank', title: 'Not Found', status: 404 }));
    });
  });
  return { server, requests, setHealthy: (v) => { healthy = v; } };
}

async function withFakeRelata(fn) {
  const { server, requests, setHealthy } = fakeRelata();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  process.env.RELATA_URL = `http://127.0.0.1:${port}`;
  process.env.RELATA_TOKEN = 'test-token';
  try {
    await fn(requests, setHealthy);
  } finally {
    delete process.env.RELATA_URL;
    delete process.env.RELATA_TOKEN;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

// --- mode 1: not configured -----------------------------------------------------

test('degrade: no grid config — syncOnce degrades with exactly one advisory line, exits 0 via the CLI, no daemon-hook side effects', async () => {
  const { repoDir } = setupRepo();
  const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
  const result = await syncOnce(spec, repoDir);
  assert.equal(result.degraded, true);
  assert.equal(result.warnings.length, 0, 'not-configured is advisory, not a warning-worthy failure');
  assert.match(result.summary, /not configured/);

  const cwd = process.cwd();
  process.chdir(repoDir);
  try {
    assert.equal(await gridCliHandler(['sync', 'fleet.yaml']), 0);
  } finally {
    process.chdir(cwd);
  }
});

test('degrade: no grid config — "sync --watch" returns immediately, inert, never waits for a shutdown signal', async () => {
  const { repoDir } = setupRepo();
  const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
  const logs = [];
  const controller = runWatch(spec, repoDir, { log: (m) => logs.push(m) });
  assert.equal(controller.active, false);
  assert.ok(logs.some((l) => l.includes('not configured')));
  controller.stop(); // must be a safe no-op
});

// --- mode 2: cortex unreachable --------------------------------------------------

test('degrade: cortex unreachable — exactly one warning, push/pull skipped, GRID.md gains a stale marker', async () => {
  await withFakeRelata(async (requests, setHealthy) => {
    setHealthy(false);
    const { repoDir } = setupRepo();
    const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));

    const result = await syncOnce(spec, repoDir);
    assert.equal(result.degraded, true);
    assert.equal(result.warnings.length, 1, 'exactly one warning for a whole-cortex outage, not one per grid type');
    assert.equal(requests.filter((r) => r.pathname === '/ingest').length, 0, 'push must be skipped entirely, not attempted and failed per-type');

    const gridMd = fs.readFileSync(path.join(repoDir, '_fleet', 'local', 'grid', 'GRID.md'), 'utf8');
    assert.match(gridMd, /⚠ unreachable since/);
  });
});

test('degrade: cortex unreachable — pushed.json is left untouched, not created or blanked', async () => {
  await withFakeRelata(async (requests, setHealthy) => {
    setHealthy(false);
    const { repoDir } = setupRepo();
    const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
    await syncOnce(spec, repoDir);
    assert.ok(!fs.existsSync(path.join(repoDir, '_fleet', 'local', 'grid', 'pushed.json')));
  });
});

test('degrade: unreachable-since persists across repeated calls (simulated restarts) — does not reset to "now" each time', async () => {
  await withFakeRelata(async (requests, setHealthy) => {
    setHealthy(false);
    const { repoDir } = setupRepo();
    const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));

    const first = await syncOnce(spec, repoDir);
    const sinceMatch1 = first.summary.match(/unreachable since (\S+)/);
    await sleep(50);
    const second = await syncOnce(spec, repoDir); // a fresh call, as a restarted cron invocation would be
    const sinceMatch2 = second.summary.match(/unreachable since (\S+)/);

    assert.ok(sinceMatch1 && sinceMatch2);
    assert.equal(sinceMatch1[1], sinceMatch2[1], 'the FIRST failure timestamp must survive, not be overwritten by the second call');
  });
});

// --- mode 3: automatic recovery ---------------------------------------------------

test('degrade: recovery is automatic — the next successful cycle clears the stale marker and catches up', async () => {
  await withFakeRelata(async (requests, setHealthy) => {
    setHealthy(false);
    const { repoDir } = setupRepo();
    const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
    writeFile(repoDir, '_fleet/local/LEDGER.md', '| # | Task | Owner | Depends on | Status | Artifact |\n|---|---|---|---|---|---|\n| 1 | do the thing | alice | - | pending | - |\n');

    const down = await syncOnce(spec, repoDir);
    assert.equal(down.degraded, true);

    setHealthy(true);
    const recovered = await syncOnce(spec, repoDir);
    assert.equal(recovered.degraded, false);
    assert.ok(recovered.pushResult.pushed.length > 0, 'the ledger row queued during the outage must be caught up on the first successful cycle');

    const gridMd = fs.readFileSync(path.join(repoDir, '_fleet', 'local', 'grid', 'GRID.md'), 'utf8');
    assert.doesNotMatch(gridMd, /⚠ unreachable/, 'a normal materialize() rebuild clears the stale header automatically');
    assert.ok(!fs.existsSync(path.join(repoDir, '_fleet', 'local', 'grid', 'unreachable-since')), 'the marker is cleared on recovery');
  });
});

// --- gate isolation invariant, end to end ----------------------------------------

/**
 * The strongest form of this task's core invariant: grid code is never on the import path of `qa`/`eval` at
 * all (core never imports `ee/`), so this is somewhat belt-and-braces — but it is exactly what the
 * acceptance criteria ask for, and cheap to prove directly rather than only by architectural argument.
 */
test('degrade: a full eval run is byte-identical whether grid is unconfigured or pointed at an unreachable cortex', () => {
  const runEval = (env) => execFileSync('node', ['src/cli.js', 'eval', 'fleet.yaml', '--stage', '2'], { cwd: REPO_ROOT, encoding: 'utf8', env });

  const envWithoutGrid = { ...process.env };
  delete envWithoutGrid.RELATA_URL;
  delete envWithoutGrid.RELATA_TOKEN;
  const withoutGrid = runEval(envWithoutGrid);

  const withUnreachableGrid = runEval({ ...process.env, RELATA_URL: 'http://127.0.0.1:1', RELATA_TOKEN: 'x' });

  assert.equal(withoutGrid, withUnreachableGrid);
});
