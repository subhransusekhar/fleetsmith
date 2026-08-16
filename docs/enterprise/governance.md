# Governance (v0.7.0 G10.2)

Purposes, the `OrgDocument` approval lifecycle, equip scoping, and audit — the governance layer that sits on
top of the grid's sync mechanics. See [`setup.md`](setup.md) for standing the grid up first, and
[`identity.md`](identity.md) for token provisioning/rotation and the client-side identity/ACL story this
document doesn't repeat.

## Purposes

Every recall declares a `purpose` — the unit of governance on reads, and what shows up in the audit trail
(below). Six standard purposes, always available (`ee/src/grid/purposes.js`):

| Purpose | Meaning |
|---|---|
| `cross_dev_reuse` | checking whether a peer already built it |
| `regression_check` | past failures touching these files |
| `product_context` | product/roadmap background for a decision |
| `client_commitment` | what we promised a client |
| `decision_rationale` | why a past decision was made |
| `grid_sync` | the daemon's own machinery |

A fleet can declare additional purposes via `fleet.yaml`'s `grid.purposes` list; the CLI's own `--purpose`
flags (`grid knowledge --purpose`, `grid audit --purpose`) validate against the standard six plus those
extras and print the full list if you typo one. This is a **local, client-side vocabulary** — no
purpose-registration endpoint exists on the engine (`/purposes`, `/purpose`, `/purposes/register` all 404;
the engine's own `purpose_mode` is `open`, meaning it accepts any purpose string, registered or not). The
generic `remember`/`recall`/`justify`/`forget` verbs deliberately do **not** enforce this vocabulary — it's a
typo-proofing convenience for the one place a human types a purpose by hand, not a hard gate.

**Three purposes have a special effect on recall:** `product_context`, `client_commitment`, and
`decision_rationale` (`ORG_RECALL_PURPOSES` in `ee/src/memory/relatadb.js`) cause `recall()` to also search
`OrgDocument` (imported org knowledge) and merge those hits in alongside ordinary memory items. Every other
purpose searches memory items only.

## Importing org knowledge

`fleetsmith grid import <path|dir> --kind meeting|discussion|decision|spec [--client <name>] [--date <YYYY-MM-DD>]`
plans a chunked import (dry-run by default; add `--apply` to actually ingest). Already-imported chunks are
skipped idempotently on re-import. Each chunk becomes one `OrgDocument` row, keyed by `(repo_id, content_hash)`
— the same content imported twice is the same row, re-ingested (RelataDB's only "update" mechanism), not a
duplicate.

## The approval lifecycle

Every imported `OrgDocument` starts as `draft` (a row with no `approval` field). Four forward states, one step
at a time — `draft → proposed → approved → published` — plus one backward exception:

```
draft ──propose──> proposed ──approve──> approved ──publish──> published
          ^                │
          └────reject──────┘   (proposed → draft only; requires a non-empty note)
```

| Verb | CLI | Requires an approver? | Notes |
|---|---|---|---|
| Propose | `fleetsmith grid propose <content_hash>` | No | `draft → proposed`, anyone can propose. |
| Approve | `fleetsmith grid approve <content_hash>` | **Yes** | `proposed → approved` — the only transition gated on `grid.approvers`/`GRID_APPROVERS` (a client-side allowlist; see [`identity.md`](identity.md) for why this isn't an engine-enforced role). |
| Publish | `fleetsmith grid publish <content_hash>` | No | `approved → published`. |
| Reject | (console only today: `POST /api/knowledge/:contentHash/reject`) | **Yes** | The one backward transition, `proposed → draft` only — refused from any other state. Requires a non-empty rejection note; `rejected_by`/`rejected_at`/`rejection_note` persist as a historical record even through a later re-propose/re-approve cycle. |

Skipping a step or moving backward from anywhere but `proposed` is refused outright, naming the only valid
next state. An **approved or published** document gets a fixed 1.5× score boost in recall (`RANKING_BOOST`)
and lists by title in `GRID.md`'s "Org-approved" section — approval never writes to `_fleet/local` or
`_fleet/shared`; the PR ladder remains the only path into the committed tier (see
[`docs/evolution.md`](../evolution.md)'s invariant 9).

This lifecycle applies only to `OrgDocument` — a "procedural" memory (a `lesson`-kind `remember()` call) has no
first-class approval fields at all; the console's Procedures screen is read-only for exactly this reason.

## Equip scoping

`EquipBinding` rows (keyed by `repo_id, fleet, agent, scope_kind, scope_ref`) restrict what a specific agent
may recall, in one of three ways:

- **`purpose`** — which recall `purpose` strings this agent may use at all.
- **`knowledge_collection`** — which `OrgDocument` collections (by kind, or `kind:client` — e.g.
  `meeting:acme`) this agent may recall from.
- **`procedure`** — whether this agent may recall `lesson`-kind memory at all (one collection, named `*`, since
  there's no finer real identity for procedures today).

**Absent bindings mean unrestricted** — this is opt-in restriction, never opt-in permission. A fresh grid with
no `EquipBinding` rows at all behaves exactly as it did before G8.5; writing a binding only ever narrows one
specific agent's access, never widens it beyond the default.

An admin edits bindings via the console (`equip.html`, backed by `PUT /api/equip/:fleet/:agent?remote=...`,
body `{"bindings": [{"scope_kind": "...", "scope_ref": "...", "equipped": true}]}`) or reads the current state
(`GET`, any member). The same `equippedRefs()`/`knowledgeCollectionRef()` functions that compute the console's
"effective" view are what `recall()` itself calls to enforce it — the UI can never disagree with what's
actually enforced, because it isn't a second implementation of the same logic.

## Audit

Every purpose-bearing action produces an entry the cortex's own audit chain records:

```sh
fleetsmith grid audit [--actor a] [--since t] [--until t] [--purpose p] [--limit n] [--json]
fleetsmith grid audit --why <item-id>
```

`--why <item-id>` explains one item's lineage: an `org:<content_hash>` id resolves to the `OrgDocument`'s own
source file, import date, and approval/rejection history; any other id resolves via the ordinary memory-verb
`justify()`. There is no degraded counterpart for `--why` — without a cortex there's nothing to explain
lineage against.

Without a cortex configured, `grid audit` (without `--why`) still answers from
`_fleet/local/runs/<actor>-<ts>/events.jsonl` — real run events, but no purpose/recall/approval history, since
none of that exists anywhere without a cortex to have recorded it. The console mirrors the same query
(`audit.html`, `GET /api/audit`) with one added restriction: a non-admin member's `actor` filter is
server-overwritten to their own discovered identity — they cannot query anyone else's audit trail, admin
tampering with the query string included.

## Positioning

Every governance mechanism above is opt-in narrowing on top of a grid that works fully without it — no
purposes declared, no equip bindings written, no approvals run means every recall behaves exactly as it did
before this milestone. Without a cortex at all, `grid audit`/`grid knowledge` degrade to local, file-only
answers rather than refusing outright (see [`degradation.md`](degradation.md)).

## See also

- [`identity.md`](identity.md) — token provisioning, rotation, client-side identity/ACL enforcement
- [`ee/console/README.md`](../../ee/console/README.md) — the console's full route table
- [`docs/architecture/intelligence-grid.md`](../architecture/intelligence-grid.md) — the load-bearing design decisions behind all of the above
