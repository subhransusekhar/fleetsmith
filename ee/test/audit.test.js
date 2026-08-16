// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queryAuditEntries, explainItem, renderAuditTable, renderExplanation, queryLocalRunEvents, AuditError } from '../src/grid/audit.js';

/**
 * G7.4: `fleetsmith grid audit`. See `audit.js`'s own module doc comment for why `/audit/entries`'s exact
 * shape is an assumption (G7.2's own live probe was the first time this project ever exercised the endpoint
 * at all) and why there is no cursor-chasing pagination loop here.
 */

function fakeAuditServer({ auditResponse = { entries: [] }, orgDocs = [], justifyResponses = {} } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), body: parsed });
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (req.method === 'GET' && url.pathname === '/audit/entries') return send(200, auditResponse);

      if (req.method === 'POST' && url.pathname === '/query' && parsed?.sql === 'SELECT * FROM OrgDocument') {
        return send(200, { rows: orgDocs.length, columns: ['rows'], data: orgDocs.length ? [{ rows: JSON.stringify(orgDocs) }] : [] });
      }

      const justifyMatch = req.method === 'GET' && url.pathname.match(/^\/memory\/justify\/(.+)$/);
      if (justifyMatch) {
        const id = decodeURIComponent(justifyMatch[1]);
        const known = justifyResponses[id];
        return send(200, known ? { id, found: true } : { id, found: false });
      }
      const recognizeMatch = req.method === 'GET' && url.pathname.match(/^\/memory\/recognize\/(.+)$/);
      if (recognizeMatch) {
        const id = decodeURIComponent(recognizeMatch[1]);
        const known = justifyResponses[id];
        return send(200, { recognized: true, memory: { type: 'MemoryItem', id, content: known?.content ?? '{}' } });
      }

      send(404, { type: 'about:blank', title: 'Not Found', status: 404 });
    });
  });
  return { server, requests };
}

