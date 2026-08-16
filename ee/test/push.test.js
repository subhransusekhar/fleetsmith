// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pushOnce, assertOwnRow, PushError } from '../src/grid/push.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'projection');
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/**
 * A real git repo plus a real `_fleet/local/` tree, built from the same fixture files G2.2's golden tests
 * use (`ee/test/fixtures/projection/*`) — not hand-invented formats. One untracked source file
 * (`src/feature.js`) exists so the ledger's one `in-progress` task (seq 2) has real declared-work to pick up.
 */
function setupRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-push-test-'));
  git(['init', '-q'], repoDir);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  git(['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], repoDir);

  writeFile(repoDir, '.gitignore', '_fleet/local/\n');
  writeFile(repoDir, 'README.md', '# test repo\n');
  git(['add', '.'], repoDir);
  git(['commit', '-q', '-m', 'base'], repoDir);
  const baseSha = git(['rev-parse', 'HEAD'], repoDir).trim();
  git(['update-ref', 'refs/remotes/origin/main', baseSha], repoDir);

  // Real declared work for the ledger's one in-progress task (seq 2).
  writeFile(repoDir, 'src/feature.js', 'export function NewFeature() {}\n');

  const localDir = path.join(repoDir, '_fleet', 'local');
  writeFile(localDir, 'LEDGER.md', readFixture('ledger.md'));
  writeFile(localDir, 'handoffs/01-analyst-to-builder.md', readFixture('01-analyst-to-builder.md'));
  const currentMarker = readFixture('CURRENT-alice');
  writeFile(localDir, 'runs/CURRENT-alice', currentMarker);
  writeFile(localDir, `runs/${currentMarker.trim()}/events.jsonl`, readFixture('events.jsonl'));

  return { repoDir, localDir };
}

function fakeRelata({ failObjectTypes = [] } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      const url = new URL(req.url, 'http://localhost');
      const objectType = url.searchParams.get('object_type');
      requests.push({ method: req.method, pathname: url.pathname, objectType, body: parsed });

      if (req.method === 'POST' && url.pathname === '/ingest') {
        if (failObjectTypes.includes(objectType)) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'about:blank', title: 'Internal Server Error', status: 500, detail: 'simulated failure' }));
          return;
        }
        const rows = parsed?.rows ?? [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ rows_ingested: rows.length, rows_queued: rows.length, rows_rejected: 0, connector: 'direct', errors: [] }));
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
  const config = { url: `http://127.0.0.1:${port}`, token: 'test-token', purposes: ['grid_sync'] };
  try {
    await fn(config, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const ACTOR_OPTS = { actor: 'alice' };

// --- assertOwnRow --------------------------------------------------------------

test('assertOwnRow passes for a row attributed to the local actor and throws PushError otherwise', () => {
  assert.doesNotThrow(() => assertOwnRow('FleetTask', { actor: 'alice' }, 'alice'));
  assert.throws(() => assertOwnRow('FleetTask', { actor: 'bob' }, 'alice'), PushError);
});

// --- first push: everything is new --------------------------------------------

test('pushOnce ingests every row on a fresh checkout — one request per type with data', async () => {
  await withFakeRelata({}, async (config, requests) => {
    const { repoDir, localDir } = setupRepo();
    const result = await pushOnce(config, repoDir, { ...ACTOR_OPTS, localDir });

    assert.equal(result.skipped.length, 0);
    assert.ok(result.pushed.length > 0);
    assert.deepEqual(requests.map((r) => r.objectType).sort(), ['ActorPresence', 'FleetTask', 'HandoffPointer', 'RunEventSummary']);

    const fleetTaskReq = requests.find((r) => r.objectType === 'FleetTask');
    const inProgress = fleetTaskReq.body.rows.find((r) => r.task_seq === 2);
    assert.deepEqual(inProgress.files_declared, ['src/feature.js']);
    assert.deepEqual(inProgress.symbols_declared, ['NewFeature']);

    const pushedJson = JSON.parse(fs.readFileSync(path.join(localDir, 'grid', 'pushed.json'), 'utf8'));
    assert.equal(Object.keys(pushedJson).length, result.pushed.length);
  });
});

// --- unchanged state: zero requests --------------------------------------------

test('pushOnce makes zero requests when nothing changed since the last push', async () => {
  await withFakeRelata({}, async (config, requests) => {
    const { repoDir, localDir } = setupRepo();
    const first = await pushOnce(config, repoDir, { ...ACTOR_OPTS, localDir });
    requests.length = 0;

    const second = await pushOnce(config, repoDir, { ...ACTOR_OPTS, localDir });
    assert.equal(requests.length, 0);
    assert.equal(second.pushed.length, 0);
    assert.deepEqual(second.skipped.sort(), first.pushed.sort());
  });
});

// --- one edited row: exactly one ingest ----------------------------------------

test('editing one ledger row triggers exactly one /ingest request, scoped to FleetTask only', async () => {
  await withFakeRelata({}, async (config, requests) => {
    const { repoDir, localDir } = setupRepo();
    await pushOnce(config, repoDir, { ...ACTOR_OPTS, localDir });
    requests.length = 0;

    const ledgerPath = path.join(localDir, 'LEDGER.md');
    fs.writeFileSync(ledgerPath, fs.readFileSync(ledgerPath, 'utf8').replace('| 1 | analyze requirements | analyst | - | done |', '| 1 | analyze requirements | analyst | - | blocked |'));

    const result = await pushOnce(config, repoDir, { ...ACTOR_OPTS, localDir });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].objectType, 'FleetTask');
    assert.equal(result.pushed.length, 1);
  });
});

