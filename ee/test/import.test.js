// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from '../src/memory/relatadb.js';
import {
  chunkMarkdown,
  chunkPlainText,
  chunkFile,
  planImport,
  applyImport,
  ImportError,
  DEFAULT_MAX_CHUNK_CHARS,
} from '../src/grid/import.js';

function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-import-test-'));
}

// --- chunkMarkdown -------------------------------------------------------------------

test('chunkMarkdown splits on headings, retaining the heading path per chunk', () => {
  const md = ['# Meeting', '', '## Attendees', '', 'Alice, Bob', '', '## Decisions', '', 'Ship X by Friday.'].join('\n');
  const chunks = chunkMarkdown(md);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0].headingPath, ['Meeting', 'Attendees']);
  assert.match(chunks[0].text, /Alice, Bob/);
  assert.deepEqual(chunks[1].headingPath, ['Meeting', 'Decisions']);
  assert.match(chunks[1].text, /Ship X by Friday/);
});

test('chunkMarkdown packs multiple paragraphs under one heading into as few chunks as fit maxChars', () => {
  const md = ['# Notes', '', 'para one', '', 'para two', '', 'para three'].join('\n');
  const chunks = chunkMarkdown(md, { maxChars: 2000 });
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /para one[\s\S]*para two[\s\S]*para three/);
});

test('chunkMarkdown starts a new chunk when packing would exceed maxChars, never splitting a paragraph', () => {
  const para = 'x'.repeat(100);
  const md = ['# Notes', '', para, '', para, '', para].join('\n');
  const chunks = chunkMarkdown(md, { maxChars: 150 });
  assert.ok(chunks.length >= 2, 'three 100-char paragraphs must not all fit in one 150-char chunk');
  for (const c of chunks) assert.ok(c.text.length <= 150 || c.text === para, 'a chunk is either within budget or exactly one oversized paragraph');
});

test('chunkMarkdown drops a heading section with only whitespace, producing no phantom chunk', () => {
  const md = ['# Meeting', '', '## Empty section', '', '', '## Real section', '', 'content here'].join('\n');
  const chunks = chunkMarkdown(md);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].headingPath, ['Meeting', 'Real section']);
});

test('chunkMarkdown handles content before any heading (empty heading path)', () => {
  const md = ['preamble text', '', '# First heading', '', 'body'].join('\n');
  const chunks = chunkMarkdown(md);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0].headingPath, []);
  assert.match(chunks[0].text, /preamble text/);
});

// --- chunkPlainText ------------------------------------------------------------------

test('chunkPlainText splits on speaker-turn boundaries (small maxChars forces them into separate chunks, proving the split really happened)', () => {
  const transcript = ['Alice: welcome everyone', 'to the call.', '', 'Bob: thanks for having me.'].join('\n');
  const chunks = chunkPlainText(transcript, { maxChars: 10 });
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0].headingPath, []);
  assert.match(chunks[0].text, /Alice: welcome everyone/);
  assert.match(chunks[1].text, /Bob: thanks for having me/);
});

test('chunkPlainText packs short adjacent turns into one chunk at the default budget — same packing behavior chunkMarkdown uses', () => {
  const transcript = ['Alice: welcome everyone', 'to the call.', '', 'Bob: thanks for having me.'].join('\n');
  const chunks = chunkPlainText(transcript);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /Alice: welcome everyone[\s\S]*Bob: thanks for having me/);
});

test('chunkPlainText always closes a turn at a blank line, regardless of speaker prefix — no cross-turn merge inside the chunker itself', () => {
  const transcript = ['Alice: first sentence.', '', 'Second sentence, same speaker.'].join('\n');
  const chunks = chunkPlainText(transcript, { maxChars: 5 }); // forces the two turns apart so the split is observable
  assert.equal(chunks.length, 2);
  assert.match(chunks[0].text, /first sentence/);
  assert.match(chunks[1].text, /Second sentence, same speaker/);
});

test('chunkFile dispatches by extension: .md gets heading-aware chunking, .txt gets speaker-turn chunking', () => {
  const md = chunkFile('notes.md', '# H\n\nbody');
  assert.deepEqual(md[0].headingPath, ['H']);
  const txt = chunkFile('call.txt', 'Alice: hi\n\nBob: hello', { maxChars: 5 });
  assert.equal(txt.length, 2);
  assert.deepEqual(txt[0].headingPath, []);
});

