# The Intelligence Grid — Enterprise Multi-Developer Architecture

**Status:** design · **Created:** 2026-08-15 · **Milestone:** [`docs/milestones/v0.7.0-intelligence-grid.md`](../milestones/v0.7.0-intelligence-grid.md) · **Tasks:** [`docs/milestones/v0.7.0-tasks.md`](../milestones/v0.7.0-tasks.md) · **Builds on:** [`multi-user-context.md`](multi-user-context.md), the v0.6 memory port

## The problem

The three-tier workspace (`multi-user-context.md`) makes team knowledge shareable **through git**: learnings promote via PR into `_fleet/shared/`, and everyone gets them on pull. That is correct and stays the OSS answer. But it cannot answer four enterprise asks:

1. Two developers' agents cannot see each other's **in-flight work** — ledger rows, handoffs, declared files — before a commit exists.
2. Team memory is only as fresh as the last merged PR; there is no **semantic recall across the team** mid-task.
3. **Organizational context** (client meetings, group calls, product discussions) has no ingestion path into agent decision-making.
4. There is no **central governance**: no per-developer identity on reads, no purpose audit, no org-approval channel.

The rejected-as-default alternative in `multi-user-context.md` — "keep everything local, sync via a backend" — is exactly this design, now built as the enterprise tier on top of the unchanged OSS tier.

## Position: a fourth tier that is a projection, not a store

```
user-global        ~/.claude/skills/ …            methodology I reuse everywhere
project-shared     _fleet/shared/    (committed)  what the team has learned (PR-gated)
project-local      _fleet/local/     (gitignored) what my current run is doing
grid (enterprise)  RelataDB cortex   (cloud)      what everyone is doing/knows RIGHT NOW
```

The grid tier holds **projections and memory, never authority**. The precedence rule from the handover protocol extends verbatim: *the message is a doorbell; the file is the payload.* The grid is a doorbell network — local files remain authoritative, grid state is advisory and staleness-marked, and the promotion ladder into `_fleet/shared/` remains the only path by which anything becomes reviewed team knowledge.

## Components

```
  developer A laptop                          developer B laptop
┌─────────────────────────┐                 ┌─────────────────────────┐
│ fleet agents            │                 │ fleet agents            │
│   │ read/write (files)  │                 │                         │
│ _fleet/local/           │                 │ _fleet/local/           │
│   LEDGER.md  handoffs/  │                 │   LEDGER.md  handoffs/  │
│   runs/  notes/         │                 │   grid/peers/A/  ◄──────┼── read-only projection
│   grid/peers/B/  ◄──────┼── of B's work   │                         │
│         ▲               │                 │         ▲               │
│  fleetsmith grid sync   │                 │  fleetsmith grid sync   │
└───┬─────┴───────────────┘                 └───┬─────┴───────────────┘
    │ push: /ingest (typed rows)                │
    │ pull: SSE /graph/changes + cursor         │
    ▼                                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                RelataDB cortex (customer-run, BYOL)              │
│  grid ontology: FleetTask · ActorPresence · HandoffPointer ·     │
│                 RunEventSummary                                  │
│  memory verbs:  MemoryItem · ProcedureMemory · DecisionRecord    │
│  org knowledge: OrgDocument (meetings, calls, discussions)       │
│  governance:    purpose registry · ACL · audit chain · AS OF     │
└──────────────────────────────────────────────────────────────────┘
        ▲                                   ▲
  fleetsmith grid import              ee/console (admin: grid board,
  (meeting notes, transcripts)        audit, approvals, equip, tokens)
```

- **`fleetsmith grid` daemon** (`ee/src/grid/`): push side projects local ledger/handoffs/presence up as typed rows; pull side materializes peers' projections down into `_fleet/local/grid/peers/<actor>/` plus one `GRID.md` rollup. Agents only ever read files — the design is identical across Claude Code, opencode, and goose, and survives the database disappearing.
- **RelataDB memory adapter** (`ee/src/memory/`): the v0.6 five-verb port over `/memory/*`, giving team-wide semantic recall with mandatory `purpose`.
- **Org knowledge import** (`ee/src/grid/import.js`): meeting notes and discussions as provenance-tracked `OrgDocument` rows, bi-temporal (business time = meeting date).
- **Cortex console** (`ee/console/`): stateless BFF over RelataDB's REST — grid board, audit, approval state machine, equip scopes, tokens. No second database.

