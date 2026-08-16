// SPDX-License-Identifier: AGPL-3.0-only
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { normalizeSpec } from 'fleetsmith/spec';
import { resolveGridConfig } from '../config.js';
import { resolveActor } from '../actor.js';
import { request } from '../memory/relatadb.js';
import { resolveRepoId, ingestRows } from './ontology.js';
import { gridInit } from './init.js';
import { pushOnce, collectLedgerTasks, resolveBranch } from './push.js';
import { pullOnce, reconcile, watchGridChanges, startIntervalReconcile } from './pull.js';
import { materialize } from './materialize.js';
import { findOverlaps } from './overlaps.js';
import { mergeRisks } from './merge-risk.js';
import { renderOverlaps } from './overlaps-render.js';
import { tasksFromGitOnly, listCandidateBranches } from './git-only.js';
import { planImport, applyImport } from './import.js';
import { queryKnowledgeLive, queryKnowledgeDegraded, renderKnowledgeTable } from './knowledge.js';
import { assertPushIdentity, rotateToken, IdentityError } from './identity.js';

/**
 * The `fleetsmith grid` CLI verb (G3.5): `init` (G3.1), `sync`, and `sync --watch` — the daemon that ties
 * push (G3.2), pull (G3.3), and materialize (G3.4) together into the one thing a developer or a CI step
 * actually runs. `ee/src/index.js` registers `gridCliHandler` through `registerCliCommand('grid', …)`; this
 * module is the logic underneath it.
 *
 * --- `registerDaemonHook('run_start'/'run_end')` is provisioned, not load-bearing (verified 2026-08-16) ----
 *
 * `src/lib/registry.js`'s `runDaemonHooks(event, …)` is real, tested core infrastructure — but grepping the
 * whole core tree turns up no call site for it at all: neither `src/cli.js` nor `src/eval/`/`src/evolve/`
 * ever invokes it. A hook registered here would therefore never fire today; it is wired anyway (see
 * `ee/src/index.js`) because the registry contract is real and a future core caller may start invoking it,
 * but this module does NOT depend on it to detect a real run's lifecycle. The mechanism that actually works,
 * used by `runWatch` below: `fs.watch()` on `_fleet/local/runs/` for the `CURRENT-<actor>` marker file
 * appearing (a run started) or disappearing (a run ended) — the same file `log-event.sh` itself manages.
 *
 * --- `ended_at` and "history preserved" (verified against a fresh, isolated RelataDB instance) -------------
 *
 * The milestone's own cursor/history story assumes `AS OF` queries work for these ad-hoc ingested types; they
 * do not — `SELECT * FROM T AS OF <ts>` returns zero rows, the same failure mode as any `WHERE` clause
 * (G3.3's finding). What DOES work, verified directly: a bare `SELECT * FROM T` already returns EVERY
 * version ever ingested for a key (RelataDB has no server-side dedup — G2.1), so "history is preserved and
 * queryable" is true without `AS OF` at all. `onRunEnd` below pushes a new `ActorPresence` row with
 * `ended_at` set rather than deleting anything; G3.4's `materialize()` already resolves "last write wins"
 * client-side from that same full history, so the ended state surfaces in `presence.json` with zero new
 * machinery needed here.
 *
 * --- Degradation (G3.6): three distinct "grid isn't working" conditions, three distinct responses ----------
 *
 *  1. **Not configured at all** — the common OSS-checkout case. `init` still refuses outright (`DaemonError`,
 *     non-zero exit): typing `grid init` is a deliberate setup action, and a silently-skipped setup is a
 *     worse failure mode than a clear one. Every OTHER subcommand (`sync`, `sync --watch`) prints one
 *     advisory line and exits/returns 0 — a cron'd `grid sync` on a repo nobody enabled the enterprise tier
 *     for must never page anyone. Daemon hooks (`onRunStart`/`onRunEnd`) already no-op silently for this
 *     case (unchanged from G3.5).
 *  2. **Configured but the cortex is unreachable** (network failure, 401, or any other error the connectivity
 *     probe below surfaces — a license-expiry symptom looks identical to any other auth/HTTP failure from
 *     this module's vantage point, and is handled the same way, not specially detected). `syncOnce` probes
 *     once with the same cheap authenticated no-op read G3.1's `gridInit` uses (`POST /query {sql:"SELECT
 *     1"}`) before doing anything else. On failure: exactly ONE warning, `pushOnce`/`pullOnce` are skipped
 *     entirely (so `pushed.json` stays untouched — the next success re-diffs and catches up naturally, no
 *     buffering machinery needed), and `_fleet/local/grid/GRID.md`'s header gets a stale marker via a
 *     targeted text edit — deliberately NOT a `materialize()` call, which would rebuild the file from this
 *     cycle's (empty) `newRows` and erase every previously-known peer section. `_fleet/local/grid/
 *     unreachable-since` persists the timestamp of the FIRST failure across process restarts (a `grid sync`
 *     cron invocation is a fresh process every time), and is cleared on the next success.
 *  3. **Recovery is automatic**, not a separate code path: once the probe succeeds again, `unreachable-since`
 *     is cleared and the ordinary push→pull→materialize cycle runs, which naturally overwrites `GRID.md`'s
 *     header back to a normal one as part of its regular full rebuild.
 */

