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
- `RELATA_ADMIN_TOKEN` (optional) — required only for the token-CREATE/REVOKE routes (`POST /api/tokens`,
  `DELETE /api/tokens/:id`), which the engine itself gates behind this distinct credential, verified directly
  (`DELETE /tokens/:id` with an ordinary bearer token returns `403 admin token required`). Self-rotation
  (`POST /api/tokens/self/rotate`) needs no admin token — every other route works without one.
- `RELATA_LICENSE_EXPIRES_AT` (optional, ISO 8601) — enables the license-expiry warning on the health screen
  (G8.7). Nothing on this engine's HTTP surface reports license expiry (verified — see `routes/health.js`'s own
  doc comment for the full probe trail), so this is an operator-supplied value mirroring what they already
  know from their own node's local license file.
- `PORT` (optional, default `4173`).

## Routes

| Method | Path | Role | Screen |
|---|---|---|---|
| GET | `/api/health` | public | G8.7 (unauthenticated reachability check, unchanged since G8.1) |
| GET | `/api/health/detail?remote=` | member | G8.7 (engine status, storage vs. free-tier cap, license warning, per-actor harness degradation) |
| GET | `/api/board?remote=` | member | G8.2 |
| GET | `/api/audit?actor=&since=&until=&purpose=&limit=` | member (self-only, forced) / admin (any actor) | G8.3 |
| GET | `/api/audit/why?id=` | member | G8.3 |
| GET | `/api/knowledge?q=&purpose=&asOf=&asRecorded=&limit=` | member | G8.4 (search) |
| GET | `/api/knowledge/documents` | member | G8.4 (browse, metrics, review queue) |
| GET | `/api/procedures?q=&purpose=&limit=` | member | G8.4 (read-only — see `routes/knowledge.js`) |
| POST | `/api/knowledge/:contentHash/propose` | member | G8.4 |
| POST | `/api/knowledge/:contentHash/approve` | **admin** | G8.4 (returns `diff` against the currently-published same title+chunk_index, if one exists) |
| POST | `/api/knowledge/:contentHash/publish` | member | G8.4 |
| POST | `/api/knowledge/:contentHash/reject` | **admin** | G8.4 (body: `{note}`, required) |
| GET | `/api/equip/:fleet/:agent?remote=` | member | G8.5 (bindings + the exact `effective` view `recall()` itself computes) |
| PUT | `/api/equip/:fleet/:agent?remote=` | **admin** | G8.5 (body: `{bindings: [{scope_kind, scope_ref, equipped}]}`) |
| GET | `/api/tokens` | **admin** | G8.6 (this-process-only, see below) |
| POST | `/api/tokens` | **admin** | G8.6 (body: `{id, owner?, ttlSeconds?}` — full value shown once) |
| DELETE | `/api/tokens/:id` | **admin** | G8.6 (immediate, irreversible) |
| POST | `/api/tokens/self/rotate` | member (self-service) | G8.6 (wraps G7.1's `rotateToken`, caller's own token) |
| GET | `/api/members?remote=` | member | G8.6 (grid-activity actors ∪ tokens created here, role from `CONSOLE_ADMINS`) |

