// SPDX-License-Identifier: AGPL-3.0-only
import fs from 'node:fs';
import path from 'node:path';
import { isApprovedOrPublished } from './approval.js';

/**
 * Materializers (G3.4): turn `reconcile()`'s (G3.3) `newRows` into the plain files agents actually read —
 * `_fleet/local/grid/peers/<actor>/{LEDGER.md,presence.json,handoffs.md}` and the `GRID.md` rollup. Agents
 * read files, never the grid API directly (an architecture invariant, not a G3.4-specific choice) — this
 * module is the one place that turns rows into that filesystem shape.
 *
 * `newRows` may contain more than one row for the same natural key: `/ingest` has no server-side dedup
 * (verified in G2.1 — two writes to one key produce two bi-temporal versions, not one overwritten row), and
 * `reconcile()` returns raw, unpacked records in the engine's stable insertion order (also verified). So
 * every renderer here resolves "last write wins" by taking the LAST occurrence of a natural key in
 * `newRows`'s order before rendering, not just sorting-and-printing everything, which would otherwise show a
 * `FleetTask` table with duplicate `#` rows for a task that was pushed more than once.
 *
 * Per-actor files are upsert-only: an actor absent from a given `materialize()` call keeps whatever their
 * peer directory already holds on disk. `reconcile()` already does a full re-scan every cycle, so a
 * momentary absence (a transient query failure, a page-limit truncation) should not blank out a peer's real,
 * previously-known state — "never delete a peer directory" extends to never blanking a file inside it
 * either. `GRID.md`, by contrast, is fully rebuilt every call from whatever `newRows` this cycle actually
 * has — it is explicitly a staleness-marked, best-effort snapshot of "what reconcile saw just now", not an
 * accumulated history.
 */

export const DEFAULT_STALE_TTL_MS = 15 * 60 * 1000;
const DECLARED_TRUNCATE = 10;

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

/** Resolves "last write wins" for rows sharing one natural key, preserving `rows`' own order as the recency signal (verified stable/insertion order — G3.3). */
function latestByKey(rows, keyFn) {
  const byKey = new Map();
  for (const row of rows) byKey.set(keyFn(row), row);
  return [...byKey.values()];
}

function isStale(heartbeatAt, now, staleTtlMs) {
  const heartbeatMs = Date.parse(heartbeatAt);
  return !Number.isFinite(heartbeatMs) || now - heartbeatMs > staleTtlMs;
}

function truncateList(list) {
  if (!list || list.length === 0) return '';
  if (list.length <= DECLARED_TRUNCATE) return list.join(', ');
  return `${list.slice(0, DECLARED_TRUNCATE).join(', ')} (+${list.length - DECLARED_TRUNCATE} more)`;
}

/** Same table shape as `src/handover/protocol.js`'s `ledgerTemplate()`, so any agent that can read a local ledger can read a peer's. Deduped by `task_seq` (last write wins), sorted by `task_seq`. */
export function renderPeerLedger(actor, tasks) {
  const rows = latestByKey(tasks, (t) => t.task_seq).sort((a, b) => a.task_seq - b.task_seq);
  return [
    `# ${actor} — Ledger (peer projection, read-only)`,
    '',
    '| # | Task | Owner | Depends on | Status | Artifact |',
    '|---|------|-------|-----------|--------|----------|',
    ...rows.map((t) => `| ${t.task_seq} | ${t.task} | ${t.actor} | ${t.depends_on?.length ? t.depends_on.join(', ') : '-'} | ${t.status} | ${t.artifact || '-'} |`),
    '',
  ].join('\n');
}

/** ActorPresence verbatim (whichever row is last-write-wins, since the type carries no seq — one slot per actor) plus a computed `stale` flag. */
export function renderPresence(presenceRows, { now = Date.now(), staleTtlMs = DEFAULT_STALE_TTL_MS } = {}) {
  const presence = latestByKey(presenceRows, () => 'only')[0];
  const payload = { ...presence, stale: isStale(presence.heartbeat_at, now, staleTtlMs) };
  return `${JSON.stringify(payload, Object.keys(payload).sort(), 2)}\n`;
}

/** Deduped by `seq` (last write wins), sorted by `seq`. Never the handoff body — pointer, from→to, artifact path, and a shortened digest, matching the milestone's "pointers and digests only" rule. */
export function renderHandoffsList(actor, pointers) {
  const rows = latestByKey(pointers, (p) => p.seq).sort((a, b) => a.seq - b.seq);
  return [
    `# ${actor} — Handoffs (peer projection, read-only)`,
    '',
    ...(rows.length ? rows.map((p) => `- #${p.seq}: ${p.from_agent} → ${p.to_agent} — \`${p.artifact}\` (criteria digest: \`${p.criteria_digest.slice(0, 12)}…\`)`) : ['(no handoffs)']),
    '',
  ].join('\n');
}

/** Distinct titles among approved/published `OrgDocument` rows (G7.3) — deduped first by `content_hash` (last-write-wins; each chunk of one document is its own row) then by `title` (every chunk of one document shares it), sorted for a stable render. */
function approvedOrgTitles(orgDocumentRows) {
  const latest = latestByKey(orgDocumentRows, (r) => r.content_hash);
  return [...new Set(latest.filter(isApprovedOrPublished).map((r) => r.title))].sort();
}

/**
 * The rollup: header (sync timestamp, cortex reachability, active actor count), an "Org-approved" section
 * (G7.3) listing approved/published org-knowledge titles, per-actor in-progress tasks with truncated
 * declared work and a staleness marker, and a cross-actor dependencies section scanning every
 * `FleetTask.depends_on` for `@actor#seq` references. Deterministic ordering (actor name, then task/seq) so
 * successive `GRID.md`s diff meaningfully instead of churning on row order alone.
 */