export class DaemonError extends Error {}

const DEFAULT_HEARTBEAT_MS = 5 * 60 * 1000;
const DEFAULT_WATCH_DEBOUNCE_MS = 1000;

export function loadSpecFile(file) {
  if (!file) throw new DaemonError('missing <fleet.yaml> argument');
  const raw = YAML.parse(fs.readFileSync(file, 'utf8'));
  return normalizeSpec(raw);
}

function resolveConfigOrThrow(spec) {
  const config = resolveGridConfig(spec);
  if (!config) {
    throw new DaemonError(
      'grid is not configured — set RELATA_URL + RELATA_TOKEN, or a `grid:` block in fleet.yaml (`url` + `token_env`), before running `fleetsmith grid <command>`.'
    );
  }
  return { ...config, fleetName: spec?.fleet?.name };
}

function localDirFor(spec, cwd) {
  return path.join(cwd, spec?.fleet?.local ?? '_fleet/local');
}

function nowIso() {
  return new Date().toISOString();
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

/** Last-write-wins by natural key (`repo_id`+`actor`+`task_seq`), same resolution `materialize()` (G3.4) already applies to every other row type — `/ingest` has no server-side dedup, and a peer's own ledger can also legitimately repeat a `task_seq` across pushes. */
function dedupeTasks(rows) {
  const byKey = new Map();
  for (const t of rows) byKey.set(`${t.repo_id}|${t.actor}|${t.task_seq}`, t);
  return [...byKey.values()];
}

/**
 * Every currently-known `FleetTask` this checkout can see: this actor's own ledger (never returned by
 * `reconcile()`, which explicitly excludes the calling actor's own rows — "you are not your own peer") plus
 * whichever peer `FleetTask` rows the caller already has on hand from this cycle's reconcile. `findOverlaps`
 * (G5.1) and `mergeRisks` (G5.2) both need the FULL active set, local and peer alike, to see a real
 * cross-actor collision.
 */
function gatherActiveTasks(localDir, repoDir, ctx, peerFleetTaskRows, warnings) {
  const localTasks = collectLedgerTasks(localDir, repoDir, ctx, warnings);
  return dedupeTasks([...localTasks, ...peerFleetTaskRows]);
}

/** Runs G5.1+G5.2 over `tasks` and atomically writes `_fleet/local/grid/OVERLAPS.md` (G5.3). Never throws: a `mergeRisks` git failure degrades to no risks found for the affected pair, with a warning (G5.2's own contract) — this function surfaces those warnings, it never lets one git hiccup break the render. */
function computeAndRenderOverlaps(tasks, repoDir, localDir, { syncedAt } = {}) {
  const overlaps = findOverlaps(tasks);
  const { risks, warnings } = mergeRisks(tasks, repoDir);
  const markdown = renderOverlaps(overlaps, risks, { syncedAt: syncedAt ?? nowIso(), warnings });
  const overlapsPath = path.join(localDir, 'grid', 'OVERLAPS.md');
  atomicWrite(overlapsPath, markdown);
  return { overlaps, risks, warnings, markdown, written: overlapsPath };
}

/** The cheapest real connectivity+auth probe: `GET /health` is unauthenticated regardless of the token (G3.1's finding), so only an authenticated call actually proves the cortex is both reachable AND accepting this token. */
async function checkCortexReachable(config) {
  try {
    await request(config, { method: 'POST', path: '/query', body: { sql: 'SELECT 1', purpose: config.purposes?.[0] ?? 'grid_sync' } });
    return { reachable: true };
  } catch (e) {
    return { reachable: false, reason: e.message };
  }
}

function unreachableSincePath(localDir) {
  return path.join(localDir, 'grid', 'unreachable-since');
}

/** Returns the FIRST-failure timestamp, creating it only if this is a new outage — a restart between two failed cycles must not reset "since" to "just now". */
function markUnreachableSince(localDir) {
  const p = unreachableSincePath(localDir);
  const existing = readIfExists(p)?.trim();
  if (existing) return existing;
  const since = nowIso();
  atomicWrite(p, since);
  return since;
}

function clearUnreachableMarker(localDir) {
  try {
    fs.unlinkSync(unreachableSincePath(localDir));
  } catch {
    /* already absent — nothing to clear */
  }
}

/**
 * A targeted edit to GRID.md's own header line, not a `materialize()` call — there is no new `newRows` to
 * rebuild the file from during an outage, and rebuilding from an empty set would erase every previously
 * materialized peer section. Falls back to writing a minimal placeholder when no GRID.md exists yet (an
 * outage before the very first successful sync) or its header doesn't match the expected shape.
 */
function markGridStale(localDir, since, reason) {
  const p = path.join(localDir, 'grid', 'GRID.md');
  const current = readIfExists(p);
  const staleSegment = `⚠ unreachable since ${since} (${reason}) — peer data may be stale`;
  if (current === null || !current.includes('· Cortex:')) {
    atomicWrite(p, `# Grid\n\n_Synced: never_ · Cortex: ${staleSegment} · Active actors: 0\n`);
    return;
  }
  atomicWrite(p, current.replace(/· Cortex: [^·\n]*/, `· Cortex: ${staleSegment}`));
}

// --- one-shot commands -----------------------------------------------------------

/** `fleetsmith grid init`. Throws `DaemonError`/`InitError` (G3.1) for a missing config or a failed token check — a user error, not a degradable one. */
export async function runInit(spec, cwd = process.cwd()) {
  const config = resolveConfigOrThrow(spec);
  const localDir = localDirFor(spec, cwd);
  const result = await gridInit(config, { localDir, actor: resolveActor() });
  const summary = `grid init: migrate ${result.migration.engineMigrationRan ? 'ran' : 'skipped (no admin token)'}, token ${result.tokenSanity.authenticated ? 'ok' : 'FAILED'}${
    result.tokenSanity.mismatch ? ` (principal mismatch: ${result.tokenSanity.note})` : ''
  }, ACL policy ${result.aclPolicy.applied ? 'applied' : 'NOT applied (template only — ' + result.aclPolicy.note + ')'}, skeleton at ${result.skeleton.gridDir}`;
  return { summary, result };
}

/**
 * One push → reconcile → materialize cycle. Never throws: an unconfigured grid or an unreachable cortex are
 * both degraded-but-successful outcomes (see the module doc comment's degradation section) — `sync` running
 * unattended (a cron job, a daemon loop) must never fail loudly for either. `result.degraded` is set in both
 * cases so a caller can tell "nothing happened, on purpose" from a normal cycle without parsing the summary
 * text.
 */
export async function syncOnce(spec, cwd = process.cwd()) {
  const rawConfig = resolveGridConfig(spec);
  const localDir = localDirFor(spec, cwd);

  if (!rawConfig) {
    return { summary: 'grid sync: not configured — skipping (set RELATA_URL+RELATA_TOKEN, or a `grid:` block in fleet.yaml, to enable)', warnings: [], degraded: true, notConfigured: true };
  }
  const config = { ...rawConfig, fleetName: spec?.fleet?.name };

  const reachability = await checkCortexReachable(config);
  if (!reachability.reachable) {
    const since = markUnreachableSince(localDir);
    markGridStale(localDir, since, reachability.reason);
    return {
      summary: `grid sync: cortex unreachable since ${since} (${reachability.reason}) — push buffered (pushed.json untouched), pull skipped, peers marked stale`,
      warnings: [reachability.reason],
      degraded: true,
    };
  }
  clearUnreachableMarker(localDir);

  const actor = resolveActor();
  const repoId = resolveRepoId(cwd);
  const branch = resolveBranch(cwd);

  // G7.1: refuse to push (not the whole cycle — pull/materialize proceed regardless, reading peers is
  // always allowed) when a REAL, discoverable token principal mismatches the resolved local actor. When no
  // principal is discoverable at all (the common bearer-mode case — see identity.js's own doc comment),
  // nothing was actually verified, so the push proceeds; a thrown IdentityError is the only case that skips it.
  let pushResult = { pushed: [], skipped: [], warnings: [] };
  const identityWarnings = [];
  try {
    await assertPushIdentity(config, actor);
    pushResult = await pushOnce(config, cwd, { localDir, actor, repoId, branch });
  } catch (e) {
    if (!(e instanceof IdentityError)) throw e;
    identityWarnings.push(`push skipped: ${e.message}`);
  }

  const pullResult = await pullOnce(config, cwd, { localDir, repoId, actor });

  // Reuses this cycle's already-fetched `pullResult.newRows` rather than a fresh reconcile() — reconcile()
  // is a full bounded scan every call (G3.3's own finding), so a second call here would just re-fetch the
  // same rows over the network for no benefit, and would double this cycle's HTTP round trips.
  const overlapWarnings = [];
  const ctx = { repoId, actor, branch, purpose: config.purposes?.[0] ?? 'grid_sync', origin: 'human' };
  const peerFleetTaskRows = pullResult.newRows.filter((r) => r.typeName === 'FleetTask').map((r) => r.row);
  const tasks = gatherActiveTasks(localDir, cwd, ctx, peerFleetTaskRows, overlapWarnings);
  const { overlaps, warnings: riskWarnings } = computeAndRenderOverlaps(tasks, cwd, localDir);
  overlapWarnings.push(...riskWarnings);

  const { written } = materialize(pullResult.newRows, localDir, { overlapCount: overlaps.length });
  written.push(path.join(localDir, 'grid', 'OVERLAPS.md'));

  const actorsSeen = new Set(pullResult.newRows.map((r) => r.row.actor));
  const warnings = [...identityWarnings, ...pushResult.warnings, ...pullResult.warnings, ...overlapWarnings];
  const summary = `grid sync: pushed ${pushResult.pushed.length} row(s), pulled ${pullResult.newRows.length} row(s) from ${actorsSeen.size} actor(s), wrote ${written.length} file(s), ${overlaps.length} overlap(s)${
    warnings.length ? `, ${warnings.length} warning(s)` : ''
  }`;
  return { summary, warnings, pushResult, pullResult, written, overlaps, degraded: false };
}

/**
 * `fleetsmith grid overlaps` (G5.3): pull the latest rows, compute overlaps (G5.1) and merge risks (G5.2)
 * over this checkout's own ledger plus every peer's, render and write `OVERLAPS.md`, and return it for the
 * CLI to print. A standalone pull, not a full `syncOnce` — this command answers "what's colliding right now"
 * without also pushing this actor's own state or touching `GRID.md`/peer files; degrades the same way `sync`
 * does (never throws) for the two shared advisory conditions: not configured, and cortex unreachable.
 */
export async function computeOverlaps(spec, cwd = process.cwd()) {
  const rawConfig = resolveGridConfig(spec);
  const localDir = localDirFor(spec, cwd);

  if (!rawConfig) {
    return {
      summary: 'grid overlaps: not configured — skipping (set RELATA_URL+RELATA_TOKEN, or a `grid:` block in fleet.yaml, to enable)',
      warnings: [],
      degraded: true,
      notConfigured: true,
      overlaps: [],
      risks: [],
    };
  }
  const config = { ...rawConfig, fleetName: spec?.fleet?.name };

  const reachability = await checkCortexReachable(config);
  if (!reachability.reachable) {
    return {
      summary: `grid overlaps: cortex unreachable (${reachability.reason}) — cannot compute a live view`,
      warnings: [reachability.reason],
      degraded: true,
      overlaps: [],
      risks: [],
    };
  }

  const actor = resolveActor();
  const repoId = resolveRepoId(cwd);
  const branch = resolveBranch(cwd);
  const ctx = { repoId, actor, branch, purpose: config.purposes?.[0] ?? 'grid_sync', origin: 'human' };

  const warnings = [];
  const { newRows, warnings: reconcileWarnings } = await reconcile(config, repoId, { actor });
  warnings.push(...reconcileWarnings);
  const peerFleetTaskRows = newRows.filter((r) => r.typeName === 'FleetTask').map((r) => r.row);
  const tasks = gatherActiveTasks(localDir, cwd, ctx, peerFleetTaskRows, warnings);

  const { overlaps, risks, warnings: riskWarnings, markdown, written } = computeAndRenderOverlaps(tasks, cwd, localDir);
  warnings.push(...riskWarnings);

  const activeCount = tasks.filter((t) => t.status === 'in-progress').length;
  const summary = `grid overlaps: ${overlaps.length} overlap(s), ${risks.length} merge risk(s) across ${activeCount} active task(s)${
    warnings.length ? `, ${warnings.length} warning(s)` : ''
  }`;
  return { summary, warnings, overlaps, risks, markdown, written, degraded: false };
}

const GIT_ONLY_BANNER = 'git-only mode — file-level overlaps from fetched branches; task metadata unavailable';

/**
 * `fleetsmith grid overlaps --git-only` (G5.5): the OSS answer for overlap detection with no cortex at all —
 * rule 3 of this milestone ("nothing is ee-only") applied to the overlap engine specifically. Needs no grid
 * config, no network access, and no RelataDB: it synthesizes minimal task rows straight from local git state
 * (`tasksFromGitOnly`, G5.5) over every local/remote-tracking branch this checkout already knows about, and
 * runs the SAME `findOverlaps()` (G5.1) every grid-backed path uses. File-kind overlaps only —
 * `artifact`/`symbol`/`dependency-cycle` are structurally absent, since none of that is derivable from git
 * alone (no merge-risk analysis here either; that needs real branch names this function already has, but is
 * out of this task's scope — see #55). Never throws: a git failure anywhere degrades to fewer/no synthesized
 * rows, surfaced via `warnings`, never a blocked command.
 *
 * Deliberately does NOT exclude the currently checked-out branch from the candidate list: the primary real
 * use case is "does my own in-progress work collide with a peer's branch I already fetched," and excluding
 * the current branch would make that undetectable — `listCandidateBranches`' own `currentBranch` exclusion
 * option exists for callers that want it, this one just does not.
 */
export function computeGitOnlyOverlaps(spec, cwd = process.cwd()) {
  const localDir = localDirFor(spec, cwd);
  const branches = listCandidateBranches(cwd, {});
  const { tasks, warnings } = tasksFromGitOnly(cwd, branches);

  const overlaps = findOverlaps(tasks);
  const markdown = renderOverlaps(overlaps, [], { syncedAt: nowIso(), warnings, banner: GIT_ONLY_BANNER });
  const overlapsPath = path.join(localDir, 'grid', 'OVERLAPS.md');
  atomicWrite(overlapsPath, markdown);

  const summary = `grid overlaps --git-only: ${overlaps.length} overlap(s) across ${tasks.length} branch(es)${
    warnings.length ? `, ${warnings.length} warning(s)` : ''
  }`;
  return { summary, warnings, overlaps, risks: [], markdown, written: overlapsPath, degraded: false, gitOnly: true };
}

/**
 * `fleetsmith grid knowledge <query> [--as-of <date>] [--as-recorded <date>] [--purpose <p>] [--limit n]`
 * (G6.5): "what did we know before the March decision" — see `knowledge.js`'s own module doc comment for why
 * `--as-of`/`--as-recorded` filter client-side over plain data fields rather than an engine `AS OF` clause.
 * No cortex configured at all: degrades to `queryKnowledgeDegraded` over `_fleet/shared/knowledge/` directly
 * (rule 3), never throws — this is a read-only query command, not a setup action like `init`.
 */
export async function computeGridKnowledge(spec, cwd, query, opts = {}) {
  const rawConfig = resolveGridConfig(spec);
  const result = rawConfig ? await queryKnowledgeLive({ ...rawConfig, fleetName: spec?.fleet?.name }, query, opts) : queryKnowledgeDegraded(cwd, query, opts);
  const markdown = renderKnowledgeTable(result, opts);
  const summary = `grid knowledge${result.degraded ? ' (degraded)' : ''}: ${result.rows.length} result(s) for "${query}"${
    opts.asOf ? `, as-of ${opts.asOf}` : ''
  }${opts.asRecorded ? `, as-recorded ${opts.asRecorded}` : ''}`;
  return { summary, markdown, rows: result.rows, degraded: result.degraded, purpose: result.purpose };
}

// --- watch mode --------------------------------------------------------------------

/**
 * `fleetsmith grid sync --watch`: runs `syncOnce` on startup, then again whenever the SSE doorbell fires
 * (G3.3), on the fixed interval fallback, on a local ledger/handoff file change (debounced), or on a run
 * starting. A presence heartbeat re-ingests `ActorPresence` with a fresh `heartbeat_at` on its own timer,
 * independent of whether anything else changed — deliberately bypassing `pushOnce`'s digest-diff, since the
 * whole point of a heartbeat is a fresh timestamp even when nothing else did change. Returns a controller;
 * the real CLI handler runs this until the process receives SIGINT/SIGTERM.
 *
 * Returns `{stop(), active: false}` immediately, printing one advisory line, when grid is not configured —
 * `sync --watch` on an OSS checkout must not hang waiting for a SIGINT that would only ever stop a loop that
 * was never doing anything (see the module doc comment's degradation section). `gridCliHandler` checks
 * `.active` to decide whether to wait for a shutdown signal at all.
 */
export function runWatch(spec, cwd = process.cwd(), opts = {}) {
  const log = opts.log ?? console.log;
  const rawConfig = resolveGridConfig(spec);
  if (!rawConfig) {
    log('grid sync --watch: not configured — skipping (set RELATA_URL+RELATA_TOKEN, or a `grid:` block in fleet.yaml, to enable)');
    return { stop() {}, active: false };
  }
  const config = { ...rawConfig, fleetName: spec?.fleet?.name };
  const localDir = localDirFor(spec, cwd);
  const actor = resolveActor();
  const repoId = resolveRepoId(cwd);
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const debounceMs = opts.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;

  let stopped = false;
  let syncChain = Promise.resolve();
  let debounceTimer = null;

  function scheduleSync(reason) {
    if (stopped) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      syncChain = syncChain
        .then(() => syncOnce(spec, cwd))
        .then((r) => log(`[${reason}] ${r.summary}`))
        .catch((e) => log(`[${reason}] sync failed: ${e.message}`));
    }, debounceMs);
  }

  scheduleSync('startup');

  const sse = watchGridChanges(config, { onSignal: ({ reason }) => scheduleSync(reason) });
  const interval = startIntervalReconcile(({ reason }) => scheduleSync(reason), opts.reconcileIntervalMs);

  const fsWatchers = [];
  function watchIfExists(target, handler) {
    try {
      const watcher = fs.watch(target, handler);
      // An FSWatcher emits 'error' asynchronously for some failure modes even when the initial fs.watch()
      // call itself didn't throw (e.g. the watched path is removed later) — an unhandled 'error' event on
      // any EventEmitter crashes the process, so this must always have a listener, even a silent one; a
      // broken watcher is a degraded condition here, never a reason to take the whole daemon down.
      watcher.on('error', () => {});
      fsWatchers.push(watcher);
    } catch {
      /* the path did not exist at watch time — nothing to watch */
    }
  }
  watchIfExists(path.join(localDir, 'LEDGER.md'), () => scheduleSync('local-ledger-change'));
  fs.mkdirSync(path.join(localDir, 'handoffs'), { recursive: true });
  watchIfExists(path.join(localDir, 'handoffs'), () => scheduleSync('local-handoff-change'));

  const currentMarkerName = `CURRENT-${actor}`;
  const currentMarkerPath = path.join(localDir, 'runs', currentMarkerName);
  let running = fs.existsSync(currentMarkerPath);
  let lastKnownRunId = running ? (fs.readFileSync(currentMarkerPath, 'utf8').trim() || null) : null;

  // Created proactively (a fresh checkout has no runs/ directory until the first `run_start` event) — a
  // watch target that does not exist at startup is never retried, so a daemon started before any agent has
  // ever run would otherwise never detect the FIRST one.
  fs.mkdirSync(path.join(localDir, 'runs'), { recursive: true });
  watchIfExists(path.join(localDir, 'runs'), (eventType, filename) => {
    if (filename !== currentMarkerName) return;
    const nowRunning = fs.existsSync(currentMarkerPath);
    if (nowRunning && !running) {
      running = true;
      try {
        lastKnownRunId = fs.readFileSync(currentMarkerPath, 'utf8').trim() || null;
      } catch {
        lastKnownRunId = null;
      }
      scheduleSync('run-start');
    } else if (!nowRunning && running) {
      running = false;
      const endedAt = nowIso();
      ingestRows(config, 'ActorPresence', [
        { repo_id: repoId, actor, run_id: lastKnownRunId ?? `${actor}-ended`, branch: opts.branch ?? 'unknown', started_at: endedAt, heartbeat_at: endedAt, ended_at: endedAt, purpose: 'grid_sync', origin: 'human' },
      ]).catch((e) => log(`run-end presence supersession failed: ${e.message}`));
      scheduleSync('run-end');
    }
  });

  const heartbeatTimer = setInterval(() => {
    const ts = nowIso();
    ingestRows(config, 'ActorPresence', [
      { repo_id: repoId, actor, run_id: lastKnownRunId ?? `${actor}-daemon`, branch: opts.branch ?? 'unknown', started_at: opts.daemonStartedAt ?? ts, heartbeat_at: ts, purpose: 'grid_sync', origin: 'human' },
    ]).catch((e) => log(`heartbeat failed: ${e.message}`));
  }, heartbeatMs);

  return {
    stop() {
      stopped = true;
      clearTimeout(debounceTimer);
      clearInterval(heartbeatTimer);
      sse.stop();
      interval.stop();
      for (const w of fsWatchers) w.close();
    },
    active: true,
  };
}

