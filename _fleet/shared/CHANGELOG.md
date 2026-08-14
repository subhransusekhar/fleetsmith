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
