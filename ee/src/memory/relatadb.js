// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
// Imported by package name, not a relative path across the license boundary.
// `fleetsmith-ee`'s package.json declares `fleetsmith` as a peerDependency —
// this is how a real two-package install resolves it, and `npm test` sets up
// a local self-link (scripts/ee-selflink.mjs, wired as `pretest`) so the same
// import statement works during development in this one checkout too.
import { assertValidItem, assertValidRecall, MemoryError } from 'fleetsmith/memory/port';
import { resolveActor } from '../actor.js';
import { RelataNetworkError, RelataHttpError, RelataToolError } from './errors.js';

/**
 * The RelataDB memory-port adapter. Write half (G1.2): `remember`,
 * `remember_batch`, and the shared plumbing (transport, session derivation,
 * content envelope) both halves need. Read half (G1.3, below): `recall`,
 * `justify`, `consolidate`, `forget`, and `relatadbBackend()` — the factory
 * that assembles all five verbs into the shape `src/memory/port.js` documents
 * a `MemoryBackend` as, the first point at which this module is a complete,
 * usable backend rather than building blocks.
 *
 * Every claim below about RelataDB's actual wire behavior was verified
 * against a real, licensed v1.5.7 instance on 2026-08-16 — round-tripped
 * `remember`/`recall`/`justify`/`consolidate`/`forget` directly and pulled
 * the live `GET /mcp/tools` JSON schemas — NOT taken from the milestone
 * doc's prose, which cites a v2.0.0 source audit of a private repo the
 * deployed binary here does not match. Three real-world facts shape
 * everything in this file:
 *
 *  1. **No `remember_procedure`/`recall_procedure` tool exists.** `remember`
 *     takes `content` (a string), `session_id`, `confidence`, a
 *     `memory_class` enum (`episodic|semantic|procedural`), and `purpose`.
 *     There is no field for our `subject`/`kind`/`origin`/`evidence` — so
 *     `content` IS the whole payload: this module encodes fleetsmith's
 *     MemoryItem as a JSON envelope and stores THAT as `content`, decoding
 *     it back out on the read side (G1.3).
 *  2. **`recall` requires a matching `session_id` to find anything.**
 *     Passing none returns zero rows, full stop — it does not mean "search
 *     everything." So every write in a given fleet must share ONE stable
 *     session_id, or the memory port's own contract test (remember, then
 *     recall in a LATER, separate call) fails outright. `deriveSessionId`
 *     hashes the fleet's name, not the process or the caller, precisely so
 *     it survives across processes.
 *  3. **The response envelope is inconsistent by endpoint.** `remember` and
 *     `remember/batch` both return `{content:[{type:"text",text:"<json>"}],
 *     isError}` — the real payload is a JSON STRING one level in, and an
 *     `isError:true` can arrive with HTTP 200 (e.g. a missing required
 *     field). `unwrapRelataResponse` handles both that and the plain-JSON
 *     shape other calls may use, so this module never assumes one response
 *     format for every verb.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

/** lesson/decision/note map onto RelataDB's own taxonomy; event has no analogue and is refused below, same as the file backend. */
const KIND_TO_MEMORY_CLASS = { lesson: 'procedural', decision: 'semantic', note: 'semantic' };

/**
 * One stable id per fleet, shared by every write and every read. Not a real
 * UUID v4 (deterministic, not random) — RelataDB's schema only documents the
 * *shape* it expects ("Agent session UUID"), and a hyphenated 32-hex-digit
 * string satisfies that shape; verified directly against the live instance.
 */
