// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withDegradation } from '../src/memory/degrade.js';
import { relatadbBackend } from '../src/memory/relatadb.js';
import { RelataNetworkError, RelataHttpError, RelataToolError, RelataMalformedResponseError } from '../src/memory/errors.js';
import { fileBackend } from 'fleetsmith/memory/file';
import { normalizeSpec } from 'fleetsmith/spec';
import { MemoryError } from 'fleetsmith/memory/port';

/**
 * A scriptable fake relata backend — this suite tests `degrade.js`'s OWN
 * decision logic (when to trip, when to fall back for one call vs. forever,
 * what never trips), not RelataDB's wire format. That is G1.2/G1.3's job,
 * already covered against a real instance.
 */
function scriptedRelata(script) {
  let call = 0;
  const calls = [];
  const behavior = (verb) => async (...args) => {
    calls.push(verb);
    const next = script[calls.length - 1];
    call++;
    if (!next) throw new Error(`scriptedRelata: no script entry for call #${call} (verb ${verb})`);
    if (next.throws) throw next.throws;
    return next.returns;
  };
  return {
    calls,
    backend: {
      remember: behavior('remember'),
      recall: behavior('recall'),
      consolidate: behavior('consolidate'),
      forget: behavior('forget'),
      justify: behavior('justify'),
    },
  };
}

function realFileBackend() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-degrade-'));
  const spec = normalizeSpec({ fleet: { name: 'degrade-test' }, agents: [{ name: 'a', role: 'r' }] });
  return { dir, backend: fileBackend({ spec, cwd: dir }) };
}

function capturingOnDegrade() {
  const calls = [];
  return { calls, onDegrade: (reason) => calls.push(reason) };
}

// --- kill-the-server: the acceptance scenario, named verbatim -------------

test('kill-the-server: calls before the failure hit relata, calls after return file-backend results, exactly one warning', async () => {
  const { dir, backend: file } = realFileBackend();
  const { onDegrade, calls: warnings } = capturingOnDegrade();
  const { backend: relata, calls: relataCalls } = scriptedRelata([
    { returns: { id: 'relata-1' } }, // remember #1 — relata is "up"
    { throws: new RelataNetworkError('connect ECONNREFUSED 127.0.0.1:9090') }, // the "kill"
    // No more script entries: if degrade.js tries relata again after this,
    // scriptedRelata itself throws "no script entry" and fails the test.
  ]);
  const wrapped = withDegradation(relata, file, { onDegrade });

  const before = await wrapped.remember({ kind: 'note', text: 'before the kill', origin: 'human' });
  assert.equal(before.id, 'relata-1');
  assert.equal(relataCalls.length, 1, 'the call before the kill must reach relata');

  const after1 = await wrapped.remember({ kind: 'note', text: 'right after the kill', origin: 'human' });
  const after2 = await wrapped.remember({ kind: 'note', text: 'well after the kill', origin: 'human' });
  assert.ok(after1.id && after1.id !== 'relata-1', 'post-kill remember must be served by the file backend');
  assert.ok(after2.id);
  assert.equal(relataCalls.length, 2, 'relata must not be tried again once degraded');

  assert.equal(warnings.length, 1, 'exactly one warning, not one per subsequent call');
  assert.match(warnings[0], /RelataNetworkError/);

  fs.rmSync(dir, { recursive: true, force: true });
});

// --- immediate-trip conditions ---------------------------------------------

