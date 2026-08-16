// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';
import { fakeRelata } from './fake-relata.js';
import { _resetForTests as resetTokens } from '../server/routes/tokens.js';

const REMOTE = 'git@github.com:acme/widgets.git';

/** Boots BOTH a fake RelataDB and a real console server (the actual product, not a unit under test) wired to it — the same "test the actual product entry point" discipline this project's own memory of G5.5 already established. */
async function withConsole(consoleEnv, relataOpts, fn) {
  const { server: relataServer, requests } = fakeRelata(relataOpts);
  await new Promise((resolve) => relataServer.listen(0, '127.0.0.1', resolve));
  const relataUrl = `http://127.0.0.1:${relataServer.address().port}`;

  const { server, consoleConfig } = createServer({ RELATA_URL: relataUrl, ...consoleEnv });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const consoleUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    await fn({ consoleUrl, relataUrl, requests, consoleConfig });
  } finally {
    resetTokens();
    server.closeAllConnections?.();
    relataServer.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => relataServer.close(resolve));
  }
}

function fetchJson(url, opts = {}) {
  return fetch(url, opts).then(async (res) => ({ status: res.status, body: await res.json() }));
}

const AUTH = (token) => ({ headers: { Authorization: `Bearer ${token}` } });

// --- authn: every route but /api/health requires a valid token -------------------------------------------

test('GET /api/health requires no token at all — the one deliberately public route', async () => {
  await withConsole({}, {}, async ({ consoleUrl }) => {
    const { status, body } = await fetchJson(`${consoleUrl}/api/health`);
    assert.equal(status, 200);
    assert.equal(body.reachable, true);
  });
});

test('every non-health route 401s with no Authorization header at all', async () => {
  await withConsole({}, {}, async ({ consoleUrl }) => {
    for (const [method, path] of [
      ['GET', `/api/board?remote=${encodeURIComponent(REMOTE)}`],
      ['GET', '/api/audit'],
      ['GET', '/api/knowledge?q=x'],
      ['GET', '/api/procedures?q=x'],
      ['GET', `/api/equip/demo/scout?remote=${encodeURIComponent(REMOTE)}`],
      ['GET', '/api/tokens'],
    ]) {
      const { status } = await fetchJson(`${consoleUrl}${path}`, { method });
      assert.equal(status, 401, `${method} ${path} must 401 with no token`);
    }
  });
});

test('a token the cortex rejects gets 401, not a fan-out attempt', async () => {
  await withConsole({}, {}, async ({ consoleUrl }) => {
    const { status } = await fetchJson(`${consoleUrl}/api/board?remote=${encodeURIComponent(REMOTE)}`, AUTH('nonsense-token'));
    assert.equal(status, 401);
  });
});

// --- authz: admin-only routes reject a member token, server-side, before any fan-out -----------------------