// --- daemon hooks (registered via registerDaemonHook — see the module doc comment: provisioned, not load-bearing) ---

/**
 * `registerDaemonHook('run_start', onRunStart)` / `('run_end', onRunEnd)`. Neither `src/cli.js` nor
 * `src/eval/`/`src/evolve/` calls `runDaemonHooks('run_start'|'run_end', …)` anywhere today, so there is no
 * real, specified argument shape to match — `ctx = {spec, cwd}` is chosen because it mirrors
 * `registerMemoryBackend`'s own factory signature elsewhere in this file, the closest real precedent in
 * this codebase. Both no-op silently (never throw) when `ctx.spec` is absent or grid is unconfigured, since
 * `runDaemonHooks` already catches a throwing hook but there is no reason to rely on that here.
 */
export async function onRunStart(ctx = {}) {
  const { spec, cwd = process.cwd() } = ctx;
  if (!spec) return;
  const config = resolveGridConfig(spec);
  if (!config) return;
  const ts = nowIso();
  const actor = resolveActor();
  await ingestRows(
    { ...config, fleetName: spec?.fleet?.name },
    'ActorPresence',
    [{ repo_id: resolveRepoId(cwd), actor, run_id: `${actor}-${ts}`, branch: 'unknown', started_at: ts, heartbeat_at: ts, purpose: 'grid_sync', origin: 'human' }]
  );
}

