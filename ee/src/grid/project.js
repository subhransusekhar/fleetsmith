// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';

/**
 * Projection serializers (G2.2): deterministic, I/O-free functions that turn what already exists on disk —
 * the ledger table, a handoff file, the `CURRENT-<actor>` marker plus its run's events, and a run's
 * `events.jsonl` — into the four G2.1 grid row shapes (`ee/src/grid/ontology.js`). Every function here takes
 * file CONTENTS as plain strings/objects; none of them touch `fs` or the network (a test in
 * `project.test.js` greps this file's own source to hold that, since a caller — the `fleetsmith grid`
 * daemon, G3, not yet built — owns reading the files and calling `ingestRows()` with what these return).
 *
 * `ctx = { repoId, actor, branch, purpose?, origin? }` supplies the fields these inputs cannot: `repoId`
 * (`resolveRepoId()`, G2.1) and `actor` (the developer running this fleet, from the standard resolution
 * chain) are properties of the machine/checkout, not of any one file; `branch` is likewise read once by the
 * caller (`git branch --show-current`), not re-derived per file here.
 *
 * `FleetTask.status` vocabulary is duplicated from `ontology.js`'s `GRID_TYPES.FleetTask.statuses`, not
 * imported from it, so this module's own source stays free of `ontology.js`'s `node:fs` (it reads
 * `types.json`) and `node:child_process` (`resolveRepoId`'s `git config`) imports. Keep the two lists in sync
 * by hand — a fourth grid type or a new status value is rare enough that hand-sync is the honest trade here,
 * not a real risk.
 */
const FLEET_TASK_STATUSES = ['pending', 'in-progress', 'done', 'blocked', 'dropped'];

const DEFAULT_PURPOSE = 'fleetsmith_grid';
const DEFAULT_ORIGIN = 'human';

export class ProjectionError extends Error {}

function rowDefaults(ctx) {
  return { repo_id: ctx.repoId, branch: ctx.branch, purpose: ctx.purpose ?? DEFAULT_PURPOSE, origin: ctx.origin ?? DEFAULT_ORIGIN };
}

/**
 * Parses `_fleet/local/LEDGER.md`'s table (`| # | Task | Owner | Depends on | Status | Artifact |`, the exact
 * shape `src/handover/protocol.js`'s `ledgerTemplate()` emits) into `FleetTask[]`. A row is skipped (with a
 * message pushed to `warnings`, never a throw) when its `#` cell isn't an integer, it doesn't have exactly
 * six cells, or its `Status` cell isn't one of the ledger's five values — malformed input from a
 * hand-edited ledger is common enough that tolerance, not rejection, is the only usable behavior for a
 * projection that runs unattended on every push.
 *
 * `Depends on` splits on commas; `-` (the template's own "no dependency" marker) and blank cells become no
 * entry. Cross-actor references (`@<actor>#<seq>`) pass through unchanged — resolving them is a peer's job,
 * not this projection's.
 *
 * `files_declared`/`symbols_declared` are always `[]` here — that's G2.3's declared-work extraction, merged
 * in by whatever calls this, not something a ledger row states about itself.
 */
