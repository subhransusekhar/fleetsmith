## 0.5.0 — Self-evolving harness

A harness can now observe its own runs, evaluate the result, propose a change, validate it, and hand you a reviewable branch. One model call in the whole system; everything else is deterministic.

**Observe**
- Run telemetry: a dependency-free JSONL logger under `<workspace>/local/runs/`, with run ids namespaced per developer. The handover gate now records its verdicts instead of discarding them.
- `fleetsmith health` — per-agent and per-skill utility, failure risk, redundancy, validation gaps, and handoff compatibility, with no LLM calls and a ΔH early exit so a steady state costs nothing.

**Evaluate**
- `fleetsmith qa` — the deterministic verification battery (spec gate, per-target compile, handoff graph, capability leaks, loop bounds, origin markers, drift), wired into CI.
- `fleetsmith eval` — trigger discrimination plus a held-out fleet corpus, with a staged ladder, a measured noise floor, and paired baseline comparison.

**Mutate and promote**
- `fleetsmith patch` — a typed, format-preserving mutation API. Comments and formatting survive; protected targets are refused; a patch either fully applies and validates or does nothing.
- ACE-style learned playbooks: id'd bullets with helpful/harmful counters, merged deterministically, compiled in as an advisory section after all human-authored instruction.
- `fleetsmith evolve` — the reflective loop, and `--review` for one-at-a-time promotion with a decision log that deprioritizes categories you keep rejecting.
- `fleetsmith protected` — a hard-coded protected-path manifest, enforced in-process and again in CI on `fleet-evolve/*` branches.

**Workspace**
- The workspace now has two tiers: `shared/` (committed team knowledge — changelog, playbooks, decisions, eval baselines) and `local/` (gitignored per-developer runtime). `fleetsmith migrate-workspace` moves an existing install.
- Provenance: `origin: human|evolved` and `protected`, emitted into compiled frontmatter.
- The meta-fleet's four methodologies are now vendored into `fleet.yaml` rather than living only at user scope.

**Fixes**
- The harness changelog moved to `<workspace>/shared/CHANGELOG.md`; it was previously regenerated into CLAUDE.md and AGENTS.md and destroyed on every build.
- `CLAUDE.md` and `AGENTS.md` are byte-stable across rebuilds (they embedded the build date).
- Drift detection compares content, not line endings — it previously reported every generated file as drifted on Windows.

# Changelog

Notable changes per release. Dates are release dates.