export async function onRunEnd(ctx = {}) {
  const { spec, cwd = process.cwd() } = ctx;
  if (!spec) return;
  const config = resolveGridConfig(spec);
  if (!config) return;
  const ts = nowIso();
  const actor = resolveActor();
  await ingestRows(
    { ...config, fleetName: spec?.fleet?.name },
    'ActorPresence',
    [{ repo_id: resolveRepoId(cwd), actor, run_id: `${actor}-ended`, branch: 'unknown', started_at: ts, heartbeat_at: ts, ended_at: ts, purpose: 'grid_sync', origin: 'human' }]
  );
}

// --- CLI dispatch ------------------------------------------------------------------

/**
 * A `--flag` immediately followed by a non-`--` token consumes it as a value (`--kind meeting` -> `{kind:
 * 'meeting'}`); a `--flag` with no such next token (end of argv, or the next token is itself another `--flag`)
 * stays a boolean `true` (`--watch`, `--git-only`, `--apply`). Safe because every real call site in this
 * codebase places value-flags after every positional argument — never `--kind meeting fleet.yaml`.
 */
function parseGridArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/**
 * `registerCliCommand('grid', gridCliHandler)`'s handler. Exit codes per the milestone's own rule: 0 even
 * when degraded (a warning was printed, not thrown); non-zero only for a user error — bad args, or no grid
 * config when a grid command is explicitly invoked.
 */
