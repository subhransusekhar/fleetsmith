# fleetsmith — agent harness

**Goal:** Meta agent-fleet builder: one fleet.yaml spec compiles into coordinated agents, skills, and a file-based handover protocol for Claude Code, opencode, and goose

For building an agent harness for a project or domain — creating an agent fleet or team, generating agents and skills for a codebase, setting up a multi-agent workflow, or extending, auditing, or porting an existing fleet across Claude Code, opencode, and goose, run the fleet orchestrator instead of working solo. Simple questions can be answered directly.

## Invoking the fleet

- **opencode:** run `/harness-builder`, or switch to the `harness-builder` primary agent (fleet subagents live in `.opencode/agents/`).
- **goose:** `goose run --recipe .goose/recipes/harness-builder.yaml`
- **Claude Code:** the `harness-builder` skill triggers on domain requests (see CLAUDE.md).

## Coordination

Fleet coordination is file-based under `_fleet/`: handoff documents in `_fleet/local/handoffs/` (template provided) and a task ledger at `_fleet/local/LEDGER.md`. Handoff files are the source of truth between agents — read them before resuming or auditing fleet work, and never delete them mid-run.

## Changelog

Harness changes are recorded in `_fleet/shared/CHANGELOG.md` — append a row there rather than editing this file, which is regenerated on every build.
