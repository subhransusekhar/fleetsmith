// SPDX-License-Identifier: AGPL-3.0-only
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { normalizeSpec } from 'fleetsmith/spec';
import { resolveGridConfig } from '../config.js';
import { resolveActor } from '../actor.js';
import { resolveRepoId, ingestRows } from './ontology.js';
import { gridInit } from './init.js';
import { pushOnce } from './push.js';
import { pullOnce, watchGridChanges, startIntervalReconcile } from './pull.js';
import { materialize } from './materialize.js';

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

// --- one-shot commands -----------------------------------------------------------

/** `fleetsmith grid init`. Throws `DaemonError`/`InitError` (G3.1) for a missing config or a failed token check — a user error, not a degradable one. */
export async function runInit(spec, cwd = process.cwd()) {
  const config = resolveConfigOrThrow(spec);
  const localDir = localDirFor(spec, cwd);
  const result = await gridInit(config, { localDir, actor: resolveActor() });
  const summary = `grid init: migrate ${result.migration.engineMigrationRan ? 'ran' : 'skipped (no admin token)'}, token ${result.tokenSanity.authenticated ? 'ok' : 'FAILED'}${
    result.tokenSanity.mismatch ? ` (principal mismatch: ${result.tokenSanity.note})` : ''
  }, skeleton at ${result.skeleton.gridDir}`;
  return { summary, result };
}

/** One push → reconcile → materialize cycle. Never throws for a degraded condition (network errors, per-type failures) — only for a missing/malformed grid config, which is a user error. */
export async function syncOnce(spec, cwd = process.cwd()) {
  const config = resolveConfigOrThrow(spec);
  const localDir = localDirFor(spec, cwd);
  const actor = resolveActor();
  const repoId = resolveRepoId(cwd);

  const pushResult = await pushOnce(config, cwd, { localDir, actor, repoId });
  const pullResult = await pullOnce(config, cwd, { localDir, repoId, actor });
  const { written } = materialize(pullResult.newRows, localDir);

  const actorsSeen = new Set(pullResult.newRows.map((r) => r.row.actor));
  const warnings = [...pushResult.warnings, ...pullResult.warnings];
  const summary = `grid sync: pushed ${pushResult.pushed.length} row(s), pulled ${pullResult.newRows.length} row(s) from ${actorsSeen.size} actor(s), wrote ${written.length} file(s)${
    warnings.length ? `, ${warnings.length} warning(s)` : ''
  }`;
  return { summary, warnings, pushResult, pullResult, written };
}

// --- watch mode --------------------------------------------------------------------

/**
 * `fleetsmith grid sync --watch`: runs `syncOnce` on startup, then again whenever the SSE doorbell fires
 * (G3.3), on the fixed interval fallback, on a local ledger/handoff file change (debounced), or on a run
 * starting. A presence heartbeat re-ingests `ActorPresence` with a fresh `heartbeat_at` on its own timer,
 * independent of whether anything else changed — deliberately bypassing `pushOnce`'s digest-diff, since the
 * whole point of a heartbeat is a fresh timestamp even when nothing else did change. Returns a controller;
 * the real CLI handler runs this until the process receives SIGINT/SIGTERM.
 */
export function runWatch(spec, cwd = process.cwd(), opts = {}) {
  const config = resolveConfigOrThrow(spec);
  const localDir = localDirFor(spec, cwd);
  const actor = resolveActor();
  const repoId = resolveRepoId(cwd);
  const log = opts.log ?? console.log;
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

function parseGridArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      flags[a.slice(2)] = true;
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

  if (!subcommand || !['init', 'sync'].includes(subcommand)) {
    console.error(`error: unknown grid subcommand "${subcommand ?? ''}" — expected "init" or "sync [--watch]"`);
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

    if (flags.watch) {
      const controller = runWatch(spec);
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

    const { summary, warnings } = await syncOnce(spec);
    console.log(summary);
    for (const w of warnings) console.error(`warning: ${w}`);
    return 0;
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 1;
  }
}
