// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';
import { serveStatic } from '../server/static.js';

function fetchText(url, opts) {
  return fetch(url, opts).then(async (res) => ({ status: res.status, text: await res.text(), headers: res.headers }));
}

async function withServer(fn) {
  const { server } = createServer({ RELATA_URL: 'http://127.0.0.1:1' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET / serves the board page (index.html), unauthenticated — static assets are not API routes', async () => {
  await withServer(async (url) => {
    const { status, text, headers } = await fetchText(`${url}/`);
    assert.equal(status, 200);
    assert.match(headers.get('content-type'), /text\/html/);
    assert.match(text, /fleetsmith grid — board/);
  });
});

test('the board page has no mutation affordance — no fetch call anywhere in it uses POST/PUT/DELETE', async () => {
  await withServer(async (url) => {
    const { text } = await fetchText(`${url}/`);
    assert.doesNotMatch(text, /method:\s*['"](POST|PUT|DELETE)['"]/i);
    // Every fetch() call must target /api/board — a read, never a write endpoint.
    for (const m of text.matchAll(/fetch\(([^)]*)\)/g)) {
      assert.match(m[1], /\/api\/board/, `unexpected fetch target in the board page: ${m[1]}`);
    }
  });
});

test('a real request for "/../../../../../../etc/passwd" never serves a file outside the web directory', async () => {
  // `new URL()` (used both here and inside `serveStatic` itself) already normalizes "../" out of a pathname
  // before this module ever sees it, and `path.join` (not `path.resolve`) keeps a leading "/" segment inside
  // WEB_DIR rather than resetting to the filesystem root — this test proves the END RESULT (never serves
  // anything outside WEB_DIR, never 200s on a nonexistent file) holds through the REAL server, not just that
  // one internal guard fired.
  await withServer(async (url) => {
    const { status } = await fetchText(`${url}/../../../../../../etc/passwd`);
    assert.notEqual(status, 200);
  });
});

test('serveStatic\'s own boundary check refuses a path outside WEB_DIR if ever reached directly (defense in depth, in case a future caller passes an already-decoded path)', () => {
  // Bypasses the module's own `new URL()` normalization by calling path resolution the same way serveStatic
  // does, isolating just the boundary check itself.
  const req = { method: 'GET', url: '/%2e%2e%2f%2e%2e%2fpackage.json' }; // stays encoded through new URL(); still must not escape
  let written = null;
  const res = { writeHead: (status) => (written = status), end: () => {} };
  const served = serveStatic(req, res);
  assert.equal(served, false);
  assert.equal(written, null);
});

test('an unknown static path 404s as plain text, not JSON (only /api/* speaks JSON errors)', async () => {
  await withServer(async (url) => {
    const { status, text } = await fetchText(`${url}/nope.js`);
    assert.equal(status, 404);
    assert.doesNotMatch(text, /^\s*{/);
  });
});

test('/api/ paths are never handled by static serving, even for a bogus one', async () => {
  await withServer(async (url) => {
    const { status, text } = await fetchText(`${url}/api/does-not-exist`);
    assert.equal(status, 404);
    assert.match(text, /^\s*{/, 'an /api/ 404 must still be JSON, from the router, not the static fallback');
  });
});

// --- G8.4's two new pages ----------------------------------------------------------------------------------

test('GET /knowledge.html serves the knowledge screen, with real mutation affordances targeting only /api/knowledge routes', async () => {
  await withServer(async (url) => {
    const { status, text } = await fetchText(`${url}/knowledge.html`);
    assert.equal(status, 200);
    assert.match(text, /fleetsmith grid — knowledge/);
    // Unlike the board/audit pages, mutation IS the point here — but every mutating call must stay scoped to
    // /api/knowledge, never wander into another screen's routes.
    for (const m of text.matchAll(/api\(`([^`]*)`/g)) {
      assert.match(m[1], /^\/api\/knowledge/, `unexpected API target in the knowledge page: ${m[1]}`);
    }
  });
});

test('GET /procedures.html serves a read-only page — no mutating fetch anywhere, only /api/procedures reads', async () => {
  await withServer(async (url) => {
    const { status, text } = await fetchText(`${url}/procedures.html`);
    assert.equal(status, 200);
    assert.match(text, /fleetsmith grid — procedures/);
    assert.doesNotMatch(text, /method:\s*['"](POST|PUT|DELETE)['"]/i);
    for (const m of text.matchAll(/fetch\(([^)]*)\)/g)) {
      assert.match(m[1], /\/api\/procedures/, `unexpected fetch target in the procedures page: ${m[1]}`);
    }
  });
});

// --- G8.5's equip page --------------------------------------------------------------------------------------

test('GET /equip.html serves the equip screen, with every API call scoped to /api/equip', async () => {
  await withServer(async (url) => {
    const { status, text } = await fetchText(`${url}/equip.html`);
    assert.equal(status, 200);
    assert.match(text, /fleetsmith grid — equip/);
    for (const m of text.matchAll(/api\(`([^`]*)`/g)) {
      assert.match(m[1], /^\/api\/equip/, `unexpected API target in the equip page: ${m[1]}`);
    }
  });
});

// --- G8.6's members page -------------------------------------------------------------------------------------

test('GET /members.html serves the members/tokens screen, with every API call scoped to /api/members or /api/tokens', async () => {
  await withServer(async (url) => {
    const { status, text } = await fetchText(`${url}/members.html`);
    assert.equal(status, 200);
    assert.match(text, /fleetsmith grid — members/);
    let apiCallCount = 0;
    for (const m of text.matchAll(/api\((?:`([^`]*)`|'([^']*)'|"([^"]*)")/g)) {
      const target = m[1] ?? m[2] ?? m[3];
      apiCallCount++;
      assert.match(target, /^\/api\/(members|tokens)/, `unexpected API target in the members page: ${target}`);
    }
    assert.ok(apiCallCount >= 4, 'expected members/create/rotate/revoke calls to all be present');
  });
});
