// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queryKnowledgeLive, queryKnowledgeDegraded, renderKnowledgeTable, DEFAULT_PURPOSE, AS_OF_DEFAULT_PURPOSE } from '../src/grid/knowledge.js';
import { planImport, applyImport } from '../src/grid/import.js';

/**
 * G6.5: temporal knowledge queries. The live path is exercised against a fake cortex supporting both
 * `POST /ingest` (so a real `applyImport()` call, G6.1, can seed it) and `POST /query`'s `HYBRID_SEARCH`
 * form (G6.3) reading from that same in-memory store — end to end, not two disconnected fakes.
 */

function fakeCortex() {
  const orgDocuments = [];
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

      if (req.method === 'POST' && url.pathname === '/ingest' && url.searchParams.get('object_type') === 'OrgDocument') {
        orgDocuments.push(...(parsed?.rows ?? []));
        return send(200, { rows_ingested: parsed.rows.length, rows_queued: parsed.rows.length, rows_rejected: 0, connector: 'direct', errors: [] });
      }

      if (req.method === 'POST' && url.pathname === '/query') {
        const m = /^HYBRID_SEARCH FROM OrgDocument QUERY '((?:[^']|'')*)' LIMIT (\d+)$/.exec(parsed?.sql ?? '');
        if (!m) return send(400, { type: 'about:blank', title: 'Bad Request', status: 400, detail: `unrecognized sql: ${parsed?.sql}` });
        const q = m[1].replace(/''/g, "'").toLowerCase();
        const limit = Number(m[2]);
        const matches = orgDocuments
          .filter((d) => d.chunk_text.toLowerCase().includes(q))
          .slice(0, limit)
          .map((d, i) => ({ ...d, score: 1 - i * 0.1 }));
        return send(200, { rows: matches.length, columns: ['rows'], data: matches.length ? [{ rows: JSON.stringify(matches) }] : [] });
      }

      send(404, { type: 'about:blank', title: 'Not Found', status: 404 });
    });
  });
  return { server, orgDocuments, requests };
}

