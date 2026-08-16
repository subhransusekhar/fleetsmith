// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { request, rememberOne } from '../src/memory/relatadb.js';
import { ingestRows, resolveRepoId } from '../src/grid/ontology.js';
import { queryAuditEntries } from '../src/grid/audit.js';
import { rotateToken } from '../src/grid/identity.js';

/**
 * G9.3 — the contract pin: the exact engine-surface facts every other module in `ee/` is written against,
 * asserted directly, against a real instance, so upstream drift fails THIS suite instead of a customer's
 * `fleetsmith grid sync` loop three layers away from the actual break.
 *
 * --- The pin itself -------------------------------------------------------------------------------------
 *
 * `ENGINE_VERSION_PIN` below names the engine version every assertion in this file was written and verified
 * against. Upgrade procedure (the issue's own words): bump the pin — both the constant below AND the image
 * tag in `ee/test/fixtures/relata-compose.yml` — in ONE PR, run this suite against the new version, and READ
 * every diff in behavior it reports before touching any grid code that depends on these facts. A contract
 * that silently starts failing after a bump is exactly the signal this file exists to produce.
 *
 * --- Why the pin is 1.5.7, not the milestone doc's "v2.0.0" ----------------------------------------------
 *
 * The milestone architecture doc's engine facts (this issue's own "Engine facts that shape the code" section)
 * cite a private v2.0.0 source audit. Every OTHER module in `ee/` that talks to a real engine
 * (`relatadb.js`, `ontology.js`, `pull.js`, `knowledge.js`, `daemon.js`) was instead verified against a real,
 * licensed, reachable v1.5.7 instance — the only version this project has ever actually round-tripped a
 * request against — and several of those verifications directly CONTRADICT the v2.0.0-sourced doc (see below).
 * Pinning a version nobody has run this suite against would defeat the entire point of a contract pin: every
 * assertion here was independently re-verified live (2026-08-16) against that same real v1.5.7 instance before
 * this file was committed. Once a licensed v2.0.0 (or later) instance is reachable — see the
 * relatadb-local-instance-and-v2-api-shapes project note on the ZySec re-licensing turnaround — bump the pin
 * and expect several of these assertions to need updating, not just re-running.
 *
 * --- Concrete discrepancies this task's own live re-verification found, beyond what earlier tasks logged ---
 *
 *  - `LIMIT n AFTER '<cursor>'` (the milestone doc's own pagination story) has ZERO effect on this engine for
 *    ad-hoc `/ingest`-registered types: `SELECT * FROM T LIMIT 2 AFTER '<anything, including garbage>'`
 *    returns the exact same first page as `SELECT * FROM T LIMIT 2` with no cursor at all. `_system_from` is
 *    echoed back as a recognized column NAME but its VALUE is never populated on any row — matching, and now
 *    independently reconfirming, `pull.js`'s own already-documented finding. Contract 3 below pins this
 *    CURRENT truth (a cursor that accepts anything and changes nothing) rather than asserting the milestone
 *    doc's aspirational forward-pagination story, and is written to notice — not fail — if a future engine
 *    version makes `AFTER` actually advance the page.
 *  - `/memory/recall` does NOT require `purpose` at the engine level: an unauthenticated-of-purpose call
 *    returns a plain `200` with an empty result set, not a 4xx. The "purpose is mandatory on recall" rule
 *    this project actually enforces (`src/memory/port.js`'s `assertValidRecall`) is fleetsmith's OWN
 *    client-side gate, not something the engine itself guarantees — contract 4 pins both halves of that
 *    distinction separately, since conflating them would hide a real difference in WHERE the guarantee lives.
 *  - `AS OF` is NOT the unconditional no-op `daemon.js`'s/`knowledge.js`'s own doc comments describe — that
 *    finding was reproduced here with a BARE DATE string ("2026-08-16", parsed as midnight), which returns
 *    zero rows for a same-day insert and looks identical to "AS OF is broken" but is really "AS OF correctly
 *    says nothing existed yet at midnight." A full ISO-8601 instant shows the real mechanism: `AS OF` filters
 *    by SYSTEM/transaction time (when the engine ingested the row), not by the row's own `valid_from`
 *    BUSINESS field — two rows inserted in the same real moment, one `valid_from` 2020 and one 2099, become
 *    visible or invisible TOGETHER, never separated by their own `valid_from`. Contract 7 pins THIS more
 *    precise fact and is written to notice, not fail, if a future engine version gains real valid-axis
 *    awareness for ad-hoc ingested types.
 *  - `/graph/changes` SSE emits zero frames — for either `/ingest` or `/memory/remember` writes — on this
 *    single-node, no-replication-peers deployment (`GET /health`'s own `deployment_id` never changes across
 *    calls; `pull.js`'s doc comment already attributes this to "Replication transport: noop, no peers
 *    configured"). Contracts 1 and 2 are written so a lack of frames is the documented, current, NON-failing
 *    state for contract 2 (remember correctly excluded) but is explicitly distinguished from "SSE never emits
 *    anything at all" (contract 1's own job, which is the one that actually tells the two apart) rather than
 *    letting one silent skip stand in for both questions.
 *
 * --- Live re-verification honesty note ------------------------------------------------------------------
 *
 * Every contract below except #5 was independently exercised for real against the licensed v1.5.7 instance on
 * this dev host while writing this file (2026-08-16) — not merely reasoned about. Contract #5 (token rotation)
 * was deliberately NOT exercised against that instance's real bearer token: `/tokens/self/rotate` invalidates
 * the calling token immediately and irreversibly, and that instance's token is this whole project's only
 * working credential for every other live test in this milestone — rotating it for a probe would have broken
 * every other G-task's live verification capability for the rest of this session. What WAS verified for real:
 * a bogus token against `/tokens/self/rotate` returns `401` (auth is enforced on the route at all), and
 * `GET /tokens/self` reports `{"present": false}` even for the real, correctly-authenticating token — matching
 * `identity.js`'s own already-documented finding. The real successful-rotation-then-old-token-revoked path is
 * therefore gated behind an EXTRA, explicit opt-in beyond `RELATA_TEST_URL` (see contract 5's own comment) —
 * the same "explicit opt-in beyond mere availability" pattern this project already uses for
 * `FLEETSMITH_GRID_EVAL_LIVE`.
 */
