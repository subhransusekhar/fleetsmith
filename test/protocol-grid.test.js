import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpec } from '../src/spec/schema.js';
import { archetype } from '../src/patterns/index.js';
import { buildClaudeCode } from '../src/adapters/claude-code.js';
import { buildOpencode } from '../src/adapters/opencode.js';
import { buildGoose } from '../src/adapters/goose.js';
import { protocolBlock } from '../src/handover/protocol.js';

/**
 * G4.1: the handover protocol's grid-awareness section, compiled only when a spec has a `grid:` block.
 * Core (MIT) never talks to RelataDB or imports `ee/` here — this section only ever names a path
 * (`_fleet/local/grid/GRID.md`) an ee/-provided daemon may or may not have populated; core's job is just to
 * tell agents where to look and what the words on that page mean, exactly like it already does for
 * `LEDGER.md`.
 */

function gridSpec() {
  const raw = archetype('pipeline', 'demo', 'demo domain');
  raw.fleet.grid = { url: 'https://relata.example.internal', token_env: 'RELATA_TOKEN' };
  return normalizeSpec(raw);
}

function noGridSpec() {
  return normalizeSpec(archetype('pipeline', 'demo', 'demo domain'));
}

const PROTOCOL_ARGS = { agent: 'a', dir: '_fleet/local/handoffs', ledgerPath: '_fleet/local/LEDGER.md', incoming: [], outgoing: ['b'], artifact: null, criteria: [], schema: null };

// --- protocolBlock() itself -----------------------------------------------------

test('protocolBlock: no gridPath produces no grid section at all — byte-identical to calling it without the param', () => {
  const withoutParam = protocolBlock(PROTOCOL_ARGS);
  const withNullGridPath = protocolBlock({ ...PROTOCOL_ARGS, gridPath: null });
  assert.equal(withoutParam, withNullGridPath);
  assert.doesNotMatch(withoutParam, /Grid awareness/);
});

test('protocolBlock: gridPath renders a static, deterministic grid-awareness section naming exactly that path', () => {
  const rendered = protocolBlock({ ...PROTOCOL_ARGS, gridPath: '_fleet/local/grid/GRID.md' });
  assert.match(rendered, /\*\*Grid awareness\*\*/);
  assert.match(rendered, /_fleet\/local\/grid\/GRID\.md/);
  assert.match(rendered, /advisory and may be stale/);
  assert.match(rendered, /depends on: @<actor>#<task-seq>/);

  // Static-string test: the same call, twice, must be byte-identical — nothing run-varying (no
  // Date.now(), no random id, no counter) can have leaked into this section.
  const renderedAgain = protocolBlock({ ...PROTOCOL_ARGS, gridPath: '_fleet/local/grid/GRID.md' });
  assert.equal(rendered, renderedAgain);
  assert.doesNotMatch(rendered, /\d{4}-\d{2}-\d{2}/, 'no date-shaped content');
  assert.doesNotMatch(rendered, /\b\d{10,}\b/, 'no timestamp/counter-shaped content');
});

// --- compiled into all three targets ---------------------------------------------

test('a grid-enabled spec compiles the grid-awareness section into all three targets’ agent prompts', () => {
  const spec = gridSpec();
  for (const [name, build] of [['claude-code', buildClaudeCode], ['opencode', buildOpencode], ['goose', buildGoose]]) {
    const fileSet = build(spec);
    // Not filtered to a specific path shape: claude-code/opencode emit per-agent .md files, goose embeds
    // the same compiled prompt body inside a `prompt:` field in per-agent .yaml recipes — checking every
    // compiled file's content is what actually proves the section reached each target, without assuming
    // one target's file layout for another.
    const combined = [...fileSet.files.values()].join('\n');
    assert.match(combined, /Grid awareness/, `${name} build should contain the grid-awareness section somewhere in its compiled output`);
    assert.match(combined, /_fleet\/local\/grid\/GRID\.md/, `${name} build should reference the GRID.md path`);
  }
});

test('a grid-disabled spec never mentions grid awareness in any of the three targets’ compiled output', () => {
  const spec = noGridSpec();
  for (const [name, build] of [['claude-code', buildClaudeCode], ['opencode', buildOpencode], ['goose', buildGoose]]) {
    const fileSet = build(spec);
    const combined = [...fileSet.files.values()].join('\n');
    assert.doesNotMatch(combined, /Grid awareness/, `${name} build must not mention grid awareness when the spec has no grid: block`);
    assert.doesNotMatch(combined, /grid\/GRID\.md/, `${name} build must not reference GRID.md when the spec has no grid: block`);
  }
});

// --- grid-disabled compile is unaffected by this change at all -------------------

test('a grid-disabled spec’s compiled output is identical whether built before or after this change (no gridPath ever computed)', () => {
  const spec = noGridSpec();
  const first = buildClaudeCode(spec);
  const second = buildClaudeCode(spec);
  assert.deepEqual([...first.files.entries()], [...second.files.entries()], 'compiling twice from the same grid-disabled spec must be perfectly deterministic');
  // spec.fleet.grid is normalized to null (src/spec/schema.js) for a spec with no grid: block, so
  // compileAgentBody's `spec.fleet.grid ? … : null` ternary always takes the null branch here — the same
  // code path (and therefore the same output) as if gridPath were never introduced into protocolBlock at all.
  assert.equal(spec.fleet.grid, null);
});
