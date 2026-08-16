// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  deriveSessionId,
  encodeContent,
  decodeContent,
  unwrapRelataResponse,
  request,
  rememberOne,
  rememberBatch,
} from '../src/memory/relatadb.js';
import { RelataNetworkError, RelataHttpError, RelataToolError } from '../src/memory/errors.js';
import { MemoryError } from 'fleetsmith/memory/port';

/**
 * A fake RelataDB, not a mock of our own assumptions about it: every shape
 * this server returns was captured from a real, licensed v1.5.7 instance on
 * 2026-08-16 (round-tripped remember/remember-batch/recall directly; see the
 * relatadb-local-instance-and-v2-api-shapes project memory and G1.1's PR for
 * the full session). CI has no live RelataDB, so this is what keeps this
 * suite honest without one — a server that lies the same way the real one
 * does, not a server that lies the way this module hopes it does.
 */
function fakeRelata() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });

      if (req.headers.authorization !== 'Bearer test-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'unauthorized', code: 'about:blank' }));
        return;
      }

      if (req.method === 'POST' && req.url === '/memory/remember') {
        if (!parsed?.content) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ content: [{ type: 'text', text: 'missing required argument: content' }], isError: true }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            stored: 'MemoryItem',
            id: `fake-${requests.length}`,
            session_id: parsed.session_id ?? '',
            confidence: parsed.confidence ?? 1.0,
            preview: parsed.content.slice(0, 40),
            processing_time_ms: 0,
          })
        );
        return;
      }

      if (req.method === 'POST' && req.url === '/memory/remember/batch') {
        const results = (parsed?.items ?? []).map((item, i) => ({
          stored: 'MemoryItem',
          id: `fake-batch-${requests.length}-${i}`,
          session_id: item.session_id ?? '',
          confidence: item.confidence ?? 1.0,
          preview: item.content.slice(0, 40),
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            content: [{ type: 'text', text: JSON.stringify({ stored: results.length, submitted: results.length, results }) }],
            isError: false,
          })
        );
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
  const config = { url: `http://127.0.0.1:${port}`, token: 'test-token', purposes: ['test_purpose'], fleetName: 'test-fleet' };
  try {
    await fn(config, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// --- pure helpers -------------------------------------------------------

test('deriveSessionId is deterministic per fleet name, and distinct across names', () => {
  assert.equal(deriveSessionId('fleet-a'), deriveSessionId('fleet-a'));
  assert.notEqual(deriveSessionId('fleet-a'), deriveSessionId('fleet-b'));
  assert.match(deriveSessionId('fleet-a'), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('encodeContent/decodeContent round-trip a MemoryItem through content as the only channel', () => {
  const item = { kind: 'lesson', text: 'write the handoff first', subject: 'skill-smith', origin: 'evolved', evidence: ['gate_block'] };
  const decoded = decodeContent(encodeContent(item));
  assert.equal(decoded.kind, 'lesson');
  assert.equal(decoded.text, 'write the handoff first');
  assert.equal(decoded.subject, 'skill-smith');
  assert.equal(decoded.origin, 'evolved');
  assert.deepEqual(decoded.evidence, ['gate_block']);
  assert.equal(typeof decoded.actor, 'string');
});

test('decodeContent degrades to a plain note for content fleetsmith did not write', () => {
  // RelataDB may hold rows from another tool, or from before this envelope
  // existed. That is a real memory row's honest shape, not a parse failure.
  const decoded = decodeContent('just some plain text nobody enveloped');
  assert.equal(decoded.kind, 'note');
  assert.equal(decoded.text, 'just some plain text nobody enveloped');
});

test('unwrapRelataResponse passes plain JSON through and unwraps the MCP content envelope', () => {
  assert.deepEqual(unwrapRelataResponse({ stored: 'x', id: '1' }), { stored: 'x', id: '1' });
  assert.deepEqual(
    unwrapRelataResponse({ content: [{ type: 'text', text: '{"rows":[],"count":0}' }], isError: false }),
    { rows: [], count: 0 }
  );
  assert.throws(
    () => unwrapRelataResponse({ content: [{ type: 'text', text: 'missing required argument: content' }], isError: true }),
    RelataToolError
  );
});

// --- transport ------------------------------------------------------------

test('request() sends the bearer token and JSON body, and returns the unwrapped result', async () => {
  await withFakeRelata(async (config, requests) => {
    const result = await request(config, { method: 'POST', path: '/memory/remember', body: { content: 'hi' } });
    assert.equal(requests[0].headers.authorization, 'Bearer test-token');
    assert.equal(requests[0].body.content, 'hi');
    assert.equal(result.stored, 'MemoryItem');
  });
});

test('request() throws RelataHttpError with the status on a non-2xx response', async () => {
  await withFakeRelata(async (config) => {
    const bad = { ...config, token: 'wrong-token' };
    await assert.rejects(() => request(bad, { method: 'GET', path: '/memory/recall' }), (e) => {
      assert.ok(e instanceof RelataHttpError);
      assert.equal(e.status, 401);
      assert.match(e.message, /unauthorized/);
      return true;
    });
  });
});

test('request() throws RelataNetworkError when the server is unreachable', async () => {
  // Port 0 with nothing listening (never bound) — an address guaranteed to
  // refuse the connection outright, not just respond slowly.
  const config = { url: 'http://127.0.0.1:1', token: 'x' };
  await assert.rejects(() => request(config, { method: 'GET', path: '/health', timeoutMs: 500 }), RelataNetworkError);
});

// --- rememberOne / rememberBatch ------------------------------------------

test('rememberOne writes the content envelope, the derived session id, and the mapped memory_class', async () => {
  await withFakeRelata(async (config, requests) => {
    const result = await rememberOne(config, { kind: 'lesson', text: 'always write the handoff', subject: 'skill-smith', origin: 'evolved' });
    assert.ok(result.id);
    const sent = requests[0].body;
    assert.equal(sent.session_id, deriveSessionId('test-fleet'));
    assert.equal(sent.memory_class, 'procedural');
    assert.equal(sent.purpose, 'test_purpose');
    assert.deepEqual(decodeContent(sent.content), {
      kind: 'lesson',
      subject: 'skill-smith',
      origin: 'evolved',
      evidence: [],
      actor: decodeContent(sent.content).actor,
      text: 'always write the handoff',
    });
  });
});

test('rememberOne maps decision and note to semantic', async () => {
  await withFakeRelata(async (config, requests) => {
    await rememberOne(config, { kind: 'decision', text: 'd', origin: 'human' });
    await rememberOne(config, { kind: 'note', text: 'n', origin: 'human' });
    assert.equal(requests[0].body.memory_class, 'semantic');
    assert.equal(requests[1].body.memory_class, 'semantic');
  });
});

test('rememberOne refuses event before making any network call', async () => {
  await withFakeRelata(async (config, requests) => {
    await assert.rejects(() => rememberOne(config, { kind: 'event', text: 'x' }), MemoryError);
    assert.equal(requests.length, 0, 'an event must never reach the network');
  });
});

test('rememberOne still enforces the port-level item validation (delegates to assertValidItem)', async () => {
  await withFakeRelata(async (config, requests) => {
    await assert.rejects(() => rememberOne(config, { kind: 'lesson', text: '   ' }), MemoryError);
    await assert.rejects(() => rememberOne(config, { kind: 'nonsense', text: 'x' }), MemoryError);
    assert.equal(requests.length, 0, 'an invalid item must never reach the network');
  });
});

test('a 200 response with isError:true (a real RelataDB shape) surfaces as RelataToolError', async () => {
  await withFakeRelata(async (config) => {
    // The fake server returns this exact shape when `content` is absent from
    // the body — captured verbatim from the real instance's 400-equivalent.
    await assert.rejects(() => request(config, { method: 'POST', path: '/memory/remember', body: {} }), (e) => {
      assert.ok(e instanceof RelataToolError);
      assert.match(e.message, /missing required argument: content/);
      return true;
    });
  });
});

test('rememberBatch writes every item under one shared session id and returns every id', async () => {
  await withFakeRelata(async (config, requests) => {
    const result = await rememberBatch(config, [
      { kind: 'decision', text: 'd1', origin: 'human' },
      { kind: 'note', text: 'n1', origin: 'human' },
    ]);
    assert.equal(result.ids.length, 2);
    const sent = requests[0].body;
    assert.equal(sent.items.length, 2);
    assert.equal(sent.items[0].session_id, sent.items[1].session_id);
    assert.equal(sent.items[0].session_id, deriveSessionId('test-fleet'));
  });
});

test('rememberBatch refuses the whole batch if any item is an event, before any network call', async () => {
  await withFakeRelata(async (config, requests) => {
    await assert.rejects(
      () => rememberBatch(config, [{ kind: 'note', text: 'ok' }, { kind: 'event', text: 'nope' }]),
      MemoryError
    );
    assert.equal(requests.length, 0);
  });
});

// --- optional live verification -------------------------------------------

/**
 * Skips loudly, never passes silently, when no live instance is configured —
 * CI has none. Point RELATA_URL/RELATA_TOKEN at a real instance (as used
 * throughout G1.1/G1.2 development, see the project memory) to actually
 * exercise this against the real wire, not the fake server above.
 */
test('live: rememberOne round-trips against a real RelataDB instance, if configured', async (t) => {
  if (!process.env.RELATA_URL || !process.env.RELATA_TOKEN) {
    t.skip('RELATA_URL/RELATA_TOKEN not set — no live instance configured for this run');
    return;
  }
  const config = {
    url: process.env.RELATA_URL,
    token: process.env.RELATA_TOKEN,
    purposes: ['fleetsmith_live_test'],
    fleetName: `fleetsmith-live-test-${process.pid}`,
  };
  const { id } = await rememberOne(config, { kind: 'note', text: 'live G1.2 test item', origin: 'human' });
  assert.ok(id);
  // Clean up after ourselves — this hits a real, possibly shared instance.
  await request(config, { method: 'DELETE', path: `/memory/forget/${id}`, query: { purpose: 'fleetsmith_live_test' } });
});