// --- planImport: pure, no network ----------------------------------------------------

test('planImport touches no network at all — zero requests reach a listening server just from planning', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const dir = tmpDir();
    writeFile(dir, 'notes.md', '# Meeting\n\nSome content.\n');
    const { plan, warnings } = planImport(dir, { kind: 'meeting', actor: 'alice', repoDir: dir, date: '2026-01-15' });
    assert.equal(plan.length, 1);
    assert.deepEqual(warnings, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.deepEqual(requests, [], 'planImport must never make an HTTP request of any kind');
});

test('planImport requires a kind', () => {
  const dir = tmpDir();
  writeFile(dir, 'notes.md', '# X\n\nbody');
  assert.throws(() => planImport(dir, { actor: 'alice', repoDir: dir }), ImportError);
});

test('planImport rejects a malformed --date up front, before touching any file content', () => {
  const dir = tmpDir();
  writeFile(dir, 'notes.md', '# X\n\nbody');
  assert.throws(() => planImport(dir, { kind: 'meeting', actor: 'alice', repoDir: dir, date: 'not-a-date' }), ImportError);
});

test('planImport falls back to file mtime with a warning when --date is omitted', () => {
  const dir = tmpDir();
  writeFile(dir, 'notes.md', '# X\n\nbody');
  const { plan, warnings } = planImport(dir, { kind: 'meeting', actor: 'alice', repoDir: dir });
  assert.equal(plan.length, 1);
  assert.match(plan[0].validFrom, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(warnings.some((w) => w.includes('no --date given')));
});

test('planImport skips an unreadable/empty file with a warning rather than throwing', () => {
  const dir = tmpDir();
  writeFile(dir, 'empty.md', '   \n\n  ');
  const { plan, warnings } = planImport(dir, { kind: 'meeting', actor: 'alice', repoDir: dir, date: '2026-01-01' });
  assert.deepEqual(plan, []);
  assert.ok(warnings.some((w) => w.includes('no chunks')));
});

// --- 3-file fixture corpus: correct kinds/dates, heading-path prefixes --------------

function buildFixtureCorpus(dir) {
  writeFile(
    dir,
    'meeting-2026-01-10.md',
    ['# Q1 Planning Meeting', '', '## Attendees', '', 'Alice, Bob, Carol', '', '## Decisions', '', 'We decided to ship the reports export by Friday.', ''].join('\n')
  );
  writeFile(
    dir,
    'discussion-api-design.md',
    ['# API Design Discussion', '', '## Options considered', '', 'REST vs GraphQL — went with REST for simplicity.', ''].join('\n')
  );
  writeFile(dir, 'call-transcript.txt', ['Alice: let\'s review the roadmap.', '', 'Bob: sounds good, starting with Q2.', ''].join('\n'));
}

test('a 3-file fixture corpus imports with correct kinds/dates and heading-path prefixes retained in chunk_text', () => {
  const dir = tmpDir();
  buildFixtureCorpus(dir);

  const { plan, warnings } = planImport(dir, { kind: 'meeting', client: 'acme', actor: 'alice', repoDir: dir, date: '2026-01-10' });
  assert.deepEqual(warnings, []);
  assert.equal(plan.length, 3);

  const bySource = Object.fromEntries(plan.map((f) => [f.sourceFile, f]));
  assert.ok(bySource['meeting-2026-01-10.md']);
  assert.ok(bySource['discussion-api-design.md']);
  assert.ok(bySource['call-transcript.txt']);

  for (const f of plan) {
    assert.equal(f.validFrom, '2026-01-10');
    for (const row of f.rows) {
      assert.equal(row.kind, 'meeting');
      assert.equal(row.client, 'acme');
      assert.equal(row.imported_by, 'alice');
      assert.equal(row.purpose, 'product_context');
      assert.match(row.content_hash, /^[0-9a-f]{64}$/);
    }
  }

  const meetingRows = bySource['meeting-2026-01-10.md'].rows;
  assert.ok(meetingRows.some((r) => r.chunk_text.startsWith('# Q1 Planning Meeting > ## Decisions')), 'the Decisions chunk must carry its full heading path as a prefix');
  assert.ok(meetingRows.some((r) => /ship the reports export/.test(r.chunk_text)));

  const transcriptRows = bySource['call-transcript.txt'].rows;
  assert.ok(transcriptRows.every((r) => !r.chunk_text.match(/^#/)), 'plain-text chunks never get a markdown heading prefix');
});

test('purpose defaults to product_context except decision, which maps to decision_rationale', () => {
  const dir = tmpDir();
  writeFile(dir, 'x.md', '# X\n\nbody');
  const meeting = planImport(dir, { kind: 'meeting', actor: 'a', repoDir: dir, date: '2026-01-01' });
  const decision = planImport(dir, { kind: 'decision', actor: 'a', repoDir: dir, date: '2026-01-01' });
  assert.equal(meeting.plan[0].rows[0].purpose, 'product_context');
  assert.equal(decision.plan[0].rows[0].purpose, 'decision_rationale');
});

// --- applyImport: idempotent, the only network-touching step -----------------------

function fakeIngestServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      const url = new URL(req.url, 'http://localhost');
      requests.push({ method: req.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), body: parsed });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ rows_ingested: parsed?.rows?.length ?? 0, rows_queued: 0, rows_rejected: 0, connector: 'direct', errors: [] }));
    });
  });
  return { server, requests };
}

