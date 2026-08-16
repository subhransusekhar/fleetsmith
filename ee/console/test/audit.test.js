// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server/index.js';
import { fakeRelata } from './fake-relata.js';

const WEB_DIR = fileURLToPath(new URL('../web', import.meta.url));

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

function fetchJson(url, token) {
  return fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

const ENTRIES = [
  { timestamp: 't1', actor: 'ada', action: 'recall', purpose: 'product_context', object: 'obj-1' },
  { timestamp: 't2', actor: 'grace', action: 'recall', purpose: 'product_context', object: 'obj-2' },
];

// --- G8.3's own access rule: member self-only, server-forced, tampered params don't escape it ----------------

test('a member token only ever sees their own entries, even when ?actor= names someone else', async () => {
  await withConsole(
    {},
    { auditEntries: ENTRIES, tokensSelf: (t) => (t === 'member-token' ? { present: true, principal: 'ada' } : { present: false }) },
    async ({ consoleUrl }) => {
      const { status, body } = await fetchJson(`${consoleUrl}/api/audit?actor=grace`, 'member-token');
      assert.equal(status, 200);
      assert.deepEqual(
        body.entries.map((e) => e.actor),
        ['ada']
      );
      assert.equal(body.selfOnly, true);
    }
  );
});

test('an admin token sees every actor, ?actor= filter honored as given', async () => {
  await withConsole(
    { CONSOLE_ADMINS: 'alice' },
    { auditEntries: ENTRIES, tokensSelf: (t) => (t === 'admin-token' ? { present: true, principal: 'alice' } : { present: false }) },
    async ({ consoleUrl }) => {
      const all = await fetchJson(`${consoleUrl}/api/audit`, 'admin-token');
      assert.equal(all.body.entries.length, 2);
      assert.equal(all.body.selfOnly, false);

      const filtered = await fetchJson(`${consoleUrl}/api/audit?actor=grace`, 'admin-token');
      assert.deepEqual(
        filtered.body.entries.map((e) => e.actor),
        ['grace']
      );
    }
  );
});

test('a member token with no discoverable principal at all is refused (403), not silently shown zero or everything', async () => {
  await withConsole({}, { auditEntries: ENTRIES, tokensSelf: () => ({ present: false }) }, async ({ consoleUrl }) => {
    const { status, body } = await fetchJson(`${consoleUrl}/api/audit`, 'member-token');
    assert.equal(status, 403);
    assert.match(body.error, /discoverable principal/);
  });
});

test('getAuditWhy is not actor-restricted — it answers "why does this id exist", not scoped to a caller\'s own rows', async () => {
  await withConsole({}, { justifyResult: { found: true }, recognizeResult: JSON.stringify({ text: 'x', evidence: [], origin: 'human' }) }, async ({ consoleUrl }) => {
    const { status } = await fetchJson(`${consoleUrl}/api/audit/why?id=some-id`, 'member-token');
    assert.equal(status, 200);
  });
});

// --- the web page itself: read-only, and the CSV export matches the visible columns --------------------------

test('audit.html makes no mutating fetch call — every request is a GET to /api/audit or /api/audit/why', () => {
  const html = fs.readFileSync(path.join(WEB_DIR, 'audit.html'), 'utf8');
  assert.doesNotMatch(html, /method:\s*['"](POST|PUT|DELETE)['"]/i);
  for (const m of html.matchAll(/fetch\(([^)]*)\)/g)) {
    assert.match(m[1], /\/api\/audit/, `unexpected fetch target in the audit page: ${m[1]}`);
  }
});

test('audit.html\'s CSV export uses the same five columns the table renders, so it matches the visible filter by construction', () => {
  const html = fs.readFileSync(path.join(WEB_DIR, 'audit.html'), 'utf8');
  const csvHeader = /const header = \[(.*?)\];/.exec(html)?.[1];
  assert.ok(csvHeader, 'expected a `header` array in the CSV-building code');
  const columns = csvHeader.split(',').map((s) => s.trim().replace(/['"]/g, ''));
  assert.deepEqual(columns, ['timestamp', 'actor', 'action', 'purpose', 'object']);
  // The export button never re-fetches — it serializes `currentEntries`, the same array `renderRows()` just
  // painted, so a client-side filter round-trip can never disagree with what CSV.
  assert.match(html, /toCsv\(currentEntries\)/);
});
