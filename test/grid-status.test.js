import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeSpec } from '../src/spec/schema.js';
import { archetype } from '../src/patterns/index.js';
import { buildOpencode } from '../src/adapters/opencode.js';
import { ledgerTemplate } from '../src/handover/protocol.js';
import { gridStatusLine, gridStatusScript, GRID_STATUS_SCRIPT_PATH } from '../src/compile/orchestrator.js';
import { buildFleetsmithTools } from '../src/opencode-plugin.js';

const NOW = Date.parse('2026-08-16T12:00:00Z');

function gridMdFixture({ actors = 2, synced = '2026-08-16T11:55:00Z', order = 'normal' } = {}) {
  const syncedLine = `_Synced: ${synced}_`;
  const cortexLine = 'Cortex: reachable';
  const actorsLine = `Active actors: ${actors}`;
  const header = order === 'shuffled' ? `${actorsLine} · ${cortexLine} · ${syncedLine}` : `${syncedLine} · ${cortexLine} · ${actorsLine}`;
  return `# Grid\n\n${header}\n\n## alice\n_(active — last seen ${synced})_\n(no in-progress tasks)\n`;
}

// --- gridStatusLine: pure parsing ------------------------------------------------

test('gridStatusLine renders the expected format from a fixture GRID.md', () => {
  const line = gridStatusLine(gridMdFixture({ actors: 3, synced: '2026-08-16T11:55:00Z' }), { now: NOW });
  assert.equal(line, 'grid: 3 actors active, 0 overlaps, synced 5m ago');
});

test('gridStatusLine singularizes for exactly 1 actor / 1 overlap', () => {
  const line = gridStatusLine(gridMdFixture({ actors: 1 }), { now: NOW, overlapsMdContent: '- one overlap\n' });
  assert.match(line, /^grid: 1 actor active, 1 overlap, /);
});

test('gridStatusLine tolerates header field reordering — labeled matching, not positional', () => {
  const normal = gridStatusLine(gridMdFixture({ order: 'normal' }), { now: NOW });
  const shuffled = gridStatusLine(gridMdFixture({ order: 'shuffled' }), { now: NOW });
  assert.equal(normal, shuffled);
});

test('gridStatusLine returns null when GRID.md is absent or has no Active actors field', () => {
  assert.equal(gridStatusLine(null), null);
  assert.equal(gridStatusLine(''), null);
  assert.equal(gridStatusLine('# Grid\n\nsomething unrelated\n'), null);
});

test('gridStatusLine handles "never" synced and an unparseable synced value gracefully', () => {
  assert.match(gridStatusLine(gridMdFixture({ synced: 'never' }), { now: NOW }), /synced never$/);
  assert.match(gridStatusLine(gridMdFixture({ synced: 'not-a-date' }), { now: NOW }), /synced not-a-date$/);
});

test('gridStatusLine counts overlap bullet rows from OVERLAPS.md when present', () => {
  const line = gridStatusLine(gridMdFixture(), { now: NOW, overlapsMdContent: '- a\n- b\n- c\n\nnot a bullet\n' });
  assert.match(line, /3 overlaps/);
});

// --- gridStatusScript: the real standalone script, executed for real ------------

async function withTempWorkspace(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-grid-status-test-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function specWithGrid() {
  const raw = archetype('pipeline', 'demo', 'demo domain');
  raw.fleet.grid = { url: 'https://relata.example.internal', token_env: 'RELATA_TOKEN' };
  return normalizeSpec(raw);
}

test('gridStatusScript runs as a real, dependency-free Node script and prints the expected line', async () => {
  await withTempWorkspace((dir) => {
    const spec = specWithGrid();
    const scriptPath = path.join(dir, GRID_STATUS_SCRIPT_PATH);
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, gridStatusScript(spec));

    const gridDir = path.join(dir, spec.fleet.local, 'grid');
    fs.mkdirSync(gridDir, { recursive: true });
    fs.writeFileSync(path.join(gridDir, 'GRID.md'), gridMdFixture({ actors: 2, synced: 'never' }));

    const stdout = execFileSync('node', [scriptPath], { cwd: dir, encoding: 'utf8' });
    assert.equal(stdout.trim(), 'grid: 2 actors active, 0 overlaps, synced never');
  });
});