test('member token gets 403 on every admin-only route — this is G8.1\'s own acceptance criterion, ahead of the full G8.8 suite', async () => {
  await withConsole(
    { CONSOLE_ADMINS: 'alice', RELATA_ADMIN_TOKEN: 'admin-secret' },
    { tokensSelf: (t) => (t === 'member-token' ? { present: true, principal: 'mallory' } : { present: false }) },
    async ({ consoleUrl }) => {
      const memberAuth = AUTH('member-token');
      const cases = [
        ['POST', '/api/knowledge/abc123/approve', {}],
        ['PUT', `/api/equip/demo/scout?remote=${encodeURIComponent(REMOTE)}`, { memory_scopes: [] }],
        ['GET', '/api/tokens', undefined],
        ['POST', '/api/tokens', { id: 'new-token' }],
        ['DELETE', '/api/tokens/some-id', undefined],
      ];
      for (const [method, path, body] of cases) {
        const { status } = await fetchJson(`${consoleUrl}${path}`, {
          method,
          ...memberAuth,
          ...(body !== undefined ? { headers: { ...memberAuth.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
        });
        assert.equal(status, 403, `${method} ${path} must 403 for a member token`);
      }
    }
  );
});

test('a member token with NO discoverable principal at all also 403s on admin routes — fails closed, not open', async () => {
  await withConsole({ CONSOLE_ADMINS: 'alice' }, { tokensSelf: () => ({ present: false }) }, async ({ consoleUrl }) => {
    const { status } = await fetchJson(`${consoleUrl}/api/tokens`, AUTH('member-token'));
    assert.equal(status, 403);
  });
});

test('an admin token (principal listed in CONSOLE_ADMINS) is accepted on an admin route', async () => {
  await withConsole(
    { CONSOLE_ADMINS: 'alice', RELATA_ADMIN_TOKEN: 'admin-secret' },
    { tokensSelf: (t) => (t === 'admin-token' ? { present: true, principal: 'alice' } : { present: false }) },
    async ({ consoleUrl }) => {
      const { status, body } = await fetchJson(`${consoleUrl}/api/tokens`, AUTH('admin-token'));
      assert.equal(status, 200);
      assert.deepEqual(body.tokens, []);
    }
  );
});

// --- board (G8.2) -----------------------------------------------------------------------------------------

test('GET /api/board requires ?remote, groups tasks/presence by actor, and computes overlaps', async () => {
  const repoIdOf = await import('../server/repo.js').then((m) => m.repoIdFromRemote(REMOTE));
  await withConsole(
    {},
    {
      queryRows: {
        FleetTask: [
          { repo_id: repoIdOf, actor: 'ada', task_seq: 1, task: 't1', status: 'in-progress', artifact: 'x.md', depends_on: [] },
          { repo_id: repoIdOf, actor: 'grace', task_seq: 1, task: 't2', status: 'in-progress', artifact: 'x.md', depends_on: [] },
        ],
        ActorPresence: [{ repo_id: repoIdOf, actor: 'ada', run_id: 'r1', heartbeat_at: new Date().toISOString() }],
      },
    },
    async ({ consoleUrl }) => {
      const { status, body } = await fetchJson(`${consoleUrl}/api/board?remote=${encodeURIComponent(REMOTE)}`, AUTH('member-token'));
      assert.equal(status, 200);
      assert.deepEqual(
        body.actors.map((a) => a.actor),
        ['ada', 'grace']
      );
      assert.equal(body.actors.find((a) => a.actor === 'ada').presence.stale, false);
      assert.equal(body.overlaps.length, 1);
      assert.equal(body.overlaps[0].kind, 'artifact');
    }
  );
});

test('GET /api/board without ?remote is a 400, not a crash', async () => {
  await withConsole({}, {}, async ({ consoleUrl }) => {
    const { status } = await fetchJson(`${consoleUrl}/api/board`, AUTH('member-token'));
    assert.equal(status, 400);
  });
});

// --- audit (G8.3) -----------------------------------------------------------------------------------------

test('GET /api/audit forwards filters and returns the cortex\'s entries', async () => {
  await withConsole({}, { auditEntries: [{ timestamp: 't', actor: 'ada', action: 'recall', purpose: 'p', object: 'o' }] }, async ({ consoleUrl, requests }) => {
    const { status, body } = await fetchJson(`${consoleUrl}/api/audit?actor=ada&limit=5`, AUTH('member-token'));
    assert.equal(status, 200);
    assert.equal(body.entries.length, 1);
    const auditReq = requests.find((r) => r.pathname === '/audit/entries');
    assert.equal(auditReq.query.actor, 'ada');
    assert.equal(auditReq.query.limit, '5');
  });
});

test('GET /api/audit/why requires ?id', async () => {
  await withConsole({}, {}, async ({ consoleUrl }) => {
    const { status } = await fetchJson(`${consoleUrl}/api/audit/why`, AUTH('member-token'));
    assert.equal(status, 400);
  });
});

// --- knowledge & procedures (G8.4) -------------------------------------------------------------------------

test('GET /api/procedures is read-only and says so — no approval mechanism exists for procedural memory', async () => {
  await withConsole({}, { recallRows: [{ id: '1', score: 0.9, content: JSON.stringify({ kind: 'lesson', text: 'reuse me', origin: 'human', evidence: [] }) }] }, async ({ consoleUrl }) => {
    const { status, body } = await fetchJson(`${consoleUrl}/api/procedures?q=reuse`, AUTH('member-token'));
    assert.equal(status, 200);
    assert.match(body.note, /read-only/);
  });
});

test('POST /api/knowledge/:hash/propose requires a discoverable principal', async () => {
  await withConsole({}, { tokensSelf: () => ({ present: false }) }, async ({ consoleUrl }) => {
    const { status, body } = await fetchJson(`${consoleUrl}/api/knowledge/abc123/propose`, { method: 'POST', ...AUTH('member-token') });
    assert.equal(status, 403);
    assert.match(body.error, /discoverable principal/);
  });
});

test('a fully-wired propose call transitions the OrgDocument row via the caller\'s own token', async () => {
  const contentHash = 'hash-1';
  await withConsole(
    {},
    {
      tokensSelf: (t) => (t === 'member-token' ? { present: true, principal: 'ada' } : { present: false }),
      queryRows: { OrgDocument: [{ repo_id: 'r', content_hash: contentHash, title: 'Doc', kind: 'spec', chunk_index: 0, chunk_text: 'x' }] },
    },
    async ({ consoleUrl, requests }) => {
      const { status, body } = await fetchJson(`${consoleUrl}/api/knowledge/${contentHash}/propose`, { method: 'POST', ...AUTH('member-token') });
      assert.equal(status, 200);
      assert.equal(body.approval, 'proposed');
      const ingest = requests.find((r) => r.pathname === '/ingest');
      assert.equal(ingest.token, 'member-token', 'the mutation must be attributed to the CALLER\'s own token, not a service token');
    }
  );
});

// --- equip (G8.5) ------------------------------------------------------------------------------------------

test('GET /api/equip returns a default, unrestricted scope when none has been saved yet', async () => {
  await withConsole({}, {}, async ({ consoleUrl }) => {
    const { status, body } = await fetchJson(`${consoleUrl}/api/equip/demo/scout?remote=${encodeURIComponent(REMOTE)}`, AUTH('member-token'));
    assert.equal(status, 200);
    assert.equal(body.scope, null);
    assert.deepEqual(body.compiled, { purposes: [], approvedOnly: false });
  });
});

test('PUT /api/equip requires admin, validates purposes, and ingests under the caller\'s own token', async () => {
  await withConsole(
    { CONSOLE_ADMINS: 'alice' },
    { tokensSelf: (t) => (t === 'admin-token' ? { present: true, principal: 'alice' } : { present: false }) },
    async ({ consoleUrl, requests }) => {
      const { status, body } = await fetchJson(`${consoleUrl}/api/equip/demo/scout?remote=${encodeURIComponent(REMOTE)}`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ knowledge_purposes: ['product_context'], approved_only: true }),
      });
      assert.equal(status, 200);
      assert.deepEqual(body.compiled, { purposes: ['product_context'], approvedOnly: true });
      assert.equal(body.scope.updated_by, 'alice');
      const ingest = requests.find((r) => r.pathname === '/ingest');
      assert.equal(ingest.token, 'admin-token');
    }
  );
});