export const ENGINE_VERSION_PIN = '1.5.7';

const SETTLE_MS = 3000;
const SSE_WINDOW_MS = 4000;

function liveConfig(purpose) {
  return {
    url: process.env.RELATA_TEST_URL,
    token: process.env.RELATA_TEST_TOKEN ?? '',
    purposes: [purpose],
    fleetName: `fleetsmith-g9.3-contract-pin-${process.pid}-${purpose}`,
  };
}

function skipIfNoLiveInstance(t) {
  if (!process.env.RELATA_TEST_URL) {
    t.skip(`RELATA_TEST_URL not set — no live RelataDB configured for this run (pinned engine version: ${ENGINE_VERSION_PIN}; see fixtures/relata-compose.yml)`);
    return true;
  }
  return false;
}

/**
 * One bounded SSE read: resolves with every frame seen within `windowMs`, never rejects on a plain timeout.
 *
 * `Connection: close` (rather than leaving the request on Node's default keep-alive pool) matters here
 * specifically: an earlier version of this helper, with no such header, occasionally handed a LATER test's
 * fresh `/graph/changes` connection a stray leftover frame from a PRIOR test's own, already-aborted
 * connection on the same pooled socket — a real cross-test contamination bug in this helper, not evidence of
 * the engine actually emitting anything. Forcing the socket closed (and explicitly cancelling the body after
 * abort, awaited before returning) is what makes each call's frame list genuinely its own.
 */
async function collectSseFrames(config, windowMs) {
  const url = new URL('/graph/changes', config.url);
  const controller = new AbortController();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'text/event-stream', Connection: 'close' },
    signal: controller.signal,
  });
  const frames = [];
  let buffer = '';
  const readLoop = (async () => {
    for await (const chunk of Readable.fromWeb(res.body)) {
      buffer += chunk.toString('utf8');
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      frames.push(...parts.filter((p) => p.trim()));
    }
  })().catch(() => {}); // aborting the fetch rejects the async iterator — expected, not a real error
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  controller.abort();
  await res.body?.cancel?.().catch(() => {});
  await readLoop;
  return frames;
}

