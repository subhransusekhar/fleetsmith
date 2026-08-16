// SPDX-License-Identifier: AGPL-3.0-only
import fs from 'node:fs';
import path from 'node:path';
import { request, justify, queryAllOrgDocuments } from '../memory/relatadb.js';

/**
 * `fleetsmith grid audit` (G7.4): the compliance answer as a CLI — filterable queries over the engine's
 * audit chain, plus `--why <item-id>` for lineage.
 *
 * --- `GET /audit/entries`'s exact shape is UNVERIFIED — this is an assumption, documented as one -----------
 *
 * G7.2's own `purposes.test.js` live test was the FIRST attempt this project has ever made at this endpoint —
 * before that, `/audit/entries` was only named in the milestone's own architecture doc, never independently
 * exercised. Neither its query-parameter names nor its response envelope have been confirmed against a real
 * instance. This module therefore: (1) sends the filters this task's own CLI spec names (`actor`, `since`,
 * `until`, `purpose`, `limit`) as plain query-string params — the conventional shape for a REST audit-log
 * endpoint, not a confirmed contract; (2) unpacks the response defensively, trying a bare array or a handful
 * of plausible wrapper field names, the same defensive-parsing shape `rotateToken()` (G7.1) already uses for
 * ITS OWN unverified response. If a live instance's real shape differs, that is itself a finding worth fixing
 * here, not a reason this code should have waited to be written.
 *
 * --- Pagination: no cursor-chasing loop, and that is deliberate --------------------------------------------
 *
 * G3.3 already found, the hard way, that `_system_from`-based cursors do not reliably work for ad-hoc ingested
 * types on this engine. Whether `/audit/entries` has a REAL, working cursor of its own is unverified either
 * way. Rather than build a paging loop on a mechanism no prior work in this project has confirmed, this module
 * sends `limit` (default 50) and returns exactly what the engine gives back for that one call — the same
 * "bounded, not exhaustive" honesty `PAGE_LIMIT` already carries in `pull.js`'s own reconcile().
 *
 * --- `--why <item-id>`: two different lineage sources behind one flag ---------------------------------------
 *
 * A plain memory-verb item (`remember()`'d lesson/decision/note) is explained by the existing `justify()`
 * (`/memory/justify` + `/memory/recognize`). An `OrgDocument` hit's id (`org:<content_hash>`, G6.3's own
 * convention) has no `/memory/justify` entry at all — it was never written through the memory verbs — so its
 * lineage comes from the row itself: source file, importer, import/business dates, and G7.3's approval
 * history. `explainItem` dispatches on the `org:` prefix rather than guessing which source an id came from.
 *
 * --- Degraded mode (rule 3): what's auditable with no cortex at all -----------------------------------------
 *
 * `_fleet/local/runs/<actor>-<ts>/events.jsonl` is the one thing a checkout can audit locally — real run
 * events, no purpose/recall/approval history, since none of that exists anywhere without a cortex to have
 * recorded it. The degraded output says so directly, not silently offering a lesser answer as if it were the
 * same thing.
 */

export class AuditError extends Error {}

const DEFAULT_LIMIT = 50;

