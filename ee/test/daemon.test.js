// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInit, syncOnce, runWatch, gridCliHandler, loadSpecFile, onRunStart, onRunEnd, computeOverlaps, computeGitOnlyOverlaps, DaemonError } from '../src/grid/daemon.js';
import { request } from '../src/memory/relatadb.js';
import { resolveActor } from '../src/actor.js';
import { resolveRepoId } from '../src/grid/ontology.js';

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

function fakeRelata({ failInit = false, queryRows = {}, tokensSelf = { present: false }, rotateResponse = { token: 'rotated-token' } } = {}) {
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
        // `queryRows` lets a test seed peer rows a real reconcile() would have found (e.g. a peer's
        // FleetTask row that overlaps this actor's own) — mocking the unpacked `{rows: JSON-string}` shape
        // reconcile()'s own unpackRecords() expects, one record holding every seeded row for that type.
        const match = /FROM (\w+)/.exec(parsed.sql);
        const rows = queryRows[match?.[1]];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(rows?.length ? JSON.stringify({ rows: rows.length, columns: ['rows'], data: [{ rows: JSON.stringify(rows) }] }) : JSON.stringify({ rows: 0, columns: ['rows'], data: [] }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/tokens/self') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tokensSelf));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/tokens/self/rotate') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rotateResponse));
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

test('gridCliHandler: "sync" with no grid config exits 0, degraded (G3.6 — not a user error)', async () => {
  const { repoDir } = setupRepo();
  const cwd = process.cwd();
  process.chdir(repoDir);
  try {
    assert.equal(await gridCliHandler(['sync', 'fleet.yaml']), 0);
  } finally {
    process.chdir(cwd);
  }
});