async function withFakeCortex(fn) {
  const { server, orgDocuments, requests } = fakeCortex();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const config = { url: `http://127.0.0.1:${port}`, token: 'test-token', purposes: ['product_context'] };
  try {
    await fn(config, orgDocuments, requests);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-knowledge-test-'));
}

function orgDocRow(overrides) {
  return {
    repo_id: 'r1',
    content_hash: overrides.content_hash ?? 'hash1',
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
    ...overrides,
  };
}

// --- live path: fixture corpus, as-of before/after ----------------------------------

test('queryKnowledgeLive with --as-of includes documents on/before the date and excludes later ones', async () => {
  await withFakeCortex(async (config, orgDocuments) => {
    orgDocuments.push(orgDocRow({ content_hash: 'early', valid_from: '2026-01-01', chunk_text: 'roadmap talk early' }));
    orgDocuments.push(orgDocRow({ content_hash: 'late', valid_from: '2026-03-01', chunk_text: 'roadmap talk late' }));

    const before = await queryKnowledgeLive(config, 'roadmap talk', { asOf: '2026-02-01' });
    assert.ok(before.rows.some((r) => r.provenance.includes('early')) || before.rows.length === 1);
    assert.equal(before.rows.length, 1);
    assert.equal(before.rows[0].valid_from, '2026-01-01');

    const after = await queryKnowledgeLive(config, 'roadmap talk', { asOf: '2026-04-01' });
    assert.equal(after.rows.length, 2);

    const unfiltered = await queryKnowledgeLive(config, 'roadmap talk', {});
    assert.equal(unfiltered.rows.length, 2);
  });
});

test('--as-of excludes a document exactly ON the boundary date only when the query date is strictly earlier', async () => {
  await withFakeCortex(async (config, orgDocuments) => {
    orgDocuments.push(orgDocRow({ content_hash: 'boundary', valid_from: '2026-02-15', chunk_text: 'boundary test roadmap' }));

    const exact = await queryKnowledgeLive(config, 'boundary test roadmap', { asOf: '2026-02-15' });
    assert.equal(exact.rows.length, 1, 'on-or-before includes the exact boundary date');

    const earlier = await queryKnowledgeLive(config, 'boundary test roadmap', { asOf: '2026-02-14' });
    assert.equal(earlier.rows.length, 0);
  });
});

// --- live path: --as-recorded demonstrably differs from --as-of (real G6.1 import, backdated) ----

test('--as-recorded demonstrably differs from --as-of after a late import of an old (backdated) document', async () => {
  await withFakeCortex(async (config) => {
    const dir = tmpDir();
    writeFile(dir, 'old-notes.md', '# Old Meeting\n\nWe discussed the ancient roadmap plan.\n');
    const localDir = path.join(dir, '_fleet', 'local');

    // Imported NOW (real wall clock), but with a deliberately backdated business date via --date (G6.1).
    const { plan } = planImport(dir, { kind: 'meeting', actor: 'alice', repoDir: dir, date: '2020-01-01' });
    await applyImport(config, plan, { localDir, repoId: 'r'.repeat(64) });

    // --as-of, keyed off valid_from (the backdated business date): the document IS "known" as of a date soon after 2020.
    const asOfResult = await queryKnowledgeLive(config, 'ancient roadmap plan', { asOf: '2020-06-01' });
    assert.equal(asOfResult.rows.length, 1, '--as-of must include the document — its business date is well before the cutoff');

    // --as-recorded, keyed off imported_at (real import wall-clock, which is TODAY, not 2020): the document
    // was NOT yet in the cortex as of 2020-06-01, regardless of what business date it claims.
    const asRecordedResult = await queryKnowledgeLive(config, 'ancient roadmap plan', { asRecorded: '2020-06-01' });
    assert.equal(asRecordedResult.rows.length, 0, '--as-recorded must exclude the document — it was not actually imported until just now, long after 2020');
  });
});

// --- purpose defaulting -------------------------------------------------------------

test('purpose defaults to decision_rationale for as-of/as-recorded queries, product_context otherwise, both overridable', async () => {
  await withFakeCortex(async (config, orgDocuments) => {
    orgDocuments.push(orgDocRow({ content_hash: 'p1', chunk_text: 'purpose test roadmap' }));

    const plain = await queryKnowledgeLive(config, 'purpose test roadmap', {});
    assert.equal(plain.purpose, DEFAULT_PURPOSE);

    const withAsOf = await queryKnowledgeLive(config, 'purpose test roadmap', { asOf: '2026-12-31' });
    assert.equal(withAsOf.purpose, AS_OF_DEFAULT_PURPOSE);

    const overridden = await queryKnowledgeLive(config, 'purpose test roadmap', { asOf: '2026-12-31', purpose: 'client_commitment' });
    assert.equal(overridden.purpose, 'client_commitment');
  });
});

test('the actual /query request carries the resolved purpose, for RelataDB\'s purpose audit', async () => {
  await withFakeCortex(async (config, orgDocuments, requests) => {
    orgDocuments.push(orgDocRow({ content_hash: 'audit', chunk_text: 'audit test roadmap' }));
    await queryKnowledgeLive(config, 'audit test roadmap', { asOf: '2026-12-31' });
    const queryReq = requests.find((r) => r.pathname === '/query');
    assert.equal(queryReq.body.purpose, AS_OF_DEFAULT_PURPOSE);
  });
});

// --- degraded (file-backend) path ---------------------------------------------------

function writeKnowledgeFixture(dir, filename, { kind = 'meeting', client = 'acme', date = '2026-01-10', source = filename, body = 'roadmap notes' } = {}) {
  writeFile(dir, path.join('_fleet/shared/knowledge', filename), ['---', `kind: ${kind}`, `client: ${client}`, `date: ${date}`, `source: ${source}`, '---', '', `# ${body}`, '', body, ''].join('\n'));
}

test('queryKnowledgeDegraded filters by frontmatter date and labels itself as degraded', () => {
  const dir = tmpDir();
  writeKnowledgeFixture(dir, 'early.md', { date: '2026-01-01', body: 'roadmap early talk' });
  writeKnowledgeFixture(dir, 'late.md', { date: '2026-03-01', body: 'roadmap late talk' });

  const before = queryKnowledgeDegraded(dir, 'roadmap', { asOf: '2026-02-01' });
  assert.equal(before.degraded, true);
  assert.equal(before.rows.length, 1);
  assert.equal(before.rows[0].valid_from, '2026-01-01');

  const after = queryKnowledgeDegraded(dir, 'roadmap', { asOf: '2026-04-01' });
  assert.equal(after.rows.length, 2);
});

test('queryKnowledgeDegraded on an absent knowledge/ directory returns an empty, still-labeled result', () => {
  const dir = tmpDir();
  const result = queryKnowledgeDegraded(dir, 'anything', {});
  assert.deepEqual(result.rows, []);
  assert.equal(result.degraded, true);
});

test('renderKnowledgeTable\'s banner names degraded mode explicitly, and is absent for the live result', () => {
  const dir = tmpDir();
  writeKnowledgeFixture(dir, 'notes.md', { body: 'roadmap talk' });
  const degraded = queryKnowledgeDegraded(dir, 'roadmap', {});
  const degradedMd = renderKnowledgeTable(degraded, {});
  assert.match(degradedMd, /degraded \(file-backend\) mode/);

  const liveMd = renderKnowledgeTable({ rows: [], purpose: 'product_context', degraded: false }, {});
  assert.doesNotMatch(liveMd, /degraded/);
});

test('a malformed frontmatter block in degraded mode is treated as the whole file body, never a throw', () => {
  const dir = tmpDir();
  writeFile(dir, '_fleet/shared/knowledge/broken.md', '# No frontmatter\n\nunusual roadmap plain text\n');
  const result = queryKnowledgeDegraded(dir, 'unusual roadmap plain text', {});
  assert.equal(result.rows.length, 1);
});

// --- renderKnowledgeTable: pure rendering ------------------------------------------

test('renderKnowledgeTable renders a ranked table with the exact requested columns', () => {
  const result = {
    purpose: 'product_context',
    degraded: false,
    rows: [{ score: 0.9, kind: 'meeting', client: 'acme', valid_from: '2026-01-10', provenance: 'notes.md (meeting, acme, 2026-01-10)', excerpt: 'roadmap talk' }],
  };
  const md = renderKnowledgeTable(result, {});
  assert.match(md, /\| Score \| Kind \| Client \| Date \| Provenance \| Excerpt \|/);
  assert.match(md, /\| 0\.90 \| meeting \| acme \| 2026-01-10 \| notes\.md \(meeting, acme, 2026-01-10\) \| roadmap talk \|/);
});

test('renderKnowledgeTable shows an explicit "no knowledge found" message for an empty result, not a blank table', () => {
  const md = renderKnowledgeTable({ purpose: 'product_context', degraded: false, rows: [] }, {});
  assert.match(md, /no knowledge found matching this query/);
  assert.doesNotMatch(md, /\| Score \|/);
});

test('renderKnowledgeTable\'s metadata line reflects the active as-of/as-recorded filters', () => {
  const md = renderKnowledgeTable({ purpose: 'decision_rationale', degraded: false, rows: [] }, { asOf: '2026-01-01', asRecorded: '2026-06-01' });
  assert.match(md, /purpose: decision_rationale/);
  assert.match(md, /as-of: 2026-01-01/);
  assert.match(md, /as-recorded: 2026-06-01/);
});