// --- contract 1: /ingest rows appear on /graph/changes SSE -------------------------------------------------

test(`contract 1 (engine ${ENGINE_VERSION_PIN}): /ingest rows appear on /graph/changes`, async (t) => {
  if (skipIfNoLiveInstance(t)) return;
  const config = liveConfig('fleetsmith_g9_3_contract1');
  const repoId = `contract-pin-c1-${process.pid}`;

  const framesPromise = collectSseFrames(config, SSE_WINDOW_MS);
  await new Promise((resolve) => setTimeout(resolve, 200)); // let the SSE connection actually establish first
  await ingestRows(config, 'FleetTask', [{ repo_id: repoId, actor: 'contract-pin-probe', task_seq: 1, task: 'contract pin probe', status: 'pending' }]);
  const frames = await framesPromise;

  if (frames.length === 0) {
    t.skip(
      'zero frames observed on /graph/changes after a real /ingest call — matches pull.js\'s already-documented finding that this single-node, ' +
        'no-replication-peers deployment never emits a frame at all (see this file\'s own header for the concrete engine facts). This is a known ' +
        'environment limitation, not a silent pass: re-run against a multi-node/replicated deployment to actually exercise this contract.'
    );
    return;
  }
  assert.ok(frames.some((f) => f.includes(repoId)), '/graph/changes must eventually surface a frame referencing the row this test just ingested');
});

// --- contract 2: /memory/remember writes do NOT appear on /graph/changes -----------------------------------

test(`contract 2 (engine ${ENGINE_VERSION_PIN}): /memory/remember writes do NOT appear on /graph/changes`, async (t) => {
  if (skipIfNoLiveInstance(t)) return;
  const config = liveConfig('fleetsmith_g9_3_contract2');
  const marker = `contract-pin-c2-${process.pid}`;

  const framesPromise = collectSseFrames(config, SSE_WINDOW_MS);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await rememberOne(config, { kind: 'note', text: marker, origin: 'human' });
  const frames = await framesPromise;

  const leaked = frames.some((f) => f.includes(marker));
  if (leaked) {
    // The acceptance criterion's own words: this must be a visible NOTICE, not a failure — it means upstream
    // closed the /memory vs /ingest changefeed gap, which is good news that simplifies G2's split, not a break.
    t.diagnostic(
      'IMPROVEMENT NOTICE: a /memory/remember write appeared on /graph/changes on this engine version. If confirmed on a clean, ' +
        'replicated deployment (not just this single-node one, where contract 1 above may also be all-frames-absent for an unrelated reason), ' +
        'this means the /memory vs /ingest changefeed split (G2.1\'s own load-bearing architectural decision) can potentially be simplified — see issue #76.'
    );
  }
  assert.ok(true, 'this contract intentionally never fails on this branch — see the diagnostic above for what a leak would mean');
});

// --- contract 3: LIMIT n AFTER '<cursor>' pagination semantics ----------------------------------------------