test('gridCliHandler: "init" with no grid config still exits 1 (a deliberate setup action, unlike sync)', async () => {
  const { repoDir } = setupRepo();
  const cwd = process.cwd();
  process.chdir(repoDir);
  try {
    assert.equal(await gridCliHandler(['init', 'fleet.yaml']), 1);
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

test('syncOnce never throws — no grid config degrades to a successful, advisory result (G3.6)', async () => {
  const { repoDir } = setupRepo();
  const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
  const result = await syncOnce(spec, repoDir);
  assert.equal(result.degraded, true);
  assert.equal(result.notConfigured, true);
  assert.match(result.summary, /not configured/);
});

// --- identity (G7.1): a real principal mismatch refuses push, but pull still works -------------------------

test('syncOnce refuses to push (not the whole cycle) when the token principal really mismatches the local actor — pull still works', async () => {
  const realActor = resolveActor();
  const mismatchedPrincipal = `not-${realActor}`;
  await withFakeRelata({ tokensSelf: { present: true, principal: mismatchedPrincipal } }, async (config, requests) => {
    const { repoDir } = setupRepo();
    const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
    const result = await syncOnce(spec, repoDir);

    assert.equal(result.degraded, false, 'a real identity mismatch degrades the push step only, not the whole cycle');
    assert.equal(result.pushResult.pushed.length, 0, 'nothing must have been pushed');
    assert.ok(result.warnings.some((w) => w.includes('push skipped') && w.includes(mismatchedPrincipal) && w.includes(realActor)));
    assert.ok(!requests.some((r) => r.pathname === '/ingest'), 'no row may have been ingested when the principal genuinely mismatches');
    assert.ok(requests.some((r) => r.pathname === '/query'), 'pull (reconcile) must still have run — reading peers is always allowed');
    void config;
  });
});

test('syncOnce pushes normally when the engine reports no discoverable principal at all (the common bearer-mode case)', async () => {
  await withFakeRelata({ tokensSelf: { present: false } }, async (config, requests) => {
    const { repoDir } = setupRepo();
    const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
    const result = await syncOnce(spec, repoDir);

    assert.equal(result.degraded, false);
    assert.ok(!result.warnings.some((w) => w.includes('push skipped')), 'an undiscoverable principal must never be treated as a mismatch');
    assert.ok(requests.some((r) => r.pathname === '/ingest'), 'push must have proceeded — nothing was actually verified to refuse it on');
    void config;
  });
});

test('syncOnce pushes normally when the token principal matches the local actor', async () => {
  const realActor = resolveActor();
  await withFakeRelata({ tokensSelf: { present: true, principal: realActor } }, async (config, requests) => {
    const { repoDir } = setupRepo();
    const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
    const result = await syncOnce(spec, repoDir);

    assert.equal(result.degraded, false);
    assert.ok(!result.warnings.some((w) => w.includes('push skipped')));
    assert.ok(requests.some((r) => r.pathname === '/ingest'));
    void config;
  });
});

test('gridCliHandler: "token rotate" prints the new token and update/restart guidance', async () => {
  const { repoDir } = setupRepo();
  await withFakeRelata({ rotateResponse: { token: 'shiny-new-token' } }, async (config, requests) => {
    const { exitCode, logs } = await runCliInDir(repoDir, ['token', 'fleet.yaml', 'rotate']);
    assert.equal(exitCode, 0);
    assert.ok(logs.some((l) => l.includes('shiny-new-token')));
    assert.ok(logs.some((l) => /restart/i.test(l)));
    assert.ok(requests.some((r) => r.pathname === '/tokens/self/rotate' && r.method === 'POST'));
    void config;
  });
});

test('gridCliHandler: "token" rejects an unknown sub-subcommand', async () => {
  const { repoDir } = setupRepo();
  await withFakeRelata({}, async () => {
    const { exitCode, errors } = await runCliInDir(repoDir, ['token', 'fleet.yaml', 'bogus-action']);
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => e.includes('rotate')));
  });
});

test('gridCliHandler: "token rotate" with no grid config errors clearly (a deliberate action, like init)', async () => {
  const { repoDir } = setupRepo();
  const { exitCode, errors } = await runCliInDir(repoDir, ['token', 'fleet.yaml', 'rotate']);
  assert.equal(exitCode, 1);
  assert.ok(errors.some((e) => e.includes('not configured')));
});

test('gridCliHandler: "token" mentions itself in the unknown-subcommand help text', async () => {
  const originalError = console.error;
  const errors = [];
  console.error = (m) => errors.push(m);
  try {
    await gridCliHandler(['bogus']);
  } finally {
    console.error = originalError;
  }
  assert.ok(errors.some((e) => e.includes('token rotate')));
});

// --- overlaps (G5.3): syncOnce's post-reconcile hook, GRID.md's pointer line, and the one-shot verb -------

function peerFleetTask(overrides) {
  return {
    actor: 'peer-bob',
    task_seq: 9,
    task: 'peer overlapping work',
    status: 'in-progress',
    depends_on: [],
    artifact: '',
    files_declared: [],
    symbols_declared: [],
    branch: 'feat/peer',
    purpose: 'grid_sync',
    origin: 'human',
    ...overrides,
  };
}

test('syncOnce with no overlapping peer rows writes OVERLAPS.md as the explicit no-overlaps file, and GRID.md gets "none detected"', async () => {
  await withFakeRelata({}, async () => {
    const { repoDir } = setupRepo();
    const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
    const result = await syncOnce(spec, repoDir);

    assert.equal(result.degraded, false);
    assert.deepEqual(result.overlaps, []);
    assert.ok(result.written.some((p) => p.endsWith('OVERLAPS.md')));

    const overlapsMd = fs.readFileSync(path.join(repoDir, '_fleet', 'local', 'grid', 'OVERLAPS.md'), 'utf8');
    assert.match(overlapsMd, /no overlaps detected as of/);

    const gridMd = fs.readFileSync(path.join(repoDir, '_fleet', 'local', 'grid', 'GRID.md'), 'utf8');
    assert.match(gridMd, /_Overlaps: none detected_/);
  });
});

test('syncOnce detects an overlap against a seeded peer FleetTask row (same artifact as the local ledger), writes OVERLAPS.md and GRID.md\'s pointer', async () => {
  const { repoDir } = setupRepo();
  const repoId = resolveRepoId(repoDir);
  // The local fixture's own task #2 (in-progress) declares this exact artifact — see ee/test/fixtures/projection/ledger.md.
  const overlappingArtifact = 'handoffs/02-builder-to-reviewer.md';

  await withFakeRelata({ queryRows: { FleetTask: [peerFleetTask({ repo_id: repoId, artifact: overlappingArtifact })] } }, async () => {
    const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
    const result = await syncOnce(spec, repoDir);

    assert.equal(result.degraded, false);
    assert.equal(result.overlaps.length, 1);
    assert.equal(result.overlaps[0].kind, 'artifact');
    assert.ok(result.overlaps[0].actors.includes('peer-bob'));

    const overlapsMd = fs.readFileSync(path.join(repoDir, '_fleet', 'local', 'grid', 'OVERLAPS.md'), 'utf8');
    assert.match(overlapsMd, new RegExp(overlappingArtifact.replace(/[/.]/g, '\\$&')));
    assert.match(overlapsMd, /peer-bob/);

    const gridMd = fs.readFileSync(path.join(repoDir, '_fleet', 'local', 'grid', 'GRID.md'), 'utf8');
    assert.match(gridMd, /_Overlaps: 1 detected — see \[OVERLAPS\.md\]\(\.\/OVERLAPS\.md\)_/);
  });
});

test('computeOverlaps (the "grid overlaps" one-shot verb) never throws when not configured (G3.6 parity)', async () => {
  const { repoDir } = setupRepo();
  const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
  const result = await computeOverlaps(spec, repoDir);
  assert.equal(result.degraded, true);
  assert.equal(result.notConfigured, true);
  assert.match(result.summary, /not configured/);
});

test('computeOverlaps runs a standalone pull+compute+render without pushing this actor\'s own state', async () => {
  const { repoDir } = setupRepo();
  const repoId = resolveRepoId(repoDir);
  const overlappingArtifact = 'handoffs/02-builder-to-reviewer.md';

  await withFakeRelata({ queryRows: { FleetTask: [peerFleetTask({ repo_id: repoId, artifact: overlappingArtifact })] } }, async (config, requests) => {
    const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
    const result = await computeOverlaps(spec, repoDir);

    assert.equal(result.degraded, false);
    assert.equal(result.overlaps.length, 1);
    assert.match(result.summary, /grid overlaps:/);
    assert.match(result.markdown, new RegExp(overlappingArtifact.replace(/[/.]/g, '\\$&')));
    assert.ok(result.written.endsWith('OVERLAPS.md'));
    assert.ok(!requests.some((r) => r.pathname === '/ingest'), 'computeOverlaps must not push — it only pulls and computes');
    void config;
  });
});

// --- git-only degraded mode (G5.5): zero grid config, zero network access -----------

test('computeGitOnlyOverlaps detects a real overlap between two local peer branches — no grid config, no fake server, no network at all', () => {
  const { repoDir } = setupRepo();
  const baseSha = git(['rev-parse', 'HEAD'], repoDir).trim();

  // `add shared.js` explicitly, never `-A` — this repo's fleet.yaml/_fleet/local live UNTRACKED in the
  // working tree (setupRepo()'s own convention), and `-A` would sweep them into this branch's commit,
  // making them vanish from the working tree the moment a later checkout lands on a branch that doesn't
  // have them tracked.
  git(['checkout', '-q', '-b', 'feat/alice-thing', baseSha], repoDir);
  fs.writeFileSync(path.join(repoDir, 'shared.js'), 'ALICE\n');
  git(['add', 'shared.js'], repoDir);
  git(['commit', '-q', '-m', 'alice work'], repoDir);

  git(['checkout', '-q', '-b', 'feat/bob-thing', baseSha], repoDir);
  fs.writeFileSync(path.join(repoDir, 'shared.js'), 'BOB\n');
  git(['add', 'shared.js'], repoDir);
  git(['commit', '-q', '-m', 'bob work'], repoDir);
  // stays checked out on feat/bob-thing — computeGitOnlyOverlaps must still find feat/alice-thing as a candidate

  const spec = loadSpecFile(path.join(repoDir, 'fleet.yaml'));
  // No RELATA_URL/RELATA_TOKEN set anywhere, no fake server listening — the strongest possible proof this
  // path makes no network call of any kind.
  const result = computeGitOnlyOverlaps(spec, repoDir);

  assert.equal(result.degraded, false);
  assert.equal(result.gitOnly, true);
  assert.equal(result.overlaps.length, 1);
  assert.equal(result.overlaps[0].kind, 'file');
  assert.deepEqual(result.overlaps[0].evidence, ['shared.js']);
  assert.deepEqual(result.risks, []);

  const overlapsMd = fs.readFileSync(path.join(repoDir, '_fleet', 'local', 'grid', 'OVERLAPS.md'), 'utf8');
  assert.match(overlapsMd, /git-only mode/);
  assert.match(overlapsMd, /shared\.js/);
});

test('gridCliHandler: "overlaps --git-only" works with no RELATA_URL/RELATA_TOKEN configured at all', async () => {
  const { repoDir } = setupRepo();
  const baseSha = git(['rev-parse', 'HEAD'], repoDir).trim();

  // `add shared.js` explicitly, never `-A` — this repo's fleet.yaml/_fleet/local live UNTRACKED in the
  // working tree (setupRepo()'s own convention), and `-A` would sweep them into this branch's commit,
  // making them vanish from the working tree the moment a later checkout lands on a branch that doesn't
  // have them tracked.
  git(['checkout', '-q', '-b', 'feat/alice-thing', baseSha], repoDir);
  fs.writeFileSync(path.join(repoDir, 'shared.js'), 'ALICE\n');
  git(['add', 'shared.js'], repoDir);
  git(['commit', '-q', '-m', 'alice work'], repoDir);

  git(['checkout', '-q', '-b', 'feat/bob-thing', baseSha], repoDir);
  fs.writeFileSync(path.join(repoDir, 'shared.js'), 'BOB\n');
  git(['add', 'shared.js'], repoDir);
  git(['commit', '-q', '-m', 'bob work'], repoDir);

  const cwd = process.cwd();
  process.chdir(repoDir);
  const originalLog = console.log;
  const logs = [];
  console.log = (m) => logs.push(m);
  try {
    assert.equal(process.env.RELATA_URL, undefined, 'fixture precondition: no grid config in the environment');
    const exitCode = await gridCliHandler(['overlaps', 'fleet.yaml', '--git-only']);
    assert.equal(exitCode, 0);
  } finally {
    console.log = originalLog;
    process.chdir(cwd);
  }
  assert.ok(logs.some((l) => /grid overlaps --git-only:/.test(l)));
  assert.ok(logs.some((l) => l.includes('git-only mode')));
});

test('gridCliHandler: "overlaps" without --git-only still needs grid config (degrades, does not error)', async () => {
  const { repoDir } = setupRepo();
  const cwd = process.cwd();
  process.chdir(repoDir);
  try {
    assert.equal(await gridCliHandler(['overlaps', 'fleet.yaml']), 0);
  } finally {
    process.chdir(cwd);
  }
});

test('gridCliHandler: "overlaps" mentions --git-only in its own unknown-subcommand help text', async () => {
  const originalError = console.error;
  const errors = [];
  console.error = (m) => errors.push(m);
  try {
    await gridCliHandler(['bogus']);
  } finally {
    console.error = originalError;
  }
  assert.ok(errors.some((e) => e.includes('--git-only')));
});

test('gridCliHandler: "overlaps" prints the summary and the rendered table, exits 0', async () => {
  const { repoDir } = setupRepo();
  const repoId = resolveRepoId(repoDir);
  const overlappingArtifact = 'handoffs/02-builder-to-reviewer.md';
  const cwd = process.cwd();
  process.chdir(repoDir);
  const originalLog = console.log;
  const logs = [];
  console.log = (m) => logs.push(m);
  try {
    await withFakeRelata({ queryRows: { FleetTask: [peerFleetTask({ repo_id: repoId, artifact: overlappingArtifact })] } }, async () => {
      const exitCode = await gridCliHandler(['overlaps', 'fleet.yaml']);
      assert.equal(exitCode, 0);
    });
  } finally {
    console.log = originalLog;
    process.chdir(cwd);
  }
  assert.ok(logs.some((l) => /grid overlaps:/.test(l)));
  assert.ok(logs.some((l) => l.includes('## Declared overlaps')));
});

// --- grid import (G6.1) -------------------------------------------------------------

function runCliInDir(dir, argv) {
  const cwd = process.cwd();
  process.chdir(dir);
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  const errors = [];
  console.log = (m) => logs.push(m);
  console.error = (m) => errors.push(m);
  return gridCliHandler(argv)
    .then((exitCode) => ({ exitCode, logs, errors }))
    .finally(() => {
      console.log = originalLog;
      console.error = originalError;
      process.chdir(cwd);
    });
}

test('gridCliHandler: "import" dry-run (no --apply) works with no grid config at all, touches no network', async () => {
  const { repoDir } = setupRepo();
  fs.writeFileSync(path.join(repoDir, 'notes.md'), '# Meeting\n\nWe discussed the roadmap.\n');

  const { exitCode, logs } = await runCliInDir(repoDir, ['import', 'fleet.yaml', 'notes.md', '--kind', 'meeting', '--date', '2026-01-10']);
  assert.equal(exitCode, 0);
  assert.ok(logs.some((l) => /grid import:.*1 file\(s\), 1 chunk\(s\) planned \(dry-run/.test(l)));
});

test('gridCliHandler: "import" requires --kind', async () => {
  const { repoDir } = setupRepo();
  fs.writeFileSync(path.join(repoDir, 'notes.md'), '# X\n\nbody\n');
  const { exitCode, errors } = await runCliInDir(repoDir, ['import', 'fleet.yaml', 'notes.md']);
  assert.equal(exitCode, 1);
  assert.ok(errors.some((e) => e.includes('--kind')));
});

test('gridCliHandler: "import" requires a <path|dir> argument', async () => {
  const { repoDir } = setupRepo();
  const { exitCode, errors } = await runCliInDir(repoDir, ['import', 'fleet.yaml']);
  assert.equal(exitCode, 1);
  assert.ok(errors.some((e) => e.includes('<path|dir>')));
});

test('gridCliHandler: "import --apply" with no grid config configured errors clearly (a deliberate setup action, like init)', async () => {
  const { repoDir } = setupRepo();
  fs.writeFileSync(path.join(repoDir, 'notes.md'), '# X\n\nbody\n');
  const { exitCode, errors } = await runCliInDir(repoDir, ['import', 'fleet.yaml', 'notes.md', '--kind', 'meeting', '--date', '2026-01-10', '--apply']);
  assert.equal(exitCode, 1);
  assert.ok(errors.some((e) => e.includes('not configured')));
});

test('gridCliHandler: "import --apply" ingests against a fake server, and a re-run is idempotent (zero new rows)', async () => {
  const { repoDir } = setupRepo();
  fs.writeFileSync(path.join(repoDir, 'notes.md'), '# Meeting\n\nWe discussed the roadmap.\n');

  await withFakeRelata({}, async (config, requests) => {
    const first = await runCliInDir(repoDir, ['import', 'fleet.yaml', 'notes.md', '--kind', 'meeting', '--date', '2026-01-10', '--apply']);
    assert.equal(first.exitCode, 0);
    assert.ok(first.logs.some((l) => /grid import --apply \[text-only \(BM25\)\]: 1 row\(s\) ingested, 0 already known/.test(l)));
    assert.ok(requests.some((r) => r.pathname === '/ingest' && r.query.object_type === 'OrgDocument'));
    const ingestReq = requests.find((r) => r.pathname === '/ingest');
    assert.ok(ingestReq.body.rows.every((r) => !('_emb_text' in r)), 'no accelEndpoint configured — _emb_text must be entirely absent, not just empty');

    requests.length = 0;
    const second = await runCliInDir(repoDir, ['import', 'fleet.yaml', 'notes.md', '--kind', 'meeting', '--date', '2026-01-10', '--apply']);
    assert.equal(second.exitCode, 0);
    assert.ok(second.logs.some((l) => /grid import --apply \[text-only \(BM25\)\]: 0 row\(s\) ingested, 1 already known/.test(l)));
    assert.deepEqual(requests, [], 're-apply must not call /ingest at all once every row is already known');
    void config;
  });
});

test('gridCliHandler: "import" mentions itself in the unknown-subcommand help text', async () => {
  const originalError = console.error;
  const errors = [];
  console.error = (m) => errors.push(m);
  try {
    await gridCliHandler(['bogus']);
  } finally {
    console.error = originalError;
  }
  assert.ok(errors.some((e) => e.includes('import <path|dir>')));
});

// --- grid knowledge (G6.5) -----------------------------------------------------------

test('gridCliHandler: "knowledge" degrades to the file-backend path with no grid config, and labels itself', async () => {
  const { repoDir } = setupRepo();
  fs.mkdirSync(path.join(repoDir, '_fleet', 'shared', 'knowledge'), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, '_fleet', 'shared', 'knowledge', 'notes.md'),
    ['---', 'kind: meeting', 'client: acme', 'date: 2026-01-10', 'source: notes.md', '---', '', '# Notes', '', 'roadmap discussion text', ''].join('\n')
  );

  const { exitCode, logs } = await runCliInDir(repoDir, ['knowledge', 'fleet.yaml', 'roadmap discussion']);
  assert.equal(exitCode, 0);
  assert.ok(logs.some((l) => /grid knowledge \(degraded\):/.test(l)));
  assert.ok(logs.some((l) => l.includes('degraded (file-backend) mode')));
});

test('gridCliHandler: "knowledge" requires a <query> argument', async () => {
  const { repoDir } = setupRepo();
  const { exitCode, errors } = await runCliInDir(repoDir, ['knowledge', 'fleet.yaml']);
  assert.equal(exitCode, 1);
  assert.ok(errors.some((e) => e.includes('<query>')));
});

test('gridCliHandler: "knowledge --limit" rejects a non-positive-integer value', async () => {
  const { repoDir } = setupRepo();
  const { exitCode, errors } = await runCliInDir(repoDir, ['knowledge', 'fleet.yaml', 'anything', '--limit', 'not-a-number']);
  assert.equal(exitCode, 1);
  assert.ok(errors.some((e) => e.includes('--limit')));
});

test('gridCliHandler: "knowledge" queries the live cortex when grid is configured, threading --as-of through', async () => {
  const { repoDir } = setupRepo();
  const repoId = resolveRepoId(repoDir);

  await withFakeRelata(
    {
      queryRows: {
        OrgDocument: [
          {
            repo_id: repoId,
            content_hash: 'h1',
            kind: 'meeting',
            title: 'a meeting',
            client: 'acme',
            chunk_index: 0,
            chunk_text: 'roadmap discussion text',
            source_file: 'notes.md',
            imported_by: 'alice',
            valid_from: '2026-01-01',
            imported_at: '2026-01-01T00:00:00.000Z',
            purpose: 'product_context',
            origin: 'human',
          },
        ],
      },
    },
    async (config, requests) => {
      const { exitCode, logs } = await runCliInDir(repoDir, ['knowledge', 'fleet.yaml', 'roadmap discussion', '--as-of', '2026-06-01']);
      assert.equal(exitCode, 0);
      assert.ok(logs.some((l) => /grid knowledge:/.test(l) && !l.includes('degraded')));
      assert.ok(logs.some((l) => l.includes('notes.md (meeting, acme, 2026-01-01)')));
      assert.ok(requests.some((r) => r.pathname === '/query' && /HYBRID_SEARCH FROM OrgDocument/.test(r.body?.sql ?? '')));
      void config;
    }
  );
});

test('gridCliHandler: "knowledge" mentions itself in the unknown-subcommand help text', async () => {
  const originalError = console.error;
  const errors = [];
  console.error = (m) => errors.push(m);
  try {
    await gridCliHandler(['bogus']);
  } finally {
    console.error = originalError;
  }
  assert.ok(errors.some((e) => e.includes('knowledge <query>')));
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
      // 600ms, not 300ms: the debounce itself is only 30ms, but the chain it triggers (fs.watch event ->
      // scheduleSync -> a full syncOnce() — two HTTP round trips to the fake server plus materialize()'s
      // file I/O) occasionally exceeded a 300ms window under load, flaking this test.
      await sleep(600);
      assert.ok(logs.some((l) => l.includes('run-start')));

      fs.rmSync(markerPath);
      await sleep(600);

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
    // A request legitimately IN FLIGHT at the exact moment `stop()` runs (sent by the client, not yet fully
    // arrived and logged by the server) is not a bug — `stop()` only prevents FUTURE requests (clearing
    // timers/watchers/SSE), it cannot un-send one already on the wire. Without this short settle window,
    // resetting `requests` immediately after `stop()` races that in-flight request's arrival, occasionally
    // counting it as "after stop" when it was really "before, just slow to land" — worse odds once syncOnce's
    // chain grew a real extra round trip (G7.1's identity check). Settling first, THEN resetting, keeps the
    // assertion about what it actually means: no request INITIATED after stop.
    await sleep(100);
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
