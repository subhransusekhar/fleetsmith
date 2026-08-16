// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { materialize, renderPeerLedger, renderPresence, renderHandoffsList, renderGridRollup } from '../src/grid/materialize.js';
import { ledgerToTasks } from '../src/grid/project.js';

function tempLocalDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-materialize-test-'));
}

const NOW = Date.parse('2026-08-16T12:00:00Z');

function row(typeName, fields) {
  return { typeName, row: { repo_id: 'repo1', purpose: 'grid_sync', origin: 'human', branch: 'main', ...fields } };
}

// --- renderPeerLedger ----------------------------------------------------------

test('renderPeerLedger produces the same table shape the local ledger template uses, and its output parses with ledgerToTasks (G2.2)', () => {
  const tasks = [
    { actor: 'bob', task_seq: 2, task: 'implement feature', status: 'in-progress', depends_on: ['1'], artifact: 'handoffs/02.md', files_declared: [], symbols_declared: [] },
    { actor: 'bob', task_seq: 1, task: 'analyze requirements', status: 'done', depends_on: [], artifact: '', files_declared: [], symbols_declared: [] },
  ];
  const md = renderPeerLedger('bob', tasks);
  assert.match(md, /\| # \| Task \| Owner \| Depends on \| Status \| Artifact \|/);

  const { tasks: parsed, warnings } = ledgerToTasks(md, { repoId: 'r', actor: 'bob', branch: 'main' });
  assert.deepEqual(warnings, []);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map((t) => t.task_seq).sort(), [1, 2]);
  assert.equal(parsed.find((t) => t.task_seq === 1).status, 'done');
  assert.equal(parsed.find((t) => t.task_seq === 2).depends_on[0], '1');
});

test('renderPeerLedger dedupes by task_seq, last write wins, sorted by task_seq', () => {
  const tasks = [
    { actor: 'bob', task_seq: 1, task: 'first version', status: 'pending', depends_on: [], artifact: '' },
    { actor: 'bob', task_seq: 1, task: 'second version', status: 'done', depends_on: [], artifact: '' },
  ];
  const md = renderPeerLedger('bob', tasks);
  assert.equal((md.match(/\| 1 \|/g) ?? []).length, 1, 'only one row for task_seq 1');
  assert.match(md, /second version/);
  assert.doesNotMatch(md, /first version/);
});

test('renderPeerLedger renders "-" for empty depends_on/artifact', () => {
  const md = renderPeerLedger('bob', [{ actor: 'bob', task_seq: 1, task: 't', status: 'pending', depends_on: [], artifact: '' }]);
  assert.match(md, /\| 1 \| t \| bob \| - \| pending \| - \|/);
});

// --- renderPresence --------------------------------------------------------------

test('renderPresence carries the row verbatim plus a computed stale flag — fresh heartbeat is not stale', () => {
  const json = renderPresence([{ actor: 'bob', run_id: 'r1', branch: 'main', started_at: '2026-08-16T11:00:00Z', heartbeat_at: '2026-08-16T11:59:00Z' }], { now: NOW });
  const parsed = JSON.parse(json);
  assert.equal(parsed.stale, false);
  assert.equal(parsed.run_id, 'r1');
});

test('renderPresence marks a heartbeat older than the TTL as stale', () => {
  const json = renderPresence([{ actor: 'bob', run_id: 'r1', heartbeat_at: '2026-08-16T11:00:00Z' }], { now: NOW, staleTtlMs: 15 * 60 * 1000 });
  assert.equal(JSON.parse(json).stale, true);
});

test('renderPresence resolves multiple rows for one actor (repeated pushes) by last write wins', () => {
  const json = renderPresence(
    [
      { actor: 'bob', run_id: 'r1', heartbeat_at: '2026-08-16T10:00:00Z' },
      { actor: 'bob', run_id: 'r2', heartbeat_at: '2026-08-16T11:59:30Z' },
    ],
    { now: NOW }
  );
  const parsed = JSON.parse(json);
  assert.equal(parsed.run_id, 'r2');
  assert.equal(parsed.stale, false);
});

// --- renderHandoffsList --------------------------------------------------------