## Load-bearing decisions

Each of these was forced by evidence, not preference; reversing one requires re-checking its source.

| Decision | Why (evidence) |
|---|---|
| Task/presence state goes through **`/ingest` as our own ontology types**, not the memory verbs | RelataDB v2.0.0 source: `/memory/*` writes bypass `governed_upsert`, so they never reach the `/graph/changes` SSE changefeed. Only `/ingest` rows get WAL + ACL + fan-out |
| Sync = **SSE wake-up + cursor reconciliation** (`LIMIT n AFTER '<system_from_ns>'`), never `/watch/stream` | `/watch/stream` is a stateless per-request poll, O(watchers × query cost), registry lost on restart. SSE broadcast buffer is 1000 with gap notices — so SSE is only ever the doorbell; the cursor pull is the payload |
| **Single-writer rows**: every grid row keyed by actor (or actor+seq) | The engine has no CRDTs and no client-facing merge — only bi-temporal supersession + HLC ordering. Keying by actor makes concurrent-write conflicts impossible by construction |
| **One org = one tenant**; developer identity = bearer token principal + `actor` field | Multi-tenant mode is cluster-profile + paid-license only; sub-tenant namespaces are stored but not enforced (#54); single-tenant reads ignore org headers. Never build isolation on namespaces |
| Grid rows carry **pointers and digests, never handoff bodies or file contents** | Server-side conditional-ACL enforcement is not yet wired into every call site (#3118/#3125/#3126); client-side redaction + minimal payloads are the defense until it is |
| Agents read **files, not APIs** | Keeps the harness portable across all three targets and makes degradation trivial: an unreachable cortex just means stale files |
| **Text-only recall by default** (BM25 + RRF), embedder sidecar optional | Embeddings are caller-supplied since engine v1.1; adding an embedding dependency to a one-dep project needs its own justification (v0.6.0 stance, unchanged) |
| Deterministic overlap checks; model judgment only inside existing agent turns | Project invariant since v0.5: deterministic checks carry every gate; exactly one model call in the evolution loop. The grid adds zero model calls |

## Invariants (additions to `docs/evolution.md` when G9.4 lands)

1. **Grid state is advisory.** It may never gate an agent, alter a QA/eval verdict, or bypass the promotion ladder. The SubagentStop handover gate (`validate-handoff.sh`, protected path) is untouched.
2. **Every capability has a degraded core answer.** No feature is ee-only: overlaps degrade to git file-intersection, org knowledge to committed `_fleet/shared/knowledge/`, recall to token-overlap.
3. **Degradation is silent-success, loud-warning:** no config → v0.6 behavior; unreachable/license-expired → one warning, stale-marked grid files, runs complete.
4. **`_fleet/local/` is never synced wholesale** — only the typed projection leaves the machine.

## The `ee/` boundary

Everything above ships under `ee/` — **AGPL-3.0-only** (`ee/LICENSE`), published as `fleetsmith-ee` — while core stays MIT with one runtime dependency. Core never imports `ee/`: the CLI loads `fleetsmith-ee` fail-soft, and the package registers backends and commands through `src/lib/registry.js`. `rm -rf ee/` must leave core byte-identical to OSS behavior; CI enforces the import boundary, SPDX headers, and the standing no-vendoring rule.

BYOL engineering rules stand unchanged from v0.6.0: never ship or vendor the RelataDB binary, never patch the engine (requests go upstream — ZySec AI is an Infinia group company, so this is intra-group coordination, not vendor negotiation), always degrade to the file backend.

## Prior art consulted

- **RelataDB v2.0.0 source audit** (2026-08-15): capabilities, gaps, and the decisions table above.
- **TencentDB Agent Memory v2.0** (`TencentCloud/TencentDB-Agent-Memory`, MIT): admin-console patterns adopted — equip/loadout scoping, private-by-default sharing, one-time-visible credentials, asset status machines, observed-not-declared activity — and gaps deliberately built against: no real review queue (ours is a reviewer-gated state machine), no audit UI (ours ships in v1), frontend-only permission checks (ours are server-side), governance in JSON blobs (ours are typed rows).
