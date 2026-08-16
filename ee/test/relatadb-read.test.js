// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { recall, justify, consolidate, forget, relatadbBackend } from '../src/memory/relatadb.js';
import { RelataHttpError } from '../src/memory/errors.js';
import { MemoryError, runContract } from 'fleetsmith/memory/port';

/**
 * A fuller fake RelataDB than G1.2's write-only one: this exercises
 * recall/justify/recognize/forget together, so it needs actual state to read
 * back — an in-memory store keyed by id, scoped by `session_id` exactly the
 * way the real engine scopes it (see `deriveSessionId`'s doc comment: no
 * matching session_id, no results, regardless of query text — confirmed
 * against the real instance, not assumed).
 *
 * Matching is a plain substring check, not RelataDB's real BM25/hybrid
 * ranking — this fake exists to prove OUR parameter construction, envelope
 * decoding, and error handling are correct, not to reimplement search.
 */
function fakeRelataStore() {
  const items = new Map(); // id -> {content, session_id, memory_class, confidence}
  let counter = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;

      if (req.headers.authorization !== 'Bearer test-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'unauthorized' }));
        return;
      }

      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const wrapped = (obj, isError = false) => ({ content: [{ type: 'text', text: isError ? obj : JSON.stringify(obj) }], isError });

      if (req.method === 'POST' && req.url === '/memory/remember') {
        if (!parsed?.content) return send(200, wrapped('missing required argument: content', true));
        const id = `fake-${++counter}`;
        items.set(id, { content: parsed.content, session_id: parsed.session_id ?? '', memory_class: parsed.memory_class, confidence: parsed.confidence ?? 1.0 });
        return send(200, { stored: 'MemoryItem', id, session_id: parsed.session_id ?? '', confidence: parsed.confidence ?? 1.0, preview: parsed.content.slice(0, 40) });
      }

      if (req.method === 'GET' && url.pathname === '/memory/recall') {
        const query = url.searchParams.get('query') ?? url.searchParams.get('q');
        if (!query) return send(400, wrapped('missing required argument: q (or query)', true));
        const sessionId = url.searchParams.get('session_id');
        const classFilter = url.searchParams.get('class_filter');
        const topK = Number(url.searchParams.get('top_k') ?? 10);
        const rows = [...items.entries()]
          .filter(([, it]) => it.session_id === (sessionId ?? ''))
          .filter(([, it]) => (classFilter ? it.memory_class === classFilter : true))
          .filter(([, it]) => it.content.toLowerCase().includes(query.toLowerCase()))
          .slice(0, topK)
          .map(([id, it]) => ({ id, content: it.content, confidence: it.confidence, score: 1, memory_class: it.memory_class, session_id: it.session_id }));
        return send(200, wrapped({ rows, count: rows.length, query, mode: 'hybrid' }));
      }

      const justifyMatch = req.method === 'GET' && url.pathname.match(/^\/memory\/justify\/(.+)$/);
      if (justifyMatch) {
        const id = decodeURIComponent(justifyMatch[1]);
        if (!items.has(id)) return send(200, wrapped({ id, found: false, provenance: null }));
        return send(200, wrapped({ id, found: true, provenance: { id, prov_hex: '0'.repeat(66), valid_from: 1, valid_to: 9999999999, chain: [], chain_length: 0 } }));
      }

      const recognizeMatch = req.method === 'GET' && url.pathname.match(/^\/memory\/recognize\/(.+)$/);
      if (recognizeMatch) {
        const id = decodeURIComponent(recognizeMatch[1]);
        const it = items.get(id);
        if (!it) return send(400, wrapped('missing required argument: raw', true)); // matches the real engine's odd unknown-id shape
        return send(200, wrapped({ recognized: true, memory: { type: 'MemoryItem', id, content: it.content, confidence: it.confidence } }));
      }

      const forgetMatch = req.method === 'DELETE' && url.pathname.match(/^\/memory\/forget\/(.+)$/);
      if (forgetMatch) {
        const id = decodeURIComponent(forgetMatch[1]);
        items.delete(id);
        return send(200, { memory_item_id: id, policy: 'delete_after_0d', forget_at_ns: 0, scheduled: false });
      }

      send(404, { type: 'about:blank', title: 'Not Found', status: 404, detail: `no route for ${req.url}` });
    });
  });

  return { server, items };
}

async function withFakeStore(fn) {
  const { server, items } = fakeRelataStore();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const config = { url: `http://127.0.0.1:${port}`, token: 'test-token', purposes: ['test_purpose'], fleetName: 'test-fleet' };
  try {
    await fn(config, items);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// --- recall -----------------------------------------------------------------

test('recall finds an item written under the same derived session id', async () => {
  await withFakeStore(async (config) => {
    const backend = relatadbBackend(config);
    await backend.remember({ kind: 'lesson', text: 'always write the handoff file', origin: 'evolved', subject: 'skill-smith' });
    const found = await backend.recall('handoff file', { purpose: 'p' });
    assert.equal(found.length, 1);
    assert.equal(found[0].text, 'always write the handoff file');
    assert.equal(found[0].kind, 'lesson');
    assert.equal(found[0].subject, 'skill-smith');
  });
});

test('recall requires a purpose, same as every backend', async () => {
  await withFakeStore(async (config) => {
    await assert.rejects(() => recall(config, 'anything', {}), /purpose/i);
  });
});

test('recall filters by exact kind client-side, beyond RelataDB\'s coarser class_filter', async () => {
  // decision and note both map to memory_class "semantic" — class_filter alone
  // cannot tell them apart, so an exact kind match must happen after decoding.
  await withFakeStore(async (config) => {
    const backend = relatadbBackend(config);
    await backend.remember({ kind: 'decision', text: 'shared vocabulary decision', origin: 'human' });
    await backend.remember({ kind: 'note', text: 'shared vocabulary note', origin: 'human' });
    const decisions = await recall(config, 'shared vocabulary', { purpose: 'p', kind: 'decision' });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].kind, 'decision');
  });
});