test('PUT /api/equip rejects an unknown purpose before any network call', async () => {
  await withConsole(
    { CONSOLE_ADMINS: 'alice' },
    { tokensSelf: (t) => (t === 'admin-token' ? { present: true, principal: 'alice' } : { present: false }) },
    async ({ consoleUrl, requests }) => {
      const { status } = await fetchJson(`${consoleUrl}/api/equip/demo/scout?remote=${encodeURIComponent(REMOTE)}`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ knowledge_purposes: ['not_a_real_purpose'] }),
      });
      assert.equal(status, 400);
      assert.ok(!requests.some((r) => r.pathname === '/ingest'), 'must reject before ever reaching /ingest');
    }
  );
});

// --- tokens (G8.6) -----------------------------------------------------------------------------------------

test('POST /api/tokens without RELATA_ADMIN_TOKEN configured returns 503, not a crash', async () => {
  await withConsole({ CONSOLE_ADMINS: 'alice' }, { tokensSelf: (t) => (t === 'admin-token' ? { present: true, principal: 'alice' } : { present: false }) }, async ({ consoleUrl }) => {
    const { status } = await fetchJson(`${consoleUrl}/api/tokens`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'new-token' }),
    });
    assert.equal(status, 503);
  });
});

test('a full create -> list -> revoke cycle, using the server-held admin secret, never the caller\'s own token', async () => {
  await withConsole(
    { CONSOLE_ADMINS: 'alice', RELATA_ADMIN_TOKEN: 'admin-secret-value' },
    { tokensSelf: (t) => (t === 'admin-token' ? { present: true, principal: 'alice' } : { present: false }), adminToken: 'admin-secret-value' },
    async ({ consoleUrl, requests }) => {
      const create = await fetchJson(`${consoleUrl}/api/tokens`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'new-token', owner: 'bob' }),
      });
      assert.equal(create.status, 201);
      assert.equal(create.body.token, 'secret-new-token');
      const createReq = requests.find((r) => r.pathname === '/tokens' && r.method === 'POST');
      assert.equal(createReq.token, 'admin-secret-value', 'token CRUD must use the console\'s own admin secret, never the caller\'s bearer token');

      const list = await fetchJson(`${consoleUrl}/api/tokens`, { headers: { Authorization: 'Bearer admin-token' } });
      assert.equal(list.body.tokens.length, 1);
      assert.equal(list.body.tokens[0].owner, 'bob');
      assert.match(list.body.note, /no list-all-tokens endpoint/);

      const revoke = await fetchJson(`${consoleUrl}/api/tokens/new-token`, { method: 'DELETE', headers: { Authorization: 'Bearer admin-token' } });
      assert.equal(revoke.status, 200);

      const listAfter = await fetchJson(`${consoleUrl}/api/tokens`, { headers: { Authorization: 'Bearer admin-token' } });
      assert.equal(listAfter.body.tokens.length, 0);
    }
  );
});

// --- health (G8.7) -----------------------------------------------------------------------------------------

test('GET /api/health reports reachable:false, not a 5xx, when the cortex cannot be reached', async () => {
  const { server, consoleConfig } = createServer({ RELATA_URL: 'http://127.0.0.1:1' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { status, body } = await fetchJson(`http://127.0.0.1:${server.address().port}/api/health`);
    assert.equal(status, 200);
    assert.equal(body.reachable, false);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  void consoleConfig;
});
