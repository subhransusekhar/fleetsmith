// SPDX-License-Identifier: AGPL-3.0-only
import fs from 'node:fs';
import path from 'node:path';
import { request } from '../memory/relatadb.js';
import { ontologyMigrate } from './ontology.js';
import { resolveActor } from '../actor.js';
import { aclPolicyStatus } from './identity.js';
import { seedPurposes } from './purposes.js';

/**
 * `fleetsmith grid init` (G3.1): the one-time (and always safe to re-run) setup a checkout needs before the
 * push/pull loops (G3.2/G3.3) have anything to talk to. Wired as the `init` subcommand of the `grid` CLI
 * verb in G3.5 — this module is the logic underneath that command, callable directly by anything (a test, a
 * future daemon) that already has a resolved grid config.
 *
 * --- Two things the milestone assumed exist on the real engine surface, and don't (verified 2026-08-16 ------
 * --- against a fresh, isolated RelataDB v1.5.7 instance in bearer auth mode) -----------------------------
 *
 *  1. **No purpose-registration endpoint exists.** `/purposes`, `/purpose`, `/purposes/register` all 404.
 *     `[purpose] mode = "open"` is this engine's only observed configuration — every purpose string works
 *     unregistered regardless, so "seed the standard purposes" has no real network call to make. This step
 *     is therefore a pure, local, zero-network computation: the list this checkout will use for every future
 *     grid call, not a write to the engine. `seedPurposes()` itself now lives in `./purposes.js` (G7.2), which
 *     also names each standard purpose's one-line meaning and `assertPurpose()` for typo-proofing a
 *     human-typed `--purpose` CLI flag — this module just calls it.
 *  2. **`/tokens/self` reports `{"present": false}` for every bearer token tried, including the actual,
 *     correctly-authenticating one** — not just for ad-hoc `POST /tokens`-created records (which also never
 *     authenticated as real credentials in testing; that endpoint appears to be bookkeeping for a different
 *     auth mode, not live in `bearer` mode). There is no principal identity to discover in the one auth mode
 *     `resolveGridConfig` (G1.1) supports. `checkTokenSanity` below still calls `/tokens/self` — a caller on
 *     `oidc`/`mtls` might see `present: true` with a real principal, and the mismatch check exists for that
 *     case — but the common, currently-only-observed case is `present: false`, reported as a plain fact, not
 *     a warning.
 *
 * What IS real and load-bearing: an actual authenticated network call. `checkTokenSanity` issues
 * `POST /query {sql: "SELECT 1"}` — the cheapest real round trip that enforces the bearer token (confirmed:
 * a wrong token 401s here; `GET /health`, by contrast, is unauthenticated regardless of the header, so it
 * cannot stand in for this check).
 */

export class InitError extends Error {}

async function checkTokenSanity(config, actor) {
  try {
    await request(config, { method: 'POST', path: '/query', body: { sql: 'SELECT 1', purpose: config.purposes?.[0] ?? 'grid_sync' } });
  } catch (e) {
    throw new InitError(`grid token does not authenticate against ${config.url}: ${e.message}`);
  }

  const self = await request(config, { method: 'GET', path: '/tokens/self' });
  if (!self?.present) {
    return { authenticated: true, principal: null, mismatch: false, note: 'this engine reports no per-token principal for the configured bearer token — nothing to compare against the local actor' };
  }
  const principal = self.principal ?? self.owner ?? self.id ?? null;
  const mismatch = principal !== null && principal !== actor;
  return {
    authenticated: true,
    principal,
    mismatch,
    note: mismatch ? `the token's principal ("${principal}") does not match the resolved local actor ("${actor}") — grid rows this checkout pushes will be attributed to "${actor}"` : undefined,
  };
}

/** Creates `filePath` with `content` only if it does not already exist — re-running `gridInit` must never overwrite real materialized state (a peer's `GRID.md`, an in-progress `pushed.json` digest map, a live cursor). */
function ensureFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) return false;
  fs.writeFileSync(filePath, content);
  return true;
}

function writeSkeleton(localDir) {
  const gridDir = path.join(localDir, 'grid');
  fs.mkdirSync(path.join(gridDir, 'peers'), { recursive: true });
  const created = {
    cursor: ensureFile(path.join(gridDir, 'cursor'), ''),
    'pushed.json': ensureFile(path.join(gridDir, 'pushed.json'), '{}\n'),
    'GRID.md': ensureFile(path.join(gridDir, 'GRID.md'), '# Grid\n\ngrid not yet synced; run `fleetsmith grid sync`\n'),
  };
  return { gridDir, created };
}

/**
 * Runs every G3.1 step in order, throwing `InitError` immediately (before any network call) when `config` is
 * absent — the one refusal this function makes, since every other step below is designed to degrade rather
 * than fail. Safe to call repeatedly: `ontologyMigrate` is idempotent (G2.1), purpose seeding makes no
 * network call, the token check is read-only, and `writeSkeleton` never overwrites an existing file.
 */
export async function gridInit(config, { localDir = '_fleet/local', actor = resolveActor() } = {}) {
  if (!config) {
    throw new InitError(
      'grid is not configured — set RELATA_URL + RELATA_TOKEN, or a `grid:` block in fleet.yaml (`url` + `token_env`), before running `fleetsmith grid init`. See docs/architecture/intelligence-grid.md.'
    );
  }

  const migration = await ontologyMigrate(config);
  const purposeSeed = seedPurposes(config);
  const tokenSanity = await checkTokenSanity(config, actor);
  const aclPolicy = aclPolicyStatus(); // G7.1 — always a template-only notice; see identity.js's own doc comment for why
  const skeleton = writeSkeleton(localDir);

  return { migration, purposeSeed, tokenSanity, aclPolicy, skeleton };
}
