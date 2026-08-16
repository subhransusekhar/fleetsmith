// SPDX-License-Identifier: AGPL-3.0-only
import { request } from '../../../src/memory/relatadb.js';
import { RelataHttpError } from '../../../src/memory/errors.js';

/**
 * G8.6 — tokens & members, one-time-visible credentials. Real, verified engine constraints (probed directly
 * against a live instance, GET-only/error-shape probes, no state mutated — 2026-08-16):
 *
 *  1. **`POST /tokens` and `DELETE /tokens/:id` require the engine's own distinct admin credential, not an
 *     ordinary per-developer bearer token** — confirmed via `DELETE /tokens/<id>` with no/a bogus bearer
 *     returning `403 {"detail":"admin token required"}`. This is the SAME separate `RELATA_ADMIN_TOKEN`
 *     `ee/src/grid/ontology.js`'s `ontologyMigrate()` already established (G2.1). So token administration is
 *     the ONE route family in this whole console that cannot forward the caller's own token — it forwards
 *     `consoleConfig.adminToken` instead, a server-held secret, while OUR OWN role gate (`role: 'admin'` in
 *     the route table, `CONSOLE_ADMINS`) decides which humans may trigger it. Every other route in this
 *     package forwards the caller's own token; this file is the documented exception, not the pattern.
 *  2. **There is no `GET /tokens` list-all endpoint.** `GET /tokens` returns `405 Method Not Allowed` with
 *     `Allow: POST` — confirmed directly. Only `POST /tokens` (create) and `GET|DELETE /tokens/:id`
 *     (get-by-id / revoke, both requiring a known id) are real. So "prefix-only listing" cannot mean "every
 *     token this org has ever created" — no mechanism gives that back, and this console has no second
 *     database to keep its own authoritative copy in (the whole point of "no persistent state anywhere"). What
 *     it CAN honestly offer: the tokens THIS PROCESS has created since it last started, held in memory, lost
 *     on restart — exactly the "restart mid-session loses nothing but in-flight requests" tradeoff the
 *     acceptance criteria already accepts. `GET /api/tokens` is explicit about this in its own response, never
 *     presented as an authoritative org-wide listing.
 *  3. **The created token's own value is returned exactly once**, in the `POST /tokens` response body (field
 *     name unverified beyond the fact that `id` is the one REQUIRED request field — a real create attempt
 *     against a live instance was avoided here since cleanup requires the same admin token this deployment
 *     does not have configured in this session; this module unpacks the response as defensively as
 *     `rotateToken()` (G7.1) already does for its own likewise-unverified response shape). This console never
 *     stores that value anywhere past the single response it arrives in — "one-time-visible" is enforced by
 *     construction (no second database to have kept it in), not by a policy this code has to remember to obey.
 */

export class TokenAdminError extends Error {}

/** In-memory only, this process's lifetime — see point 2 above. Never the authoritative list. */
const createdThisProcess = [];

function requireAdminToken(consoleConfig) {
  if (!consoleConfig.adminToken) {
    const err = new TokenAdminError('RELATA_ADMIN_TOKEN is not configured on this console — token administration is unavailable until it is.');
    err.status = 503;
    throw err;
  }
}

export async function listTokens(_ctx, consoleConfig) {
  return {
    status: 200,
    body: {
      tokens: createdThisProcess.map((t) => ({ id: t.id, owner: t.owner, prefix: t.prefix, createdAt: t.createdAt, createdBy: t.createdBy })),
      note: 'this engine has no list-all-tokens endpoint (verified: GET /tokens -> 405) — this is only what THIS console process has created since it last started, not an authoritative org-wide list',
      tokenAdminConfigured: Boolean(consoleConfig.adminToken),
    },
  };
}

export async function createToken(ctx, consoleConfig) {
  requireAdminToken(consoleConfig);
  const id = typeof ctx.body.id === 'string' && ctx.body.id ? ctx.body.id : null;
  if (!id) {
    const err = new TokenAdminError('body.id is required — the engine\'s own POST /tokens rejects a body missing it');
    err.status = 400;
    throw err;
  }
  const owner = typeof ctx.body.owner === 'string' ? ctx.body.owner : '';

  let result;
  try {
    result = await request({ url: consoleConfig.url, token: consoleConfig.adminToken }, { method: 'POST', path: '/tokens', body: { id, ...(owner ? { owner } : {}) } });
  } catch (e) {
    if (e instanceof RelataHttpError) {
      const err = new TokenAdminError(`token creation refused by the cortex: ${e.message}`);
      err.status = e.status;
      throw err;
    }
    throw e;
  }
  const value = result?.token ?? result?.value ?? result?.secret ?? null;
  createdThisProcess.push({ id, owner, prefix: value ? value.slice(0, 8) : '(unknown)', createdAt: new Date().toISOString(), createdBy: ctx.principal ?? '(unknown)' });

  return { status: 201, body: { id, owner, token: value, warning: value ? 'this value is shown exactly once — it is not retrievable again through this console' : 'the engine\'s response carried no recognizable token field under any known name (token/value/secret) — see this route\'s module doc comment' } };
}

export async function revokeToken(ctx, consoleConfig) {
  requireAdminToken(consoleConfig);
  const { id } = ctx.params;
  try {
    await request({ url: consoleConfig.url, token: consoleConfig.adminToken }, { method: 'DELETE', path: `/tokens/${encodeURIComponent(id)}` });
  } catch (e) {
    if (e instanceof RelataHttpError) {
      const err = new TokenAdminError(`revocation refused by the cortex: ${e.message}`);
      err.status = e.status;
      throw err;
    }
    throw e;
  }
  const idx = createdThisProcess.findIndex((t) => t.id === id);
  if (idx !== -1) createdThisProcess.splice(idx, 1);
  return { status: 200, body: { id, revoked: true } };
}

/** Test-only — the in-memory list above is otherwise process-lifetime, unresettable from outside. */
export function _resetForTests() {
  createdThisProcess.length = 0;
}
