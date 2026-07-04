---
name: harness-builder
description: Builds a complete agent harness for any project or domain — coordinated agent teams, skills, and handover protocols compiled for Claude Code, opencode, and goose via fleetsmith. Use when the user says "build a harness for this project", "create an agent fleet/team for X", "generate agents and skills for this domain", "set up a multi-agent workflow", or asks to re-run, extend, audit, or fix an existing fleet ("add an agent", "redo the skills", "the fleet misses X", "port my agents to goose/opencode"). Simple questions about fleetsmith itself can be answered directly.
---

# Harness Builder

Orchestrates the fleetsmith meta-fleet — `domain-analyst`, `fleet-architect`, `skill-smith`, `harness-qa` — to generate a domain-tailored agent harness. The fleet designs a `fleet.yaml`; the fleetsmith compiler does the deterministic file generation; QA gates the result.

- Pattern: **pipeline** with a generate-verify tail · Execution: **subagents** (each stage's output is a file; no mid-flight debate needed)
- Workspace: `_fleet/` (handoffs in `_fleet/handoffs/`, ledger at `_fleet/LEDGER.md`)
- Compiler: `node src/cli.js` in this repo (or `npx fleetsmith` once installed)

## Phase 0: Context check

Check the target project before anything:
- `fleet.yaml` exists + user asks for a partial change ("add an agent", "deepen skill X") → **partial re-run**: invoke only the affected agent(s) with prior handoffs as input, then recompile (Phase 4) and QA (Phase 5).
- `fleet.yaml` exists + user brings a new domain → **fresh run**: move `_fleet/` to `_fleet_prev/`, keep the old fleet.yaml as `fleet.prev.yaml` for reference.
- Nothing exists → **initial run**: create `_fleet/handoffs/` and seed `_fleet/LEDGER.md`.
- Only an audit is requested ("check the harness", "did anything drift?") → run Phase 5 alone.

Ask the user exactly one thing if unstated: which targets to emit (`claude-code`, `opencode`, `goose`, or `all`). Default to `all` if they don't care.

## Invocation

Invoke each agent with the Agent tool using its definition in `.claude/agents/` and `model: "opus"`. Sequential phases run synchronously; Phase 3 skill authoring may fan out in background if skills are independent.

## Phases

### Phase 1: Domain analysis
`domain-analyst` explores the target project/domain → `_fleet/handoffs/01-domain-analyst-to-fleet-architect.md`.
**Gate:** the brief names concrete work types with inputs/outputs. A brief of adjectives goes back once with the gaps named.

### Phase 2: Fleet architecture
`fleet-architect` designs `fleet.yaml` (pattern, roster, capabilities, handoff graph, skill stubs) and gets `validate` passing → `02-fleet-architect-to-skill-smith.md`.
**Gate:** `node src/cli.js validate fleet.yaml` exits 0. Show the user the roster + pattern one-liner before proceeding; this is the cheapest moment for course correction.

### Phase 3: Skill authoring
`skill-smith` replaces every `TODO(skill-smith)` with researched methodology, adds references/scripts → `03-skill-smith-to-harness-qa.md`.

### Phase 4: Compile
You (the orchestrator) run the deterministic step yourself — no agent needed:
```
node src/cli.js build fleet.yaml --target <targets> --out <project-root> [--force on re-runs]
```
Record the emitted file list in the ledger.

### Phase 5: QA gate
`harness-qa` runs the full check battery (spec gate, compile gate, boundary cross-checks, trigger tests, capability-leak grep) → `04-harness-qa-verdict.md`.
**Gate:** FAIL findings route back — architecture flaws to `fleet-architect`, shallow skills to `skill-smith`, adapter bugs to you (fix fleetsmith source, add a regression test, rebuild). Max two repair loops; after that, ship with documented gaps and tell the user.

### Phase 6: Register and report
1. Ensure the target's pointer file was emitted (CLAUDE.md for Claude Code; AGENTS.md for opencode + goose) and append a changelog row (date, change, target, reason).
2. Report to the user: roster table, emitted files per target, how to invoke the fleet in each tool, QA verdict summary, and any documented gaps.
3. Ask one feedback question. Route feedback: output quality → skill; role gap → agent definition; ordering → this skill; then log the change in the changelog.

## Data flow

File-based only: each phase's handoff lives in `_fleet/handoffs/` per the template. Before starting phase N+1, verify phase N's handoff file exists — a missing file means the phase is not done regardless of what the agent's reply claimed. Intermediates stay in `_fleet/` for audit; the deliverable is the compiled harness in the project root.

## Error handling

- Agent failure → retry once with the failure appended to its brief; second failure → proceed with a documented gap in ledger + final report.
- QA and producer disagree → QA's file:line evidence wins over the producer's claim; no evidence → producer wins, log as WARN.
- User interrupts mid-run → ledger + handoffs make every phase resumable; on the next invocation Phase 0 detects the partial state.

## Test scenarios

- **Happy path:** "build a harness for this project" on a small repo → 4 phases run, `fleet.yaml` validates, build emits all three targets, QA passes, pointer files registered.
- **Failure path:** skill-smith produces a >500-line skill body → QA flags it, one repair loop fixes it via references/ split, re-run passes.
- **Partial re-run:** "add a security-reviewer agent to the fleet" → Phase 0 routes to fleet-architect only, recompile, QA, changelog row appended.
