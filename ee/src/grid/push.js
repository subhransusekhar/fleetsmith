// SPDX-License-Identifier: AGPL-3.0-only
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { GRID_TYPES, ingestRows, resolveRepoId } from './ontology.js';
import { ledgerToTasks, presenceFrom, handoffToPointer, eventsToSummary, ProjectionError } from './project.js';
import { declaredFiles, declaredSymbols } from './declared.js';
import { resolveActor } from '../actor.js';

/**
 * The grid push loop (G3.2): reads what already exists on disk, projects it into grid rows (G2.2), enriches
 * in-progress `FleetTask` rows with declared-work (G2.3), and `POST /ingest`s only what changed since the
 * last successful push — tracked in `_fleet/local/grid/pushed.json` (a map of `rowKey -> content digest`).
 *
 * Rows are upserts by their natural key (G2.1: every type is keyed by `actor`, or `actor`+`seq`), so
 * re-pushing an unchanged row is harmless regardless of whether `pushed.json` is right — the digest map is
 * an optimization to skip needless network calls, never the source of truth for correctness. Confirmed
 * directly (G2.1 testing): RelataDB has no server-side dedup on `/ingest` — two writes to the same key
 * produce two bi-temporal versions, not one row overwritten. A `pushed.json` self-heal (missing or corrupt
 * → treated as `{}`, forcing a full re-push) is therefore safe in the sense that matters: every row that
 * gets re-sent still carries its own correct, unchanged content, so whichever version a reader treats as
 * "latest" (G3.3's job) reads the same thing either way. It is not "zero-duplicate-storage" in a literal
 * row-count sense — RelataDB's bi-temporal model was never going to give us that, and G3.2 does not depend on it.
 */

export class PushError extends Error {}

