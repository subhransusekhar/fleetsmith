// SPDX-License-Identifier: AGPL-3.0-only
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { request } from '../memory/relatadb.js';
import { GRID_TYPES } from './ontology.js';
import { resolveActor } from '../actor.js';

/**
 * The grid pull loop (G3.3): the SSE doorbell plus the cursor-driven reconcile that is the actual payload
 * path, and the always-on interval fallback that makes SSE non-load-bearing by construction.
 *
 * --- Why `reconcile()` is a full bounded scan, filtered CLIENT-side, not a true incremental server-side ----
 * --- cursor pull (verified 2026-08-16 against a fresh, isolated RelataDB v1.5.7 instance — this ------------
 * --- deployment's real behavior, not the milestone doc's v2.0.0-source-audit assumption) -------------------
 *
 *  - **A `WHERE` clause of ANY kind makes an ad-hoc `/ingest`-registered type return ZERO rows.** Confirmed
 *    directly: `SELECT * FROM T WHERE repo_id = '<real, matching value>'` → `{rows: 0, data: []}` against a
 *    type that a bare `SELECT * FROM T` (no WHERE at all) shows genuinely has matching data — and even a
 *    trivially-true `WHERE 1=1` empties the result the same way. This is the same shape of gap already hit
 *    in G1.3 (`recall()` has no server-side `subject` filter either) — so `repo_id` filtering here happens
 *    CLIENT-side, after an unfiltered fetch, exactly like `recall()`'s `subject`/exact-`kind` filtering.
 *  - `_system_from` is a real, recognized column name (the engine echoes it in the response's `columns`
 *    list) but its VALUE is never populated for an ad-hoc `/ingest`-registered type, in any query shape
 *    tried (`SELECT _system_from`, `SELECT _system_from, rows` — both return an empty `{}` per row). Only a
 *    bare `SELECT *` (no other clause at all) returns real data, and it wraps every row from ONE `/ingest`
 *    CALL into a single JSON array under a pseudo-column literally named `rows` — one result record per
 *    ingest call, not per logical row. There is therefore no per-row system time this adapter can read back
 *    on this engine surface today, and nothing real to seed `AFTER` with.
 *  - The SQL `LIMIT n` clause genuinely bounds the record count (verified: `LIMIT 2` returns exactly 2) and
 *    composes fine with `AFTER` (unlike `WHERE`, `LIMIT n AFTER '<cursor>'` still returns real data — verified
 *    against a type with no `WHERE` involved at all). `OFFSET` is a hard SQL parse error. `AFTER`'s actual
 *    filtering EFFECT could not be verified either way — there is nothing real to seed it with, per the point
 *    above — but including it, unlike `WHERE`, is at least harmless.
 *  - Result order is stable and matches insertion order across repeated identical queries (verified 3x) —
 *    enough to resolve "last write wins" for a natural key appearing in more than one record, by array
 *    position, without a real timestamp.
 *  - `/graph/changes` (the SSE changefeed) produced ZERO frames over repeated 10-15s windows with real
 *    `/ingest` calls happening mid-connection, both type-filtered and unfiltered. The server log's own
 *    `"Replication transport: noop (no peers configured)"` line is the likely reason: this single-node
 *    `free`-profile deployment has no replication transport configured, and the changefeed appears to ride
 *    on top of that. This is not a bug in this module — it is exactly the situation the milestone's own
 *    design already anticipated ("SSE is never load-bearing"; see the interval fallback below), and is why
 *    this module treats a live SSE connection as a nice-to-have, not something correctness depends on.
 *
 * Net effect: `reconcile()` fetches every record of a type (bounded by `PAGE_LIMIT`, no `WHERE`) every cycle,
 * then filters to `repoId` and away from the local actor client-side — rather than a true server-filtered
 * delta. This is CORRECT, not just tolerable, because G3.4's materialization is keyed and idempotent —
 * at-least-once delivery plus idempotent writes is an exactly-once *effect*, even though this is not an
 * exactly-once *transport*. Two real gaps this leaves, both surfaced via `warnings` rather than hidden:
 * (1) if a single type's total record count ACROSS EVERY REPO sharing this cortex ever exceeds `PAGE_LIMIT`,
 * older records (possibly this repo's own) become unreachable — there is no working `OFFSET`/`AFTER` to page
 * past the cap; (2) because filtering is client-side, one cortex serving many projects means every reconcile
 * cycle fetches every OTHER project's rows for a type too, not just this repo's — a real bandwidth/scaling
 * cost the milestone's "one cortex serves many projects" design did not anticipate needing to pay.
 */

