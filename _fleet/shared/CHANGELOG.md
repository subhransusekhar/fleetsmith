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