const DEFAULT_PURPOSE = 'grid_sync';
const DEFAULT_ORIGIN = 'human';

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function resolveBranch(repoDir) {
  try {
    return execFileSync('git', ['branch', '--show-current'], { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'HEAD';
  } catch {
    return 'HEAD';
  }
}

/** A stable, sorted-key JSON serialization — two calls with the same field values always digest identically, regardless of insertion order. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digestOf(row) {
  return createHash('sha256').update(canonicalJson(row)).digest('hex');
}

function rowKey(typeName, row) {
  const key = GRID_TYPES[typeName].key.map((field) => row[field]).join('|');
  return `${typeName}::${key}`;
}

function readPushedDigests(pushedJsonPath) {
  const raw = readIfExists(pushedJsonPath);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // corrupt pushed.json — self-heal via a full re-push, see the module doc comment
  }
}

/**
 * Every candidate row must belong to the local actor — pushing another actor's row would misattribute grid
 * state to them, a bug and a security issue, not a recoverable/warn-and-continue case. `pushOnce` calls this
 * on every row it collects, before any network activity; exported directly so this guard is testable on its
 * own and reusable by anything else that assembles rows to push (a future source beyond the four G2.2/G2.3
 * projections, e.g. if a push path were ever extended to read from `_fleet/local/grid/peers/` by mistake).
 */
export function assertOwnRow(typeName, row, actor) {
  if (row.actor !== actor) {
    throw new PushError(`refusing to push a ${typeName} row attributed to actor "${row.actor}" — this checkout only pushes rows for "${actor}"`);
  }
}

function collectLedgerTasks(localDir, repoDir, ctx, warnings) {
  const ledgerPath = path.join(localDir, 'LEDGER.md');
  const content = readIfExists(ledgerPath);
  if (content === null) return [];
  const { tasks, warnings: ledgerWarnings } = ledgerToTasks(content, ctx);
  warnings.push(...ledgerWarnings);

  const inProgress = tasks.filter((t) => t.status === 'in-progress');
  if (inProgress.length > 0) {
    const { files, warnings: fileWarnings } = declaredFiles(repoDir);
    const { symbols, warnings: symbolWarnings } = declaredSymbols(files, repoDir);
    warnings.push(...fileWarnings, ...symbolWarnings);
    for (const task of inProgress) {
      task.files_declared = files;
      task.symbols_declared = symbols;
    }
  }
  return tasks;
}

function collectHandoffPointers(localDir, ctx, warnings) {
  const handoffsDir = path.join(localDir, 'handoffs');
  let entries;
  try {
    entries = fs.readdirSync(handoffsDir);
  } catch {
    return [];
  }
  const pointers = [];
  for (const filename of entries) {
    if (!/^\d+-[A-Za-z0-9._-]+-to-[A-Za-z0-9._-]+\.md$/.test(filename)) continue;
    const content = readIfExists(path.join(handoffsDir, filename));
    if (content === null) continue;
    try {
      pointers.push(handoffToPointer(filename, content, ctx));
    } catch (e) {
      warnings.push(`skipped handoff "${filename}": ${e.message}`);
    }
  }
  return pointers;
}

function collectPresenceAndEvents(localDir, ctx, warnings) {
  const currentMarkerPath = path.join(localDir, 'runs', `CURRENT-${ctx.actor}`);
  const marker = readIfExists(currentMarkerPath);
  if (marker === null) return { presence: null, eventSummary: null };

  const runId = marker.trim();
  const eventsContent = readIfExists(path.join(localDir, 'runs', runId, 'events.jsonl')) ?? '';
  const presence = presenceFrom(marker, eventsContent, ctx);

  let eventSummary = null;
  try {
    eventSummary = eventsToSummary(eventsContent, ctx);
  } catch (e) {
    if (!(e instanceof ProjectionError)) throw e;
    warnings.push(`no RunEventSummary for run "${runId}": ${e.message}`);
  }
  return { presence, eventSummary };
}

/**
 * Runs one push cycle: read, project, enrich, digest-diff, `/ingest` only what changed, update
 * `pushed.json` only for what succeeded. Never throws except via `assertOwnRow` (a foreign-actor row is a
 * bug, not a degradable condition) — every other failure (a bad ledger row, an unreadable handoff, a network
 * error) is collected into `warnings` and skipped for this cycle, to be retried on the next one.
 */
export async function pushOnce(config, repoDir, opts = {}) {
  const actor = opts.actor ?? resolveActor();
  const branch = opts.branch ?? resolveBranch(repoDir);
  const localDir = opts.localDir ?? path.join(repoDir, '_fleet', 'local');
  const redactRow = opts.redactRow ?? ((row) => row);
  const ctx = { repoId: opts.repoId ?? resolveRepoId(repoDir), actor, branch, purpose: opts.purpose ?? DEFAULT_PURPOSE, origin: opts.origin ?? DEFAULT_ORIGIN };

  const warnings = [];
  const rowsByType = { FleetTask: [], ActorPresence: [], HandoffPointer: [], RunEventSummary: [] };

  rowsByType.FleetTask.push(...collectLedgerTasks(localDir, repoDir, ctx, warnings));
  rowsByType.HandoffPointer.push(...collectHandoffPointers(localDir, ctx, warnings));
  const { presence, eventSummary } = collectPresenceAndEvents(localDir, ctx, warnings);
  if (presence) rowsByType.ActorPresence.push(presence);
  if (eventSummary) rowsByType.RunEventSummary.push(eventSummary);

  for (const [typeName, rows] of Object.entries(rowsByType)) {
    for (const row of rows) assertOwnRow(typeName, row, actor);
  }

  const pushedJsonPath = path.join(localDir, 'grid', 'pushed.json');
  const digests = readPushedDigests(pushedJsonPath);

  const pushed = [];
  const skipped = [];
  let digestsChanged = false;

  for (const [typeName, rows] of Object.entries(rowsByType)) {
    const changed = [];
    for (const row of rows) {
      const key = rowKey(typeName, row);
      const digest = digestOf(row);
      if (digests[key] === digest) {
        skipped.push(key);
      } else {
        changed.push({ key, digest, row });
      }
    }
    if (changed.length === 0) continue;

    let redacted;
    try {
      redacted = changed.map(({ row }) => redactRow(row));
    } catch (e) {
      warnings.push(`${typeName}: redaction refused this batch, nothing pushed for it this cycle: ${e.message}`);
      continue;
    }

    try {
      await ingestRows(config, typeName, redacted);
      for (const { key, digest } of changed) {
        digests[key] = digest;
        digestsChanged = true;
        pushed.push(key);
      }
    } catch (e) {
      warnings.push(`${typeName}: /ingest failed for ${changed.length} row(s), will retry next cycle: ${e.message}`);
    }
  }

  if (digestsChanged) {
    fs.mkdirSync(path.dirname(pushedJsonPath), { recursive: true });
    fs.writeFileSync(pushedJsonPath, `${JSON.stringify(digests, Object.keys(digests).sort(), 2)}\n`);
  }

  return { pushed, skipped, warnings };
}
