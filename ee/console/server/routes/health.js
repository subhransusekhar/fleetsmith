// SPDX-License-Identifier: AGPL-3.0-only
import { request } from '../../../src/memory/relatadb.js';
import { RelataNetworkError, RelataHttpError } from '../../../src/memory/errors.js';
import { reconcile } from '../../../src/grid/pull.js';
import { repoIdFromRemote } from '../repo.js';

/**
 * G8.7 — deployment health, split across two routes with genuinely different auth requirements:
 *
 *  - `GET /api/health` (`role: 'public'`, unchanged since G8.1): mirrors the engine's own unauthenticated
 *    `GET /health` — a wrong token still gets HTTP 200 from it (G3.1's own verified finding), so gating
 *    fleetsmith's OWN reachability check behind a bearer token a monitoring probe would rarely have adds
 *    friction the engine itself does not require.
 *  - `GET /api/health/detail` (`role: 'member'`, new): the richer cortex + harness panel, which NEEDS a real
 *    token — `GET /status` and `GET /metrics` both 401 without one (verified directly against the primary dev
 *    instance: unauthenticated returns `401 Bearer token missing or invalid`), forwarded as the CALLER's own
 *    token like every other non-token-admin route in this console.
 *
 * --- What could and could not be found on this engine surface (verified directly, GET-only, 2026-08-16) ----
 *
 *  - `GET /status` (authenticated): real fields — `profile`, `node_id`, `role`, `active_connections`,
 *    `query_quota`, `ingested_rows`, `uptime_secs`. Surfaced here as `engineStatus`.
 *  - `GET /metrics` (authenticated): Prometheus text format. `relata_store_total_stored_bytes`'s own HELP
 *    text reads "Total stored bytes (hot + spilled) — free-tier cap is metered against this" — confirming
 *    both that the metric is real and that the free-tier cap this task's own issue names (10 GB) is metered
 *    against exactly this value. `parseStorageBytes` below extracts it.
 *  - **License expiry is NOT retrievable through any HTTP endpoint at all.** `/license`, `/admin/license`,
 *    `/license/status`, `/admin/status`, `/v1/health` all 404; `/status` and `/metrics` (both checked in
 *    full) carry no expiry field. The engine's own `valid_until` claim lives ONLY in the node's local license
 *    file, unreachable from a remote console. `licenseStatus` below therefore reads `consoleConfig
 *    .licenseExpiresAt` (`RELATA_LICENSE_EXPIRES_AT` env var) — an operator-supplied value mirroring what
 *    they already know from their own node, never a value this console claims to have queried from the engine.
 */

const FREE_TIER_CAP_BYTES = 10 * 1024 ** 3;
const LICENSE_WARNING_THRESHOLD_DAYS = 14;
// Deliberately shorter than routes/board.js's/routes/members.js's general 15-minute presence TTL: this task's
// own acceptance criterion is "shows as degraded within one sync cycle," and daemon.js's own default sync
// cadence (DEFAULT_RECONCILE_INTERVAL_MS / DEFAULT_HEARTBEAT_MS) is 5 minutes — one missed cycle's worth of
// slack (2x) catches a real outage fast without flagging ordinary jitter between cycles as degraded.
const LAST_SYNC_DEGRADED_TTL_MS = 10 * 60 * 1000;

/** No real developer's `actor` field is ever this string — see the identical convention in `routes/board.js`/`routes/members.js`. */
const NOBODY = ' console ';

export async function getDeploymentHealth(_ctx, consoleConfig) {
  const base = {
    consoleUrl: consoleConfig.url,
    tokenAdminConfigured: Boolean(consoleConfig.adminToken),
    admins: consoleConfig.admins.length,
  };
  try {
    // No token: this specific engine endpoint ignores the Authorization header regardless (see above), so
    // there is no caller token to forward here even in principle — this is the one call in the whole console
    // that is never made on a caller's behalf.
    const engine = await request({ url: consoleConfig.url, token: '' }, { method: 'GET', path: '/health' });
    return { status: 200, body: { ...base, reachable: true, engine } };
  } catch (e) {
    // Unlike the CLI daemon, this console has no local file backend to degrade to — an unreachable cortex is
    // reported plainly, not silently absorbed.
    return { status: 200, body: { ...base, reachable: false, error: e instanceof RelataNetworkError ? e.message : String(e.message ?? e) } };
  }
}

/**
 * `GET /metrics` returns Prometheus TEXT format, not JSON — `relatadb.js`'s own `request()` unconditionally
 * tries `JSON.parse` on every response body (`unwrapRelataResponse(null)` for anything that fails to parse),
 * so it would silently turn this endpoint's real text body into `null`. This is a small, local, direct `fetch`
 * instead, for this one non-JSON endpoint only — everything else in this console keeps using `request()`.
 */