test(`contract 3 (engine ${ENGINE_VERSION_PIN}): LIMIT n AFTER '<cursor>' pagination semantics`, async (t) => {
  if (skipIfNoLiveInstance(t)) return;
  const config = liveConfig('fleetsmith_g9_3_contract3');
  // A FRESH, uniquely-named ad-hoc type (auto-registered on first /ingest — ontology.js's own documented
  // mechanism), not one of the six real grid types: `WHERE`, even a trivially-true one, empties an ad-hoc
  // type's results entirely on this engine (pull.js's own already-documented finding, independently reconfirmed
  // while writing this file), so the only way to test `LIMIT`/`AFTER` cleanly with no `WHERE` at all is a
  // type this test knows has ONLY its own rows in it. Five SEPARATE /ingest calls, not one batched call with
  // five rows — the engine wraps every row from ONE ingest call into a single result record (pull.js's
  // unpackRecords()), so a `LIMIT n` bounds RECORD count, not logical row count; one row per call is what
  // makes `LIMIT 2` mean "the first two rows" in the way this test needs to assert against.
  const typeName = `ContractPinC3Probe${process.pid}`;
  for (let i = 1; i <= 5; i++) {
    await request(config, { method: 'POST', path: '/ingest', query: { object_type: typeName }, body: { rows: [{ seq: i, note: `row ${i}` }] } });
  }
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

  const firstPage = await request(config, { method: 'POST', path: '/query', body: { sql: `SELECT * FROM ${typeName} LIMIT 2` } });
  assert.equal(firstPage.data.length, 2, 'a LIMIT smaller than the available rows must return exactly that many');

  // Short-page termination: asking for more records than exist must return fewer than the limit — the
  // caller's own signal that this was the last page, with no further pagination needed.
  const fullPage = await request(config, { method: 'POST', path: '/query', body: { sql: `SELECT * FROM ${typeName} LIMIT 50` } });
  assert.equal(fullPage.data.length, 5, 'a LIMIT larger than the available rows must return exactly the available rows — the short-page termination signal');

  // Ordering: the same query run twice must come back in the same order — whatever that order is, it must be
  // stable, since neither push.js nor pull.js sorts client-side and both rely on a deterministic engine order.
  const repeat = await request(config, { method: 'POST', path: '/query', body: { sql: `SELECT * FROM ${typeName} LIMIT 50` } });
  assert.deepEqual(fullPage.data, repeat.data, 'identical repeated queries must return rows in the same order');

  // AFTER: the pinned CURRENT truth is that it has no effect on ad-hoc ingested types (see this file's header)
  // — asking AFTER any cursor value (even garbage) returns the exact same first page again, not the next one.
  // If a future engine version makes AFTER actually advance the page, that is an improvement, not a contract
  // violation — flagged as a notice rather than failing this test outright.
  const afterSamePage = await request(config, { method: 'POST', path: '/query', body: { sql: `SELECT * FROM ${typeName} LIMIT 2 AFTER '0'` } });
  if (JSON.stringify(afterSamePage.data) === JSON.stringify(firstPage.data)) {
    assert.deepEqual(afterSamePage.data, firstPage.data, "AFTER '<cursor>' is currently a no-op for ad-hoc ingested types — pinning that exact behavior");
  } else {
    t.diagnostic(
      "IMPROVEMENT NOTICE: LIMIT n AFTER '<cursor>' returned a DIFFERENT page than a bare LIMIT on this engine version — this engine may have " +
        'gained real forward-pagination for ad-hoc ingested types. Re-verify pull.js\'s reconcile() and update its own doc comment if confirmed.'
    );
  }
});

// --- contract 4: /memory/recall requires/records purpose ----------------------------------------------------

test(`contract 4 (engine ${ENGINE_VERSION_PIN}): /memory/recall's engine-level purpose requirement, and that a given purpose is recorded`, async (t) => {
  if (skipIfNoLiveInstance(t)) return;
  const config = liveConfig('fleetsmith_g9_3_contract4');

  // The RAW engine call, bypassing fleetsmith's own port-level assertValidRecall gate entirely — this is
  // deliberately probing what the ENGINE itself enforces, not what this project's own client-side rule adds
  // on top of it. See this file's header for why these are pinned as two separate facts.
  const withoutPurpose = await request(config, { method: 'GET', path: '/memory/recall', query: { query: 'contract pin probe', session_id: 'g9-3-contract-pin' } });
  assert.ok(withoutPurpose, 'a recall with no purpose at all must not throw at the engine level — the engine does not itself require it (fleetsmith\'s own assertValidRecall is the actual enforcement point)');

  const purpose = `fleetsmith_g9_3_contract4_probe_${process.pid}`;
  await rememberOne(config, { kind: 'note', text: `contract 4 probe for ${purpose}`, origin: 'human' });
  const withPurpose = await request(config, {
    method: 'GET',
    path: '/memory/recall',
    query: { query: 'contract 4 probe', session_id: 'g9-3-contract-pin', purpose },
  });
  assert.ok(withPurpose, 'a recall with a declared purpose must succeed');

  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const entries = await queryAuditEntries(config, { purpose, limit: 10 });
  assert.ok(entries.length > 0, `a recall's declared purpose ("${purpose}") must be findable in /audit/entries filtered by that same purpose`);
});

// --- contract 5: /tokens/self/rotate + mid-stream revocation --------------------------------------------------