// --- pushed.json self-heals -----------------------------------------------------

test('a corrupt pushed.json self-heals into a full re-push, with correct content resent', async () => {
  await withFakeRelata({}, async (config, requests) => {
    const { repoDir, localDir } = setupRepo();
    const first = await pushOnce(config, repoDir, { ...ACTOR_OPTS, localDir });

    fs.writeFileSync(path.join(localDir, 'grid', 'pushed.json'), 'not valid json{{{');
    requests.length = 0;

    const second = await pushOnce(config, repoDir, { ...ACTOR_OPTS, localDir });
    assert.deepEqual(second.pushed.sort(), first.pushed.sort());
    assert.ok(requests.length >= 4, 'every type with data should be re-sent');

    const fleetTaskReq = requests.find((r) => r.objectType === 'FleetTask');
    assert.ok(fleetTaskReq.body.rows.some((r) => r.task_seq === 1 && r.task === 'analyze requirements'), 'resent content must still be correct');
  });
});

test('a deleted pushed.json self-heals the same way', async () => {
  await withFakeRelata({}, async (config, requests) => {
    const { repoDir, localDir } = setupRepo();
    const first = await pushOnce(config, repoDir, { ...ACTOR_OPTS, localDir });
    fs.rmSync(path.join(localDir, 'grid', 'pushed.json'));
    requests.length = 0;

    const second = await pushOnce(config, repoDir, { ...ACTOR_OPTS, localDir });
    assert.deepEqual(second.pushed.sort(), first.pushed.sort());
  });
});

// --- redaction hook --------------------------------------------------------------

test('a redactRow that throws for every FleetTask row blocks that whole type, but sibling types still push', async () => {
  await withFakeRelata({}, async (config, requests) => {
    const { repoDir, localDir } = setupRepo();
    const redactRow = (row) => {
      if ('task_seq' in row) throw new Error('policy: no FleetTask rows may leave this machine');
      return row;
    };
    const result = await pushOnce(config, repoDir, { ...ACTOR_OPTS, localDir, redactRow });

    assert.ok(!requests.some((r) => r.objectType === 'FleetTask'));
    assert.ok(requests.some((r) => r.objectType === 'HandoffPointer'), 'other types must still push');
    assert.ok(result.warnings.some((w) => w.includes('FleetTask') && w.includes('no FleetTask rows may leave this machine')));
  });
});