async function fetchMetricsText(config) {
  let res;
  try {
    res = await fetch(new URL('/metrics', config.url), { headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new RelataNetworkError(`request to ${config.url}/metrics failed: ${e.message}`);
  }
  if (!res.ok) throw new RelataHttpError(`RelataDB GET /metrics -> HTTP ${res.status}`, { status: res.status });
  return res.text();
}

/** A single Prometheus-text gauge/counter value by exact metric name — not a general parser, just this one line shape (`<name> <value>`), which is all this route needs. */
function parseMetricValue(metricsText, name) {
  const line = metricsText.split('\n').find((l) => l.startsWith(`${name} `));
  if (!line) return null;
  const value = Number(line.slice(name.length).trim());
  return Number.isFinite(value) ? value : null;
}

/** `capBytes: null` for any non-`free` profile — the 10 GB cap is the free tier's own limit, not a universal one; this console has no basis to guess a cap for `server`/`cluster` profiles, so it reports usage without a percentage rather than inventing a number. */
export function storageStatus(metricsText, profile) {
  const usedBytes = parseMetricValue(metricsText, 'relata_store_total_stored_bytes');
  if (usedBytes === null) return { available: false };
  const capBytes = profile === 'free' ? FREE_TIER_CAP_BYTES : null;
  return { available: true, usedBytes, capBytes, percentUsed: capBytes ? Math.round((usedBytes / capBytes) * 1000) / 10 : null };
}

/** Pure — `now` is injectable so a fixture can test the 14-day threshold deterministically, per this task's own acceptance criterion, without depending on real wall-clock time. `configured: false` (no warning, no error) is the default, honest state when the operator has not set `RELATA_LICENSE_EXPIRES_AT` at all. */
export function licenseStatus(expiresAt, now = Date.now()) {
  if (!expiresAt) return { configured: false };
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) return { configured: false, error: `RELATA_LICENSE_EXPIRES_AT is not a valid date: "${expiresAt}"` };
  const daysRemaining = Math.floor((expiresMs - now) / 86_400_000);
  const warning = daysRemaining <= LICENSE_WARNING_THRESHOLD_DAYS;
  return {
    configured: true,
    expiresAt,
    daysRemaining,
    warning,
    message: warning
      ? `license expires in ${daysRemaining} day(s) — start reissue now (manual process, ~24h turnaround)`
      : `license valid for ${daysRemaining} more day(s)`,
  };
}

function isStale(heartbeatAt, now, staleTtlMs) {
  const heartbeatMs = Date.parse(heartbeatAt);
  return !Number.isFinite(heartbeatMs) || now - heartbeatMs > staleTtlMs;
}

function latestByActor(rows) {
  const byActor = new Map();
  for (const row of rows) byActor.set(row.actor, row); // last write wins, reconcile()'s own verified stable insertion order
  return byActor;
}

/**
 * The harness panel: per known actor, `last_sync` (G8.7's own new `ActorPresence` field, stamped by
 * `daemon.js`'s `syncOnce()` only on a cycle that actually completes) and a derived degradation state —
 * distinct from mere presence/`heartbeat_at` staleness (which only proves the daemon PROCESS is alive). An
 * actor with no `last_sync` at all (a pre-G8.7 daemon, or one that has never completed a single cycle) is
 * reported as `unknown`, not silently folded into either healthy or degraded.
 */
function harnessStatus(presenceRows, now) {
  const byActor = latestByActor(presenceRows);
  return [...byActor.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([actor, row]) => {
    if (!row.last_sync) return { actor, state: 'unknown', lastSync: null, heartbeatAt: row.heartbeat_at };
    const degraded = isStale(row.last_sync, now, LAST_SYNC_DEGRADED_TTL_MS);
    return { actor, state: degraded ? 'degraded' : 'healthy', lastSync: row.last_sync, heartbeatAt: row.heartbeat_at };
  });
}

/** The authenticated detail route: cortex status/storage/license, plus per-actor harness degradation. Every fan-out here uses the CALLER's own token, same as every non-token-admin route in this console. */
export async function getDeploymentHealthDetail(ctx, consoleConfig) {
  const config = { url: consoleConfig.url, token: ctx.token };
  const warnings = [];

  let engineStatus = null;
  let storage = { available: false };
  try {
    engineStatus = await request(config, { method: 'GET', path: '/status' });
  } catch (e) {
    warnings.push(`GET /status failed: ${e.message}`);
  }
  try {
    const metricsText = await fetchMetricsText(config);
    storage = storageStatus(metricsText, engineStatus?.profile);
  } catch (e) {
    warnings.push(`GET /metrics failed: ${e.message}`);
  }

  const license = licenseStatus(consoleConfig.licenseExpiresAt);

  let harness = [];
  if (ctx.query.remote) {
    const repoId = repoIdFromRemote(ctx.query.remote);
    try {
      const { newRows, warnings: reconcileWarnings } = await reconcile({ ...config, purposes: ['grid_sync'] }, repoId, { actor: NOBODY });
      harness = harnessStatus(newRows.filter((r) => r.typeName === 'ActorPresence').map((r) => r.row), Date.now());
      warnings.push(...reconcileWarnings);
    } catch (e) {
      warnings.push(`harness status query failed: ${e.message}`);
    }
  }

  return { status: 200, body: { engineStatus, storage, license, harness, warnings } };
}