export class PullError extends Error {}

const GRID_TYPE_NAMES = Object.keys(GRID_TYPES);
export const PAGE_LIMIT = 5000;
export const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
export const SSE_DEBOUNCE_MS = 1000;
export const SSE_MAX_BACKOFF_MS = 60_000;
export const SSE_INITIAL_BACKOFF_MS = 1000;

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** Write-temp-then-rename, per the issue's explicit instruction — a crash mid-write must never leave a half-written cursor file behind. */
function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function escapeSqlString(value) {
  return String(value).replace(/'/g, "''");
}

/** Unpacks one type's raw `/query` response — each record's `rows` pseudo-column holds the JSON array of every logical row from one `/ingest` call — into a flat, ordered list of `{typeName, row}`. A record that fails to parse is skipped, not fatal to the rest of the reconcile. */
function unpackRecords(typeName, queryResult) {
  const out = [];
  for (const record of queryResult?.data ?? []) {
    let rows;
    try {
      rows = JSON.parse(record.rows ?? '[]');
    } catch {
      continue;
    }
    for (const row of rows) out.push({ typeName, row });
  }
  return out;
}

/**
 * One full reconcile pass across all four grid types, scoped to `repoId`. Returns every row NOT attributed
 * to `actor` (you are not your own peer) — `warnings` names any per-type query failure or page-limit
 * truncation, never throws for those; only a malformed `repoId` is refused outright (a caller bug, not a
 * degradable network condition).
 */
export async function reconcile(config, repoId, opts = {}) {
  if (!/^[0-9a-f]{64}$/i.test(repoId)) {
    throw new PullError(`reconcile: repoId "${repoId}" does not look like a resolveRepoId() SHA-256 hash`);
  }
  const actor = opts.actor ?? resolveActor();
  const cursor = opts.cursor ?? null;
  const limit = opts.limit ?? PAGE_LIMIT;
  const purpose = config.purposes?.[0] ?? 'grid_sync';

  const warnings = [];
  const newRows = [];

  for (const typeName of GRID_TYPE_NAMES) {
    // No WHERE clause: a `WHERE` of any kind — even a trivially-true one — makes an ad-hoc
    // `/ingest`-registered type return zero rows on this engine (verified). `repo_id` is filtered below,
    // client-side, after fetching every record of this type regardless of which repo it belongs to.
    const sql = cursor ? `SELECT * FROM ${typeName} LIMIT ${limit} AFTER '${escapeSqlString(cursor)}'` : `SELECT * FROM ${typeName} LIMIT ${limit}`;

    let result;
    try {
      result = await request(config, { method: 'POST', path: '/query', body: { sql, purpose } });
    } catch (e) {
      warnings.push(`reconcile: query for ${typeName} failed: ${e.message}`);
      continue;
    }

    const unpacked = unpackRecords(typeName, result);
    if (unpacked.length >= limit) {
      warnings.push(`reconcile: ${typeName} hit the ${limit}-record page cap (across every repo sharing this cortex) — some rows, possibly this repo's own, may not have been fetched this cycle (see the module doc comment: there is no working OFFSET/AFTER to page past it today)`);
    }
    for (const entry of unpacked) {
      if (entry.row.repo_id !== repoId) continue; // this cortex may serve many projects — filtered client-side, the server won't
      if (entry.row.actor === actor) continue; // you are not your own peer
      newRows.push(entry);
    }
  }

  return { newRows, warnings };
}

/**
 * The one-shot CLI mode (`fleetsmith grid sync`, no `--watch`): reads the persisted cursor, reconciles once,
 * and persists whatever cursor value this cycle used — best-effort bookkeeping (see the module doc comment:
 * there is no real advancing position to persist on this engine surface today), kept mainly so a future
 * engine version that DOES honor `AFTER` benefits from it, and so `_fleet/local/grid/cursor`'s mtime is a
 * real "last successful reconcile" staleness signal for G3.4's rollup.
 */
export async function pullOnce(config, repoDir, opts = {}) {
  const localDir = opts.localDir ?? path.join(repoDir, '_fleet', 'local');
  const cursorPath = path.join(localDir, 'grid', 'cursor');
  const cursor = readIfExists(cursorPath)?.trim() || null;

  const { newRows, warnings } = await reconcile(config, opts.repoId, { ...opts, cursor });
  atomicWrite(cursorPath, cursor ? `${cursor}\n` : '');
  return { newRows, warnings };
}

/**
 * The SSE doorbell. Any frame schedules a debounced reconcile signal; a gap notice (the engine's own
 * slow-subscriber warning) or a stream error/close signals immediately, then reconnects with exponential
 * backoff (capped at `maxBackoffMs`). `onSignal({reason})` is the caller's hook — G3.5's daemon wires it to
 * an actual `reconcile()` call; this module only decides WHEN to ask for one, never performs one itself.
 *
 * Verified against a real instance: this stream produced literally nothing over repeated 10-15s windows
 * with concurrent `/ingest` calls (see the module doc comment) — every code path below except "stream never
 * emits, ever" is therefore exercised only by the mock SSE server in `pull.test.js`, not by a live instance.
 * That is by design, not a gap in this task: the milestone's own invariant is that SSE is never load-bearing,
 * and `startIntervalReconcile` below is what a real single-node deployment actually relies on.
 */
export function watchGridChanges(config, opts = {}) {
  const types = opts.types ?? GRID_TYPE_NAMES;
  const onSignal = opts.onSignal ?? (() => {});
  const debounceMs = opts.debounceMs ?? SSE_DEBOUNCE_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? SSE_MAX_BACKOFF_MS;
  const initialBackoffMs = opts.initialBackoffMs ?? SSE_INITIAL_BACKOFF_MS;
  const fetchImpl = opts.fetch ?? fetch;

  let stopped = false;
  let debounceTimer = null;
  let backoffMs = initialBackoffMs;
  let abortController = null;
  let reconnectTimer = null;

  function signal(reason) {
    if (reason === 'gap' || reason === 'sse-error') {
      clearTimeout(debounceTimer);
      onSignal({ reason });
      return;
    }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => onSignal({ reason }), debounceMs);
  }

  function parseFrames(buffer) {
    const frames = buffer.split('\n\n');
    const remainder = frames.pop(); // the last chunk may be incomplete — held back for the next read
    for (const frame of frames) {
      const isGap = /^event:\s*gap\b/im.test(frame) || /"type"\s*:\s*"gap"/.test(frame);
      signal(isGap ? 'gap' : 'sse');
    }
    return remainder;
  }

  async function connectOnce() {
    abortController = new AbortController();
    const url = new URL('/graph/changes', config.url);
    if (types.length) url.searchParams.set('type', types.join(','));

    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'text/event-stream' },
      signal: abortController.signal,
    });
    if (!res.ok || !res.body) {
      throw new PullError(`SSE connection to ${url} failed: HTTP ${res.status}`);
    }

    backoffMs = initialBackoffMs; // a successful connect resets backoff
    let buffer = '';
    for await (const chunk of Readable.fromWeb(res.body)) {
      buffer = parseFrames(buffer + chunk.toString('utf8'));
    }
  }

  async function loop() {
    while (!stopped) {
      try {
        await connectOnce();
        if (stopped) return;
        signal('sse-error'); // the stream ended (server closed it) — reconcile immediately, then reconnect
      } catch (e) {
        if (stopped) return;
        signal('sse-error');
      }
      if (stopped) return;
      await new Promise((resolve) => {
        reconnectTimer = setTimeout(resolve, backoffMs);
      });
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    }
  }

  loop();

  return {
    stop() {
      stopped = true;
      clearTimeout(debounceTimer);
      clearTimeout(reconnectTimer);
      abortController?.abort();
    },
  };
}

/** The always-on fallback that makes SSE non-load-bearing: `onSignal({reason:'interval'})` on a fixed timer, regardless of SSE health. */
export function startIntervalReconcile(onSignal, intervalMs = DEFAULT_RECONCILE_INTERVAL_MS) {
  const timer = setInterval(() => onSignal({ reason: 'interval' }), intervalMs);
  return { stop: () => clearInterval(timer) };
}
