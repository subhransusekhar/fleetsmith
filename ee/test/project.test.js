// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ledgerToTasks, presenceFrom, handoffToPointer, eventsToSummary, ProjectionError } from '../src/grid/project.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'projection');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const ctx = { repoId: 'repo-abc123', actor: 'alice', branch: 'main' };

// --- purity: no fs/network imports in this module --------------------------

test('project.js imports no fs/network modules — a pure, I/O-free module', () => {
  const projectJsPath = fileURLToPath(new URL('../src/grid/project.js', import.meta.url));
  const source = fs.readFileSync(projectJsPath, 'utf8');
  assert.doesNotMatch(source, /from\s+['"]node:(fs|fs\/promises|http|https|net|dgram|dns|child_process)['"]/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
});

// --- ledgerToTasks -----------------------------------------------------------

test('ledgerToTasks parses well-formed rows into FleetTask objects', () => {
  const { tasks } = ledgerToTasks(read('ledger.md'), ctx);
  const task1 = tasks.find((t) => t.task_seq === 1);
  assert.deepEqual(task1, {
    repo_id: 'repo-abc123',
    branch: 'main',
    purpose: 'fleetsmith_grid',
    origin: 'human',
    actor: 'alice',
    task_seq: 1,
    task: 'analyze requirements',
    status: 'done',
    depends_on: [],
    artifact: 'handoffs/01-analyst-to-builder.md',
    files_declared: [],
    symbols_declared: [],
  });
});

test('ledgerToTasks splits same-actor Depends on cells and preserves cross-actor @actor#seq references verbatim', () => {
  const { tasks } = ledgerToTasks(read('ledger.md'), ctx);
  assert.deepEqual(tasks.find((t) => t.task_seq === 2).depends_on, ['1']);
  assert.deepEqual(tasks.find((t) => t.task_seq === 3).depends_on, ['@bob#4']);
});

test('ledgerToTasks treats a "-" Artifact cell as no artifact', () => {
  const { tasks } = ledgerToTasks(read('ledger.md'), ctx);
  assert.equal(tasks.find((t) => t.task_seq === 3).artifact, '');
});

test('ledgerToTasks tolerates malformed rows by skipping them and collecting a warning, never throwing', () => {
  const { tasks, warnings } = ledgerToTasks(read('ledger.md'), ctx);
  assert.equal(tasks.length, 3, 'only the 3 well-formed rows (seq 1, 2, 3) should survive');
  assert.equal(warnings.length, 3, 'one warning each for the bad-seq row, the too-few-cells row, and the bad-status row');
});

test('ledgerToTasks warns distinctly for a non-numeric seq, a short row, and an off-vocabulary status', () => {
  const { warnings } = ledgerToTasks(read('ledger.md'), ctx);
  assert.ok(warnings.some((w) => w.includes('garbage')), 'the non-numeric-seq row should be named in a warning');
  assert.ok(warnings.some((w) => w.includes('expected 6 columns')), 'the too-few-cells row should be named in a warning');
  assert.ok(warnings.some((w) => w.includes('almost-done')), 'the off-vocabulary status row should be named in a warning');
});

test('ledgerToTasks ignores the header row and the separator row with no warning', () => {
  const { tasks, warnings } = ledgerToTasks('| # | Task | Owner | Depends on | Status | Artifact |\n|---|---|---|---|---|---|\n', ctx);
  assert.deepEqual(tasks, []);
  assert.deepEqual(warnings, []);
});

// --- presenceFrom -------------------------------------------------------------

test('presenceFrom reads the run id from the CURRENT marker and the started_at/heartbeat_at anchors from the events', () => {
  const presence = presenceFrom(read('CURRENT-alice'), read('events.jsonl'), ctx);
  assert.deepEqual(presence, {
    repo_id: 'repo-abc123',
    branch: 'main',
    purpose: 'fleetsmith_grid',
    origin: 'human',
    actor: 'alice',
    run_id: 'alice-20260816T100000Z',
    started_at: '2026-08-16T10:00:00Z',
    heartbeat_at: '2026-08-16T10:06:00Z',
  });
});

test('presenceFrom falls back to the timestamp encoded in the run id when no run_start line is present', () => {
  const eventsWithoutRunStart = read('events.jsonl')
    .split('\n')
    .filter((l) => !l.includes('"run_start"'))
    .join('\n');
  const presence = presenceFrom(read('CURRENT-alice'), eventsWithoutRunStart, ctx);
  assert.equal(presence.started_at, '2026-08-16T10:00:00Z');
});

test('presenceFrom tolerates an entirely empty events file', () => {
  const presence = presenceFrom(read('CURRENT-alice'), '', ctx);
  assert.equal(presence.run_id, 'alice-20260816T100000Z');
  assert.equal(presence.started_at, '2026-08-16T10:00:00Z');
  assert.equal(presence.heartbeat_at, '2026-08-16T10:00:00Z');
});

// --- handoffToPointer ---------------------------------------------------------

test('handoffToPointer parses the {seq}-{from}-to-{to}.md filename', () => {
  const pointer = handoffToPointer('01-analyst-to-builder.md', read('01-analyst-to-builder.md'), ctx);
  assert.equal(pointer.seq, 1);
  assert.equal(pointer.from_agent, 'analyst');
  assert.equal(pointer.to_agent, 'builder');
  assert.equal(pointer.artifact, '01-analyst-to-builder.md');
  assert.match(pointer.criteria_digest, /^[0-9a-f]{64}$/);
});

test('handoffToPointer digests only the Acceptance criteria section, not the handoff body', () => {
  const content = read('01-analyst-to-builder.md');
  const expected = createHash('sha256').update('- [ ] Feature builds and passes existing tests\n- [ ] New tests cover the happy path and one edge case').digest('hex');
  const pointer = handoffToPointer('01-analyst-to-builder.md', content, ctx);
  assert.equal(pointer.criteria_digest, expected);
});

test('handoffToPointer digest is stable across whitespace-only changes outside the criteria section', () => {
  const original = read('01-analyst-to-builder.md');
  const reworded = original.replace('Build the feature described in the requirements analysis.', 'Build the feature described in the requirements analysis.   \n\n\nExtra blank lines above.');
  const a = handoffToPointer('01-analyst-to-builder.md', original, ctx);
  const b = handoffToPointer('01-analyst-to-builder.md', reworded, ctx);
  assert.equal(a.criteria_digest, b.criteria_digest);
});

test('handoffToPointer falls back to a whole-file digest when there is no Acceptance criteria section', () => {
  const content = read('02-builder-to-reviewer.md');
  const pointer = handoffToPointer('02-builder-to-reviewer.md', content, ctx);
  // Normalized the same way handoffToPointer() itself does before hashing — a Windows checkout's
  // core.autocrlf gives `content` real \r\n bytes that must be normalized identically here, or this
  // assertion diverges from the function under test purely by platform, not by any real behavior difference.
  assert.equal(pointer.criteria_digest, createHash('sha256').update(content.replace(/\r\n/g, '\n').trim()).digest('hex'));
});

test('handoffToPointer throws ProjectionError on a filename that does not match the naming convention', () => {
  assert.throws(() => handoffToPointer('not-a-handoff.md', 'anything', ctx), ProjectionError);
});

// --- eventsToSummary -----------------------------------------------------------

test('eventsToSummary reduces a run to gate_pass/gate_block/execute_tool_error counts, ignoring other event kinds and malformed lines', () => {
  const summary = eventsToSummary(read('events.jsonl'), ctx);
  assert.deepEqual(summary, {
    repo_id: 'repo-abc123',
    branch: 'main',
    purpose: 'fleetsmith_grid',
    origin: 'human',
    actor: 'alice',
    run_id: 'alice-20260816T100000Z',
    gate_pass: 2,
    gate_block: 1,
    execute_tool_error: 1,
  });
});

test('eventsToSummary throws ProjectionError when no line parses at all', () => {
  assert.throws(() => eventsToSummary('not json\nalso not json', ctx), ProjectionError);
});