`role: 'admin'` routes are exactly what G8.8's curl-bypass suite targets: a member token (or no token at all)
must get a 403/401 from every one of them, server-side, regardless of what the web UI would have rendered.
The manifest this suite checks against (`server/manifest.js`'s `routeManifest()`) is derived directly from
`buildApp()`'s own router — there is no second, hand-maintained route list to fall out of sync with the one
above.

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
- There is no distinct "ProcedureMemory" type with real, approval-worthy fields, nor a queryable `supersedes`
  chain — `/api/procedures` is read-only for exactly this reason (see `server/routes/knowledge.js`). RelataDB's
  real `consolidate` MCP tool is schema-documented to supersede one item by id, but that shape was read off
  `GET /mcp/tools`, never independently round-tripped in this project — not a basis this console builds a
  mutation on.
- `reject` (G8.4) is the one transition that moves backward (`proposed` -> `draft`) and the one that requires
  a note — `ee/src/grid/approval.js`'s `rejectOrgDocument`, a new sibling to G7.3's forward-only
  `assertValidTransition` machinery, not a case bolted onto it.
- **Equip (G8.5) is REAL enforcement, not a declared intent.** `EquipBinding` is a first-class row in the G2.1
  ontology (`ee/src/grid/types.json`), and `ee/src/memory/relatadb.js`'s `recall()` actually consults bindings
  — when a caller passes `agent`/`fleet`/`repoId` in `opts` (an optional, additive extension riding on the
  same generic object; the core memory port's own `RecallOptions` contract is untouched) — filtering both
  `OrgDocument` results (by `knowledge_collection`, `kind[:client]`) and `lesson`-kind memory items (by
  `procedure`). Per scope_kind, an EMPTY set of bindings means unrestricted: existing callers that never pass
  `agent`/`fleet`/`repoId` (everything in this codebase, until this task) see byte-identical behavior.
  `/api/equip`'s `effective` field calls the exact same `equippedRefs`/`knowledgeCollectionRef` helpers
  `recall()` enforces with, so the console can never show an "effective" view that disagrees with reality.
- **Tokens & members (G8.6).** `ttlSeconds` on create is forwarded best-effort as `ttl_seconds` — the one
  earlier probe against `POST /tokens` only established that `id` is required, not an expiry field's real
  name, so this is documented as assumed, same tier as the token-value field itself. Revocation is immediate
  and irreversible — a live test confirms a revoked token fails to authenticate on its very next request
  (the ~15s SSE-reauth framing in the issue describes a live stream this engine profile never actually opens,
  per G3.3's own finding that `/graph/changes` emits nothing; what's real and verified is that revocation kills
  the NEXT request outright, which is what actually stops the interval-reconcile fallback G3.5 established as
  load-bearing). Every request is logged once (`server/logging.js`) with only method/path/redacted-query/
  status/duration in scope — headers and response bodies are never even passed to the logger, so a token
  value has no code path into log output at all, not merely a scrub applied after capturing it.
- **Deployment health (G8.7).** `GET /status` and `GET /metrics` both need a real (authenticated) token —
  verified directly, both 401 unauthenticated — forwarded as the caller's own, same as every non-token-admin
  route. `relata_store_total_stored_bytes`'s own `/metrics` HELP text ("free-tier cap is metered against
  this") confirms the 10 GB free-tier cap this task names is metered against exactly that gauge. **License
  expiry is not retrievable through any HTTP endpoint at all** — `/license`, `/admin/license`,
  `/license/status`, `/admin/status` all 404; the expiry lives only in the node's local license file, which a
  remote console cannot read — see `RELATA_LICENSE_EXPIRES_AT` above. The harness panel's per-actor
  degradation reads a NEW `ActorPresence.last_sync` field (additive, `ee/src/grid/types.json`), stamped by
  `daemon.js`'s `syncOnce()` only on a cycle that actually completes — distinct from `heartbeat_at`, which
  only proves the daemon process is alive even while its actual sync attempts are failing. `last_sync` is
  carried forward through the heartbeat timer's and run-end's OWN presence pushes (both fixed as part of this
  task) so a heartbeat firing after a successful sync never silently blanks it back out — last-write-wins on
  `ActorPresence` replaces the whole row, not a per-field merge.
- **The authz-bypass suite (G8.8, `test/authz-bypass.test.js`).** Every mutation route in the live manifest
  gets a raw-fetch bypass attempt per insufficient role (anonymous, member-where-admin-needed), each asserting
  BOTH the correct status code and zero state change via a follow-up admin-authenticated read — a route that
  merely 403s while still mutating would pass a status-only check. The completeness check
  (`assertMutationsFullyTested`) fails loudly, naming every gap, if a new mutation route is ever added without
  a matching test case; its own correctness is proven with a synthetic manifest (a real drift scenario can't
  be committed just to watch CI fail on it). Point 4 of this task's own "what to build" ("run in CI with the
  live container") could not be exercised this session — CI is currently disabled by the user's own
  instruction (see project memory), and no live credentials were configured; the suite runs fully against a
  fake cortex today and is ready to run against a live one the moment both are available again.