function firstOf(obj, ...keys) {
  for (const k of keys) {
    if (obj?.[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

/** `GET /audit/entries` with the filters this task's own CLI spec names. See the module doc comment for why this endpoint's exact shape is an assumption, not a confirmed contract. */
export async function queryAuditEntries(config, opts = {}) {
  const query = { limit: opts.limit ?? DEFAULT_LIMIT };
  if (opts.actor) query.actor = opts.actor;
  if (opts.since) query.since = opts.since;
  if (opts.until) query.until = opts.until;
  if (opts.purpose) query.purpose = opts.purpose;

  const result = await request(config, { method: 'GET', path: '/audit/entries', query });
  return Array.isArray(result) ? result : firstOf(result, 'entries', 'rows', 'data') ?? [];
}

function normalizeAuditEntry(entry) {
  return {
    timestamp: firstOf(entry, 'timestamp', 'ts', 'created_at', 'time') ?? '',
    actor: firstOf(entry, 'actor', 'principal', 'who') ?? '',
    action: firstOf(entry, 'action', 'verb', 'op', 'type') ?? '',
    purpose: firstOf(entry, 'purpose') ?? '',
    object: firstOf(entry, 'object', 'object_type', 'target', 'id') ?? '',
  };
}

/** `id.startsWith('org:')` -> the row's own lineage (G6.3's/G7.3's fields); otherwise the memory-verb port's `justify()`. Throws `AuditError` when nothing is found either way — a caller asking "why does this exist" deserves a clear answer, not a silent empty result. */
export async function explainItem(config, id) {
  if (id.startsWith('org:')) {
    const contentHash = id.slice('org:'.length);
    const rows = (await queryAllOrgDocuments(config)).filter((r) => r.content_hash === contentHash);
    if (rows.length === 0) throw new AuditError(`no OrgDocument row found for "${id}"`);
    const latest = rows[rows.length - 1]; // last-write-wins, same resolution every other bi-temporal read in this package uses
    return {
      id,
      kind: 'org_document',
      text: latest.chunk_text,
      origin: latest.origin,
      evidence: [`${latest.source_file} (${latest.kind}${latest.client ? `, ${latest.client}` : ''}, ${latest.valid_from})`],
      imported_by: latest.imported_by,
      imported_at: latest.imported_at,
      approval: { state: latest.approval || 'draft', approved_by: latest.approved_by || null, approved_at: latest.approved_at || null },
    };
  }

  const result = await justify(config, id);
  if (!result) throw new AuditError(`no memory item found for "${id}"`);
  return { id, kind: 'memory_item', ...result };
}

/** `entries` -> a markdown table (timestamp, actor, action, purpose, object), or the raw JSON when `opts.json` — pure rendering, no network. */
export function renderAuditTable(entries, opts = {}) {
  if (opts.json) return `${JSON.stringify(entries, null, 2)}\n`;

  const rows = entries.map(normalizeAuditEntry);
  const lines = ['# Audit', ''];
  if (rows.length === 0) {
    lines.push('no audit entries found matching this query.', '');
    return lines.join('\n');
  }
  lines.push(
    '| Timestamp | Actor | Action | Purpose | Object |',
    '|-----------|-------|--------|---------|--------|',
    ...rows.map((r) => `| ${r.timestamp} | ${r.actor} | ${r.action} | ${r.purpose} | ${r.object} |`),
    ''
  );
  return lines.join('\n');
}

/** `explainItem()`'s result -> readable markdown (or raw JSON when `opts.json`), covering both a memory item's evidence/origin and an OrgDocument's provenance/approval history. */
export function renderExplanation(explanation, opts = {}) {
  if (opts.json) return `${JSON.stringify(explanation, null, 2)}\n`;

  const lines = [`# Why: ${explanation.id}`, '', `- kind: ${explanation.kind}`, `- origin: ${explanation.origin}`];
  if (explanation.text) lines.push(`- text: ${explanation.text}`);
  if (explanation.evidence?.length) lines.push('- evidence:', ...explanation.evidence.map((e) => `  - ${e}`));
  if (explanation.counters) lines.push(`- counters: +${explanation.counters.helpful}/-${explanation.counters.harmful}`);
  if (explanation.imported_by) lines.push(`- imported_by: ${explanation.imported_by}`, `- imported_at: ${explanation.imported_at}`);
  if (explanation.approval) {
    lines.push(`- approval: ${explanation.approval.state}${explanation.approval.approved_by ? ` (by ${explanation.approval.approved_by} at ${explanation.approval.approved_at})` : ''}`);
  }
  lines.push('');
  return lines.join('\n');
}

// --- degraded mode: local run events only, no cortex needed ---------------------------

function readEventsFile(filePath) {
  const events = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* a partial final line is normal while a run is in flight — skip, not fatal */
    }
  }
  return events;
}

/** Reads every `_fleet/local/runs/<run-id>/events.jsonl` this checkout has, filtered by `--actor`/`--since`/`--until` if given — the only thing auditable with no cortex configured at all. `<run-id>` is `log-event.sh`'s own `<actor>-<ts>` format, so the actor is recovered from the directory name, not a field the event itself necessarily carries. */
export function queryLocalRunEvents(localDir, opts = {}) {
  const runsDir = path.join(localDir, 'runs');
  if (!fs.existsSync(runsDir)) return [];

  const entries = [];
  for (const runId of fs.readdirSync(runsDir)) {
    const eventsPath = path.join(runsDir, runId, 'events.jsonl');
    if (!fs.existsSync(eventsPath)) continue; // e.g. a stray CURRENT-<actor> marker file, not a run directory
    const actor = runId.split('-')[0];
    if (opts.actor && actor !== opts.actor) continue;

    for (const event of readEventsFile(eventsPath)) {
      const ts = event.ts;
      if (opts.since && ts && ts < opts.since) continue;
      if (opts.until && ts && ts > opts.until) continue;
      entries.push({ timestamp: ts ?? '', actor, action: event.event ?? 'event', purpose: '', object: runId });
    }
  }
  return entries.slice(0, opts.limit ?? DEFAULT_LIMIT);
}
