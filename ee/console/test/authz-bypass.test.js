// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';
import { fakeRelata } from './fake-relata.js';
import { _resetForTests as resetTokens } from '../server/routes/tokens.js';
import { repoIdFromRemote } from '../server/repo.js';
import { routeManifest, mutationRoutes, routeKey, assertMutationsFullyTested } from '../server/manifest.js';

/**
 * G8.8 — the authz-bypass suite. Every mutation route in the LIVE manifest (`server/manifest.js`, derived
 * directly from `buildApp()`'s own router — never a second, hand-maintained list) gets a raw-fetch bypass
 * attempt per insufficient role, asserting BOTH the correct status code AND zero state change (verified via a
 * follow-up admin-authenticated read) — a route that merely 403s while still mutating state would pass a
 * status-only check and fail the real requirement.
 *
 * `TESTED` tracks which manifest entries this file actually exercises; the completeness test at the bottom
 * fails loudly, naming every gap, if a new mutation route is ever added to `app.js` without a matching case
 * here — see `assertMutationsFullyTested`'s own doc comment for why a SYNTHETIC negative test (further below)
 * is how "adding an unmanifested route breaks the build" is actually provable, rather than requiring a real
 * uncovered route to be committed just to watch this file fail on it.
 */
const TESTED = new Set();
function covers(method, pattern) {
  TESTED.add(routeKey({ method, pattern }));
}

const REMOTE = 'git@github.com:acme/authz-bypass-fixture.git';
const REPO_ID = repoIdFromRemote(REMOTE);

async function withConsole(consoleEnv, relataOpts, fn) {
  const { server: relataServer, requests } = fakeRelata(relataOpts);
  await new Promise((resolve) => relataServer.listen(0, '127.0.0.1', resolve));
  const relataUrl = `http://127.0.0.1:${relataServer.address().port}`;
  const { server } = createServer({ RELATA_URL: relataUrl, ...consoleEnv });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const consoleUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ consoleUrl, requests });
  } finally {
    resetTokens();
    server.closeAllConnections?.();
    relataServer.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => relataServer.close(resolve));
  }
}