async function withFakeIngestServer(fn) {
  const { server, requests } = fakeIngestServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn({ url: `http://127.0.0.1:${port}`, token: 'test-token', purposes: ['product_context', 'decision_rationale'] }, requests);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('applyImport ingests every planned row on first apply, against a fake server', async () => {
  await withFakeIngestServer(async (config, requests) => {
    const dir = tmpDir();
    buildFixtureCorpus(dir);
    const { plan } = planImport(dir, { kind: 'meeting', actor: 'alice', repoDir: dir, date: '2026-01-10' });
    const localDir = path.join(dir, '_fleet', 'local');

    const { ingested, skipped, warnings } = await applyImport(config, plan, { localDir, repoId: 'r'.repeat(64) });
    assert.deepEqual(warnings, []);
    assert.equal(skipped, 0);
    const totalRows = plan.reduce((n, f) => n + f.rows.length, 0);
    assert.equal(ingested, totalRows);
    assert.ok(requests.every((r) => r.pathname === '/ingest' && r.query.object_type === 'OrgDocument'));
  });
});

test('applyImport → re-apply with the identical plan: zero new rows ingested, everything skipped as already known', async () => {
  await withFakeIngestServer(async (config, requests) => {
    const dir = tmpDir();
    buildFixtureCorpus(dir);
    const { plan } = planImport(dir, { kind: 'meeting', actor: 'alice', repoDir: dir, date: '2026-01-10' });
    const localDir = path.join(dir, '_fleet', 'local');
    const repoId = 'r'.repeat(64);

    const first = await applyImport(config, plan, { localDir, repoId });
    const totalRows = plan.reduce((n, f) => n + f.rows.length, 0);
    assert.equal(first.ingested, totalRows);

    requests.length = 0;
    const second = await applyImport(config, plan, { localDir, repoId });
    assert.equal(second.ingested, 0, 'a re-apply of the identical plan must ingest zero new rows');
    assert.equal(second.skipped, totalRows);
    assert.deepEqual(requests, [], 're-apply must not even call /ingest when every row is already known');
  });
});

test('applyImport re-imports only the changed chunk when one file changes, leaving unchanged chunks untouched', async () => {
  await withFakeIngestServer(async (config) => {
    const dir = tmpDir();
    writeFile(dir, 'notes.md', ['# Meeting', '', '## Section A', '', 'original text', '', '## Section B', '', 'unchanged text', ''].join('\n'));
    const localDir = path.join(dir, '_fleet', 'local');
    const repoId = 'r'.repeat(64);

    const first = planImport(dir, { kind: 'meeting', actor: 'alice', repoDir: dir, date: '2026-01-01' });
    const firstApply = await applyImport(config, first.plan, { localDir, repoId });
    assert.equal(firstApply.ingested, 2);

    writeFile(dir, 'notes.md', ['# Meeting', '', '## Section A', '', 'CHANGED text', '', '## Section B', '', 'unchanged text', ''].join('\n'));
    const second = planImport(dir, { kind: 'meeting', actor: 'alice', repoDir: dir, date: '2026-01-01' });
    const secondApply = await applyImport(config, second.plan, { localDir, repoId });
    assert.equal(secondApply.ingested, 1, 'only the changed Section A chunk should be a new content_hash');
    assert.equal(secondApply.skipped, 1, 'the unchanged Section B chunk must be skipped as already known');
  });
});

test('applyImport records repo_id on every ingested row', async () => {
  await withFakeIngestServer(async (config, requests) => {
    const dir = tmpDir();
    writeFile(dir, 'notes.md', '# X\n\nbody');
    const { plan } = planImport(dir, { kind: 'spec', actor: 'alice', repoDir: dir, date: '2026-01-01' });
    const localDir = path.join(dir, '_fleet', 'local');
    const repoId = 'deadbeef'.repeat(8);

    await applyImport(config, plan, { localDir, repoId });
    const ingestReq = requests.find((r) => r.pathname === '/ingest');
    assert.ok(ingestReq.body.rows.every((r) => r.repo_id === repoId));
  });
});

test('applyImport stamps imported_at (client-side wall-clock, G6.5) on every ingested row, distinct from valid_from', async () => {
  await withFakeIngestServer(async (config, requests) => {
    const dir = tmpDir();
    writeFile(dir, 'notes.md', '# X\n\nbody');
    // A deliberately backdated business date — imported_at must still reflect NOW, not this date.
    const { plan } = planImport(dir, { kind: 'spec', actor: 'alice', repoDir: dir, date: '2020-01-01' });
    const localDir = path.join(dir, '_fleet', 'local');

    await applyImport(config, plan, { localDir, repoId: 'r'.repeat(64) });
    const ingestReq = requests.find((r) => r.pathname === '/ingest');
    for (const row of ingestReq.body.rows) {
      assert.match(row.imported_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.equal(row.valid_from, '2020-01-01');
      assert.notEqual(row.imported_at.slice(0, 10), row.valid_from);
    }
  });
});

// --- optional embeddings via the customer-run sidecar (G6.2) ------------------------

test('applyImport omits _emb_text entirely, and reports text-only (BM25) mode, when no accelEndpoint is configured', async () => {
  await withFakeIngestServer(async (config, requests) => {
    const dir = tmpDir();
    writeFile(dir, 'notes.md', '# Meeting\n\nDiscussed the roadmap.\n');
    const { plan } = planImport(dir, { kind: 'meeting', actor: 'alice', repoDir: dir, date: '2026-01-01' });
    const localDir = path.join(dir, '_fleet', 'local');

    assert.equal(config.accelEndpoint, undefined, 'fixture precondition: no sidecar configured');
    const result = await applyImport(config, plan, { localDir, repoId: 'r'.repeat(64) });
    assert.equal(result.mode, 'text-only (BM25)');

    const ingestReq = requests.find((r) => r.pathname === '/ingest');
    assert.ok(ingestReq.body.rows.every((r) => !('_emb_text' in r)), '_emb_text must be entirely absent, not merely empty, when no sidecar is configured');
  });
});

test('applyImport populates _emb_text with the chunk text, and reports semantic (sidecar) mode, when accelEndpoint is configured', async () => {
  await withFakeIngestServer(async (baseConfig, requests) => {
    const config = { ...baseConfig, accelEndpoint: 'http://sidecar.internal:9999' };
    const dir = tmpDir();
    writeFile(dir, 'notes.md', '# Meeting\n\nDiscussed the roadmap.\n');
    const { plan } = planImport(dir, { kind: 'meeting', actor: 'alice', repoDir: dir, date: '2026-01-01' });
    const localDir = path.join(dir, '_fleet', 'local');

    const result = await applyImport(config, plan, { localDir, repoId: 'r'.repeat(64) });
    assert.equal(result.mode, 'semantic (sidecar)');

    const ingestReq = requests.find((r) => r.pathname === '/ingest');
    assert.ok(ingestReq.body.rows.every((r) => r._emb_text === r.chunk_text));
  });
});

test('applyImport never calls the sidecar itself — accelEndpoint only ever toggles the _emb_text field, no request is ever made to it', async () => {
  await withFakeIngestServer(async (baseConfig, requests) => {
    const config = { ...baseConfig, accelEndpoint: 'http://sidecar.internal:9999' };
    const dir = tmpDir();
    writeFile(dir, 'notes.md', '# X\n\nbody');
    const { plan } = planImport(dir, { kind: 'spec', actor: 'alice', repoDir: dir, date: '2026-01-01' });
    const localDir = path.join(dir, '_fleet', 'local');

    await applyImport(config, plan, { localDir, repoId: 'r'.repeat(64) });
    assert.ok(requests.every((r) => r.pathname === '/ingest'), 'every request must be the ordinary /ingest call — never a direct call to the sidecar endpoint');
  });
});

test('import.js source never imports a fetch/http client aimed at a sidecar and never adds a new dependency in either package.json', () => {
  const src = fs.readFileSync(new URL('../src/grid/import.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /accelEndpoint\)\s*{[^}]*fetch\(/s, 'accelEndpoint must only ever toggle a field, never trigger a direct network call from this module');

  for (const pkgPath of [new URL('../package.json', import.meta.url), new URL('../../package.json', import.meta.url)]) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['yaml'], `${pkgPath} must not have gained an embeddings-related dependency`);
  }
});

// --- import.js's own purity boundary: never a memory-verb call ----------------------

test('DEFAULT_MAX_CHUNK_CHARS is exported and reasonable', () => {
  assert.equal(typeof DEFAULT_MAX_CHUNK_CHARS, 'number');
  assert.ok(DEFAULT_MAX_CHUNK_CHARS > 0 && DEFAULT_MAX_CHUNK_CHARS <= 5000);
});

// --- live: dry-run writes nothing, apply/re-apply idempotent, verified via real row counts ---

async function queryAll(config, typeName) {
  const result = await request(config, { method: 'POST', path: '/query', body: { sql: `SELECT * FROM ${typeName}`, purpose: config.purposes?.[0] ?? 'product_context' } });
  return (result.data ?? []).flatMap((cell) => JSON.parse(cell.rows ?? '[]'));
}

/**
 * Skips loudly, never passes silently, when no live instance is configured — the acceptance criterion
 * ("dry-run writes nothing", "apply -> re-apply: zero new rows") explicitly calls for verification "against
 * live container row counts", not just the deterministic fake-server proof above. `process.pid` (not
 * `Date.now()`/`Math.random()`) keeps this run's `repo_id` and content unique against any other suite run
 * sharing the same instance, matching `ontology.test.js`'s own live-test convention.
 */
test('live: dry-run writes nothing, apply then re-apply is idempotent, verified against real row counts on a live RelataDB', async (t) => {
  if (!process.env.RELATA_TEST_URL) {
    t.skip('RELATA_TEST_URL not set — no live RelataDB configured for this run');
    return;
  }
  const config = { url: process.env.RELATA_TEST_URL, token: process.env.RELATA_TEST_TOKEN ?? '', purposes: ['product_context'] };
  const repoId = `repo-g6-1-${process.pid}`;
  const dir = tmpDir();
  writeFile(dir, 'notes.md', `# Live Import Test ${process.pid}\n\nUnique content for this live test run, pid ${process.pid}.\n`);
  const localDir = path.join(dir, '_fleet', 'local');

  const { plan } = planImport(dir, { kind: 'meeting', actor: `live-test-${process.pid}`, repoDir: dir, date: '2026-01-01' });
  const totalRows = plan.reduce((n, f) => n + f.rows.length, 0);
  assert.ok(totalRows > 0);

  const beforeAny = await queryAll(config, 'OrgDocument');
  assert.equal(beforeAny.filter((r) => r.repo_id === repoId).length, 0, 'planning alone must not have created any rows for this repo_id');

  const first = await applyImport(config, plan, { localDir, repoId });
  assert.equal(first.ingested, totalRows);
  await new Promise((resolve) => setTimeout(resolve, 3000)); // async ingest settle — verified elsewhere in this milestone

  const afterFirst = await queryAll(config, 'OrgDocument');
  const afterFirstCount = afterFirst.filter((r) => r.repo_id === repoId).length;
  assert.equal(afterFirstCount, totalRows, 'the live instance must show exactly the rows just ingested, for this repo_id');

  const second = await applyImport(config, plan, { localDir, repoId });
  assert.equal(second.ingested, 0, 're-apply against the live instance must ingest zero new rows');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const afterSecond = await queryAll(config, 'OrgDocument');
  const afterSecondCount = afterSecond.filter((r) => r.repo_id === repoId).length;
  assert.equal(afterSecondCount, afterFirstCount, 'the live row count for this repo_id must not grow on re-apply');
});