export async function gridCliHandler(argv) {
  const { positional, flags } = parseGridArgs(argv);
  const [subcommand, fleetYamlPath = 'fleet.yaml'] = positional;

  if (!subcommand || !['init', 'sync', 'overlaps', 'import', 'knowledge', 'token'].includes(subcommand)) {
    console.error(
      `error: unknown grid subcommand "${subcommand ?? ''}" — expected "init", "sync [--watch]", "overlaps [--git-only]", ` +
        '"import <path|dir> --kind meeting|discussion|decision|spec [--client <name>] [--date <YYYY-MM-DD>] [--apply]", ' +
        '"knowledge <query> [--as-of <YYYY-MM-DD>] [--as-recorded <YYYY-MM-DD>] [--purpose <p>] [--limit n]", or ' +
        '"token rotate" ' +
        '("overlaps --git-only" needs no cortex, no grid config, and no network access at all — the OSS answer, ' +
        'file-level overlaps synthesized straight from local git branches; "import" without --apply is a dry-run that ' +
        'touches no network either; "knowledge" degrades to filtering _fleet/shared/knowledge/ frontmatter directly ' +
        'when no cortex is configured; "token rotate" prints the new token — updating RELATA_TOKEN/token_env and ' +
        'restarting any running daemon is on you)'
    );
    return 1;
  }

  let spec;
  try {
    spec = loadSpecFile(fleetYamlPath);
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 1;
  }

  try {
    if (subcommand === 'init') {
      const { summary } = await runInit(spec);
      console.log(summary);
      return 0;
    }

    if (subcommand === 'token') {
      const tokenSubcommand = positional[2];
      if (tokenSubcommand !== 'rotate') {
        console.error(`error: unknown \`grid token\` subcommand "${tokenSubcommand ?? ''}" — expected "rotate"`);
        return 1;
      }
      const config = resolveConfigOrThrow(spec);
      const { token } = await rotateToken(config);
      console.log(`grid token rotate: new token issued — ${token}`);
      console.log('update RELATA_TOKEN (or the env var fleet.grid.token_env names) with this value, then restart any already-running `grid sync --watch` daemon to pick it up.');
      return 0;
    }

    if (subcommand === 'import') {
      const importPath = positional[2];
      if (!importPath) {
        console.error('error: `grid import` requires a <path|dir> argument');
        return 1;
      }
      const validKinds = ['meeting', 'discussion', 'decision', 'spec'];
      if (!validKinds.includes(flags.kind)) {
        console.error(`error: \`grid import\` requires --kind (one of ${validKinds.join(', ')}), got "${flags.kind ?? ''}"`);
        return 1;
      }

      const actor = resolveActor();
      const repoId = resolveRepoId();
      const localDir = localDirFor(spec, process.cwd());
      const { plan, warnings: planWarnings } = planImport(importPath, {
        kind: flags.kind,
        client: flags.client ?? '',
        date: flags.date ?? null,
        actor,
        repoDir: process.cwd(),
      });

      const totalRows = plan.reduce((n, f) => n + f.rows.length, 0);
      console.log(`grid import: ${plan.length} file(s), ${totalRows} chunk(s) planned${flags.apply ? '' : ' (dry-run — pass --apply to actually ingest)'}`);
      for (const f of plan) console.log(`  ${f.sourceFile}: ${f.rows.length} chunk(s), title="${f.title}", kind=${flags.kind}, valid_from=${f.validFrom}`);
      for (const w of planWarnings) console.error(`warning: ${w}`);

      if (!flags.apply) return 0;

      const config = resolveConfigOrThrow(spec);
      const { ingested, skipped, warnings: applyWarnings, mode } = await applyImport(config, plan, { localDir, repoId });
      console.log(`grid import --apply [${mode}]: ${ingested} row(s) ingested, ${skipped} already known (skipped, idempotent)`);
      for (const w of applyWarnings) console.error(`warning: ${w}`);
      return 0;
    }

    if (subcommand === 'knowledge') {
      const query = positional[2];
      if (!query) {
        console.error('error: `grid knowledge` requires a <query> argument');
        return 1;
      }
      const limit = flags.limit !== undefined ? Number(flags.limit) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        console.error(`error: --limit must be a positive integer, got "${flags.limit}"`);
        return 1;
      }
      const result = await computeGridKnowledge(spec, process.cwd(), query, {
        asOf: flags['as-of'] ?? null,
        asRecorded: flags['as-recorded'] ?? null,
        purpose: flags.purpose ?? undefined,
        limit,
      });
      console.log(result.summary);
      console.log(`\n${result.markdown}`);
      return 0;
    }

    if (flags.watch) {
      const controller = runWatch(spec);
      if (!controller.active) return 0; // not configured — runWatch already printed the advisory line
      await new Promise((resolve) => {
        process.on('SIGINT', () => {
          controller.stop();
          resolve();
        });
        process.on('SIGTERM', () => {
          controller.stop();
          resolve();
        });
      });
      return 0;
    }

    if (subcommand === 'overlaps') {
      const result = flags['git-only'] ? computeGitOnlyOverlaps(spec) : await computeOverlaps(spec);
      console.log(result.summary);
      if (result.markdown) console.log(`\n${result.markdown}`);
      for (const w of result.warnings) console.error(`warning: ${w}`);
      return 0;
    }

    const { summary, warnings } = await syncOnce(spec);
    console.log(summary);
    for (const w of warnings) console.error(`warning: ${w}`);
    return 0;
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 1;
  }
}