The format is loosely [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project follows [semantic versioning](https://semver.org/), and while it is
pre-1.0 the fleet spec may gain fields in minor releases — existing specs keep
building, since every new field normalizes to a default.

## [Unreleased]

## [0.4.1] — 2026-08-01

### Fixed — orchestrator/agent name collision

When `orchestrator.name` matched an agent name (e.g. `consolidateai-harness-lead`
acting as both orchestrator and agent), `FileSet.add` threw `"written twice"`
on the opencode and goose targets — the orchestrator file and the agent file
targeted the same path. The orchestrator file now replaces the agent file (the
orchestrator IS that agent, promoted to primary mode). Goose `sub_recipes` and
opencode `permission.task` maps exclude self-delegation. The validator warns so
authors know one file is missing.

### Changed — meta-fleet un-pinned from Claude Code

The fleetsmith meta-fleet agents (`domain-analyst`, `fleet-architect`,
`skill-smith`, `harness-qa`) existed only as hand-written `.claude/agents/*.md`
files, and the `harness-builder` orchestrator skill hardcoded `.claude/agents/`
and `model: "opus"`. Added a `fleet.yaml` and compiled to all three targets —
agents now exist in `.opencode/agents/` and `.goose/recipes/` with
`model: inherit` everywhere. Each target's orchestrator invocation section
references its own agent directory, not Claude Code's.

### Fixed — opencode orchestrator path typo

The opencode invocation section in `compileOrchestratorBody` referenced
`.opencode/agent/` (singular); corrected to `.opencode/agents/` to match the
adapter output and opencode's loader.

## [0.4.0] — 2026-08-01

Harness optimizations across all three targets, compiled from the platform and
best-practice research in [`docs/research/platform-optimizations-2026-08.md`](docs/research/platform-optimizations-2026-08.md)
and [`docs/research/harness-best-practices-2026-08.md`](docs/research/harness-best-practices-2026-08.md).

### Fixed — two silent failures

Both of these reported success while doing nothing, which is why they lead the list.

- **opencode: nested delegation was disabled.** `subagent_depth` defaults to `1`,
  which prevents a subagent from launching subagents. Any fleet whose orchestrator
  ran as a subagent executed with no fleet at all. Generated `opencode.json` now
  raises it (`3` for hierarchical patterns).
- **goose: parallel phases ran sequentially.** Different sub-recipes are serialized
  unless the *prompt* asks for parallelism — there is no YAML key for it — so every
  fleet declaring a parallel phase lost its concurrency. The orchestrator prompt
  now asks.

### Security

- A hostile `fleet.workspace` or `handover.dir` value could inject shell commands
  into the generated handover-gate script, which executes on whoever installs the
  harness — and fleet specs are meant to be shared. Now rejected by the validator
  and single-quoted at generation, with a regression test asserting the injected
  command does not run.
- User-scope `install` would have written a fleet's `settings.json` over
  `~/.claude/settings.json`. Now skipped with a reason, along with `loop.md` and
  `opencode.json`.

### Added — enforced contracts

Where a target can check something deterministically, fleetsmith now emits the
check rather than an instruction:

- **Claude Code**: a `SubagentStop` hook and bundled validator that block an agent
  from finishing until its handoff file exists and carries every required section
  (exit 2 returns it with the missing sections named).
- **opencode**: the handoff graph compiles into `permission.task` maps — a denied
  agent is dropped from the task tool description entirely, so it is both enforced
  and cheaper. Skills scope the same way via `permission.skill`.
- **goose**: `handoff.schema` compiles to a native `response.json_schema`, validated
  by the runtime.

### Added — spec

`agents[].effort`, `agents[].turns`, `agents[].hidden`, `agents[].memory`,
`agents[].handoff.schema`, `phases[].loop.noProgress`, `skills[].triggers`,
`skills[].freedom`, `fleet.mcp`, `fleet.allowParallelWrites`,
`defaults.opencodeModels`, `defaults.gooseModels`. All optional; existing specs
build unchanged. See [`docs/spec.md`](docs/spec.md).

### Added — cost and context

- **Model, effort, and turn tiering now reach all three targets**, not just Claude
  Code: `effort`/`maxTurns`, opencode `variant`/`steps`, goose `settings.max_turns`.
  Concrete model routing on opencode and goose requires `defaults.opencodeModels` /
  `defaults.gooseModels`, since those need provider-qualified ids.
- **Cache-stable agent prompts** — no dates or run state in a system prompt, which
  matters roughly 10× for a fleet that runs repeatedly. Per-run variance moved into
  handoff files.
- `opencode.json` sets `compaction.prune` for looping and scheduled fleets; the
  opencode plugin preserves the ledger across compaction.

### Added — prompt layer

Four-field delegation briefs (objective, output format, sources and tools,
boundaries) plus a `Failed approaches` section compaction is told to keep;
orchestrators cite handoff files rather than restating them; worker compression
contracts; three-part loop stops (success / no-progress / cap) instead of only the
iteration cap; reviewer-specific guidance for verifier agents.

### Added — validation and evals

- **Design-smell lint** (`src/spec/lint.js`, runs inside `fleetsmith validate`):
  blocks parallel writers, errors on skill descriptions that would silently
  truncate past 1,536 characters, warns on skill anti-patterns (dated guidance,
  Windows paths, unqualified MCP tool names, reference chains) and on phases that
  split one context in two.
- **Per-skill `evals/evals.json`** with should-trigger / should-not-trigger prompts,
  plus a fleet-level evals guide. Whether a skill fires and whether its output is
  good are separate properties, and a skill that never fires is indistinguishable
  from one that was never written.

### Added — experimental target

`--target claude-workflow` compiles the phase graph into a Claude Code dynamic
workflow script, with loops and gates as real control flow and `agentType` reusing
the emitted `.claude/agents/` definitions. **Opt-in and excluded from `--target all`**
— it needs a paid plan and only runs on Claude Code. Verdict, limitations, and v0.5
promotion criteria: [`docs/research/spike-claude-workflows-target.md`](docs/research/spike-claude-workflows-target.md).

### Added — goose review checks

Verifier agents also emit `.agents/checks/*.md` for `goose review`, which runs
reviewers in parallel with per-check model overrides.

### Changed — corrected platform facts

- goose moved out of Block: repo is now `aaif-goose/goose`, docs are at
  `goose-docs.ai` (the old `block.github.io` docs 404).
- `GOOSE_LEAD_MODEL` no longer exists; use `GOOSE_FAST_MODEL` and per-recipe
  `settings.goose_model`.
- goose cron accepts 5 or 6 fields only (docs claiming 7 are wrong, verified against
  source); emitted cron is 6-field, and `goose schedule add` snapshots the recipe,
  so a rebuilt harness needs the job re-added.
- Claude Code docs moved to `code.claude.com/docs/en/*`.

### Tests

25 → 63, covering the handover gate end to end (including the injection probe),
permission-graph compilation, generated-script syntax, and install-scope safety.

## [0.3.0] — 2026-07-23

### Added

- **Loop engineering as a first-class fleet capability.** `phases[].loop`
  (`until`, `max`, `check`) turns a phase into a repeat-until-condition refinement
  loop; `fleet.schedule` (`cron`, `interval`, `note`) makes the whole fleet
  recurring. Both compile to a bounded prose loop on every target, plus goose's
  native `retry` block for checked loops and `/loop` / cron / `goose schedule` for
  recurring runs.
- `generate-verify` fleets get a default iteration loop on their Verify phase.

### Docs

- Binary-first README with quickstart, generation guide, and examples by category.
- Self-contained SVG hero image and a one-paste Claude Code bootstrap.

## [0.2.0] — 2026-07-04

### Added

- **Standalone binaries** for Linux, macOS (x64 + arm64), and Windows, attached to
  the GitHub release; npm packaging; and an `install` command with `project` and
  `user` scopes.

### Fixed

- Windows binary build: invoke postject via node rather than the `.cmd` shim.
- `generate-verify`'s intentional producer/checker cycle no longer triggers the
  handoff-cycle warning.

## Before 0.2.0

Initial work, untagged: one `fleet.yaml` compiling into coordinated agents, skills,
and a file-based handover protocol for Claude Code (`.claude/`), opencode
(`.opencode/`), and goose (`.goose/recipes/`), plus the portability guarantees the
generated output still holds to.

[0.4.1]: https://github.com/subhransusekhar/fleetsmith/releases/tag/v0.4.1
[0.4.0]: https://github.com/subhransusekhar/fleetsmith/releases/tag/v0.4.0
[0.3.0]: https://github.com/subhransusekhar/fleetsmith/releases/tag/v0.3.0
[0.2.0]: https://github.com/subhransusekhar/fleetsmith/releases/tag/v0.2.0
