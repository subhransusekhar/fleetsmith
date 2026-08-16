// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';
import { fakeRelata } from './fake-relata.js';
import { _resetForTests as resetTokens } from '../server/routes/tokens.js';
import { repoIdFromRemote } from '../server/repo.js';
import { request } from '../../src/memory/relatadb.js';
import { RelataHttpError } from '../../src/memory/errors.js';

async function withConsole(consoleEnv, relataOpts, fn) {
  const { server: relataServer, requests } = fakeRelata(relataOpts);
  await new Promise((resolve) => relataServer.listen(0, '127.0.0.1', resolve));
  const relataUrl = `http://127.0.0.1:${relataServer.address().port}`;
  const logLines = [];
  const { server } = createServer({ RELATA_URL: relataUrl, ...consoleEnv }, { logger: (line) => logLines.push(line) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const consoleUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ consoleUrl, requests, logLines });
  } finally {
    resetTokens();
    server.closeAllConnections?.();
    relataServer.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => relataServer.close(resolve));
  }
}

function call(url, opts, token) {
  return fetch(url, { ...opts, headers: { ...(opts?.headers ?? {}), Authorization: `Bearer ${token}` } }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

const ADMIN_ENV = { CONSOLE_ADMINS: 'alice', RELATA_ADMIN_TOKEN: 'admin-secret-value' };
const ADMIN_RELATA = { tokensSelf: (t) => (t === 'admin-token' ? { present: true, principal: 'alice' } : { present: false }), adminToken: 'admin-secret-value' };

// --- TTL passthrough (G8.6) --------------------------------------------------------------------------------

test('creating a token with a ttlSeconds forwards ttl_seconds and reports back the engine\'s expires_at', async () => {
  await withConsole(ADMIN_ENV, ADMIN_RELATA, async ({ consoleUrl, requests }) => {
    const { status, body } = await call(`${consoleUrl}/api/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'ttl-token', ttlSeconds: 3600 }) }, 'admin-token');
    assert.equal(status, 201);
    assert.ok(body.expiresAt, 'expiresAt must be reported when the engine returns one');
    const createReq = requests.find((r) => r.pathname === '/tokens' && r.method === 'POST');
    assert.equal(createReq.body.ttl_seconds, 3600);
  });
});

test('creating a token without a ttlSeconds sends no ttl_seconds field at all', async () => {
  await withConsole(ADMIN_ENV, ADMIN_RELATA, async ({ consoleUrl, requests }) => {
    await call(`${consoleUrl}/api/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'no-ttl-token' }) }, 'admin-token');
    const createReq = requests.find((r) => r.pathname === '/tokens' && r.method === 'POST');
    assert.ok(!('ttl_seconds' in createReq.body));
  });
});

test('a second fetch of the token list shows only prefix/creation/expiry — the full value is never retrievable again (G8.6\'s own acceptance criterion)', async () => {
  await withConsole(ADMIN_ENV, ADMIN_RELATA, async ({ consoleUrl }) => {
    const create = await call(`${consoleUrl}/api/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'once-token', ttlSeconds: 60 }) }, 'admin-token');
    assert.ok(create.body.token, 'the full value is present exactly once, on creation');

    const list = await call(`${consoleUrl}/api/tokens`, {}, 'admin-token');
    const entry = list.body.tokens.find((t) => t.id === 'once-token');
    assert.ok(entry, 'the token must still be listed');
    assert.ok(!('token' in entry), 'the second fetch must never carry the full value');
    assert.equal(entry.prefix, create.body.token.slice(0, 8));
    assert.equal(entry.expiresAt, create.body.expiresAt);
  });
});

// --- self-service rotation (G8.6) --------------------------------------------------------------------------

test('POST /api/tokens/self/rotate is member-accessible (no admin gate) and forwards the caller\'s OWN token, never the admin secret', async () => {
  await withConsole({}, {}, async ({ consoleUrl, requests }) => {
    const { status, body } = await call(`${consoleUrl}/api/tokens/self/rotate`, { method: 'POST' }, 'member-token');
    assert.equal(status, 200);
    assert.equal(body.token, 'rotated-member-token');
    assert.match(body.warning, /shown exactly once/);
    const rotateReq = requests.find((r) => r.pathname === '/tokens/self/rotate');
    assert.equal(rotateReq.token, 'member-token');
  });
});

test('self-rotate surfaces a defensively-unpacked-but-missing token field as a clear 502, not a crash', async () => {
  await withConsole({}, { rotateResponse: () => ({ nonsense: true }) }, async ({ consoleUrl }) => {
    const { status } = await call(`${consoleUrl}/api/tokens/self/rotate`, { method: 'POST' }, 'member-token');
    assert.equal(status, 502);
  });
});

// --- members (G8.6) ----------------------------------------------------------------------------------------

const MEMBERS_REMOTE = 'git@github.com:acme/members-fixture.git';
const MEMBERS_REPO_ID = repoIdFromRemote(MEMBERS_REMOTE);

test('GET /api/members unions grid-activity actors with tokens created through this console, and assigns role from CONSOLE_ADMINS', async () => {
  await withConsole(
    { ...ADMIN_ENV },
    { ...ADMIN_RELATA, queryRows: { ActorPresence: [{ repo_id: MEMBERS_REPO_ID, actor: 'grace', run_id: 'r1', branch: 'main', heartbeat_at: new Date().toISOString() }] } },
    async ({ consoleUrl }) => {
      // Seed a token for a THIRD name (bob) that has no presence at all, proving the union includes both sides.
      await call(`${consoleUrl}/api/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 't1', owner: 'bob' }) }, 'admin-token');

      const { status, body } = await call(`${consoleUrl}/api/members?remote=${encodeURIComponent(MEMBERS_REMOTE)}`, {}, 'admin-token');
      assert.equal(status, 200);
      const names = body.members.map((m) => m.name).sort();
      assert.ok(names.includes('bob'), 'a token-only member (no presence yet) must still appear');
      const alice = body.members.find((m) => m.name === 'alice');
      // alice has neither presence nor a token in this fixture, so she should NOT appear — role assignment is
      // about WHO IS KNOWN, not a roster of every configured admin name regardless of activity.
      assert.ok(!alice, 'CONSOLE_ADMINS names are not auto-added to the member list — only observed actors/token owners are');
      const bob = body.members.find((m) => m.name === 'bob');
      assert.equal(bob.role, 'member');
      assert.equal(bob.lastSeen, null);
      assert.equal(bob.tokens.length, 1);

      const grace = body.members.find((m) => m.name === 'grace');
      assert.ok(grace, 'a presence-only member (no token created through this console) must appear too');
      assert.equal(grace.tokens.length, 0);
      assert.equal(grace.lastSeen.stale, false);
    }
  );
});