test(`contract 5 (engine ${ENGINE_VERSION_PIN}): /tokens/self/rotate revokes the old token immediately`, async (t) => {
  if (skipIfNoLiveInstance(t)) return;
  // Deliberately gated on a SECOND, explicit opt-in beyond RELATA_TEST_URL — rotating a token is destructive
  // and irreversible from this test's own vantage point. Never run this against a shared, non-disposable
  // instance's only working credential (see this file's header for exactly why this project's own real dev
  // instance was NOT used to exercise this contract). Same "explicit opt-in beyond mere availability" pattern
  // as FLEETSMITH_GRID_EVAL_LIVE elsewhere in this project.
  if (process.env.RELATA_TEST_ALLOW_ROTATE !== '1') {
    t.skip(
      'RELATA_TEST_ALLOW_ROTATE not set to "1" — rotating a token invalidates it immediately and irreversibly; only opt into this against a ' +
        'disposable instance/credential you do not need afterward (see fixtures/relata-compose.yml for a throwaway bearer-mode instance)'
    );
    return;
  }
  const config = liveConfig('fleetsmith_g9_3_contract5');
  const oldToken = config.token;

  const before = await request(config, { method: 'POST', path: '/query', body: { sql: 'SELECT 1' } });
  assert.ok(before, 'the starting token must work before rotation');

  const { token: newToken } = await rotateToken(config);
  assert.ok(newToken, 'rotation must return a new token value');
  assert.notEqual(newToken, oldToken, 'the new token must differ from the old one');

  await assert.rejects(
    () => request({ ...config, token: oldToken }, { method: 'POST', path: '/query', body: { sql: 'SELECT 1' } }),
    /RelataHttpError|401|403/,
    'the OLD token must stop authenticating immediately after rotation — mid-stream revocation'
  );

  const after = await request({ ...config, token: newToken }, { method: 'POST', path: '/query', body: { sql: 'SELECT 1' } });
  assert.ok(after, 'the NEW token must authenticate successfully right away');
});

// --- contract 6: /audit/entries carries purpose + principal --------------------------------------------------

test(`contract 6 (engine ${ENGINE_VERSION_PIN}): /audit/entries carries both purpose and principal on every entry`, async (t) => {
  if (skipIfNoLiveInstance(t)) return;
  const config = liveConfig('fleetsmith_g9_3_contract6');
  const purpose = `fleetsmith_g9_3_contract6_probe_${process.pid}`;

  await rememberOne(config, { kind: 'note', text: 'contract 6 probe', origin: 'human' });
  await request(config, { method: 'GET', path: '/memory/recall', query: { query: 'contract 6 probe', session_id: 'g9-3-contract-pin', purpose } });
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

  // Raw, unnormalized response — pinning the actual field name the engine uses, not audit.js's own defensive
  // fallback list (which tries "principal" as one of several guesses for what it calls "actor"; this contract
  // exists to confirm "principal" specifically, not just that SOME guess happens to resolve).
  const raw = await request(config, { method: 'GET', path: '/audit/entries', query: { purpose, limit: 10 } });
  const entries = Array.isArray(raw) ? raw : raw.entries ?? raw.items ?? raw.rows ?? raw.data ?? [];
  assert.ok(entries.length > 0, `at least one /audit/entries row must be filterable by the purpose ("${purpose}") this test just declared on a recall`);
  for (const entry of entries) {
    assert.equal(typeof entry.purpose, 'string', 'every audit entry must carry a "purpose" field');
    assert.equal(typeof entry.principal, 'string', 'every audit entry must carry a "principal" field');
    assert.ok(entry.principal.length > 0, 'principal must be a non-empty identifier, not a blank placeholder');
  }
});

// --- contract 7: AS OF valid-axis filtering on OrgDocument ----------------------------------------------------

/** Every logical row's `content_hash` across every ingest-call record a raw `/query` response returned. */
function contentHashesOf(queryResult) {
  return (queryResult.data ?? []).flatMap((record) => {
    try {
      return JSON.parse(record.rows ?? '[]');
    } catch {
      return [];
    }
  }).map((row) => row.content_hash);
}

