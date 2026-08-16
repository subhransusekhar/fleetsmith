# Identity (v0.7.0 G7.1)

Every developer running `fleetsmith grid` against a shared RelataDB cortex has their own bearer token. This
document covers provisioning, rotation, revocation, client-side enforcement, the ACL policy template, and
OIDC — stating plainly what's real today versus what's a documented gap.

## Provisioning

An admin creates one token per developer via the engine's own `POST /tokens` API (see RelataDB's own docs for
the exact request shape — fleetsmith does not wrap token *creation*, only self-service *rotation*, see below).
A 90-day TTL is the recommended default; shorter for anyone with elevated access, longer only with a
compensating control (e.g. IP allowlisting at the network layer, outside fleetsmith's own reach).

Each developer sets their own token as `RELATA_TOKEN` (or names an env var via `fleet.grid.token_env` in
`fleet.yaml`, per `ee/src/config.js`'s resolution order) — never a token literal committed to `fleet.yaml`
itself; `resolveGridConfig` refuses that outright.

## Rotation

`fleetsmith grid token rotate` calls the engine's real, documented `POST /tokens/self/rotate` endpoint and
prints the new token value. It does not, and cannot, rewrite your shell environment or `fleet.yaml` for you —
updating `RELATA_TOKEN` (or whatever env var `token_env` names) is on you.

**A running `grid sync --watch` daemon reads its token once, into memory, at process startup.** There is no
live-reload. Rotating a token therefore requires restarting any already-running daemon process before it
picks up the new value — the CLI's own output says so every time. The old token keeps authenticating until
the rotation call actually succeeds, so there's no forced downtime window as long as the restart happens
promptly afterward, not before it.

The exact response shape of `/tokens/self/rotate` has not been independently verified against a live
instance in this project's own testing — `rotateToken()` (`ee/src/grid/identity.js`) tries a few plausible
field names (`token`, `new_token`, `value`) defensively rather than assuming one, and throws a clear error if
none match.

## Revocation

Revoking a token via the engine's own token-management surface takes effect immediately for new requests. For
an already-open SSE watch connection specifically: the engine re-authenticates streams roughly every 15
seconds, so a revoked token also kills that developer's live grid watch within about that window, not
instantly — expect a short tail, not indefinite continued access.

## Client-side enforcement (the operative control today)

On every `grid sync` cycle, before pushing, fleetsmith resolves the configured token's principal (`GET
/tokens/self`) and compares it against the locally-resolved actor (`FLEETSMITH_ACTOR` env → `git config
user.email`'s local part → `$USER` → `unknown`). If the engine reports a real, discoverable principal that
**mismatches** the local actor, the push is refused outright — with an actionable fix in the error (set
`FLEETSMITH_ACTOR` to match the token, or configure the token that actually belongs to this developer). **Pull
is never affected** — reading peers' state is the entire point of the grid, and a locally-misconfigured
identity is never a reason to withhold what a checkout can already see.

**The common case today: no principal is discoverable at all.** Verified directly against a real, licensed
RelataDB instance (2026-08-15, `bearer` auth mode — see `ee/src/grid/init.js`'s own doc comment): `GET
/tokens/self` reports `{"present": false}` for every bearer token tried, including the actual,
correctly-authenticating one. When that's what the engine reports, there is nothing to compare against the
local actor, so the push proceeds unverified — refusing it in that case would break the common case entirely,
not just a genuinely misconfigured one. A caller on `oidc`/`mtls` auth (see below) might see a real principal
here; the mismatch check exists for that case too, not only as a no-op.

## Server-side ACL: a template today, not an enforced policy

`ee/src/grid/fixtures/acl-policy.json` expresses the desired access-control policy, in fleetsmith's own
vocabulary — every grid-row write must come from its own declared actor; an org-approval mutation (G7.3, not
yet built) must come from an approver role. **This is not currently enforceable against the real engine.**
RelataDB's own conditional/cell-level ACL enforcement is not yet wired into every call site upstream (tracked
as RelataDB issues #3118/#3125/#3126) — the project's own architecture doc already calls this out as a known
gap, not an assumption made here: cell-level ACL is explicitly framed as *defense in depth*, not the sole
isolation boundary.

No `/acl`, `/policy`, `/rbac`, or comparable endpoint exists anywhere in this project's own verified findings
against a real instance. `fleetsmith grid init` therefore always reports the ACL policy as a **reviewable
template, not applied** — regardless of whether an admin token happens to be configured — rather than
attempting a call against a guessed endpoint. When RelataDB ships real conditional-ACL enforcement, this file
is what an admin (or a future fleetsmith version) applies it from.

## OIDC / JWKS (documented, not implemented)

RelataDB supports OIDC/JWKS-based authentication for SSO shops as an alternative to a bare bearer token — see
RelataDB's own deployment documentation for configuring an identity provider. Fleetsmith's own config
resolution (`ee/src/config.js`) only reads a plain bearer token from `RELATA_TOKEN`/`token_env` today; it does
not perform an OIDC login flow itself. A deployment using OIDC upstream still authenticates every fleetsmith
request with the resulting bearer token exactly as today — the identity/principal-discovery behavior above
would very likely differ (a caller under `oidc`/`mtls` auth is the case `resolvePrincipal`'s `present: true`
branch already accounts for), but this has not been tested against a real OIDC-configured instance in this
project's own work.