test('renderHandoffsList renders pointer/digest, never the handoff body, deduped by seq', () => {
  const md = renderHandoffsList('bob', [
    { seq: 1, from_agent: 'analyst', to_agent: 'builder', artifact: '01.md', criteria_digest: 'a'.repeat(64) },
    { seq: 1, from_agent: 'analyst', to_agent: 'builder', artifact: '01.md', criteria_digest: 'b'.repeat(64) },
  ]);
  assert.equal((md.match(/#1:/g) ?? []).length, 1);
  assert.match(md, /bbbbbbbbbbbb…/);
});

test('renderHandoffsList renders a placeholder when there are none', () => {
  assert.match(renderHandoffsList('bob', []), /\(no handoffs\)/);
});

// --- renderGridRollup ------------------------------------------------------------

test('renderGridRollup: header, per-actor in-progress tasks with truncated declared work, staleness, cross-actor deps', () => {
  const manySymbols = Array.from({ length: 15 }, (_, i) => `Symbol${i}`);
  const md = renderGridRollup({
    actors: [
      {
        actor: 'bob',
        presence: { heartbeat_at: '2026-08-16T11:59:00Z' },
        tasks: [
          { task_seq: 1, task: 'done task', status: 'done', depends_on: [] },
          { task_seq: 2, task: 'live task', status: 'in-progress', depends_on: ['@alice#3'], files_declared: ['a.js'], symbols_declared: manySymbols },
        ],
      },
      { actor: 'alice', presence: { heartbeat_at: '2026-08-16T10:00:00Z' }, tasks: [{ task_seq: 3, task: 'stale actor task', status: 'in-progress', depends_on: [] }] },
    ],
    syncedAt: '2026-08-16T12:00:00Z',
    now: NOW,
    staleTtlMs: 15 * 60 * 1000,
  });

  assert.match(md, /Active actors: 2/);
  assert.match(md, /## alice[\s\S]*_\(stale — last seen 2026-08-16T10:00:00Z\)_/);
  assert.match(md, /## bob[\s\S]*_\(active — last seen 2026-08-16T11:59:00Z\)_/);
  assert.doesNotMatch(md, /done task/, 'only in-progress tasks are listed');
  assert.match(md, /live task.*files: a\.js.*symbols: Symbol0.*\(\+5 more\)/);
  assert.match(md, /bob#2 depends on @alice#3/);
  // Deterministic ordering: alice (a) sorts before bob (b).
  assert.ok(md.indexOf('## alice') < md.indexOf('## bob'));
});

test('renderGridRollup shows "(no presence data)" for an actor with no ActorPresence row', () => {
  const md = renderGridRollup({ actors: [{ actor: 'bob', presence: null, tasks: [] }], syncedAt: 's', now: NOW });
  assert.match(md, /\(no presence data\)/);
});

test('renderGridRollup shows "(none)" when there are no cross-actor dependencies', () => {
  const md = renderGridRollup({ actors: [{ actor: 'bob', presence: null, tasks: [{ task_seq: 1, task: 't', status: 'pending', depends_on: ['1'] }] }], syncedAt: 's', now: NOW });
  assert.match(md, /## Cross-actor dependencies\n\(none\)/);
});

test('renderGridRollup shows "(none)" for Org-approved when no titles are given, and lists sorted titles when they are (G7.3)', () => {
  const empty = renderGridRollup({ actors: [], syncedAt: 's', now: NOW });
  assert.match(empty, /## Org-approved\n\n\(none\)/);

  const withTitles = renderGridRollup({ actors: [], syncedAt: 's', now: NOW, orgApprovedTitles: ['Zebra Doc', 'Alpha Doc'] });
  assert.match(withTitles, /## Org-approved\n\n- Alpha Doc\n- Zebra Doc/);
});

// --- materialize: orchestration, upsert semantics, determinism -----------------

test('materialize writes LEDGER.md/presence.json/handoffs.md per actor plus one GRID.md, and reports every path written', () => {
  const localDir = tempLocalDir();
  const newRows = [
    row('FleetTask', { actor: 'bob', task_seq: 1, task: 't1', status: 'pending', depends_on: [], artifact: '' }),
    row('ActorPresence', { actor: 'bob', run_id: 'r1', heartbeat_at: '2026-08-16T11:59:00Z' }),
    row('HandoffPointer', { actor: 'bob', seq: 1, from_agent: 'a', to_agent: 'b', artifact: 'x.md', criteria_digest: 'c'.repeat(64) }),
  ];
  const { written } = materialize(newRows, localDir, { now: NOW });

  assert.ok(fs.existsSync(path.join(localDir, 'grid', 'peers', 'bob', 'LEDGER.md')));
  assert.ok(fs.existsSync(path.join(localDir, 'grid', 'peers', 'bob', 'presence.json')));
  assert.ok(fs.existsSync(path.join(localDir, 'grid', 'peers', 'bob', 'handoffs.md')));
  assert.ok(fs.existsSync(path.join(localDir, 'grid', 'GRID.md')));
  assert.equal(written.length, 4);
});

test('materialize is upsert-only per actor — an actor absent from a later call keeps their existing files untouched', () => {
  const localDir = tempLocalDir();
  materialize([row('FleetTask', { actor: 'bob', task_seq: 1, task: 't1', status: 'pending', depends_on: [], artifact: '' })], localDir, { now: NOW });
  const before = fs.readFileSync(path.join(localDir, 'grid', 'peers', 'bob', 'LEDGER.md'), 'utf8');

  // A later cycle with rows for a DIFFERENT actor only — bob's files must survive untouched.
  materialize([row('FleetTask', { actor: 'carol', task_seq: 1, task: 't2', status: 'pending', depends_on: [], artifact: '' })], localDir, { now: NOW });
  const after = fs.readFileSync(path.join(localDir, 'grid', 'peers', 'bob', 'LEDGER.md'), 'utf8');
  assert.equal(before, after);
  assert.ok(fs.existsSync(path.join(localDir, 'grid', 'peers', 'carol', 'LEDGER.md')));
});

test('materialize never leaves a .tmp file behind after a successful write', () => {
  const localDir = tempLocalDir();
  materialize([row('FleetTask', { actor: 'bob', task_seq: 1, task: 't1', status: 'pending', depends_on: [], artifact: '' })], localDir, { now: NOW });
  const entries = fs.readdirSync(path.join(localDir, 'grid', 'peers', 'bob'));
  assert.ok(entries.every((e) => !e.includes('.tmp-')));
});

test('materialize produces byte-identical output regardless of newRows arrival order', () => {
  const rowsInOrderA = [
    row('FleetTask', { actor: 'bob', task_seq: 1, task: 't1', status: 'pending', depends_on: [], artifact: '' }),
    row('FleetTask', { actor: 'alice', task_seq: 1, task: 't2', status: 'pending', depends_on: [], artifact: '' }),
    row('ActorPresence', { actor: 'bob', run_id: 'r1', heartbeat_at: '2026-08-16T11:59:00Z' }),
  ];
  const rowsInOrderB = [rowsInOrderA[2], rowsInOrderA[1], rowsInOrderA[0]];

  const dirA = tempLocalDir();
  const dirB = tempLocalDir();
  materialize(rowsInOrderA, dirA, { now: NOW, syncedAt: 'FIXED' });
  materialize(rowsInOrderB, dirB, { now: NOW, syncedAt: 'FIXED' });

  for (const rel of ['grid/peers/bob/LEDGER.md', 'grid/peers/bob/presence.json', 'grid/GRID.md']) {
    assert.equal(fs.readFileSync(path.join(dirA, rel), 'utf8'), fs.readFileSync(path.join(dirB, rel), 'utf8'), `${rel} must be byte-identical`);
  }
});

test('materialize resolves duplicate FleetTask pushes for one key by last write wins in both the peer ledger and GRID.md', () => {
  const localDir = tempLocalDir();
  const newRows = [
    row('FleetTask', { actor: 'bob', task_seq: 1, task: 'stale content', status: 'in-progress', depends_on: [] }),
    row('FleetTask', { actor: 'bob', task_seq: 1, task: 'fresh content', status: 'in-progress', depends_on: [] }),
  ];
  materialize(newRows, localDir, { now: NOW });
  const ledger = fs.readFileSync(path.join(localDir, 'grid', 'peers', 'bob', 'LEDGER.md'), 'utf8');
  const gridMd = fs.readFileSync(path.join(localDir, 'grid', 'GRID.md'), 'utf8');
  assert.match(ledger, /fresh content/);
  assert.doesNotMatch(ledger, /stale content/);
  assert.match(gridMd, /fresh content/);
  assert.doesNotMatch(gridMd, /stale content/);
});

test('materialize handles an actor known only via HandoffPointer/RunEventSummary with no FleetTask/ActorPresence row', () => {
  const localDir = tempLocalDir();
  const { written } = materialize(
    [row('HandoffPointer', { actor: 'dave', seq: 1, from_agent: 'a', to_agent: 'b', artifact: 'x.md', criteria_digest: 'd'.repeat(64) })],
    localDir,
    { now: NOW }
  );
  assert.ok(fs.existsSync(path.join(localDir, 'grid', 'peers', 'dave', 'handoffs.md')));
  assert.ok(!fs.existsSync(path.join(localDir, 'grid', 'peers', 'dave', 'LEDGER.md')));
  const gridMd = fs.readFileSync(path.join(localDir, 'grid', 'GRID.md'), 'utf8');
  assert.match(gridMd, /## dave/);
  assert.match(gridMd, /\(no presence data\)/);
  assert.ok(written.some((p) => p.endsWith('GRID.md')));
});

// --- RunEventSummary -> peers/<actor>/health.json (G7.5) --------------------

test('materialize writes peers/<actor>/health.json from RunEventSummary rows, summed across runs', () => {
  const localDir = tempLocalDir();
  const { written } = materialize(
    [
      row('RunEventSummary', { actor: 'bob', run_id: 'r1', gate_pass: 3, gate_block: 1, execute_tool_error: 0 }),
      row('RunEventSummary', { actor: 'bob', run_id: 'r2', gate_pass: 2, gate_block: 0, execute_tool_error: 1 }),
    ],
    localDir,
    { now: NOW }
  );
  const healthPath = path.join(localDir, 'grid', 'peers', 'bob', 'health.json');
  assert.ok(fs.existsSync(healthPath));
  assert.deepEqual(JSON.parse(fs.readFileSync(healthPath, 'utf8')), {
    actor: 'bob',
    runs: 2,
    gate_pass: 5,
    gate_block: 1,
    execute_tool_error: 1,
  });
  assert.ok(written.some((p) => p.endsWith(path.join('bob', 'health.json'))));
});

test('materialize dedupes RunEventSummary rows by repo_id+actor+run_id (last write wins) before summing health.json', () => {
  const localDir = tempLocalDir();
  materialize(
    [
      row('RunEventSummary', { actor: 'bob', run_id: 'r1', gate_pass: 1, gate_block: 0, execute_tool_error: 0 }),
      // Same natural key pushed twice (no server-side dedup, G2.1) — must count once, with the later values.
      row('RunEventSummary', { actor: 'bob', run_id: 'r1', gate_pass: 9, gate_block: 9, execute_tool_error: 9 }),
    ],
    localDir,
    { now: NOW }
  );
  const health = JSON.parse(fs.readFileSync(path.join(localDir, 'grid', 'peers', 'bob', 'health.json'), 'utf8'));
  assert.deepEqual(health, { actor: 'bob', runs: 1, gate_pass: 9, gate_block: 9, execute_tool_error: 9 });
});

test('materialize\'s health.json is upsert-only — an actor absent from a later cycle keeps their existing health.json', () => {
  const localDir = tempLocalDir();
  materialize([row('RunEventSummary', { actor: 'bob', run_id: 'r1', gate_pass: 1, gate_block: 0, execute_tool_error: 0 })], localDir, { now: NOW });
  const before = fs.readFileSync(path.join(localDir, 'grid', 'peers', 'bob', 'health.json'), 'utf8');

  materialize([row('RunEventSummary', { actor: 'carol', run_id: 'r1', gate_pass: 1, gate_block: 0, execute_tool_error: 0 })], localDir, { now: NOW });
  assert.equal(fs.readFileSync(path.join(localDir, 'grid', 'peers', 'bob', 'health.json'), 'utf8'), before);
});

test('materialize renders GRID.md\'s Org-approved section from OrgDocument rows, deduped by content_hash then by title (G7.3)', () => {
  const localDir = tempLocalDir();
  const orgDocRow = (fields) => row('OrgDocument', { content_hash: 'h1', kind: 'meeting', title: 'Q1 Doc', client: 'acme', chunk_index: 0, chunk_text: 'x', source_file: 'f.md', imported_by: 'alice', valid_from: '2026-01-01', ...fields });

  materialize(
    [
      orgDocRow({ content_hash: 'h1', title: 'Q1 Doc' }), // still draft (implicit)
      orgDocRow({ content_hash: 'h1', title: 'Q1 Doc', approval: 'approved' }), // supersedes the draft version above, same key
      orgDocRow({ content_hash: 'h2', title: 'Q1 Doc', chunk_index: 1, approval: 'approved' }), // a second chunk of the SAME document — same title
      orgDocRow({ content_hash: 'h3', title: 'Unapproved Doc' }), // never approved — must not appear
    ],
    localDir,
    { now: NOW }
  );

  const gridMd = fs.readFileSync(path.join(localDir, 'grid', 'GRID.md'), 'utf8');
  assert.match(gridMd, /## Org-approved\n\n- Q1 Doc\n/, 'the last-write-wins approved version must count, deduped to ONE title despite two approved chunks sharing it');
  assert.doesNotMatch(gridMd, /Unapproved Doc/);
});