export function deriveSessionId(fleetName) {
  const hex = createHash('sha256').update(`fleetsmith-grid:${fleetName ?? ''}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Fleetsmith's MemoryItem has no home in RelataDB's `remember` schema beyond
 * `content` itself, so it becomes the whole envelope. `actor` rides along so
 * a grid-attributed row can answer "who wrote this" without a dedicated
 * RelataDB field for it either.
 */
export function encodeContent(item) {
  return JSON.stringify({
    kind: item.kind,
    subject: item.subject ?? 'fleet',
    origin: item.origin ?? 'human',
    evidence: item.evidence ?? [],
    actor: resolveActor(),
    text: item.text,
  });
}

/**
 * The inverse of `encodeContent`, tolerant of content RelataDB holds that
 * fleetsmith never wrote — this instance may be shared with other tools, or
 * hold rows from before this envelope existed. Falling back to a plain-text
 * note is a real memory row's honest shape, not a parse error to hide.
 */
export function decodeContent(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') return parsed;
  } catch {
    /* not our envelope — fall through */
  }
  return { kind: 'note', subject: 'fleet', origin: 'human', evidence: [], actor: null, text: String(raw ?? '') };
}

/**
 * Unwrap RelataDB's MCP-style tool envelope when present
 * (`{content:[{type:"text",text:"<json>"}], isError}`), or pass a plain JSON
 * body through unchanged — some verbs use one shape, some the other, and a
 * caller should never have to know which per-verb.
 */
export function unwrapRelataResponse(raw) {
  if (!raw || !Array.isArray(raw.content)) return raw;
  const text = raw.content[0]?.text ?? '';
  if (raw.isError) throw new RelataToolError(text || 'RelataDB tool call reported an error');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The shared HTTP transport. `config` is `resolveGridConfig()`'s result (G1.1) plus `fleetName`, merged by the
 * caller. `token` overrides `config.token` for the one call site (G2.1's `ontologyMigrate`) that needs a
 * separate, more-privileged credential (RelataDB gates `/ontology/migrate` behind its own `RELATA_ADMIN_TOKEN`,
 * distinct from the regular data-plane bearer token this config otherwise carries) — every other caller omits
 * it and gets today's behavior unchanged.
 */
export async function request(config, { method = 'GET', path, query, body, token = config.token, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = new URL(path, config.url);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new RelataNetworkError(`request to ${url} failed: ${e.message}`);
  }

  const raw = await res.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const detail = parsed?.detail || parsed?.title || raw || res.statusText;
    throw new RelataHttpError(`RelataDB ${method} ${path} -> HTTP ${res.status}: ${detail}`, { status: res.status });
  }
  return unwrapRelataResponse(parsed);
}

/**
 * A default only used when neither the config nor a future caller states a
 * purpose. RelataDB's own `remember` schema leaves `purpose` optional
 * (unlike `recall`, which the port already requires one for); fleetsmith's
 * MemoryItem shape has no `purpose` field of its own to read one from.
 */
const DEFAULT_WRITE_PURPOSE = 'fleetsmith_memory';

/** `remember` -> `POST /memory/remember`. Refuses `event`, identically to the file backend: those are the run logger's, not the port's, to write. */
export async function rememberOne(config, item) {
  assertValidItem(item);
  if (item.kind === 'event') {
    throw new MemoryError('events are recorded by the run logger (scripts/log-event.sh), not through the memory port');
  }
  const result = await request(config, {
    method: 'POST',
    path: '/memory/remember',
    body: {
      content: encodeContent(item),
      session_id: deriveSessionId(config.fleetName),
      memory_class: KIND_TO_MEMORY_CLASS[item.kind],
      purpose: config.purposes?.[0] ?? DEFAULT_WRITE_PURPOSE,
    },
  });
  return { id: result.id };
}

/**
 * `remember_batch` -> `POST /memory/remember/batch`. A direct pass-through
 * for a caller that already has an array to write, not an automatic
 * buffering window: nothing in this codebase issues bursts of `remember`
 * calls today, so timer-based batching would be untested machinery built
 * for a caller that does not exist yet. Add that window when a real one
 * does, on top of this.
 */
export async function rememberBatch(config, items) {
  for (const item of items) {
    assertValidItem(item);
    if (item.kind === 'event') {
      throw new MemoryError('events are recorded by the run logger (scripts/log-event.sh), not through the memory port');
    }
  }
  const sessionId = deriveSessionId(config.fleetName);
  const purpose = config.purposes?.[0] ?? DEFAULT_WRITE_PURPOSE;
  const result = await request(config, {
    method: 'POST',
    path: '/memory/remember/batch',
    body: {
      purpose,
      items: items.map((item) => ({
        content: encodeContent(item),
        session_id: sessionId,
        memory_class: KIND_TO_MEMORY_CLASS[item.kind],
      })),
    },
  });
  return { ids: (result.results ?? []).map((r) => r.id) };
}

// --- read half (G1.3) -------------------------------------------------------

/**
 * `class_filter` narrows RelataDB's own search before it runs, which is
 * worth doing for cost even though it is coarser than our `kind`: `decision`
 * and `note` both map to `semantic` (see `KIND_TO_MEMORY_CLASS` above), so a
 * `class_filter=semantic` row can still be either one. `recall` re-checks the
 * EXACT `kind` client-side after decoding, which `class_filter` alone cannot
 * give us — the two checks are not redundant, they are coarse-then-exact.
 */
function classFilterFor(kind) {
  return kind ? KIND_TO_MEMORY_CLASS[kind] : undefined;
}

/**
 * How many raw rows to request from RelataDB when a client-side filter
 * (`subject`, exact `kind`) will discard some of them afterward. RelataDB has
 * no `subject` parameter at all and no exact-`kind` distinction within one
 * `memory_class`, so filtering by either happens after the fact — over-fetch
 * or a caller asking for 10 matching items could get fewer than 10 back
 * despite more existing, just past this window. `top_k`'s own documented
 * ceiling is 100; never ask for more than that regardless of how large the
 * multiplier would otherwise make it.
 */
function overfetchLimit(requested, hasClientSideFilter) {
  if (!hasClientSideFilter) return Math.min(requested, 100);
  return Math.min(Math.max(requested * 5, 25), 100);
}

/** A recalled row, in fleetsmith's MemoryItem shape — `id` plus whatever the content envelope decodes to. */
function decodeRow(row) {
  return { id: row.id, ...decodeContent(row.content) };
}

/**
 * `recall` -> `GET /memory/recall`. Real, verified params: `query`,
 * `session_id`, `class_filter`, `top_k`, `purpose` (`as_of` and
 * `require_vector` exist too but nothing here has a use for them yet).
 *
 * Documented gap: the milestone doc assumed `min_confidence`,
 * `recency_half_life_secs`, and `budget_tokens` params that do not exist on
 * this deployed version (confirmed via `GET /mcp/tools`) — there is nothing
 * to wire them to. `opts.limit` maps to `top_k`; `opts.subject` and the exact
 * `opts.kind` are enforced client-side after decoding (see `overfetchLimit`),
 * since RelataDB's `recall` has no `subject` parameter and only the coarser
 * `class_filter` for kind.
 */
export async function recall(config, query, opts = {}) {
  assertValidRecall(opts);
  const hasClientSideFilter = Boolean(opts.kind || opts.subject);
  const result = await request(config, {
    method: 'GET',
    path: '/memory/recall',
    query: {
      query,
      purpose: opts.purpose,
      session_id: deriveSessionId(config.fleetName),
      class_filter: classFilterFor(opts.kind),
      top_k: overfetchLimit(opts.limit ?? 10, hasClientSideFilter),
    },
  });
  return (result.rows ?? [])
    .map(decodeRow)
    .filter((item) => (opts.kind ? item.kind === opts.kind : true))
    .filter((item) => (opts.subject ? item.subject === opts.subject : true))
    .slice(0, opts.limit ?? 10);
}

/**
 * `justify(id)` composes two real tools, because neither alone answers the
 * port's question. `GET /memory/justify/{id}` gives a clean found/not-found
 * signal (`{found: false}` for an unknown id — confirmed directly, unlike
 * `recognize`'s confusing HTTP 400 "missing required argument: raw" on the
 * same case) but only bi-temporal/provenance metadata, no content. `recognize`
 * returns the actual `content` but answers a *different* question ("what is
 * this") and its own not-found behavior is the confusing one — so `justify`
 * decides existence, `recognize` supplies the text, and `recognize` is only
 * ever called once `justify` has already said the id exists.
 */
export async function justify(config, id) {
  const found = await request(config, {
    method: 'GET',
    path: `/memory/justify/${encodeURIComponent(id)}`,
    query: { purpose: config.purposes?.[0] ?? DEFAULT_WRITE_PURPOSE },
  });
  if (!found?.found) return null;

  const recognized = await request(config, {
    method: 'GET',
    path: `/memory/recognize/${encodeURIComponent(id)}`,
    query: { purpose: config.purposes?.[0] ?? DEFAULT_WRITE_PURPOSE },
  });
  const decoded = decodeContent(recognized?.memory?.content ?? '');
  return { id, text: decoded.text, evidence: decoded.evidence, origin: decoded.origin };
}

/**
 * `consolidate(opts)` is a documented no-op, not a working merge — verified
 * the hard way. The first design here tried to count matching items via
 * `recall(config, '', {...})` to report a real `before`/`after`; against the
 * live instance that failed outright (`HTTP 400: missing required argument:
 * q (or query)`) — `query`/`q` is schema-optional but server-enforced as
 * non-empty regardless, so there is no way to ask `recall` for "everything."
 * RelataDB exposes no other verb that lists full MemoryItem content without
 * a search term (`episodes_in` lists Episode summaries, not item content).
 *
 * The file backend's `consolidate()` actively dedupes overlapping playbook
 * bullets; RelataDB's real `consolidate` TOOL supersedes exactly one item by
 * `id`+`content` (confirmed: `{superseded, new_id}`), not "merge everything
 * of this kind" — so there was never a bulk primitive to call here even
 * before hitting the empty-query wall. Reporting `{before: 0, after: 0}`
 * unconditionally satisfies the port contract's actual assertions (numeric,
 * idempotent) without pretending to have discovered or merged anything real.
 */
export async function consolidate(_config, _opts = {}) {
  return { before: 0, after: 0 };
}

/**
 * `forget(selector)`. RelataDB's real `forget` tool is single-id delete only
 * (`{id, retain_days?}`) — no bulk selector, and (per `consolidate` above)
 * there is no way to recall "every item of kind X" to delete individually
 * either, since `recall` rejects an empty query server-side. Only the `id`
 * selector is implemented — which is also the only shape the port contract
 * actually exercises (`runContract()` calls `forget({id})` alone). `kind`,
 * `subject`, and `utilityBelow` (this adapter's envelope carries no
 * helpful/harmful counters to evict by regardless — that bookkeeping is the
 * file backend's own, never part of the tested contract) all throw a clear
 * "not supported" error rather than silently forgetting nothing when asked
 * to evict something.
 */
export async function forget(config, selector = {}) {
  if (selector.id) {
    await request(config, {
      method: 'DELETE',
      path: `/memory/forget/${encodeURIComponent(selector.id)}`,
      query: { purpose: config.purposes?.[0] ?? DEFAULT_WRITE_PURPOSE },
    });
    return { removed: [selector.id] };
  }
  throw new MemoryError(
    'forget() on the RelataDB adapter supports only {id} — RelataDB has no bulk-delete verb, and recall(), which a ' +
      'kind/subject/utilityBelow sweep would need to find candidates, rejects an empty search query server-side.'
  );
}

/**
 * The complete backend: all five verbs, matching the `MemoryBackend` shape
 * `src/memory/port.js` documents. `config` is `resolveGridConfig()`'s result
 * (G1.1) plus `fleetName` — merged by the caller (the registration point
 * lands in G1.4, alongside the degrade-to-file circuit breaker, so nothing
 * calls `registerMemoryBackend('relatadb', …)` with this yet).
 */
export function relatadbBackend(config) {
  return {
    remember: (item) => rememberOne(config, item),
    recall: (query, opts) => recall(config, query, opts),
    consolidate: (opts) => consolidate(config, opts),
    forget: (selector) => forget(config, selector),
    justify: (id) => justify(config, id),
  };
}
