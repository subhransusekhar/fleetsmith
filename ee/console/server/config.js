// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Console config (G8.1): resolved ONLY from the environment — the console is a single, generic deployable
 * that may serve many repos/fleets sharing one cortex (see `docs/architecture/intelligence-grid.md`: "one
 * cortex serves many projects"), so there is no `fleet.yaml` to read at server-startup time the way the CLI
 * daemon has one. Per-request scoping (which repo, which fleet) comes from query params on each route
 * instead — see `routes/`.
 *
 * Deliberately NOT `ee/src/config.js`'s `resolveGridConfig()`: that function resolves ONE bearer token shared
 * by a single developer's CLI process. The console has no such token of its own for ordinary reads/writes —
 * every request carries the CALLER's own bearer token (see `auth.js`), forwarded to the cortex as-is so the
 * engine's own ACL/audit see the real principal, never a service identity. `adminToken` below is the one
 * deliberate exception: RelataDB's own `/tokens` CRUD verbs are gated behind a distinct admin credential no
 * ordinary developer token can satisfy (verified directly — see `routes/tokens.js`'s module doc comment), so
 * token administration is the one route family that structurally cannot forward the caller's own token.
 */

export class ConsoleConfigError extends Error {}

function assertValidUrl(url, source) {
  try {
    new URL(url);
  } catch {
    throw new ConsoleConfigError(`${source} is not a valid URL: "${url}"`);
  }
}

/** Comma-separated actor names — the SAME parsing shape `ee/src/config.js`'s `readApproversEnv()` already applies to `GRID_APPROVERS`; duplicated here (not imported) since that function is CLI/fleet.yaml-config-resolution-shaped and not exported, and this is a two-line, easily-kept-in-sync rule, not a real coupling risk. */
function readCsvEnv(env, name) {
  const raw = env[name];
  if (!raw) return [];
  return raw.split(',').map((a) => a.trim()).filter(Boolean);
}

/**
 * `{ url, adminToken, admins, port }`. Throws `ConsoleConfigError` when `RELATA_URL` is missing — unlike the
 * CLI's grid config, which treats absence as "not configured, degrade silently," the console IS the cortex's
 * admin surface: a console with nowhere to connect has nothing to serve, so failing loudly at startup (not
 * per-request) is the honest behavior.
 *
 * `admins` (`CONSOLE_ADMINS` env var) names actors trusted with admin-only routes — reuses the exact same
 * client-side, config-driven-allowlist shape `ee/src/grid/approval.js`'s `assertApprover` already established
 * for `grid.approvers`, for the identical reason: "no role/scope concept has been verified on this engine
 * surface at all" (see that module's own doc comment). A caller's role is only ever resolvable when this
 * engine's `/tokens/self` reports a real principal for their token — the common bearer-mode case does not
 * (G3.1's own verified finding) — so an admin route fails CLOSED (403, `auth.js`'s `resolveRole`) whenever
 * principal discovery does not succeed, never open. This is deliberately stricter than the CLI daemon's own
 * advisory `assertPushIdentity` (which proceeds unverified when no principal is discoverable): a background
 * sync daemon degrading to "unverified" is tolerable, an admin console silently granting admin is not.
 */
export function resolveConsoleConfig(env = process.env) {
  const url = env.RELATA_URL;
  if (!url) {
    throw new ConsoleConfigError('RELATA_URL is required to start the console — it is the one cortex every request fans out to.');
  }
  assertValidUrl(url, 'RELATA_URL');

  return {
    url,
    adminToken: env.RELATA_ADMIN_TOKEN || null,
    admins: readCsvEnv(env, 'CONSOLE_ADMINS'),
    port: Number.parseInt(env.PORT ?? '4173', 10),
  };
}
