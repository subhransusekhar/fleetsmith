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
| 2026-07-24 | opencode plugin surface: `fleetsmith/opencode` entry exposing `fleet_*` in-session tools (+ opt-in `file.edited` autobuild). Core in `src/opencode-plugin.js` (peer-dep-free); entry in `src/opencode.js`. `@opencode-ai/plugin` optional peer dep. | opencode | Let the fleetsmith builder run inside opencode as tools, not just as a CLI |
| 2026-08-01 | v0.4.0 harness optimizations. Spec: `effort`, `turns`, `hidden`, `memory`, `handoff.schema`, `loop.noProgress`, `skills[].triggers`/`freedom`, `fleet.mcp`, `defaults.{opencode,goose}Models`. Claude Code: full agent frontmatter, `.claude/settings.json` + `SubagentStop` handover gate, `loop.md`, skill `allowed-tools` + live ledger injection. opencode: `opencode.json` (**`subagent_depth` — default 1 breaks nested delegation**), handoff graph → `permission.task`, `steps`/`variant`, `/fleet-status`. goose: per-agent `settings`, **parallel-prose fix** (goose serializes sub-recipes without it), `summon` injection, `response.json_schema`, 6-field cron, `.agents/checks`. Shared: cache-stable prompts, four-field briefs, cite-don't-paraphrase, three-part loop stops, design-smell lint (`src/spec/lint.js`), eval emission. | all | Platform + best-practice research (`docs/research/{platform-optimizations,harness-best-practices}-2026-08.md`); milestone in `docs/milestones/v0.4.0-harness-optimizations.md` |