test('G9.2: redaction is PER ROW — a redactRow that blocks only ONE FleetTask row still pushes its sibling rows of the SAME type', async () => {
  await withFakeRelata({}, async (config, requests) => {
    const { repoDir, localDir } = setupRepo();
    const redactRow = (row) => {
      if (row.task === 'implement feature') throw new Error('looks like it contains a secret');
      return row;
    };
    const result = await pushOnce(config, repoDir, { ...ACTOR_OPTS, localDir, redactRow });

    const fleetTaskReq = requests.find((r) => r.objectType === 'FleetTask');
    assert.ok(fleetTaskReq, 'the FleetTask type must still push — it has un-blocked rows too');
    const pushedTasks = fleetTaskReq.body.rows.map((r) => r.task);
    assert.ok(pushedTasks.includes('analyze requirements'), 'task_seq 1, not blocked, must be pushed');
    assert.ok(pushedTasks.includes('cross-actor dependent task'), 'task_seq 3, not blocked, must be pushed');
    assert.ok(!pushedTasks.includes('implement feature'), 'task_seq 2, blocked, must NOT be pushed');

    assert.ok(result.warnings.some((w) => w.includes('looks like it contains a secret')), 'the blocked row\'s own warning must still be present');
    assert.ok(result.pushed.some((k) => k.startsWith('FleetTask::') && !k.includes('implement')), 'unblocked FleetTask rows must be recorded as pushed');
  });
});

// --- network failure: retried next cycle -----------------------------------------

test('an /ingest failure for one type does not block other types from succeeding in the same cycle', async () => {
  await withFakeRelata({ failObjectTypes: ['HandoffPointer'] }, async (config) => {
    const { repoDir, localDir } = setupRepo();
    const first = await pushOnce(config, repoDir, { ...ACTOR_OPTS, localDir });

    assert.ok(!first.pushed.some((k) => k.startsWith('HandoffPointer::')));
    assert.ok(first.pushed.some((k) => k.startsWith('FleetTask::')), 'unrelated types must still succeed');
    assert.ok(first.warnings.some((w) => w.includes('HandoffPointer')));
  });
});

test('an /ingest failure leaves pushed.json untouched for that type, so a later successful cycle retries it', async () => {
  const { repoDir, localDir } = setupRepo();
  await withFakeRelata({ failObjectTypes: ['HandoffPointer'] }, async (config) => {
    await pushOnce(config, repoDir, { ...ACTOR_OPTS, localDir });
  });
  await withFakeRelata({}, async (config, requests) => {
    const result = await pushOnce(config, repoDir, { ...ACTOR_OPTS, localDir });
    assert.ok(requests.some((r) => r.objectType === 'HandoffPointer'), 'the previously-failed type must be retried');
    assert.ok(result.pushed.some((k) => k.startsWith('HandoffPointer::')));
  });
});

// --- optional live verification ----------------------------------------------

/**
 * Skips loudly, never passes silently, when no live instance is configured. Point `RELATA_TEST_URL` (+
 * `RELATA_TEST_TOKEN`) at a real, reachable RelataDB to exercise the real push → read-back round trip,
 * including a corrupt-`pushed.json` full re-push, proving the resent content is still correct (the module
 * doc comment's "self-heals in the sense that matters" claim).
 */
test('live: pushOnce round-trips real rows, and a corrupted pushed.json still resends correct content', async (t) => {
  if (!process.env.RELATA_TEST_URL) {
    t.skip('RELATA_TEST_URL not set — no live RelataDB configured for this run');
    return;
  }
  const config = { url: process.env.RELATA_TEST_URL, token: process.env.RELATA_TEST_TOKEN ?? '', purposes: ['fleetsmith_g3_2_live'] };
  const { repoDir, localDir } = setupRepo();

  const result = await pushOnce(config, repoDir, { ...ACTOR_OPTS, localDir });
  assert.ok(result.pushed.length > 0);

  fs.writeFileSync(path.join(localDir, 'grid', 'pushed.json'), 'corrupt{{{');
  const second = await pushOnce(config, repoDir, { ...ACTOR_OPTS, localDir });
  assert.deepEqual(second.pushed.sort(), result.pushed.sort());
});
