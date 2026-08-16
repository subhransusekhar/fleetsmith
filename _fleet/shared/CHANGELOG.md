# fleetsmith — Harness Changelog

Append-only record of changes to this harness: what changed, where it landed,
and why. The orchestrator writes a row whenever feedback is routed into a
skill, agent, or orchestrator change. Never rewrite history — add a row.

`Origin` is `human` for hand-authored changes and `evolved` for changes
proposed by an automated evolution cycle.

| Date | Change | Target | Origin | Reason |
|------|--------|--------|--------|--------|
| 2026-08-01 | Initial fleet build (fleetsmith) | all | human | - |
| 2026-08-04 | Changelog moved here from CLAUDE.md/AGENTS.md | all | human | Those files are regenerated on every build, so the learning record destroyed itself (v0.5.0 T1) |
| 2026-08-04 | Workspace split into shared/ and local/ tiers | all | human | _fleet is gitignored for multi-dev workflows, so team knowledge and per-developer runtime state needed separating (v0.5.0 T15) |
| 2026-08-04 | Learned notes added to fleet-architect and skill-smith | claude-code, opencode, goose | evolved | First real evolution cycle (fleet-gen/1, fleet-gen/2); grounded in gate_block and feedback events |
| 2026-08-04 | Rejected a learned note for domain-analyst | - | evolved | Duplicated `fleetsmith qa --built` drift checking in agent prose |
| 2026-08-12 | Trigger testing delegated to `fleetsmith eval` in harness-verification §4 and skill-authoring | claude-code, opencode, goose | human | The methodology told the QA agent to hand-judge 5 should + 5 should-not queries per skill — ~50 in-context routing calls per pass, up to 2 passes — for an answer `fleetsmith eval` produces deterministically in 0.1s. `eval` was referenced nowhere in the compiled harness. Dominant model cost of a fleet run |
| 2026-08-12 | Added harness-verification §7: ambient install (`qa --installed`) | claude-code, opencode, goose | human | A stale pre-rename copy at user scope is never shadowed (directory names differ), so it splits routing and its agents write to `_fleet/handoffs/` while the gate validates `_fleet/local/handoffs/` — every agent blocked and retrying. Presented as "the orchestrator takes forever to start" with nothing in any report to explain it |
| 2026-08-12 | Orchestrator skill: live-state injection fixed to `` !`cmd` `` | claude-code | human | The emitted ` ```! ` fenced block is not an injection syntax anywhere in Claude Code, so Phase 0 read literal shell source under a heading promising live state and re-derived it by hand. The opencode `fleet-status` command had it right all along |
| 2026-08-12 | Orchestrator description reworded to "Use when the request is about …" | claude-code | human | "Use for any ${trigger} request" only parses for short noun-phrase triggers; real ones end in a list, yielding "…across Claude Code, opencode, and goose request" as the first thing the router reads |
| 2026-08-16 | RelataDB memory-port adapter shipped (`ee/src/memory/`) — recall/remember/justify/consolidate/forget behind the existing five-verb port, degrade-to-file circuit breaker on unreachable/malformed responses | - | human | v0.7.0 Intelligence Grid G1: enterprise tier is BYOL and additive — a checkout with no cortex configured stays byte-identical to v0.6 |
| 2026-08-16 | `fleetsmith grid` sync daemon shipped (`ee/src/grid/daemon.js`) — init/sync/sync --watch, push/pull/materialize, presence + bi-temporal supersession | - | human | v0.7.0 G3: multi-developer state sync before any git commit; grid state is advisory only, never gates an agent (docs/evolution.md invariant 9) |
| 2026-08-16 | Grid-awareness skill compiled into every target (GRID.md/OVERLAPS.md reading methodology) | claude-code, opencode, goose | human | v0.7.0 G4: an agent must read peer state before claiming overlapping work, and the skill is grid-conditional — a grid-disabled compile stays byte-identical to v0.6 |
| 2026-08-16 | Overlap intelligence shipped (`ee/src/grid/overlaps-render.js`, merge-risk analysis, `grid overlaps [--git-only]`) | - | human | v0.7.0 G5: cross-developer file/task/dependency-cycle collisions surfaced before a PR, with a zero-network `--git-only` degraded answer |
| 2026-08-16 | Org-knowledge import + governed recall shipped (`grid import`, `grid knowledge`, `OrgDocument` ontology type) | - | human | v0.7.0 G6: meeting/discussion/decision/spec text becomes provenance-tracked, recallable team knowledge, idempotent on re-import |
| 2026-08-16 | Governance layer shipped: identity/token rotation, purposes vocabulary, `OrgDocument` approval lifecycle, equip scoping, purpose-audited `grid audit` | - | human | v0.7.0 G7: purpose-governed reads and a client-side approval/equip model, since no engine-side role/ACL enforcement exists on this engine surface today (docs/enterprise/identity.md) |
| 2026-08-16 | Admin console shipped (`ee/console/`) — board, audit, knowledge/procedures, equip, members, health screens over a stateless BFF | - | human | v0.7.0 G8: every request re-authenticated per-call against the cortex, forwarding the caller's own token; no second database or session store |
