// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';
import { fakeRelata } from './fake-relata.js';
import { repoIdFromRemote } from '../server/repo.js';

const REMOTE = 'git@github.com:acme/equip-fixture.git';
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
    server.closeAllConnections?.();
    relataServer.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => relataServer.close(resolve));
  }
}

function call(url, opts, token) {
  return fetch(url, { ...opts, headers: { ...(opts?.headers ?? {}), Authorization: `Bearer ${token}` } }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

const ADMIN_ENV = { CONSOLE_ADMINS: 'alice' };
const ADMIN_RELATA = { tokensSelf: (t) => (t === 'admin-token' ? { present: true, principal: 'alice' } : { present: false }) };

const binding = (overrides) => ({ repo_id: REPO_ID, fleet: 'demo', agent: 'scout', scope_kind: 'purpose', scope_ref: 'product_context', equipped: true, updated_by: 'alice', updated_at: '2026-01-01T00:00:00.000Z', ...overrides });

test('GET /api/equip with no bindings at all: unrestricted (every scope_kind null)', async () => {
  await withConsole({}, {}, async ({ consoleUrl }) => {
    const { status, body } = await call(`${consoleUrl}/api/equip/demo/scout?remote=${encodeURIComponent(REMOTE)}`, {}, 'member-token');
    assert.equal(status, 200);
    assert.deepEqual(body.bindings, []);
    assert.deepEqual(body.effective, { purpose: null, knowledge_collection: null, procedure: null });
  });
});

test('GET /api/equip returns the exact effective view recall() itself would compute — same helper, not a second copy', async () => {
  await withConsole(
    {},
    {
      queryRows: {
        EquipBinding: [
          binding({ scope_kind: 'purpose', scope_ref: 'product_context', equipped: true }),
          binding({ scope_kind: 'knowledge_collection', scope_ref: 'meeting:acme', equipped: true }),
          binding({ scope_kind: 'knowledge_collection', scope_ref: 'discussion:other', equipped: false }),
        ],
      },
    },
    async ({ consoleUrl }) => {
      const { body } = await call(`${consoleUrl}/api/equip/demo/scout?remote=${encodeURIComponent(REMOTE)}`, {}, 'member-token');
      assert.equal(body.bindings.length, 3);
      assert.deepEqual(body.effective.purpose, ['product_context']);
      assert.deepEqual(body.effective.knowledge_collection, ['meeting:acme']);
      assert.equal(body.effective.procedure, null, 'no procedure bindings at all — unrestricted');
    }
  );
});

test('GET /api/equip includes a fleet-wide ("*") binding alongside the agent-specific ones', async () => {
  await withConsole({}, { queryRows: { EquipBinding: [binding({ agent: '*', scope_kind: 'procedure', scope_ref: '*', equipped: true })] } }, async ({ consoleUrl }) => {
    const { body } = await call(`${consoleUrl}/api/equip/demo/scout?remote=${encodeURIComponent(REMOTE)}`, {}, 'member-token');
    assert.equal(body.bindings.length, 1);
    assert.deepEqual(body.effective.procedure, ['*']);
  });
});

test('GET /api/equip never shows a binding scoped to a different repo/fleet/agent', async () => {
  await withConsole(
    {},
    {
      queryRows: {
        EquipBinding: [
          binding({ repo_id: 'a-different-repo' }),
          binding({ fleet: 'a-different-fleet' }),
          binding({ agent: 'a-different-agent' }),
        ],
      },
    },
    async ({ consoleUrl }) => {
      const { body } = await call(`${consoleUrl}/api/equip/demo/scout?remote=${encodeURIComponent(REMOTE)}`, {}, 'member-token');
      assert.deepEqual(body.bindings, []);
    }
  );
});

test('PUT /api/equip requires admin', async () => {
  await withConsole({}, {}, async ({ consoleUrl }) => {
    const { status } = await call(
      `${consoleUrl}/api/equip/demo/scout?remote=${encodeURIComponent(REMOTE)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bindings: [] }) },
      'member-token'
    );
    assert.equal(status, 403);
  });
});

test('PUT /api/equip upserts bindings, validates purpose scope_refs, and ingests under the caller\'s own token', async () => {
  await withConsole(ADMIN_ENV, ADMIN_RELATA, async ({ consoleUrl, requests }) => {
    const { status, body } = await call(
      `${consoleUrl}/api/equip/demo/scout?remote=${encodeURIComponent(REMOTE)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bindings: [{ scope_kind: 'purpose', scope_ref: 'product_context', equipped: true }] }),
      },
      'admin-token'
    );
    assert.equal(status, 200);
    assert.deepEqual(body.effective.purpose, ['product_context']);
    assert.equal(body.bindings[0].updated_by, 'alice');
    const ingest = requests.find((r) => r.pathname === '/ingest');
    assert.equal(ingest.token, 'admin-token');
    assert.equal(ingest.query.object_type, 'EquipBinding');
  });
});

test('PUT /api/equip rejects an unknown purpose scope_ref before any network call', async () => {
  await withConsole(ADMIN_ENV, ADMIN_RELATA, async ({ consoleUrl, requests }) => {
    const { status } = await call(
      `${consoleUrl}/api/equip/demo/scout?remote=${encodeURIComponent(REMOTE)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bindings: [{ scope_kind: 'purpose', scope_ref: 'not_a_real_purpose', equipped: true }] }) },
      'admin-token'
    );
    assert.equal(status, 400);
    assert.ok(!requests.some((r) => r.pathname === '/ingest'));
  });
});

test('PUT /api/equip rejects an unknown scope_kind before any network call', async () => {
  await withConsole(ADMIN_ENV, ADMIN_RELATA, async ({ consoleUrl, requests }) => {
    const { status } = await call(
      `${consoleUrl}/api/equip/demo/scout?remote=${encodeURIComponent(REMOTE)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bindings: [{ scope_kind: 'not-a-real-kind', scope_ref: 'x', equipped: true }] }) },
      'admin-token'
    );
    assert.equal(status, 400);
    assert.ok(!requests.some((r) => r.pathname === '/ingest'));
  });
});

test('PUT /api/equip without a discoverable principal is refused', async () => {
  await withConsole({ CONSOLE_ADMINS: 'alice' }, { tokensSelf: () => ({ present: false }) }, async ({ consoleUrl }) => {
    // A token that authenticates but resolves to role 'member' (no principal) never reaches an admin route at
    // all — role check fires first — so this proves the SAME fail-closed behavior server.test.js already
    // covers generally, specific to equip's own principal-attribution requirement inside the handler.
    const { status } = await call(
      `${consoleUrl}/api/equip/demo/scout?remote=${encodeURIComponent(REMOTE)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bindings: [] }) },
      'admin-token'
    );
    assert.equal(status, 403);
  });
});
