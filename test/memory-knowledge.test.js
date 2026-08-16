import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeSpec } from '../src/spec/schema.js';
import { fileBackend } from '../src/memory/file.js';

/**
 * G6.4: the file-backend counterpart to G6.3's RelataDB `OrgDocument` union — `shared/knowledge/*.md`
 * (committed, PR-reviewed markdown with a small frontmatter block) joins `recall()` for the same fixed
 * allowlist of org purposes, so a skill's recall instructions work identically on either backend.
 */

function memFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-knowledge-'));
  const spec = normalizeSpec({ fleet: { name: 'm' }, agents: [{ name: 'analyst', role: 'r' }] });
  return { dir, spec, backend: fileBackend({ spec, cwd: dir }) };
}

function writeKnowledgeFile(dir, spec, filename, content) {
  const full = path.join(dir, spec.fleet.shared, 'knowledge', filename);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const MEETING_DOC = [
  '---',
  'kind: meeting',
  'client: acme',
  'date: 2026-01-10',
  'source: meeting-2026-01-10.md',
  '---',
  '',
  '# Q1 Planning Meeting',
  '',
  '## Attendees',
  '',
  'Alice, Bob, Carol',
  '',
  '## Decisions',
  '',
  'We decided to ship the reports export by Friday.',
  '',
].join('\n');

const DECISION_DOC = ['---', 'kind: decision', 'date: 2026-01-05', 'source: decision-log.md', '---', '', '# Auth rewrite', '', 'We chose token rotation over full re-auth.', ''].join(
  '\n'
);

test('org-purpose recall over fixture knowledge files returns ranked, provenance-carrying items', async () => {
  const { dir, spec, backend } = memFixture();
  writeKnowledgeFile(dir, spec, 'meeting-notes.md', MEETING_DOC);

  const found = await backend.recall('ship the reports export', { purpose: 'product_context' });
  assert.ok(found.length > 0);

  const hit = found.find((i) => i.evidence?.[0]?.includes('meeting-2026-01-10.md'));
  assert.ok(hit, 'the matching chunk must be present');
  assert.equal(hit.kind, 'note'); // meeting -> note, no 1:1 ITEM_KINDS mapping
  assert.match(hit.text, /ship the reports export/);
  assert.equal(hit.origin, 'human');
  assert.deepEqual(hit.evidence, ['meeting-2026-01-10.md (meeting, acme, 2026-01-10)']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recall carries the heading path in the chunk text, so an isolated chunk still shows its section', async () => {
  const { dir, spec, backend } = memFixture();
  writeKnowledgeFile(dir, spec, 'meeting-notes.md', MEETING_DOC);

  const found = await backend.recall('ship the reports export', { purpose: 'product_context' });
  const hit = found.find((i) => /ship the reports export/.test(i.text));
  assert.match(hit.text, /Q1 Planning Meeting > Decisions/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a decision-kind knowledge file maps directly onto ITEM_KIND "decision"', async () => {
  const { dir, spec, backend } = memFixture();
  writeKnowledgeFile(dir, spec, 'decision-log.md', DECISION_DOC);

  const found = await backend.recall('token rotation', { purpose: 'decision_rationale' });
  const hit = found.find((i) => /token rotation/.test(i.text));
  assert.ok(hit);
  assert.equal(hit.kind, 'decision');
  assert.deepEqual(hit.evidence, ['decision-log.md (decision, 2026-01-05)']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('non-org purposes do not scan knowledge/ at all — zero knowledge hits, even on a matching query', async () => {
  const { dir, spec, backend } = memFixture();
  writeKnowledgeFile(dir, spec, 'meeting-notes.md', MEETING_DOC);

  const found = await backend.recall('ship the reports export', { purpose: 'cross_dev_reuse' });
  assert.ok(!found.some((i) => i.id?.startsWith('knowledge:')), 'a non-org purpose must never surface a knowledge/ hit');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('remember never writes into knowledge/ — there is no writable path for it', async () => {
  const { dir, spec, backend } = memFixture();
  await backend.remember({ kind: 'lesson', text: 'a normal lesson', origin: 'human', subject: 'analyst' });
  await assert.rejects(() => backend.remember({ kind: 'knowledge', text: 'x' }), /unknown item kind/i);
  assert.ok(!fs.existsSync(path.join(dir, spec.fleet.shared, 'knowledge')), 'remember must never create the knowledge/ directory');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recall with an org purpose still unions team memory (lessons) alongside knowledge/ hits', async () => {
  const { dir, spec, backend } = memFixture();
  await backend.remember({ kind: 'lesson', text: 'always ship the reports export on time', origin: 'evolved', subject: 'analyst' });
  writeKnowledgeFile(dir, spec, 'meeting-notes.md', MEETING_DOC);

  const found = await backend.recall('ship the reports export', { purpose: 'product_context' });
  assert.ok(found.some((i) => i.kind === 'lesson'), 'team memory must still be present alongside org knowledge');
  assert.ok(found.some((i) => i.id?.startsWith('knowledge:')), 'knowledge/ hits must be present too');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a knowledge file with no client omits the client segment from provenance, not a bare double comma', async () => {
  const { dir, spec, backend } = memFixture();
  const doc = ['---', 'kind: spec', 'date: 2026-02-01', 'source: api-spec.md', '---', '', '# API Spec', '', 'The reports endpoint returns paginated JSON.', ''].join('\n');
  writeKnowledgeFile(dir, spec, 'api-spec.md', doc);

  const found = await backend.recall('reports endpoint paginated', { purpose: 'product_context' });
  const hit = found.find((i) => /reports endpoint/.test(i.text));
  assert.deepEqual(hit.evidence, ['api-spec.md (spec, 2026-02-01)']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a malformed frontmatter block degrades to treating the whole file as body, never a throw', async () => {
  const { dir, spec, backend } = memFixture();
  writeKnowledgeFile(dir, spec, 'broken.md', '# No real frontmatter here\n\njust a plain unusual roadmap file\n');

  const found = await backend.recall('unusual roadmap file', { purpose: 'product_context' });
  assert.ok(found.some((i) => /unusual roadmap file/.test(i.text)), 'a file without frontmatter must still be scanned, not skipped or thrown on');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an absent knowledge/ directory is a harmless empty result, not an error', async () => {
  const { dir, backend } = memFixture();
  const found = await backend.recall('anything at all', { purpose: 'product_context' });
  assert.deepEqual(found, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recall requires a purpose even when it would otherwise scan knowledge/', async () => {
  const { dir, spec, backend } = memFixture();
  writeKnowledgeFile(dir, spec, 'meeting-notes.md', MEETING_DOC);
  await assert.rejects(() => backend.recall('ship the reports export', {}), /purpose/i);
  fs.rmSync(dir, { recursive: true, force: true });
});
