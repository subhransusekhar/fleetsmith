// SPDX-License-Identifier: AGPL-3.0-only
import { request } from '../../src/memory/relatadb.js';
import { RelataHttpError, RelataNetworkError } from '../../src/memory/errors.js';
import { resolvePrincipal } from '../../src/grid/identity.js';

/**
 * Server-side authz — the ONLY authz (G8.1's whole point). Every route handler runs behind `requireAuth`
 * (`router.js`), which never trusts anything the caller claims about themselves beyond the bearer token
 * itself: no `X-Role` header, no client-asserted actor name, nothing the web UI could spoof with a raw curl.
 *
 * --- Two checks, deliberately different in what they can prove ---------------------------------------------
 *
 *  1. `authenticateToken`: is this token valid AT ALL? `POST /query {sql:"SELECT 1"}` is the real, verified
 *     probe (G3.1's own finding: `GET /health` is unauthenticated regardless of the bearer header, so it
 *     cannot serve this purpose — a wrong token still gets 200 from it). A non-2xx here means the token does
 *     not authenticate; every route requires this, including plain reads.
 *  2. `resolveRole`: WHO is this token, well enough to grant admin? `GET /tokens/self` (`resolvePrincipal`,
 *     G7.1) reports `present:false` for the common bearer-mode case (G3.1's own verified finding) — so this
 *     resolves to `'member'`, not a thrown error, whenever a principal isn't discoverable OR the discovered
 *     principal isn't in `config.admins`. This fails CLOSED: an admin route requires BOTH a discoverable
 *     principal AND that principal's presence in `config.admins` (`CONSOLE_ADMINS` env var) — there is no
 *     path by which an unverifiable token becomes 'admin'. This is deliberately stricter than the CLI grid
 *     daemon's own `assertPushIdentity`, which proceeds unverified (fails OPEN) when no principal is
 *     discoverable — a background sync daemon degrading to "unverified" is tolerable; an admin console
 *     silently granting admin to an unverifiable caller is not.
 */

export class AuthError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** `null` for a missing/malformed header — callers decide whether that's fatal (every route does, via `requireAuth`). */
export function extractBearerToken(req) {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/** Throws `AuthError` (401) for a missing header, an invalid token, or an unreachable cortex (502 — nothing else this stateless server could do about it). Returns nothing on success. */
export async function authenticateToken(consoleConfig, token) {
  if (!token) throw new AuthError('missing or malformed Authorization header — expected "Bearer <token>"', 401);
  try {
    await request({ url: consoleConfig.url, token }, { method: 'POST', path: '/query', body: { sql: 'SELECT 1', purpose: 'fleetsmith_console' } });
  } catch (e) {
    if (e instanceof RelataHttpError && (e.status === 401 || e.status === 403)) {
      throw new AuthError('this token does not authenticate against the configured cortex', 401);
    }
    if (e instanceof RelataNetworkError) {
      throw new AuthError(`the cortex at ${consoleConfig.url} is unreachable: ${e.message}`, 502);
    }
    throw e;
  }
}

/**
 * `{ role: 'admin'|'member', principal: string|null }`. Never throws — an error probing `/tokens/self` is
 * treated exactly like "no principal discoverable" (role `'member'`), since a probe failure is not evidence
 * of anything about the caller's identity either way.
 */
export async function resolveRole(consoleConfig, token) {
  let principal = null;
  try {
    principal = await resolvePrincipal({ url: consoleConfig.url, token });
  } catch {
    principal = null;
  }
  const isAdmin = principal !== null && consoleConfig.admins.includes(principal);
  return { role: isAdmin ? 'admin' : 'member', principal };
}
