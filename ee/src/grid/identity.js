// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { request } from '../memory/relatadb.js';

/** The reviewable ACL policy template (see the module doc comment) — loaded once, the same `JSON.parse(readFileSync(...))` pattern `ontology.js` already uses for `types.json`. */
const ACL_POLICY_PATH = new URL('./fixtures/acl-policy.json', import.meta.url);
export const ACL_POLICY = JSON.parse(readFileSync(ACL_POLICY_PATH, 'utf8'));

/** `grid init`'s report on the ACL policy template — always `applied: false`, regardless of admin-token configuration, since no engine-side mechanism exists to apply it against at all (not merely "we didn't have the rights"). Kept as a function, not a constant, so the note can eventually change without touching every call site if that ever becomes false. */
export function aclPolicyStatus() {
  return {
    applied: false,
    policy: ACL_POLICY,
    note: 'server-side ACL enforcement is not yet wired on this engine (see ee/src/grid/fixtures/acl-policy.json) — this policy is a reviewable template only; client-side identity checks (assertPushIdentity, below) are the operative control today',
  };
}

/**
 * Identity (G7.1): every developer has their own bearer token; the token's principal must match the
 * `actor` on every row this checkout pushes; an ACL policy template expresses the desired enforcement for
 * whenever the underlying engine gains a real mechanism to apply it.
 *
 * --- Server-side ACL is not a real, callable mechanism on this engine today — this is not a testing gap ----
 *
 * The milestone's own architecture doc and task doc already say so directly: "Server-side conditional-ACL
 * enforcement is not yet wired into every call site" (`docs/architecture/intelligence-grid.md`), tracked
 * upstream as RelataDB #3118/#3125/#3126, with cell-level ACL explicitly named "defense in depth, not the
 * sole isolation boundary." No `/acl`, `/policy`, `/rbac`, or similar endpoint appears anywhere in this
 * project's own research or in any module that has actually talked to a real instance (`relatadb.js`,
 * `ontology.js`, `init.js`) — only `/tokens`, `/tokens/self`, `/tokens/self/rotate` are real, verified
 * auth-adjacent endpoints. Building an "apply this ACL policy" call against a guessed endpoint would repeat
 * exactly the mistake this project's own standing rule already forbids: "refusing to build on [RelataDB
 * primitives] that aren't real." So `fixtures/acl-policy.json` is shipped as a REVIEWABLE TEMPLATE — the
 * desired policy, in fleetsmith's own vocabulary, ready to apply the moment a real mechanism exists — and
 * this module's client-side check below is the OPERATIVE control today, not a supplement to a server-side
 * one that does not exist yet.
 *
 * --- Principal discovery is ALSO unreliable on this engine, per G3.1's own already-verified finding --------
 *
 * `ee/src/grid/init.js`'s `checkTokenSanity` already found, against a real instance, that `GET /tokens/self`
 * reports `{"present": false}` for every bearer token tried, including the actual, correctly-authenticating
 * one — the common, currently-only-observed case in `bearer` auth mode. `resolvePrincipal` below makes the
 * same call for the same reason `checkTokenSanity` does (a caller on `oidc`/`mtls` might see `present: true`
 * with a real principal), but `assertPushIdentity` must not — and does not — refuse a push just because
 * verification is UNAVAILABLE (`present: false`): that would break the common case entirely, not just the
 * genuinely-misconfigured one. Only a REAL, discoverable mismatch refuses a push.
 *
 * --- Scope: push only, never pull ---------------------------------------------------------------------------
 *
 * Reading peers' state is the entire point of the grid; a misconfigured or ambiguous local token is never a
 * reason to withhold what a checkout can already see. Only `assertPushIdentity` exists — there is no
 * `assertPullIdentity`, deliberately.
 */

export class IdentityError extends Error {}

/** `GET /tokens/self` -> the discoverable principal, or `null` when the engine reports `present: false` (the common bearer-mode case — see the module doc comment) or the field itself is missing. Read-only, safe to call on every push cycle. */
export async function resolvePrincipal(config) {
  const self = await request(config, { method: 'GET', path: '/tokens/self' });
  if (!self?.present) return null;
  return self.principal ?? self.owner ?? self.id ?? null;
}

/**
 * Throws `IdentityError` — with the actionable fix in the message — only when a REAL, discoverable principal
 * mismatches `actor`. When no principal is discoverable at all, returns `{enforced: false, ...}` rather than
 * throwing: nothing was actually verified, so refusing to push would be a false positive, not a caught
 * misconfiguration. The caller (`daemon.js`'s `syncOnce`) is expected to skip the push step, not the whole
 * cycle, on a thrown `IdentityError` — pull/materialize continue regardless.
 */
export async function assertPushIdentity(config, actor) {
  const principal = await resolvePrincipal(config);
  if (principal === null) {
    return {
      enforced: false,
      principal: null,
      actor,
      note: 'this engine reports no per-token principal for the configured bearer token (the common bearer-mode case) — nothing to compare against the local actor; push proceeds unverified',
    };
  }
  if (principal !== actor) {
    throw new IdentityError(
      `this grid token's principal ("${principal}") does not match the resolved local actor ("${actor}") — refusing to push, since every row this cycle would push gets attributed to "${actor}" regardless. ` +
        `Fix: either set FLEETSMITH_ACTOR="${principal}" to match this token, or configure the token that actually belongs to "${actor}".`
    );
  }
  return { enforced: true, principal, actor, note: undefined };
}

/**
 * `POST /tokens/self/rotate` — a real, documented endpoint (distinct from `/tokens/self`, which G3.1 already
 * found broken for principal discovery in bearer mode; nothing in this project's own testing has found
 * reason to doubt rotation specifically, though its exact response shape has not been independently verified
 * against a live instance either — this tries a few plausible field names defensively rather than assuming
 * one).
 *
 * Returns only the new token value; this function cannot and does not rewrite the caller's own environment
 * or `fleet.yaml` — updating `RELATA_TOKEN` (or whatever env var `fleet.grid.token_env` names) is the
 * caller's job. A running `grid sync --watch` daemon reads its token once, into `config.token`, at process
 * startup — there is no live-reload of that value, so picking up a rotated token requires restarting any
 * already-running daemon process. The OLD token keeps authenticating until rotation actually succeeds, so
 * there is no forced downtime window as long as the restart happens promptly after rotating, not before.
 */
export async function rotateToken(config) {
  const result = await request(config, { method: 'POST', path: '/tokens/self/rotate' });
  const newToken = result?.token ?? result?.new_token ?? result?.value ?? null;
  if (!newToken) {
    throw new IdentityError(`token rotation against ${config.url} succeeded but returned no recognizable new-token field (got: ${JSON.stringify(result)})`);
  }
  return { token: newToken };
}