/** A raw fetch — no helper wrapping the request shape, deliberately, since this suite's whole point is proving the SERVER rejects a bypass attempt regardless of how it's phrased, the same as `curl` would send it. */
function rawFetch(url, opts = {}, token) {
  return fetch(url, { ...opts, headers: { ...(opts.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

const ADMIN_ENV = { CONSOLE_ADMINS: 'alice', RELATA_ADMIN_TOKEN: 'admin-secret-value' };
const ADMIN_RELATA = { tokensSelf: (t) => (t === 'admin-token' ? { present: true, principal: 'alice' } : { present: false }), adminToken: 'admin-secret-value' };

const orgDoc = (overrides) => ({
  repo_id: 'r1',
  content_hash: 'h1',
  kind: 'spec',
  title: 'Doc A',
  client: '',
  chunk_index: 0,
  chunk_text: 'text',
  source_file: 'a.md',
  imported_by: 'ada',
  valid_from: '2026-01-01',
  imported_at: '2026-01-01T00:00:00.000Z',
  purpose: 'product_context',
  origin: 'human',
  ...overrides,
});

// --- POST /api/knowledge/:contentHash/approve (admin) --------------------------------------------------------

test('bypass: POST approve — anonymous and member both refused, state unchanged', async () => {
  covers('POST', '/api/knowledge/:contentHash/approve');
  await withConsole(ADMIN_ENV, { ...ADMIN_RELATA, queryRows: { OrgDocument: [orgDoc({ approval: 'proposed' })] } }, async ({ consoleUrl, requests }) => {
    const anon = await rawFetch(`${consoleUrl}/api/knowledge/h1/approve`, { method: 'POST' });
    assert.equal(anon.status, 401);

    const member = await rawFetch(`${consoleUrl}/api/knowledge/h1/approve`, { method: 'POST' }, 'member-token');
    assert.equal(member.status, 403);

    assert.ok(!requests.some((r) => r.pathname === '/ingest'), 'neither bypass attempt may have mutated anything');
    const after = await rawFetch(`${consoleUrl}/api/knowledge/documents`, {}, 'admin-token');
    assert.equal(after.body.documents.find((d) => d.content_hash === 'h1').approval, 'proposed', 'state must be exactly what it was before either attempt');
  });
});

// --- POST /api/knowledge/:contentHash/reject (admin) ----------------------------------------------------------

test('bypass: POST reject — anonymous and member both refused, state unchanged', async () => {
  covers('POST', '/api/knowledge/:contentHash/reject');
  await withConsole(ADMIN_ENV, { ...ADMIN_RELATA, queryRows: { OrgDocument: [orgDoc({ approval: 'proposed' })] } }, async ({ consoleUrl, requests }) => {
    const body = JSON.stringify({ note: 'bypass attempt' });
    const anon = await rawFetch(`${consoleUrl}/api/knowledge/h1/reject`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(anon.status, 401);

    const member = await rawFetch(`${consoleUrl}/api/knowledge/h1/reject`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, 'member-token');
    assert.equal(member.status, 403);

    assert.ok(!requests.some((r) => r.pathname === '/ingest'));
    const after = await rawFetch(`${consoleUrl}/api/knowledge/documents`, {}, 'admin-token');
    assert.equal(after.body.documents.find((d) => d.content_hash === 'h1').approval, 'proposed');
  });
});

// --- PUT /api/equip/:fleet/:agent (admin) -----------------------------------------------------------------

test('bypass: PUT equip binding — anonymous and member both refused, bindings unchanged', async () => {
  covers('PUT', '/api/equip/:fleet/:agent');
  await withConsole(ADMIN_ENV, ADMIN_RELATA, async ({ consoleUrl, requests }) => {
    const path = `/api/equip/demo/scout?remote=${encodeURIComponent(REMOTE)}`;
    const body = JSON.stringify({ bindings: [{ scope_kind: 'purpose', scope_ref: 'product_context', equipped: false }] });

    const anon = await rawFetch(`${consoleUrl}${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(anon.status, 401);

    const member = await rawFetch(`${consoleUrl}${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body }, 'member-token');
    assert.equal(member.status, 403);

    assert.ok(!requests.some((r) => r.pathname === '/ingest'));
    const after = await rawFetch(`${consoleUrl}${path}`, {}, 'admin-token');
    assert.deepEqual(after.body.bindings, [], 'no binding may have been written by either bypass attempt');
  });
});

// --- POST /api/tokens (admin) -----------------------------------------------------------------------------

test('bypass: POST create token — anonymous and member both refused, no token created', async () => {
  covers('POST', '/api/tokens');
  await withConsole(ADMIN_ENV, ADMIN_RELATA, async ({ consoleUrl, requests }) => {
    const body = JSON.stringify({ id: 'bypass-token', owner: 'mallory' });

    const anon = await rawFetch(`${consoleUrl}/api/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(anon.status, 401);

    const member = await rawFetch(`${consoleUrl}/api/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, 'member-token');
    assert.equal(member.status, 403);

    assert.ok(!requests.some((r) => r.pathname === '/tokens' && r.method === 'POST'), 'the engine must never have seen a create call from either attempt');
    const after = await rawFetch(`${consoleUrl}/api/tokens`, {}, 'admin-token');
    assert.deepEqual(after.body.tokens, [], 'no token may exist after either bypass attempt');
  });
});

// --- DELETE /api/tokens/:id (admin) ---------------------------------------------------------------------------

test('bypass: DELETE revoke token — anonymous and member both refused, the real token survives', async () => {
  covers('DELETE', '/api/tokens/:id');
  await withConsole(ADMIN_ENV, ADMIN_RELATA, async ({ consoleUrl, requests }) => {
    // A real token must exist first — otherwise "it survived" would be vacuously true.
    const created = await rawFetch(`${consoleUrl}/api/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'survivor-token' }) }, 'admin-token');
    assert.equal(created.status, 201);
    requests.length = 0; // only care about requests from here on

    const anon = await rawFetch(`${consoleUrl}/api/tokens/survivor-token`, { method: 'DELETE' });
    assert.equal(anon.status, 401);

    const member = await rawFetch(`${consoleUrl}/api/tokens/survivor-token`, { method: 'DELETE' }, 'member-token');
    assert.equal(member.status, 403);

    assert.ok(!requests.some((r) => r.pathname === '/tokens/survivor-token' && r.method === 'DELETE'));
    const after = await rawFetch(`${consoleUrl}/api/tokens`, {}, 'admin-token');
    assert.ok(after.body.tokens.some((t) => t.id === 'survivor-token'), 'the real token must still be listed — neither bypass attempt revoked it');
  });
});

// --- member-role mutations: no "wrong role" case exists (member IS the base tier) — anonymous must still 401 --

test('bypass: POST propose — anonymous refused; a real member succeeds (positive control, proving the route itself works)', async () => {
  covers('POST', '/api/knowledge/:contentHash/propose');
  await withConsole({}, { tokensSelf: (t) => (t === 'member-token' ? { present: true, principal: 'ada' } : { present: false }), queryRows: { OrgDocument: [orgDoc({})] } }, async ({ consoleUrl }) => {
    const anon = await rawFetch(`${consoleUrl}/api/knowledge/h1/propose`, { method: 'POST' });
    assert.equal(anon.status, 401);

    const member = await rawFetch(`${consoleUrl}/api/knowledge/h1/propose`, { method: 'POST' }, 'member-token');
    assert.equal(member.status, 200, 'a real, authenticated member must still be able to propose — this route is member-accessible by design');
  });
});

test('bypass: POST publish — anonymous refused; a real member succeeds (positive control)', async () => {
  covers('POST', '/api/knowledge/:contentHash/publish');
  await withConsole({}, { tokensSelf: (t) => (t === 'member-token' ? { present: true, principal: 'ada' } : { present: false }), queryRows: { OrgDocument: [orgDoc({ approval: 'approved' })] } }, async ({ consoleUrl }) => {
    const anon = await rawFetch(`${consoleUrl}/api/knowledge/h1/publish`, { method: 'POST' });
    assert.equal(anon.status, 401);

    const member = await rawFetch(`${consoleUrl}/api/knowledge/h1/publish`, { method: 'POST' }, 'member-token');
    assert.equal(member.status, 200);
  });
});

test('bypass: POST tokens/self/rotate — anonymous refused; the engine never sees a call without a real token', async () => {
  covers('POST', '/api/tokens/self/rotate');
  await withConsole({}, {}, async ({ consoleUrl, requests }) => {
    const anon = await rawFetch(`${consoleUrl}/api/tokens/self/rotate`, { method: 'POST' });
    assert.equal(anon.status, 401);
    assert.ok(!requests.some((r) => r.pathname === '/tokens/self/rotate'));
  });
});

// --- read-route self-scoping cannot be widened by query tampering (the G8.3 case, generalized here) ----------

test('bypass: a member cannot widen GET /api/audit\'s self-only scope via a tampered ?actor= param', async () => {
  // The full dedicated suite for this lives in audit.test.js; this is the authz-bypass suite's own consolidated
  // proof that the SAME mechanism holds, satisfying G8.8's point 3 without duplicating that file's detail.
  await withConsole(
    {},
    { auditEntries: [{ timestamp: 't1', actor: 'ada', action: 'recall', purpose: 'p', object: 'o1' }, { timestamp: 't2', actor: 'grace', action: 'recall', purpose: 'p', object: 'o2' }], tokensSelf: (t) => (t === 'member-token' ? { present: true, principal: 'ada' } : { present: false }) },
    async ({ consoleUrl }) => {
      const { status, body } = await rawFetch(`${consoleUrl}/api/audit?actor=grace`, {}, 'member-token');
      assert.equal(status, 200);
      assert.deepEqual(body.entries.map((e) => e.actor), ['ada'], 'the tampered ?actor=grace must be silently overridden, never honored');
    }
  );
});

// --- completeness: 100% of manifest mutations must have a case above ----------------------------------------

test('authz-bypass suite covers every mutation route in the live manifest', () => {
  assertMutationsFullyTested(routeManifest(), TESTED);
});

// --- the completeness CHECK itself is proven to actually catch a gap (a synthetic negative test) -------------
//
// A real uncovered route cannot be committed just to watch this file fail on it — this proves the MECHANISM
// (assertMutationsFullyTested) correctly detects a manifest entry with no corresponding tested key, using a
// synthetic manifest instead of the live one. This is what "adding an unmanifested route breaks the build" is
// provable BY, in a single self-contained test.

test('assertMutationsFullyTested throws, naming the gap, when a mutation route has no tested key — proves the completeness check itself works', () => {
  const syntheticManifest = [
    { method: 'GET', pattern: '/api/fixture', role: 'member' }, // GET is never a "mutation" — must not appear in the error
    { method: 'POST', pattern: '/api/fixture/:id/covered', role: 'admin' },
    { method: 'DELETE', pattern: '/api/fixture/:id/uncovered', role: 'admin' }, // deliberately NOT in testedKeys below
  ];
  const partiallyTested = new Set([routeKey({ method: 'POST', pattern: '/api/fixture/:id/covered' })]);

  assert.throws(
    () => assertMutationsFullyTested(syntheticManifest, partiallyTested),
    (e) => {
      assert.match(e.message, /DELETE \/api\/fixture\/:id\/uncovered/);
      assert.doesNotMatch(e.message, /GET \/api\/fixture\b/, 'a GET route must never be reported as an uncovered mutation');
      return true;
    }
  );

  // And the positive case: fully covering the synthetic manifest's mutations must NOT throw.
  const fullyTested = new Set([...partiallyTested, routeKey({ method: 'DELETE', pattern: '/api/fixture/:id/uncovered' })]);
  assert.doesNotThrow(() => assertMutationsFullyTested(syntheticManifest, fullyTested));
});
