# Setup (v0.7.0 G10.2)

End-to-end: a cortex exists → an admin provisions it → two developers sync through it. Every command below was
run for real against a live RelataDB instance while writing this doc (not merely reasoned about) — two
independent temp checkouts sharing one `origin` remote URL, exactly the shape [`grid-e2e.test.js`](../../ee/test/grid-e2e.test.js)
(G3.7) exercises automatically. Treat the numbered steps as copy-paste, adjusting only the URL/token/paths.

## 0. Prerequisites

- A reachable RelataDB instance — see [`deployment.md`](deployment.md) for choosing and standing one up.
- Node ≥ 18 and `fleetsmith`/`fleetsmith-ee` installed (or, in this monorepo during development,
  `FLEETSMITH_EE_PATH=ee/src/index.js node src/cli.js ...` in place of a bare `fleetsmith` binary — every
  command below shows both forms).
- Every developer needs a bearer token for the cortex. Production should give each developer their **own**
  token — see [`identity.md`](identity.md)'s Provisioning section (token creation is the engine operator's own
  `POST /tokens` API; fleetsmith wraps rotation, not creation). This walkthrough uses one shared token for
  brevity, since that's all a fresh cortex has until an admin creates more.

## 1. Admin: stand up the cortex and create tokens

Bring up RelataDB per [`deployment.md`](deployment.md), then optionally start the admin console (needs no
`fleet.yaml` of its own — see [`ee/console/README.md`](../../ee/console/README.md) for the full option list):

```sh
RELATA_URL=http://your-cortex:9090 CONSOLE_ADMINS=alice,bob PORT=4173 \
  node ee/console/server/index.js
```

`GET /api/health` (no auth needed) is the fastest reachability check:

```sh
curl http://127.0.0.1:4173/api/health
# {"consoleUrl":"http://127.0.0.1:9090","reachable":true,"engine":{"status":"ok","profile":"free", ...}}
```

Create one token per developer via the engine's own token API (see RelataDB's own docs for the request shape).

## 2. Each developer: point a checkout at the cortex

Two ways to configure, per `ee/src/config.js`'s resolution order (env pair wins if both are set):

**Env vars** (simplest, what this walkthrough uses):
```sh
export RELATA_URL=http://your-cortex:9090
export RELATA_TOKEN=<your own token>
```

**Or a committed `fleet.yaml` block**, if the team wants the URL checked in (never the token — a literal
`fleet.grid.token` is refused outright):
```yaml
fleet:
  name: my-fleet
  grid:
    url: http://your-cortex:9090
    token_env: RELATA_TOKEN   # the NAME of the env var; export the real token yourself
```

Actor identity resolves automatically (`FLEETSMITH_ACTOR` env → the local part of `git config user.email` →
`$USER` → `unknown`) — set `FLEETSMITH_ACTOR` explicitly if your git email's local part isn't what you want as
your grid identity, as this walkthrough does for two developers sharing one machine.

## 3. `fleetsmith grid init`

```sh
$ FLEETSMITH_ACTOR=alice fleetsmith grid init fleet.yaml
# (dev override in this monorepo:)
$ FLEETSMITH_EE_PATH=ee/src/index.js FLEETSMITH_ACTOR=alice \
    node src/cli.js grid init fleet.yaml

grid init: migrate skipped (no admin token), token ok, ACL policy NOT applied (template only — ...), skeleton
at .../_fleet/local/grid
```

This is the one grid verb that **throws** (non-zero exit) if not configured at all — it's meant to be run once,
deliberately, not from automation that should degrade quietly. "Migrate skipped" is normal without a separate
engine admin token (`RELATA_ADMIN_TOKEN`) — the grid's own ontology types register themselves on first real
`fleetsmith grid sync` regardless. "ACL policy NOT applied" is also expected today — see
[`identity.md`](identity.md)'s ACL section for why (a reviewable template, not an enforced policy, on this
engine surface).

Repeat for every developer's own checkout.

## 4. `fleetsmith grid sync`

Alice edits her ledger (`_fleet/local/LEDGER.md`), then:

