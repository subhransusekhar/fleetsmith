// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from '../server/index.js';
import { fakeRelata } from './fake-relata.js';
import { repoIdFromRemote } from '../server/repo.js';
import { OVERLAP_RESPONSE } from '../../src/grid/overlaps-render.js';
import { ingestRows, resolveRepoId } from '../../src/grid/ontology.js';

const REMOTE = 'git@github.com:acme/board-fixture.git';
const REPO_ID = repoIdFromRemote(REMOTE);

async function withConsole(relataOpts, fn) {
  const { server: relataServer, requests } = fakeRelata(relataOpts);
  await new Promise((resolve) => relataServer.listen(0, '127.0.0.1', resolve));
  const relataUrl = `http://127.0.0.1:${relataServer.address().port}`;
  const { server } = createServer({ RELATA_URL: relataUrl });
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

function fetchJson(url, token = 'member-token') {
  return fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

// --- G8.2's own two-actor fixture (fake cortex — always runs; the live-gated proof is below) ---------------

test('board shows both actors from a two-actor fixture: tasks, presence, staleness', async () => {
  const now = Date.now();
  const fresh = new Date(now - 60_000).toISOString(); // 1 minute ago — well inside the 15-minute TTL
  const old = new Date(now - 20 * 60_000).toISOString(); // 20 minutes ago — past it

  await withConsole(
    {
      queryRows: {
        FleetTask: [
          { repo_id: REPO_ID, actor: 'ada', task_seq: 1, task: 'build the thing', status: 'in-progress', artifact: '', depends_on: [], files_declared: ['a.js'], symbols_declared: [] },
          { repo_id: REPO_ID, actor: 'grace', task_seq: 1, task: 'review the thing', status: 'done', artifact: '', depends_on: [], files_declared: [], symbols_declared: [] },
        ],
        ActorPresence: [
          { repo_id: REPO_ID, actor: 'ada', run_id: 'r1', branch: 'ada/feature', heartbeat_at: fresh },
          { repo_id: REPO_ID, actor: 'grace', run_id: 'r2', branch: 'grace/feature', heartbeat_at: old },
        ],
      },
    },
    async ({ consoleUrl }) => {
      const { status, body } = await fetchJson(`${consoleUrl}/api/board?remote=${encodeURIComponent(REMOTE)}`);
      assert.equal(status, 200);
      assert.deepEqual(
        body.actors.map((a) => a.actor),
        ['ada', 'grace']
      );
      const ada = body.actors.find((a) => a.actor === 'ada');
      const grace = body.actors.find((a) => a.actor === 'grace');
      assert.equal(ada.presence.stale, false, 'a heartbeat inside the TTL must read as active');
      assert.equal(grace.presence.stale, true, 'a heartbeat past the TTL must flip to stale');
      assert.equal(ada.tasks.filter((t) => t.status === 'in-progress').length, 1);
      assert.equal(grace.tasks.filter((t) => t.status === 'in-progress').length, 0, 'a done task is not in-progress');
    }
  );
});

test('overlap panel\'s suggested-response text is the SAME text grid overlaps (the CLI) renders — imported, not re-typed', async () => {
  await withConsole(
    {
      queryRows: {
        FleetTask: [
          { repo_id: REPO_ID, actor: 'ada', task_seq: 1, task: 't1', status: 'in-progress', artifact: 'shared.md', depends_on: [] },
          { repo_id: REPO_ID, actor: 'grace', task_seq: 1, task: 't2', status: 'in-progress', artifact: 'shared.md', depends_on: [] },
        ],
      },
    },
    async ({ consoleUrl }) => {
      const { body } = await fetchJson(`${consoleUrl}/api/board?remote=${encodeURIComponent(REMOTE)}`);
      assert.equal(body.overlaps.length, 1);
      assert.equal(body.overlaps[0].kind, 'artifact');
      assert.equal(body.overlaps[0].response, OVERLAP_RESPONSE.artifact);
    }
  );
});

test('cross-actor dependency edges render as "@actor#seq -> @dep"', async () => {
  await withConsole(
    {
      queryRows: {
        FleetTask: [{ repo_id: REPO_ID, actor: 'ada', task_seq: 3, task: 't', status: 'in-progress', artifact: '', depends_on: ['@grace#1'] }],
      },
    },
    async ({ consoleUrl }) => {
      const { body } = await fetchJson(`${consoleUrl}/api/board?remote=${encodeURIComponent(REMOTE)}`);
      assert.deepEqual(body.crossActorDeps, ['@ada#3 → @grace#1']);
    }
  );
});

test('board reports risks as empty with an explanatory note — merge-risk analysis needs a git checkout this stateless console does not have', async () => {
  await withConsole({}, async ({ consoleUrl }) => {
    const { body } = await fetchJson(`${consoleUrl}/api/board?remote=${encodeURIComponent(REMOTE)}`);
    assert.deepEqual(body.risks, []);
    assert.match(body.risksNote, /git checkout/);
  });
});

// --- live-gated two-actor proof, same gating convention as ee/test/grid-e2e.test.js (G3.7) -------------------

test('live: the console\'s own /api/board shows two independently-pushed actors, against a real RelataDB', async (t) => {
  if (!process.env.RELATA_TEST_URL) {
    t.skip('RELATA_TEST_URL not set — no live RelataDB configured for this run');
    return;
  }
  const config = { url: process.env.RELATA_TEST_URL, token: process.env.RELATA_TEST_TOKEN ?? '', purposes: ['fleetsmith_g8_2_live'] };
  // This checkout's own real git remote — repoIdFromRemote() (the route) and resolveRepoId() (used to seed
  // the rows below) both hash through the SAME normalizeRemoteUrl(), so passing the raw remote URL as the
  // route's own ?remote= query param produces the identical repo_id without needing to guess or duplicate it.
  const remoteUrl = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
  const repoId = resolveRepoId(process.cwd());
  const now = new Date().toISOString();
  const actorSuffix = Date.now();
  const alice = `g8-2-live-alice-${actorSuffix}`;
  const bob = `g8-2-live-bob-${actorSuffix}`;

  await ingestRows(config, 'FleetTask', [
    { repo_id: repoId, actor: alice, task_seq: 1, task: 'live board task', status: 'in-progress', artifact: '', depends_on: [], files_declared: [], symbols_declared: [], branch: 'main', purpose: 'fleetsmith_g8_2_live', origin: 'human' },
  ]);
  await ingestRows(config, 'ActorPresence', [
    { repo_id: repoId, actor: bob, run_id: `live-run-${actorSuffix}`, branch: 'main', started_at: now, heartbeat_at: now, ended_at: '', purpose: 'fleetsmith_g8_2_live', origin: 'human' },
  ]);

  const { server } = createServer({ RELATA_URL: config.url });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const consoleUrl = `http://127.0.0.1:${server.address().port}`;
    const { status, body } = await fetchJson(`${consoleUrl}/api/board?remote=${encodeURIComponent(remoteUrl)}`, config.token);
    assert.equal(status, 200);
    const actors = body.actors.map((a) => a.actor);
    assert.ok(actors.includes(alice), 'alice\'s pushed FleetTask row must be visible on the board');
    assert.ok(actors.includes(bob), 'bob\'s pushed ActorPresence row must be visible on the board');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