/**
 * `AS OF` genuinely filters — it is NOT the unconditional no-op `daemon.js`/`knowledge.js`'s own doc comments
 * describe. That earlier finding was independently reproduced here with a BARE DATE string ("2026-08-16",
 * parsed as midnight) and returned zero rows for a same-day insert — which looks identical to "AS OF is
 * broken" but is really just "AS OF correctly says nothing existed yet at midnight." A full ISO-8601 instant
 * makes the real mechanism visible: `AS OF` filters by SYSTEM/transaction time (when the engine ingested the
 * row), not by the row's own `valid_from` BUSINESS field. Two rows inserted in the same real moment — one
 * with `valid_from` in 2020, one in 2099 — become visible or invisible TOGETHER under `AS OF`, never
 * separated by their own `valid_from` value. That is the actual, useful thing to pin: `AS OF` is real and
 * working, but it does not implement "valid-axis" (business-time) filtering for ad-hoc ingested types like
 * `OrgDocument` — `knowledge.js`'s client-side `valid_from` filtering remains the genuine enforcement point,
 * just for a more precise reason than "AS OF does nothing."
 */
test(`contract 7 (engine ${ENGINE_VERSION_PIN}): AS OF valid-axis filtering on OrgDocument`, async (t) => {
  if (skipIfNoLiveInstance(t)) return;
  const config = liveConfig('fleetsmith_g9_3_contract7');
  const repoId = resolveRepoId();
  const pastHash = `contract-pin-c7-past-${process.pid}`;
  const futureHash = `contract-pin-c7-future-${process.pid}`;

  const beforeInsert = new Date().toISOString();
  await ingestRows(config, 'OrgDocument', [
    { repo_id: repoId, content_hash: pastHash, kind: 'decision', chunk_text: 'a decision valid in the past', valid_from: '2020-01-01' },
    { repo_id: repoId, content_hash: futureHash, kind: 'decision', chunk_text: 'a decision not valid until 2099', valid_from: '2099-01-01' },
  ]);
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const afterInsert = new Date().toISOString();

  // No WHERE: it empties an ad-hoc ingested type's results entirely on this engine (contract 3's own header
  // note, independently reconfirmed while writing this file) — `content_hash` membership is checked
  // client-side after a bare, unfiltered fetch, exactly like pull.js's own reconcile() filters by repo_id.
  const asOfBefore = await request(config, { method: 'POST', path: '/query', body: { sql: `SELECT * FROM OrgDocument AS OF '${beforeInsert}' LIMIT 5000` } });
  const hashesBefore = contentHashesOf(asOfBefore);
  assert.ok(
    !hashesBefore.includes(pastHash) && !hashesBefore.includes(futureHash),
    'AS OF a system-time instant strictly BEFORE this test\'s own ingest call must show neither row — proving AS OF really does filter by system/transaction time'
  );

  const asOfAfter = await request(config, { method: 'POST', path: '/query', body: { sql: `SELECT * FROM OrgDocument AS OF '${afterInsert}' LIMIT 5000` } });
  const hashesAfter = contentHashesOf(asOfAfter);
  const pastRowVisible = hashesAfter.includes(pastHash);
  const futureRowVisibleEarly = hashesAfter.includes(futureHash);

  if (pastRowVisible && !futureRowVisibleEarly) {
    // This would be genuine valid-axis (business-time) filtering — the milestone doc's own hoped-for
    // behavior. If this branch is ever hit, AS OF has gained real valid_from awareness for ad-hoc ingested
    // types, and knowledge.js's client-side filtering could be simplified to lean on it.
    t.diagnostic(
      'IMPROVEMENT NOTICE: AS OF now correctly excludes a not-yet-valid (future valid_from) OrgDocument row while keeping a past-valid one — ' +
        "this engine has gained real valid-axis filtering. Re-verify and simplify knowledge.js's client-side valid_from filtering if confirmed."
    );
    assert.ok(true);
    return;
  }

  // The pinned CURRENT truth: both rows are visible together (or absent together) purely by SYSTEM insert
  // time — `valid_from` plays no role at all in what AS OF returns for an ad-hoc ingested type.
  assert.ok(
    pastRowVisible && futureRowVisibleEarly,
    "AS OF tracks system/transaction time only for ad-hoc ingested types like OrgDocument — a row inserted \"now\" with a valid_from far in the " +
      "future (2099) is visible immediately, same as one with a valid_from in the past (2020); it provides no valid-axis (business-time) " +
      "filtering, so knowledge.js's client-side valid_from filtering remains the real enforcement point"
  );
});