test('recall filters by subject client-side — RelataDB has no subject parameter at all', async () => {
  await withFakeStore(async (config) => {
    const backend = relatadbBackend(config);
    await backend.remember({ kind: 'note', text: 'analyst note about the fleet', origin: 'human', subject: 'analyst' });
    await backend.remember({ kind: 'note', text: 'architect note about the fleet', origin: 'human', subject: 'fleet-architect' });
    const bySubject = await recall(config, 'fleet', { purpose: 'p', subject: 'analyst' });
    assert.equal(bySubject.length, 1);
    assert.equal(bySubject[0].subject, 'analyst');
  });
});

test('recall from a different fleet name never sees another fleet\'s items (session_id isolation)', async () => {
  await withFakeStore(async (config) => {
    const backend = relatadbBackend(config);
    await backend.remember({ kind: 'note', text: 'isolated note', origin: 'human' });
    const otherFleetConfig = { ...config, fleetName: 'a-completely-different-fleet' };
    const found = await recall(otherFleetConfig, 'isolated note', { purpose: 'p' });
    assert.deepEqual(found, [], 'a different fleet must not recall this fleet\'s memory');
  });
});

// --- justify ------------------------------------------------------------------

test('justify finds a remembered item and returns its evidence and origin', async () => {
  await withFakeStore(async (config) => {
    const backend = relatadbBackend(config);
    const { id } = await backend.remember({ kind: 'lesson', text: 'the lesson text', origin: 'evolved', evidence: ['gate_block: x'] });
    const why = await backend.justify(id);
    assert.equal(why.id, id);
    assert.equal(why.text, 'the lesson text');
    assert.equal(why.origin, 'evolved');
    assert.deepEqual(why.evidence, ['gate_block: x']);
  });
});

test('justify returns null for an unknown id, using justify\'s own clean found:false — not recognize\'s confusing 400', async () => {
  await withFakeStore(async (config) => {
    const why = await justify(config, 'no-such-id');
    assert.equal(why, null);
  });
});

// --- consolidate ---------------------------------------------------------------

test('consolidate is a documented no-op: numeric, idempotent, and never calls the network', async () => {
  await withFakeStore(async (config) => {
    const first = await consolidate(config);
    assert.equal(typeof first.before, 'number');
    assert.equal(typeof first.after, 'number');
    const second = await consolidate(config);
    assert.equal(second.before, second.after);
    assert.deepEqual(first, { before: 0, after: 0 });
  });
});

// --- forget --------------------------------------------------------------------

test('forget({id}) removes the item; a later justify no longer finds it', async () => {
  await withFakeStore(async (config) => {
    const backend = relatadbBackend(config);
    const { id } = await backend.remember({ kind: 'note', text: 'temporary', origin: 'human' });
    const { removed } = await backend.forget({ id });
    assert.deepEqual(removed, [id]);
    assert.equal(await backend.justify(id), null);
  });
});

test('forget without an id selector throws rather than silently forgetting nothing', async () => {
  await withFakeStore(async (config) => {
    await assert.rejects(() => forget(config, { kind: 'lesson' }), MemoryError);
    await assert.rejects(() => forget(config, { subject: 'analyst' }), MemoryError);
    await assert.rejects(() => forget(config, { utilityBelow: 0.5 }), MemoryError);
  });
});

// --- relatadbBackend() assembles the full five-verb shape ----------------------

test('relatadbBackend() satisfies the memory port contract against the fake store', async () => {
  await withFakeStore(async (config) => {
    await runContract(() => relatadbBackend(config), assert);
  });
});

// --- live verification -----------------------------------------------------

/**
 * The real proof: the exact same `runContract()` suite the file backend is
 * held to, run against a REAL RelataDB instance. This is what caught a real
 * bug during development — `consolidate()`'s first draft called `recall`
 * with an empty query string to count existing items, which the live
 * instance rejected outright (`HTTP 400: missing required argument: q (or
 * query)`) even though the schema marks it optional. The fake store above
 * cannot catch that class of error by construction, since it models this
 * module's OWN assumptions about the wire format — only the real engine can
 * contradict them. Skips loudly, never passes silently, when unconfigured.
 */
test('live: relatadbBackend() satisfies the full memory port contract against a real instance, if configured', async (t) => {
  if (!process.env.RELATA_URL || !process.env.RELATA_TOKEN) {
    t.skip('RELATA_URL/RELATA_TOKEN not set — no live instance configured for this run');
    return;
  }
  const config = {
    url: process.env.RELATA_URL,
    token: process.env.RELATA_TOKEN,
    purposes: ['fleetsmith_contract_test'],
    fleetName: `fleetsmith-contract-test-${process.pid}-${process.hrtime.bigint()}`,
  };
  await runContract(() => relatadbBackend(config), assert);
});

test('a genuine RelataDB HTTP error (wrong token) surfaces as RelataHttpError with a status, from recall too', async () => {
  await withFakeStore(async (config) => {
    const bad = { ...config, token: 'wrong' };
    await assert.rejects(() => recall(bad, 'x', { purpose: 'p' }), (e) => {
      assert.ok(e instanceof RelataHttpError);
      assert.equal(e.status, 401);
      return true;
    });
  });
});
