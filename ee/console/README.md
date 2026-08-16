# fleetsmith-ee console

The cortex admin console — a stateless BFF (`server/`) over RelataDB's REST surface. No second database, no
sessions, no user table: every request carries the caller's own bearer token, this server validates it against
the cortex per request, and (with the one documented exception of token administration, which the engine
itself gates behind a distinct admin credential) forwards that same token for every fan-out call, so the
engine's own ACL and audit trail always see the real principal, never a service identity.

## Running it

```sh
RELATA_URL=https://your-cortex:9090 \
CONSOLE_ADMINS=alice,bob \
RELATA_ADMIN_TOKEN=... \
PORT=4173 \
node ee/console/server/index.js
```

- `RELATA_URL` (required) — the one cortex every request fans out to. The console has no `fleet.yaml` of its
  own (it may serve many repos/fleets sharing one cortex); a route that needs a specific repo takes it as a
  `?remote=<git-remote-url>` query param instead and hashes it the same way `resolveRepoId()` does.
- `CONSOLE_ADMINS` (optional, comma-separated actor names) — who the admin-only routes accept. A caller's
  actor name here comes only from `GET /tokens/self`'s discoverable principal for their own token, never a
  client-asserted header; when that engine call reports no principal (the common bearer-mode case — see
  `ee/src/grid/identity.js`), every admin route fails closed (403), regardless of `CONSOLE_ADMINS`. This is
  deliberately stricter than the CLI grid daemon's own advisory identity check.
- `RELATA_ADMIN_TOKEN` (optional) — required only for the token-administration routes (`/api/tokens/*`),
  which the engine itself gates behind this distinct credential, verified directly (`DELETE /tokens/:id` with
  an ordinary bearer token returns `403 admin token required`). Every other route works without it.
- `PORT` (optional, default `4173`).

## Routes

| Method | Path | Role | Screen |
|---|---|---|---|
| GET | `/api/health` | public | G8.7 |
| GET | `/api/board?remote=` | member | G8.2 |
| GET | `/api/audit?actor=&since=&until=&purpose=&limit=` | member (self-only, forced) / admin (any actor) | G8.3 |
| GET | `/api/audit/why?id=` | member | G8.3 |
| GET | `/api/knowledge?remote=&q=&purpose=&asOf=&asRecorded=&limit=` | member | G8.4 |
| GET | `/api/procedures?q=&purpose=&limit=` | member | G8.4 (read-only — see `routes/knowledge.js`) |
| POST | `/api/knowledge/:contentHash/propose` | member | G8.4 |
| POST | `/api/knowledge/:contentHash/approve` | **admin** | G8.4 |
| POST | `/api/knowledge/:contentHash/publish` | member | G8.4 |
| GET | `/api/equip/:fleet/:agent?remote=` | member | G8.5 |
| PUT | `/api/equip/:fleet/:agent?remote=` | **admin** | G8.5 |
| GET | `/api/tokens` | **admin** | G8.6 |
| POST | `/api/tokens` | **admin** | G8.6 |
| DELETE | `/api/tokens/:id` | **admin** | G8.6 |

`role: 'admin'` routes are exactly what G8.8's curl-bypass suite targets: a member token (or no token at all)
must get a 403/401 from every one of them, server-side, regardless of what the web UI would have rendered.

`/api/audit` has a THIRD access shape, distinct from the plain member/admin split: a member token's `actor`
filter is overwritten server-side with their own discovered principal (`routes/audit.js`'s
`requireSelfOnlyActor`) regardless of what `?actor=` the request carries — a member sees only their own audit
history, never another actor's, even with a tampered query param. Admin sees any actor. A member with no
discoverable principal at all is refused (403), not silently shown zero rows or every row.

## Real engine constraints this design accounts for (verified, not assumed)

- `GET /health` is unauthenticated regardless of the bearer header, so it cannot serve as an identity probe —
  `authenticateToken` (`server/auth.js`) uses `POST /query {sql:"SELECT 1"}` instead (G3.1's own finding).
- `GET /tokens/self` reports `present:false` for the common bearer-mode case, even for a correctly-
  authenticating token (G3.1/G7.1) — so admin-role resolution fails closed whenever a principal isn't
  discoverable, rather than granting admin to an unverifiable caller.
- `POST /tokens` and `DELETE /tokens/:id` require a distinct admin credential the ordinary per-developer
  bearer token cannot satisfy; `GET /tokens` (list-all) does not exist at all (`405`, `Allow: POST`) — see
  `server/routes/tokens.js`'s module doc comment for the full probe trail.
- There is no distinct "ProcedureMemory" type with real, approval-worthy fields — `/api/procedures` is
  read-only for exactly this reason (see `server/routes/knowledge.js`).