test('401 trips immediately, on the first occurrence', async () => {
  const { dir, backend: file } = realFileBackend();
  const { onDegrade, calls: warnings } = capturingOnDegrade();
  const { backend: relata } = scriptedRelata([{ throws: new RelataHttpError('unauthorized', { status: 401 }) }, { returns: {} }]);
  const wrapped = withDegradation(relata, file, { onDegrade });

  const res = await wrapped.consolidate();
  assert.ok(typeof res.before === 'number', 'falls back to the file backend for this same call');
  assert.equal(warnings.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('403 trips immediately', async () => {
  const { dir, backend: file } = realFileBackend();
  const { onDegrade, calls: warnings } = capturingOnDegrade();
  const { backend: relata, calls: relataCalls } = scriptedRelata([{ throws: new RelataHttpError('forbidden', { status: 403 }) }, { returns: {} }]);
  const wrapped = withDegradation(relata, file, { onDegrade });
  await wrapped.consolidate();
  assert.equal(warnings.length, 1);
  await wrapped.consolidate();
  assert.equal(relataCalls.length, 1, 'relata must not be tried again once tripped');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a 4xx body reading like license exhaustion trips immediately', async () => {
  const { dir, backend: file } = realFileBackend();
  const { onDegrade, calls: warnings } = capturingOnDegrade();
  const { backend: relata } = scriptedRelata([
    { throws: new RelataHttpError('RelataDB GET /memory/recall -> HTTP 402: license exhausted, grace period ended', { status: 402 }) },
  ]);
  const wrapped = withDegradation(relata, file, { onDegrade });
  await assert.doesNotReject(() => wrapped.consolidate());
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /license exhausted/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('G9.1: a garbage/malformed response (RelataMalformedResponseError) trips immediately, exactly like an unreachable cortex', async () => {
  const { dir, backend: file } = realFileBackend();
  const { onDegrade, calls: warnings } = capturingOnDegrade();
  const { backend: relata, calls: relataCalls } = scriptedRelata([
    { throws: new RelataMalformedResponseError('RelataDB GET /memory/recall -> HTTP 200 with a non-JSON body: <<<garbage>>>') },
    { returns: { id: 'should-not-be-reached' } },
  ]);
  const wrapped = withDegradation(relata, file, { onDegrade });

  const result = await wrapped.consolidate();
  assert.ok(typeof result.before === 'number', 'falls back to the file backend for this same call — never a crash');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /RelataMalformedResponseError/);

  await wrapped.consolidate();
  assert.equal(relataCalls.length, 1, 'relata must not be tried again once tripped — a garbled response gets no more benefit of the doubt than a network failure');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a 4xx that merely mentions "license" without exhaustion language does NOT trip (not counted either — it is not a 5xx)', async () => {
  const { dir, backend: file } = realFileBackend();
  const { onDegrade, calls: warnings } = capturingOnDegrade();
  const { backend: relata } = scriptedRelata([
    { throws: new RelataHttpError('HTTP 400: license field malformed in request', { status: 400 }) },
    { returns: { id: 'still-relata' } },
  ]);
  const wrapped = withDegradation(relata, file, { onDegrade });
  await assert.rejects(() => wrapped.remember({ kind: 'note', text: 'x', origin: 'human' }), RelataHttpError);
  assert.equal(warnings.length, 0, 'a plain 4xx that is not 401/403 and does not read as license exhaustion must not trip');
  const second = await wrapped.remember({ kind: 'note', text: 'y', origin: 'human' });
  assert.equal(second.id, 'still-relata', 'relata must still be tried on the next call');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- counted 5xx: a single one does not trip, three in a row does ----------

test('a single transient 500 does not trip — falls back for that call, tries relata again next call', async () => {
  const { dir, backend: file } = realFileBackend();
  const { onDegrade, calls: warnings } = capturingOnDegrade();
  const { backend: relata, calls: relataCalls } = scriptedRelata([
    { throws: new RelataHttpError('HTTP 503: temporarily unavailable', { status: 503 }) },
    { returns: { id: 'relata-recovered' } },
  ]);
  const wrapped = withDegradation(relata, file, { onDegrade });

  const first = await wrapped.remember({ kind: 'note', text: 'during the blip', origin: 'human' });
  assert.ok(first.id !== 'relata-recovered', 'the failed call itself falls back to file, not an error to the caller');
  assert.equal(warnings.length, 0, 'one transient 500 must not trip the breaker');

  const second = await wrapped.remember({ kind: 'note', text: 'after recovery', origin: 'human' });
  assert.equal(second.id, 'relata-recovered', 'relata must be tried again — not yet degraded');
  assert.equal(relataCalls.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('three consecutive 500s trip the breaker; the third call still gets a result, not an error', async () => {
  const { dir, backend: file } = realFileBackend();
  const { onDegrade, calls: warnings } = capturingOnDegrade();
  const { backend: relata } = scriptedRelata([
    { throws: new RelataHttpError('HTTP 500', { status: 500 }) },
    { throws: new RelataHttpError('HTTP 500', { status: 500 }) },
    { throws: new RelataHttpError('HTTP 500', { status: 500 }) },
    { returns: { id: 'must-not-be-called' } }, // proves no 4th relata attempt happens
  ]);
  const wrapped = withDegradation(relata, file, { onDegrade });

  await wrapped.remember({ kind: 'note', text: '1', origin: 'human' });
  assert.equal(warnings.length, 0);
  await wrapped.remember({ kind: 'note', text: '2', origin: 'human' });
  assert.equal(warnings.length, 0);
  const third = await wrapped.remember({ kind: 'note', text: '3', origin: 'human' });
  assert.ok(third.id, 'the tripping call itself still returns a usable result via the file backend');
  assert.equal(warnings.length, 1, 'exactly one warning, on the third failure');

  const fourth = await wrapped.remember({ kind: 'note', text: '4', origin: 'human' });
  assert.notEqual(fourth.id, 'must-not-be-called', 'once tripped, relata must never be called again');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a success resets the consecutive-5xx counter — 2 failures, 1 success, 2 more failures must not trip', async () => {
  const { dir, backend: file } = realFileBackend();
  const { onDegrade, calls: warnings } = capturingOnDegrade();
  const { backend: relata } = scriptedRelata([
    { throws: new RelataHttpError('HTTP 500', { status: 500 }) },
    { throws: new RelataHttpError('HTTP 500', { status: 500 }) },
    { returns: { id: 'ok' } }, // resets the streak
    { throws: new RelataHttpError('HTTP 500', { status: 500 }) },
    { throws: new RelataHttpError('HTTP 500', { status: 500 }) },
    { returns: { id: 'still-not-tripped' } },
  ]);
  const wrapped = withDegradation(relata, file, { onDegrade });
  for (let i = 0; i < 5; i++) await wrapped.remember({ kind: 'note', text: String(i), origin: 'human' });
  assert.equal(warnings.length, 0);
  const last = await wrapped.remember({ kind: 'note', text: 'last', origin: 'human' });
  assert.equal(last.id, 'still-not-tripped');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- never a trip condition -------------------------------------------------

test('RelataToolError (a caller-side bug, HTTP 200 isError:true) is never masked and never trips', async () => {
  const { dir, backend: file } = realFileBackend();
  const { onDegrade, calls: warnings } = capturingOnDegrade();
  const { backend: relata } = scriptedRelata([{ throws: new RelataToolError('missing required argument: content') }]);
  const wrapped = withDegradation(relata, file, { onDegrade });
  await assert.rejects(() => wrapped.remember({ kind: 'note', text: 'x', origin: 'human' }), RelataToolError);
  assert.equal(warnings.length, 0, 'a malformed-payload error must not degrade the whole process');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- port-contract errors still throw, unmasked -----------------------------

test('port-contract errors (missing purpose, an invalid item) still throw through the wrapper, never degrading anything', async () => {
  // Uses the REAL relatadbBackend (against an unreachable URL that is never
  // actually dialed) rather than the scripted stub above: assertValidRecall
  // / assertValidItem live inside relatadb.js itself and throw synchronously
  // before any network call, which a dumb stub cannot exercise honestly —
  // this proves the wrapper does not swallow or reclassify what relatadb.js
  // itself throws, not just that SOME error propagates.
  const { dir, backend: file } = realFileBackend();
  const { onDegrade, calls: warnings } = capturingOnDegrade();
  const relata = relatadbBackend({ url: 'http://127.0.0.1:1', token: 'x', fleetName: 'contract-error-test' });
  const wrapped = withDegradation(relata, file, { onDegrade });

  await assert.rejects(() => wrapped.recall('x', {}), MemoryError, 'missing purpose must still throw');
  await assert.rejects(() => wrapped.remember({ kind: 'nonsense', text: 'x' }), MemoryError, 'an invalid kind must still throw');
  assert.equal(warnings.length, 0, 'a validation error must never trip the breaker');
  fs.rmSync(dir, { recursive: true, force: true });
});
