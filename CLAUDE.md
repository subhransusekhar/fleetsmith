# fleetsmith

Meta agent-fleet builder: one `fleet.yaml` spec compiles into coordinated agents, skills, and a file-based handover protocol for **Claude Code** (`.claude/`), **opencode** (`.opencode/`), and **goose** (`.goose/recipes/`).

- Library + CLI: `src/` (pure ESM, only dep is `yaml`). Adapters emit `FileSet`s — generation is pure, I/O happens once in the CLI.
- Tests: `npm test` (node --test).
- Format references for the three targets live in `docs/research/` — consult them before touching an adapter.

## Harness: fleetsmith meta-fleet

**Goal:** Generate domain-tailored agent harnesses on request.

**Trigger:** For "build a harness for this project", "create an agent fleet/team", "generate agents and skills", fleet extensions, audits, or ports to opencode/goose — use the `harness-builder` skill. Simple questions about fleetsmith itself can be answered directly.

**Changelog:**
| Date | Change | Target | Reason |
|------|--------|--------|--------|
| 2026-07-04 | Initial meta-fleet (domain-analyst, fleet-architect, skill-smith, harness-qa + harness-builder skill) | all | - |
| 2026-07-23 | Loop engineering: first-class `phases[].loop` (iteration) + `fleet.schedule` (recurring). Prose loop on every target; goose native `retry` for checked loops; `/loop`/cron/`goose schedule` for recurring. | all | Add iterative-refinement and recurring-run capability to generated fleets |