```sh
$ FLEETSMITH_ACTOR=alice fleetsmith grid sync fleet.yaml
grid sync: pushed 1 row(s), pulled 0 row(s) from 0 actor(s), wrote 2 file(s), 0 overlap(s), 4 warning(s)
```

**Expect a handful of warnings on the very first sync in a brand-new repo** — none of them mean anything is
broken:
- `RunEventSummary`/`EquipBinding` "not registered in the schema" — every grid ontology type self-registers on
  its *own* first `/ingest` call (`ee/src/grid/ontology.js`'s own doc comment); a type nobody has pushed yet
  simply has nothing to pull, and the engine reports that as a 400 rather than an empty result. It clears the
  first time anything of that type is actually pushed.
- `git diff --name-only origin/main failed` — the file-declaration enrichment step (G2.3) needs a real
  `origin/main` ref to diff against; a fresh repo with no real remote fetched yet won't have one. Push and pull
  both still work; only the "files declared" enrichment on in-progress tasks is affected.

Now bob syncs (after a couple of seconds — cross-actor visibility isn't instant, it rides the next reconcile):

```sh
$ FLEETSMITH_ACTOR=bob fleetsmith grid sync fleet.yaml
grid sync: pushed 0 row(s), pulled 2 row(s) from 1 actor(s), wrote 4 file(s), 0 overlap(s), 2 warning(s)
```

## 5. Verify: two-developer smoke test

This is the exact shape `grid-e2e.test.js` (G3.7) automates — run it by hand once per new cortex to build
confidence, or lean on the automated suite (`RELATA_TEST_URL=... node --test ee/test/grid-e2e.test.js`) for
CI-grade repetition.

```sh
# On bob's checkout, after the sync above:
$ cat _fleet/local/grid/peers/alice/LEDGER.md
# alice — Ledger (peer projection, read-only)
| # | Task | Owner | Depends on | Status | Artifact |
|---|------|-------|-----------|--------|----------|
| 1 | wire up the payments webhook | alice | - | in-progress | src/webhooks/payments.js |

$ cat _fleet/local/grid/GRID.md
# Grid
_Synced: ... · Cortex: reachable · Active actors: 1
## alice
_(active — last seen ...)_
- #1: wire up the payments webhook — files: ...
```

Both files are read-only peer projections — nothing under `_fleet/local/grid/peers/` is ever hand-edited, and
neither ever touches `_fleet/shared/` (the grid is advisory input only; see
[`docs/evolution.md`](../evolution.md)'s invariant 9).

**Console board**, same data, a different lens (`?remote=` is required — the console has no git checkout of
its own, so every repo-scoped route takes the repo's git remote URL and hashes it the same way the CLI does):

```sh
$ curl -H "Authorization: Bearer $RELATA_TOKEN" \
    "http://127.0.0.1:4173/api/board?remote=git@github.com:you/your-repo.git"
{"syncedAt":"...","actors":[{"actor":"alice","presence":{...},"tasks":[{"task":"wire up the payments webhook", "status":"in-progress", ...}]}, ...]}
```

If both checks show the other developer's task, the grid is working end to end.

## 6. Ongoing use

- `fleetsmith grid sync --watch` runs continuously — on SSE doorbell (if the engine emits one; see
  [`degradation.md`](degradation.md) for why it may not on a single-node deployment), a 5-minute interval
  fallback, local ledger/handoff file changes, and run start/end. Exits cleanly on SIGINT/SIGTERM.
- `fleetsmith grid overlaps` (or `--git-only` for the zero-dependency, no-cortex-needed answer) surfaces
  cross-developer file/task collisions in `OVERLAPS.md`.
- See [`governance.md`](governance.md) for importing team knowledge, purposes, approvals, and audit; and the
  console's `members.html`/`health.html` screens for team-wide visibility.

## Positioning

Nothing above is required to use fleetsmith. A checkout with no `RELATA_URL`/`fleet.grid` block behaves exactly
like plain v0.6 — file backend, git, done. This setup is additive: pre-commit cross-developer awareness that
would otherwise wait for a PR.
