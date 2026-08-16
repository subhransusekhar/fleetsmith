// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
// Imported by package name, not a relative path across the license boundary.
// `fleetsmith-ee`'s package.json declares `fleetsmith` as a peerDependency —
// this is how a real two-package install resolves it, and `npm test` sets up
// a local self-link (scripts/ee-selflink.mjs, wired as `pretest`) so the same
// import statement works during development in this one checkout too.
import { assertValidItem, MemoryError } from 'fleetsmith/memory/port';
import { resolveActor } from '../actor.js';
import { RelataNetworkError, RelataHttpError, RelataToolError } from './errors.js';

/**
 * The RelataDB memory-port adapter — write half (G1.2). The read half
 * (recall/justify/consolidate/forget) lands in G1.3 in this same file; this
 * task builds `remember`/`remember_batch` and the shared plumbing both
 * halves need (request transport, session derivation, the content envelope).
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

/** The shared HTTP transport. `config` is `resolveGridConfig()`'s result (G1.1) plus `fleetName`, merged by the caller. */
export async function request(config, { method = 'GET', path, query, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
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
        Authorization: `Bearer ${config.token}`,
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