test('gridStatusScript prints nothing and exits 0 when GRID.md does not exist', async () => {
  await withTempWorkspace((dir) => {
    const spec = specWithGrid();
    const scriptPath = path.join(dir, GRID_STATUS_SCRIPT_PATH);
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, gridStatusScript(spec));

    const stdout = execFileSync('node', [scriptPath], { cwd: dir, encoding: 'utf8' });
    assert.equal(stdout, '');
  });
});

// --- ledgerTemplate: conditional doc line ---------------------------------------

test('ledgerTemplate documents the @<actor>#<seq> notation only when grid is enabled', () => {
  const withGrid = ledgerTemplate('demo', true);
  const withoutGrid = ledgerTemplate('demo', false);
  assert.match(withGrid, /@<actor>#<task-seq>/);
  assert.doesNotMatch(withoutGrid, /@<actor>#<task-seq>/);
});

test('ledgerTemplate defaults to grid-disabled when the second argument is omitted', () => {
  assert.equal(ledgerTemplate('demo'), ledgerTemplate('demo', false));
});

// --- compiled fleet-status command: grid-conditional, byte-identical when off ---

test('buildOpencode: fleet-status command includes the grid status invocation only when grid is configured', () => {
  const withGrid = buildOpencode(specWithGrid());
  const withoutGrid = buildOpencode(normalizeSpec(archetype('pipeline', 'demo', 'demo domain')));

  const statusWithGrid = withGrid.files.get('.opencode/commands/fleet-status.md');
  const statusWithoutGrid = withoutGrid.files.get('.opencode/commands/fleet-status.md');
  assert.match(statusWithGrid, new RegExp(`node .*${GRID_STATUS_SCRIPT_PATH.replace('.', '\\.')}`));
  assert.doesNotMatch(statusWithoutGrid, /grid-status/);
  assert.ok(withGrid.files.has(`_fleet/local/${GRID_STATUS_SCRIPT_PATH}`), 'the script itself must be emitted when grid is configured');
  assert.ok(!withoutGrid.files.has(`_fleet/local/${GRID_STATUS_SCRIPT_PATH}`), 'the script must not be emitted when grid is not configured');
});

test('buildOpencode: a grid-disabled spec compiles a fleet-status command identical to before this change (no grid text at all)', () => {
  const fileSet = buildOpencode(normalizeSpec(archetype('pipeline', 'demo', 'demo domain')));
  const status = fileSet.files.get('.opencode/commands/fleet-status.md');
  assert.doesNotMatch(status, /grid/i);
});

// --- compaction hook: injects the grid line when GRID.md exists -----------------

/** Minimal stand-in for opencode's `tool` helper, matching test/fleetsmith.test.js's own stub — only the hooks object returned by buildFleetsmithTools is exercised here, not the tool map. */
function stubTool(def) {
  return def;
}
{
  const marker = { describe: () => marker, optional: () => marker };
  stubTool.schema = { string: () => marker, boolean: () => marker, number: () => marker };
}

test('opencode-plugin compaction hook injects the grid status line when GRID.md exists', async () => {
  await withTempWorkspace(async (dir) => {
    const gridDir = path.join(dir, '_fleet', 'local', 'grid');
    fs.mkdirSync(gridDir, { recursive: true });
    fs.writeFileSync(path.join(gridDir, 'GRID.md'), gridMdFixture({ actors: 4, synced: '2026-08-16T11:00:00Z' }));

    const { 'experimental.session.compacting': onCompact } = buildFleetsmithTools(stubTool, { directory: dir });
    const output = { context: [] };
    await onCompact({}, output);
    assert.ok(output.context.some((c) => c.includes('grid: 4 actors active')));
  });
});

test('opencode-plugin compaction hook adds nothing grid-related when GRID.md is absent — ledger-only context unaffected', async () => {
  await withTempWorkspace(async (dir) => {
    fs.mkdirSync(path.join(dir, '_fleet', 'local'), { recursive: true });
    fs.writeFileSync(path.join(dir, '_fleet', 'local', 'LEDGER.md'), '# Ledger\n');

    const { 'experimental.session.compacting': onCompact } = buildFleetsmithTools(stubTool, { directory: dir });
    const output = { context: [] };
    await onCompact({}, output);
    assert.equal(output.context.length, 1, 'only the ledger context line, nothing grid-related');
    assert.ok(!output.context.some((c) => c.includes('grid:')));
  });
});