export function ledgerToTasks(ledgerMarkdown, ctx) {
  const tasks = [];
  const warnings = [];
  const defaults = rowDefaults(ctx);

  for (const line of ledgerMarkdown.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed
      .slice(1, trimmed.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((c) => c.trim());
    if (cells.length !== 6) {
      warnings.push(`ledger row "${trimmed}" skipped: expected 6 columns, found ${cells.length}`);
      continue;
    }
    const [seqCell, taskCell, , dependsCell, statusCell, artifactCell] = cells;
    if (seqCell === '#' || /^-+$/.test(seqCell)) continue; // the header row and the `|---|---|...` separator — table furniture, not a warning-worthy row

    const seq = Number.parseInt(seqCell, 10);
    if (!Number.isInteger(seq) || String(seq) !== seqCell.trim()) {
      warnings.push(`ledger row "${trimmed}" skipped: "${seqCell}" is not a task number`);
      continue;
    }
    if (!FLEET_TASK_STATUSES.includes(statusCell)) {
      warnings.push(`ledger row #${seq} skipped: status "${statusCell}" is not one of ${FLEET_TASK_STATUSES.join(', ')}`);
      continue;
    }

    const dependsOn = dependsCell === '-' || dependsCell === '' ? [] : dependsCell.split(',').map((d) => d.trim()).filter(Boolean);
    tasks.push({
      ...defaults,
      actor: ctx.actor,
      task_seq: seq,
      task: taskCell,
      status: statusCell,
      depends_on: dependsOn,
      artifact: artifactCell === '-' ? '' : artifactCell,
      files_declared: [],
      symbols_declared: [],
    });
  }

  return { tasks, warnings };
}

/**
 * Parses the run event vocabulary's two anchors — `run_start` (its `ts` becomes `started_at`) and the
 * chronologically last event in the run (its `ts` becomes `heartbeat_at`, standing in for a dedicated
 * heartbeat event the vocabulary in `src/compile/telemetry.js` does not have) — plus the run id read from
 * `currentMarker` (the raw `CURRENT-<actor>` file content: just the run id, per `log-event.sh`).
 *
 * `lastEvents` is that SAME run's `events.jsonl` content — one file per run id by construction
 * (`log-event.sh` writes to `<runs_dir>/<run_id>/events.jsonl`), so every line here already shares one
 * `run_id`; this function does not filter across runs. A line that fails to parse as JSON is skipped, not
 * fatal. If no `run_start` line is present (a truncated or hand-trimmed log), `started_at` falls back to the
 * timestamp encoded in the run id itself (`<actor>-<YYYYMMDDTHHMMSSZ>`, `log-event.sh`'s own format) rather
 * than being left undefined.
 */
export function presenceFrom(currentMarker, lastEvents, ctx) {
  const runId = currentMarker.trim();
  const events = lastEvents
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const runStart = events.find((e) => e.event === 'run_start');
  const runIdTimestamp = runId.match(/-(\d{8}T\d{6}Z)$/);
  const fallbackTs = runIdTimestamp ? `${runIdTimestamp[1].slice(0, 4)}-${runIdTimestamp[1].slice(4, 6)}-${runIdTimestamp[1].slice(6, 8)}T${runIdTimestamp[1].slice(9, 11)}:${runIdTimestamp[1].slice(11, 13)}:${runIdTimestamp[1].slice(13, 15)}Z` : undefined;

  return {
    ...rowDefaults(ctx),
    actor: ctx.actor,
    run_id: runId,
    started_at: runStart?.ts ?? fallbackTs,
    heartbeat_at: events.length ? events[events.length - 1].ts : fallbackTs,
  };
}

const HANDOFF_FILENAME = /^(\d+)-([A-Za-z0-9._-]+)-to-([A-Za-z0-9._-]+)\.md$/;

/**
 * The body text under a `## <headingName>` line, up to (not including) the next `## ` heading or end of
 * file — found by two plain `indexOf`s, not a single combined regex: a lookahead built from `$` in multiline
 * mode matches before EVERY line break, not just at end of file, so a blank line inside the section body
 * would truncate the match there instead of at the real next-heading boundary.
 */
function extractSection(content, headingName) {
  const headingLine = new RegExp(`(?:^|\\n)##\\s*${headingName}\\s*\\n`, 'i');
  const match = headingLine.exec(content);
  if (!match) return null;
  const bodyStart = match.index + match[0].length;
  const nextHeadingIndex = content.indexOf('\n## ', bodyStart);
  return content.slice(bodyStart, nextHeadingIndex === -1 ? content.length : nextHeadingIndex);
}

/**
 * `filename` must match `{seq}-{from}-to-{to}.md` (the naming `src/handover/protocol.js`'s orchestrator
 * instructions and `src/adapters/claude-settings.js`'s gate script both use) — a caller only ever passes
 * filenames already matched against that glob, so a mismatch here is a caller bug, not a tolerable input;
 * throws `ProjectionError` rather than silently skipping.
 *
 * `criteria_digest` is the SHA-256 of the trimmed text under the handoff template's `## Acceptance criteria`
 * heading, up to the next `## ` heading or end of file — never the handoff body itself (the milestone's own
 * rule: pointers and digests only, since server-side cell ACL isn't fully wired). Falls back to a digest of
 * the whole trimmed file when no such section exists, so a hand-written handoff missing the heading still
 * gets a real, comparable digest rather than none.
 *
 * Line endings are normalized to `\n` before hashing — a real cross-platform bug, not a hypothetical one:
 * a Windows developer's own git checkout (`core.autocrlf`'s default) saves this same file with `\r\n`, and
 * without normalizing, semantically-identical criteria text would hash DIFFERENTLY across platforms, making
 * every push look like a real change and defeating the digest's whole purpose (skip a push when nothing
 * meaningful changed). Caught by this project's own Windows release-binary CI run, not written defensively
 * up front.
 */
export function handoffToPointer(filename, content, ctx) {
  const match = HANDOFF_FILENAME.exec(filename);
  if (!match) {
    throw new ProjectionError(`"${filename}" does not match the handoff naming convention "{seq}-{from}-to-{to}.md"`);
  }
  const [, seqStr, fromAgent, toAgent] = match;

  const section = extractSection(content, 'Acceptance criteria');
  const digestSource = (section ?? content).replace(/\r\n/g, '\n').trim();

  return {
    ...rowDefaults(ctx),
    actor: ctx.actor,
    seq: Number.parseInt(seqStr, 10),
    from_agent: fromAgent,
    to_agent: toAgent,
    artifact: filename,
    criteria_digest: createHash('sha256').update(digestSource).digest('hex'),
  };
}

/**
 * Reduces one run's `events.jsonl` to the three counts `RunEventSummary` carries — total across every agent
 * in the run, not broken out per agent: the type's key (`repo_id`, `actor`, `run_id`) has no room for an
 * `agent` dimension, and a nested per-agent breakdown would be a schema change beyond what G2.1 shipped.
 * Malformed lines are skipped, not fatal. `run_id` is read from the events themselves (every line already
 * carries one) rather than from `ctx` — throws `ProjectionError` if not one single valid line survives
 * parsing, since there is then no `run_id` to key the row by at all.
 */
export function eventsToSummary(eventsJsonl, ctx) {
  const events = eventsJsonl
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (events.length === 0) {
    throw new ProjectionError('events.jsonl contained no parseable event lines — no run_id to key a RunEventSummary row by');
  }

  const counts = { gate_pass: 0, gate_block: 0, execute_tool_error: 0 };
  for (const e of events) {
    if (e.event in counts) counts[e.event] += 1;
  }

  return { ...rowDefaults(ctx), actor: ctx.actor, run_id: events[0].run_id, ...counts };
}
