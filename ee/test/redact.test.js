// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactRow, matchCredentialPattern, RedactionError } from '../src/grid/redact.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// --- per-pattern true positives ------------------------------------------------------------------------------

test('matchCredentialPattern: AWS access key ID', () => {
  assert.equal(matchCredentialPattern('here is a key AKIAIOSFODNN7EXAMPLE for you'), 'aws-access-key-id');
});

test('matchCredentialPattern: GitHub personal access token', () => {
  assert.equal(matchCredentialPattern('use ghp_1234567890abcdefghijklmnopqrstuvwxyz12 for CI'), 'github-token');
});

test('matchCredentialPattern: a JWT', () => {
  assert.equal(matchCredentialPattern('token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'), 'jwt');
});

test('matchCredentialPattern: a PEM private key header', () => {
  assert.equal(matchCredentialPattern('-----BEGIN RSA PRIVATE KEY-----\nMIIBOw...'), 'pem-private-key');
});

test('matchCredentialPattern: a bearer token', () => {
  assert.equal(matchCredentialPattern('curl -H "Authorization: Bearer abc123def456ghi789jkl012"'), 'bearer-token');
});

test('matchCredentialPattern: a key=value / key: value assignment', () => {
  assert.equal(matchCredentialPattern('password=SuperSecretValue123'), 'key-value-assignment');
  assert.equal(matchCredentialPattern('api_key: "sk-abcdef1234567890"'), 'key-value-assignment');
});

test('matchCredentialPattern: none of the above -> null', () => {
  assert.equal(matchCredentialPattern('review the pull request before merging'), null);
});

// --- tricky negatives: this task's own named concern -------------------------------------------------------

test('tricky negative: a content_hash-shaped 64-hex-char string is NOT flagged — high entropy, but the field name says "hash", not "secret"', () => {
  const row = { repo_id: 'r1', content_hash: 'a'.repeat(32) + 'b'.repeat(32), title: 'Q1 Planning', chunk_text: 'we discussed the roadmap' };
  assert.deepEqual(redactRow(row), row);
});

test('tricky negative: a criteria_digest (also a 64-hex sha256) is NOT flagged, for the same reason', () => {
  const row = { repo_id: 'r1', actor: 'ada', seq: 1, criteria_digest: '0123456789abcdef'.repeat(4), from_agent: 'a', to_agent: 'b' };
  assert.deepEqual(redactRow(row), row);
});

test('tricky negative: an ordinary task title and chunk of imported text pass untouched', () => {
  const row = { task: 'implement the export feature', chunk_text: 'In the meeting we agreed to ship by Friday.' };
  assert.deepEqual(redactRow(row), row);
});

test('tricky negative: a deployment_id / node_id-shaped UUID is not flagged — "deployment_id" is not a key-shaped field name, so the entropy heuristic never even runs against it', () => {
  const row = { deployment_id: '9cd8be7a-b603-4e6b-83c7-7a3f2559e0e6' };
  assert.deepEqual(redactRow(row), row);
});

// --- true positive: the acceptance criterion's own named scenario -------------------------------------------

test('acceptance scenario: a seeded secret in a task title throws RedactionError naming the field, never the value', () => {
  const row = { repo_id: 'r1', actor: 'ada', task_seq: 1, task: 'fix the bug, AKIAIOSFODNN7EXAMPLE is the key we used', status: 'in-progress' };
  assert.throws(() => redactRow(row), (e) => {
    assert.ok(e instanceof RedactionError);
    assert.match(e.message, /field "task"/);
    assert.doesNotMatch(e.message, /AKIAIOSFODNN7EXAMPLE/, 'the offending VALUE must never appear in the thrown message');
    return true;
  });
});

test('a secret in ANY string field is caught, not just well-known ones — e.g. an imported chunk_text', () => {
  const row = { content_hash: 'x'.repeat(64), chunk_text: 'reminder: our AWS key is AKIAIOSFODNN7EXAMPLE, rotate it after the demo' };
  assert.throws(() => redactRow(row), (e) => {
    assert.match(e.message, /field "chunk_text"/);
    return true;
  });
});

test('non-string fields (numbers, arrays, booleans) are never scanned — nothing to match against', () => {
  const row = { task_seq: 1, depends_on: ['1', '2'], equipped: true, files_declared: ['a.js'] };
  assert.deepEqual(redactRow(row), row);
});

// --- the high-entropy-near-key-like-field-name heuristic -----------------------------------------------------
//
// No field in the current ontology (ee/src/grid/types.json) is actually named "token"/"secret"/"password" —
// this heuristic is forward-looking defense-in-depth for a future field or a caller-supplied row shape this
// package doesn't control, tested directly against the function rather than against a real GRID_TYPES field.

test('a high-entropy value under a key-shaped field NAME is blocked even with no recognizable pattern', () => {
  const row = { some_token: 'aZ9k2mQ7xR4vL8nT1pC6wS3jH0yF5bD2gK9uM7rN4eV1' }; // random-looking, no prefix, no "=" — pattern-blind on purpose
  assert.throws(() => redactRow(row), /high-entropy secret/);
});

test('the SAME high-entropy value under an ordinary field name is NOT blocked — field context is what matters, not the value alone', () => {
  const row = { chunk_text: 'aZ9k2mQ7xR4vL8nT1pC6wS3jH0yF5bD2gK9uM7rN4eV1' };
  assert.deepEqual(redactRow(row), row);
});

test('a SHORT value under a key-shaped field name is not blocked by the entropy heuristic (too short to judge)', () => {
  const row = { auth_token: 'short' };
  assert.deepEqual(redactRow(row), row);
});

// --- structural: every real /ingest call in ee/ goes through ingestRows(), which redacts ---------------------

test('structural: the ONLY place in ee/ that constructs a raw POST /ingest request is ingestRows() itself', () => {
  const offenders = [];
  const roots = ['ee/src', 'ee/console'].map((p) => path.join(REPO_ROOT, p));
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && !full.endsWith(`${path.sep}ontology.js`)) {
        const content = fs.readFileSync(full, 'utf8');
        if (/path:\s*['"]\/ingest['"]/.test(content)) offenders.push(full);
      }
    }
  };
  for (const root of roots) walk(root);
  assert.deepEqual(offenders, [], 'a raw /ingest call outside ontology.js would bypass ingestRows()\'s redaction entirely — see redact.js\'s own doc comment for why this must be the one choke point');
});

test('structural: ingestRows() itself calls redactRow on every row before ever reaching the network', () => {
  const content = fs.readFileSync(path.join(REPO_ROOT, 'ee/src/grid/ontology.js'), 'utf8');
  assert.match(content, /redactRow\(row\)/, 'ontology.js must actually call redactRow, not just import it');
});
