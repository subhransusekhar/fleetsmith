// SPDX-License-Identifier: AGPL-3.0-only
import { reconcile } from '../../../src/grid/pull.js';
import { repoIdFromRemote } from '../repo.js';
import { listTokensCreatedThisProcess } from './tokens.js';

/** Same sentinel `routes/board.js` uses — nothing real ever has this as an `actor`, so nothing is excluded from `reconcile()`'s "not my own rows" filter. */
const NOBODY = ' console ';
const DEFAULT_STALE_TTL_MS = 15 * 60 * 1000;

function isStale(heartbeatAt, now, staleTtlMs) {
  const heartbeatMs = Date.parse(heartbeatAt);
  return !Number.isFinite(heartbeatMs) || now - heartbeatMs > staleTtlMs;
}

function latestByActor(presenceRows) {
  const byActor = new Map();
  for (const row of presenceRows) byActor.set(row.actor, row); // last write wins, reconcile()'s own verified stable insertion order
  return byActor;
}

/**
 * G8.6's members list: "known actors (from tokens + grid activity), role, last-seen (from presence), token
 * status" — a UNION of two real, independent, otherwise-unconnected signals, not a single source:
 *
 *  - Grid activity: `ActorPresence` rows (same live `reconcile()` query `routes/board.js` already uses) give
 *    a real `actor` name + last-seen timestamp for anyone whose fleet has synced through this cortex.
 *  - Tokens created through this console (`routes/tokens.js`'s in-memory, process-lifetime list — see that
 *    module's own doc comment for why there is no authoritative org-wide token listing at all) give an
 *    `owner` name + token status for anyone provisioned here, whether or not they have ever synced yet.
 *
 * These two lists are NOT guaranteed to share names (a token's `owner` field is free text this console never
 * cross-checks against a real `actor` value) — merging them is a convenience for a human reading one screen,
 * not a claim that "owner" and "actor" are the same identity space on this engine.
 */
export async function getMembers(ctx, consoleConfig) {
  const repoId = repoIdFromRemote(ctx.query.remote);
  const config = { url: consoleConfig.url, token: ctx.token, purposes: ['grid_sync'] };
  const { newRows, warnings } = await reconcile(config, repoId, { actor: NOBODY });

  const presenceRows = newRows.filter((r) => r.typeName === 'ActorPresence').map((r) => r.row);
  const presenceByActor = latestByActor(presenceRows);
  const now = Date.now();

  const tokensByOwner = new Map();
  for (const t of listTokensCreatedThisProcess()) {
    if (!tokensByOwner.has(t.owner)) tokensByOwner.set(t.owner, []);
    tokensByOwner.get(t.owner).push(t);
  }

  const names = new Set([...presenceByActor.keys(), ...tokensByOwner.keys()].filter(Boolean));
  const members = [...names].sort().map((name) => {
    const presence = presenceByActor.get(name);
    const tokens = tokensByOwner.get(name) ?? [];
    return {
      name,
      role: consoleConfig.admins.includes(name) ? 'admin' : 'member',
      lastSeen: presence ? { heartbeatAt: presence.heartbeat_at, stale: isStale(presence.heartbeat_at, now, DEFAULT_STALE_TTL_MS), branch: presence.branch } : null,
      tokens: tokens.map((t) => ({ id: t.id, prefix: t.prefix, createdAt: t.createdAt, expiresAt: t.expiresAt })),
    };
  });

  return { status: 200, body: { members, warnings } };
}