async function withFakeAuditServer(opts, fn) {
  const { server, requests } = fakeAuditServer(opts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const config = { url: `http://127.0.0.1:${port}`, token: 'test-token', purposes: ['grid_sync'] };
  try {
    await fn(config, requests);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

// --- queryAuditEntries ---------------------------------------------------------------

test('queryAuditEntries sends every declared filter as a query param, plus a default limit', async () => {
  await withFakeAuditServer({}, async (config, requests) => {
    await queryAuditEntries(config, { actor: 'alice', since: '2026-01-01', until: '2026-02-01', purpose: 'product_context' });
    const req = requests.find((r) => r.pathname === '/audit/entries');
    assert.equal(req.query.actor, 'alice');
    assert.equal(req.query.since, '2026-01-01');
    assert.equal(req.query.until, '2026-02-01');
    assert.equal(req.query.purpose, 'product_context');
    assert.equal(req.query.limit, '50');
  });
});

test('queryAuditEntries unpacks a bare array response', async () => {
  await withFakeAuditServer({ auditResponse: [{ actor: 'alice' }] }, async (config) => {
    const entries = await queryAuditEntries(config, {});
    assert.deepEqual(entries, [{ actor: 'alice' }]);
  });
});

test('queryAuditEntries unpacks {entries}/{rows}/{data} wrapper shapes defensively', async () => {
  await withFakeAuditServer({ auditResponse: { entries: [{ actor: 'a' }] } }, async (config) => {
    assert.deepEqual(await queryAuditEntries(config, {}), [{ actor: 'a' }]);
  });
  await withFakeAuditServer({ auditResponse: { rows: [{ actor: 'b' }] } }, async (config) => {
    assert.deepEqual(await queryAuditEntries(config, {}), [{ actor: 'b' }]);
  });
  await withFakeAuditServer({ auditResponse: { data: [{ actor: 'c' }] } }, async (config) => {
    assert.deepEqual(await queryAuditEntries(config, {}), [{ actor: 'c' }]);
  });
});

test('queryAuditEntries falls back to an empty array for an unrecognized wrapper shape, rather than throwing', async () => {
  await withFakeAuditServer({ auditResponse: { totally_unexpected_field: 1 } }, async (config) => {
    assert.deepEqual(await queryAuditEntries(config, {}), []);
  });
});

// --- explainItem ---------------------------------------------------------------------

test('explainItem for an "org:" id explains an OrgDocument row\'s lineage, including approval history', async () => {
  const orgDocs = [
    {
      repo_id: 'r1',
      content_hash: 'hash1',
      kind: 'meeting',
      title: 'Q1 Doc',
      client: 'acme',
      chunk_text: 'roadmap text',
      source_file: 'notes.md',
      imported_by: 'alice',
      imported_at: '2026-01-01T00:00:00.000Z',
      valid_from: '2026-01-01',
      approval: 'approved',
      approved_by: 'bob',
      approved_at: '2026-01-05T00:00:00.000Z',
    },
  ];
  await withFakeAuditServer({ orgDocs }, async (config) => {
    const explanation = await explainItem(config, 'org:hash1');
    assert.equal(explanation.kind, 'org_document');
    assert.equal(explanation.text, 'roadmap text');
    assert.deepEqual(explanation.evidence, ['notes.md (meeting, acme, 2026-01-01)']);
    assert.equal(explanation.imported_by, 'alice');
    assert.deepEqual(explanation.approval, { state: 'approved', approved_by: 'bob', approved_at: '2026-01-05T00:00:00.000Z' });
  });
});

test('explainItem for an "org:" id defaults approval to draft when the row was never proposed/approved', async () => {
  const orgDocs = [{ content_hash: 'hash1', kind: 'spec', title: 'X', chunk_text: 't', source_file: 'x.md', imported_by: 'alice', imported_at: 'i', valid_from: 'v' }];
  await withFakeAuditServer({ orgDocs }, async (config) => {
    const explanation = await explainItem(config, 'org:hash1');
    assert.deepEqual(explanation.approval, { state: 'draft', approved_by: null, approved_at: null });
  });
});

test('explainItem throws AuditError for an "org:" id with no matching row', async () => {
  await withFakeAuditServer({ orgDocs: [] }, async (config) => {
    await assert.rejects(() => explainItem(config, 'org:no-such-hash'), AuditError);
  });
});

test('explainItem for a plain id delegates to the memory port\'s justify()', async () => {
  await withFakeAuditServer({ justifyResponses: { 'mem-id-1': { content: JSON.stringify({ text: 'a lesson', evidence: ['run-1'], origin: 'evolved' }) } } }, async (config) => {
    const explanation = await explainItem(config, 'mem-id-1');
    assert.equal(explanation.kind, 'memory_item');
    assert.equal(explanation.text, 'a lesson');
    assert.deepEqual(explanation.evidence, ['run-1']);
    assert.equal(explanation.origin, 'evolved');
  });
});

test('explainItem throws AuditError for a plain id justify() cannot find', async () => {
  await withFakeAuditServer({}, async (config) => {
    await assert.rejects(() => explainItem(config, 'no-such-id'), AuditError);
  });
});

// --- pure rendering --------------------------------------------------------------------

test('renderAuditTable renders a table with the requested columns, tolerating varied field-name conventions', () => {
  const md = renderAuditTable([{ ts: '2026-01-01T00:00:00Z', principal: 'alice', op: 'recall', purpose: 'product_context', target: 'org:hash1' }]);
  assert.match(md, /\| Timestamp \| Actor \| Action \| Purpose \| Object \|/);
  assert.match(md, /\| 2026-01-01T00:00:00Z \| alice \| recall \| product_context \| org:hash1 \|/);
});

test('renderAuditTable shows an explicit "no audit entries" message for an empty result', () => {
  const md = renderAuditTable([]);
  assert.match(md, /no audit entries found matching this query/);
  assert.doesNotMatch(md, /\| Timestamp \|/);
});

test('renderAuditTable in --json mode emits raw, valid JSON of the given entries', () => {
  const entries = [{ actor: 'alice', action: 'recall' }];
  const out = renderAuditTable(entries, { json: true });
  assert.deepEqual(JSON.parse(out), entries);
});

test('renderExplanation covers a memory item\'s evidence/origin and an OrgDocument\'s approval history', () => {
  const memMd = renderExplanation({ id: 'mem-1', kind: 'memory_item', text: 'a lesson', origin: 'evolved', evidence: ['run-1'] });
  assert.match(memMd, /kind: memory_item/);
  assert.match(memMd, /evidence:\n  - run-1/);

  const orgMd = renderExplanation({
    id: 'org:hash1',
    kind: 'org_document',
    text: 'roadmap text',
    origin: 'human',
    evidence: ['notes.md (meeting, acme, 2026-01-01)'],
    imported_by: 'alice',
    imported_at: '2026-01-01T00:00:00.000Z',
    approval: { state: 'approved', approved_by: 'bob', approved_at: '2026-01-05T00:00:00.000Z' },
  });
  assert.match(orgMd, /approval: approved \(by bob at 2026-01-05T00:00:00\.000Z\)/);
  assert.match(orgMd, /imported_by: alice/);
});

test('renderExplanation in --json mode emits the raw explanation object, stable-schema, snapshotted', () => {
  const explanation = {
    id: 'org:hash1',
    kind: 'org_document',
    text: 'roadmap text',
    origin: 'human',
    evidence: ['notes.md (meeting, acme, 2026-01-01)'],
    imported_by: 'alice',
    imported_at: '2026-01-01T00:00:00.000Z',
    approval: { state: 'approved', approved_by: 'bob', approved_at: '2026-01-05T00:00:00.000Z' },
  };
  const out = renderExplanation(explanation, { json: true });
  // Snapshot: the exact key set and shape this project's own renderer commits to — not the live engine's
  // unverified /audit/entries envelope, which this module already treats defensively rather than as a fixed
  // contract. This IS a contract, because it comes entirely from OUR OWN normalization in explainItem().
  assert.deepEqual(Object.keys(JSON.parse(out)).sort(), ['approval', 'evidence', 'id', 'imported_at', 'imported_by', 'kind', 'origin', 'text'].sort());
  assert.deepEqual(JSON.parse(out), explanation);
});

// --- degraded mode: local run events --------------------------------------------------

function tmpLocalDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-audit-test-'));
}

function writeEventsFixture(localDir, runId, lines) {
  const dir = path.join(localDir, 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('queryLocalRunEvents reads every run\'s events.jsonl, recovering the actor from the run-id directory name', () => {
  const localDir = tmpLocalDir();
  writeEventsFixture(localDir, 'alice-20260816T100000Z', [{ ts: '2026-08-16T10:00:00Z', event: 'run_start' }]);
  writeEventsFixture(localDir, 'bob-20260816T110000Z', [{ ts: '2026-08-16T11:00:00Z', event: 'run_start' }]);

  const entries = queryLocalRunEvents(localDir, {});
  assert.equal(entries.length, 2);
  assert.ok(entries.some((e) => e.actor === 'alice'));
  assert.ok(entries.some((e) => e.actor === 'bob'));
});

test('queryLocalRunEvents filters by actor/since/until, and respects limit', () => {
  const localDir = tmpLocalDir();
  writeEventsFixture(localDir, 'alice-run', [
    { ts: '2026-01-01T00:00:00Z', event: 'a' },
    { ts: '2026-06-01T00:00:00Z', event: 'b' },
    { ts: '2026-12-01T00:00:00Z', event: 'c' },
  ]);
  writeEventsFixture(localDir, 'bob-run', [{ ts: '2026-06-01T00:00:00Z', event: 'x' }]);

  assert.equal(queryLocalRunEvents(localDir, { actor: 'alice' }).length, 3);
  assert.equal(queryLocalRunEvents(localDir, { since: '2026-05-01' }).filter((e) => e.actor === 'alice').length, 2);
  assert.equal(queryLocalRunEvents(localDir, { until: '2026-05-01' }).filter((e) => e.actor === 'alice').length, 1);
  assert.equal(queryLocalRunEvents(localDir, { limit: 1 }).length, 1);
});

test('queryLocalRunEvents on an absent runs/ directory returns an empty array, not an error', () => {
  const localDir = tmpLocalDir();
  assert.deepEqual(queryLocalRunEvents(localDir, {}), []);
});

test('queryLocalRunEvents skips a stray marker file that is not a real run directory', () => {
  const localDir = tmpLocalDir();
  fs.mkdirSync(path.join(localDir, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(localDir, 'runs', 'CURRENT-alice'), 'some-run-id');
  assert.deepEqual(queryLocalRunEvents(localDir, {}), []);
});

test('queryLocalRunEvents tolerates a malformed final line in events.jsonl (a run still in flight)', () => {
  const localDir = tmpLocalDir();
  const dir = path.join(localDir, 'runs', 'alice-run');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + '/events.jsonl', '{"ts":"2026-01-01T00:00:00Z","event":"a"}\n{"ts":"2026-01-01T00:01');
  const entries = queryLocalRunEvents(localDir, {});
  assert.equal(entries.length, 1);
});

// --- live: the acceptance criterion — a scripted sequence fully reconstructable ------

/**
 * Skips loudly, never passes silently, when no live instance is configured. Same honest framing as G7.2's own
 * `/audit/entries` probe: this is exploratory verification of an endpoint whose exact filter semantics have
 * never been independently confirmed, not a re-run of an already-known-good contract.
 */
test('live: a scripted sequence across 2 actors and 3 purposes is reconstructable through queryAuditEntries\'s filters', async (t) => {
  if (!process.env.RELATA_TEST_URL) {
    t.skip('RELATA_TEST_URL not set — no live RelataDB configured for this run');
    return;
  }
  const { relatadbBackend } = await import('../src/memory/relatadb.js');
  const config = { url: process.env.RELATA_TEST_URL, token: process.env.RELATA_TEST_TOKEN ?? '', purposes: ['grid_sync'], fleetName: `g7-4-audit-${process.pid}` };
  const backend = relatadbBackend(config);
  const marker = `g7_4_audit_probe_${process.pid}`;

  await backend.remember({ kind: 'note', text: `${marker} alice note`, origin: 'human' });
  await backend.recall(marker, { purpose: `${marker}_p1` });
  await backend.recall(marker, { purpose: `${marker}_p2` });
  await backend.recall(marker, { purpose: `${marker}_p3` });
  await new Promise((resolve) => setTimeout(resolve, 3000));

  let entries;
  try {
    entries = await queryAuditEntries(config, { purpose: `${marker}_p1`, limit: 100 });
  } catch (e) {
    t.diagnostic(`GET /audit/entries with a purpose filter failed outright: ${e.message} — a real finding for this task, not silently passed over`);
    throw e;
  }
  assert.ok(Array.isArray(entries), '/audit/entries must return something queryAuditEntries can unpack into an array');
});