export function renderGridRollup({ actors, syncedAt, cortexReachable = true, staleTtlMs = DEFAULT_STALE_TTL_MS, now = Date.now(), overlapCount = null, orgApprovedTitles = [] }) {
  const sortedActors = [...actors].sort((a, b) => a.actor.localeCompare(b.actor));
  const lines = ['# Grid', '', `_Synced: ${syncedAt}_ · Cortex: ${cortexReachable ? 'reachable' : 'unreachable'} · Active actors: ${sortedActors.length}`, ''];
  if (overlapCount !== null) {
    lines.push(overlapCount > 0 ? `_Overlaps: ${overlapCount} detected — see [OVERLAPS.md](./OVERLAPS.md)_` : '_Overlaps: none detected_', '');
  }
  const sortedTitles = [...orgApprovedTitles].sort();
  lines.push('## Org-approved', '', ...(sortedTitles.length ? sortedTitles.map((t) => `- ${t}`) : ['(none)']), '');
  const crossActorDeps = [];

  for (const { actor, tasks, presence } of sortedActors) {
    const dedupedTasks = latestByKey(tasks, (t) => t.task_seq).sort((a, b) => a.task_seq - b.task_seq);
    lines.push(`## ${actor}`);
    if (presence) {
      const stale = isStale(presence.heartbeat_at, now, staleTtlMs);
      lines.push(stale ? `_(stale — last seen ${presence.heartbeat_at})_` : `_(active — last seen ${presence.heartbeat_at})_`);
    } else {
      lines.push('_(no presence data)_');
    }

    const inProgress = dedupedTasks.filter((t) => t.status === 'in-progress');
    if (inProgress.length === 0) {
      lines.push('(no in-progress tasks)');
    } else {
      for (const t of inProgress) {
        const files = truncateList(t.files_declared);
        const symbols = truncateList(t.symbols_declared);
        lines.push(`- #${t.task_seq}: ${t.task}${files ? ` — files: ${files}` : ''}${symbols ? `; symbols: ${symbols}` : ''}`);
      }
    }

    for (const t of dedupedTasks) {
      for (const dep of t.depends_on ?? []) {
        if (dep.startsWith('@')) crossActorDeps.push(`${actor}#${t.task_seq} depends on ${dep}`);
      }
    }
    lines.push('');
  }

  lines.push('## Cross-actor dependencies');
  lines.push(...(crossActorDeps.length ? crossActorDeps.sort() : ['(none)']));
  lines.push('');
  return lines.join('\n');
}

/**
 * Writes every file this module knows how to produce from one reconcile cycle's `newRows`
 * (`{typeName, row}[]`, exactly `reconcile()`'s shape). Per-actor files are upsert-only per the module doc
 * comment; `GRID.md` is fully rebuilt, including its "Org-approved" section (G7.3), which only ever reads
 * `OrgDocument` rows already present in THIS cycle's `newRows` — the same "fully rebuilt every call, not an
 * accumulated history" rule as everything else in `GRID.md`. `RunEventSummary` rows are received but have no
 * materialized file surface in this task — a deliberate scope decision (nothing in G3.4's file list calls
 * for one), not a silent drop.
 */
export function materialize(newRows, localDir, opts = {}) {
  const now = opts.now ?? Date.now();
  const staleTtlMs = opts.staleTtlMs ?? DEFAULT_STALE_TTL_MS;
  const syncedAt = opts.syncedAt ?? new Date(now).toISOString();
  const cortexReachable = opts.cortexReachable ?? true;
  const peersDir = path.join(localDir, 'grid', 'peers');

  const byType = { FleetTask: [], ActorPresence: [], HandoffPointer: [], RunEventSummary: [], OrgDocument: [] };
  for (const entry of newRows) {
    if (byType[entry.typeName]) byType[entry.typeName].push(entry.row);
  }

  const tasksByActor = groupBy(byType.FleetTask, (r) => r.actor);
  const presenceByActor = groupBy(byType.ActorPresence, (r) => r.actor);
  const handoffsByActor = groupBy(byType.HandoffPointer, (r) => r.actor);
  const actorNames = new Set([...tasksByActor.keys(), ...presenceByActor.keys(), ...handoffsByActor.keys()]);

  const written = [];
  for (const actor of actorNames) {
    const dir = path.join(peersDir, actor);
    if (tasksByActor.has(actor)) {
      const p = path.join(dir, 'LEDGER.md');
      atomicWrite(p, renderPeerLedger(actor, tasksByActor.get(actor)));
      written.push(p);
    }
    if (presenceByActor.has(actor)) {
      const p = path.join(dir, 'presence.json');
      atomicWrite(p, renderPresence(presenceByActor.get(actor), { now, staleTtlMs }));
      written.push(p);
    }
    if (handoffsByActor.has(actor)) {
      const p = path.join(dir, 'handoffs.md');
      atomicWrite(p, renderHandoffsList(actor, handoffsByActor.get(actor)));
      written.push(p);
    }
  }

  const rollupActors = [...actorNames].map((actor) => ({
    actor,
    tasks: tasksByActor.get(actor) ?? [],
    presence: presenceByActor.has(actor) ? latestByKey(presenceByActor.get(actor), () => 'only')[0] : null,
  }));
  const gridMdPath = path.join(localDir, 'grid', 'GRID.md');
  atomicWrite(
    gridMdPath,
    renderGridRollup({ actors: rollupActors, syncedAt, cortexReachable, staleTtlMs, now, overlapCount: opts.overlapCount ?? null, orgApprovedTitles: approvedOrgTitles(byType.OrgDocument) })
  );
  written.push(gridMdPath);

  return { written };
}