// --- log scrubbing (G8.6's own acceptance criterion) --------------------------------------------------------

test('nothing token-shaped ever appears in captured BFF logs, across create/list/revoke/rotate', async () => {
  await withConsole(ADMIN_ENV, ADMIN_RELATA, async ({ consoleUrl, logLines }) => {
    const create = await call(`${consoleUrl}/api/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'scrub-token', owner: 'carol' }) }, 'admin-token');
    await call(`${consoleUrl}/api/tokens`, {}, 'admin-token');
    await call(`${consoleUrl}/api/tokens/scrub-token`, { method: 'DELETE' }, 'admin-token');
    await call(`${consoleUrl}/api/tokens/self/rotate`, { method: 'POST' }, 'member-token');

    const fullLog = logLines.join('\n');
    // Every real credential this test exercised, and the fake's own generated secret value.
    const sensitiveValues = ['admin-token', 'admin-secret-value', 'member-token', create.body.token, 'rotated-member-token'];
    for (const value of sensitiveValues) {
      assert.ok(!fullLog.includes(value), `log output must never contain "${value}"`);
    }
    // The log lines themselves must be real, not empty — this test proves absence-of-leak, not absence-of-logging.
    assert.ok(logLines.length >= 4, 'expected at least one log line per request made');
  });
});

test('scrubbedRequestLine never logs headers or a response body — it only ever has method/path/query/status/duration in scope', async () => {
  const { scrubbedRequestLine } = await import('../server/logging.js');
  const req = { method: 'GET', url: '/api/board?remote=x&auth_token=leaked-secret-value' };
  const line = scrubbedRequestLine(req, 200, 5);
  assert.doesNotMatch(line, /leaked-secret-value/, 'a token-shaped query param must be redacted');
  assert.match(line, /redacted/); // URLSearchParams percent-encodes the brackets ([ -> %5B), so match loosely
});

// --- live: revoke actually kills a token's ability to authenticate --------------------------------------

test('live: revoking a real token makes it immediately fail to authenticate — what actually stops a daemon\'s next sync', async (t) => {
  if (!process.env.RELATA_TEST_URL || !process.env.RELATA_TEST_ADMIN_TOKEN) {
    t.skip('RELATA_TEST_URL/RELATA_TEST_ADMIN_TOKEN not set — no live RelataDB admin credential configured for this run');
    return;
  }
  // The issue's own wording ("their daemon's live sync stops within ~15s — the engine re-auths streams on
  // that interval") describes SSE reconnection specifically. G3.3 already established, against a real
  // instance, that /graph/changes never emits a single frame on this engine profile — there is no live SSE
  // connection to re-auth on any interval here. What IS real and independently verifiable: a revoked token
  // immediately fails to authenticate ANY new request — which is what actually halts the interval-reconcile
  // fallback (G3.5's startIntervalReconcile), the mechanism this project's own findings already established
  // as the one a real single-node deployment actually relies on. This test proves that property directly,
  // rather than a ~15s SSE claim this engine profile cannot exercise.
  const url = process.env.RELATA_TEST_URL;
  const adminToken = process.env.RELATA_TEST_ADMIN_TOKEN;
  const id = `g8-6-live-revoke-${Date.now()}`;

  const created = await request({ url, token: adminToken }, { method: 'POST', path: '/tokens', body: { id } });
  const newToken = created?.token ?? created?.value ?? created?.secret;
  assert.ok(newToken, 'token creation must return a usable value to proceed with this test');

  // Proves the new token actually works before revoking it — otherwise a 401 after revoke would be meaningless.
  await assert.doesNotReject(() => request({ url, token: newToken }, { method: 'POST', path: '/query', body: { sql: 'SELECT 1', purpose: 'fleetsmith_g8_6_live' } }));

  await request({ url, token: adminToken }, { method: 'DELETE', path: `/tokens/${encodeURIComponent(id)}` });

  await assert.rejects(
    () => request({ url, token: newToken }, { method: 'POST', path: '/query', body: { sql: 'SELECT 1', purpose: 'fleetsmith_g8_6_live' } }),
    (e) => e instanceof RelataHttpError && (e.status === 401 || e.status === 403),
    'a revoked token must fail to authenticate immediately — this is what actually stops the next sync cycle'
  );
});
