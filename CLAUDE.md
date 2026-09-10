## Harness: fleetsmith

**Goal:** Meta agent-fleet builder: one fleet.yaml spec compiles into coordinated agents, skills, and a file-based handover protocol for Claude Code, opencode, and goose

**Trigger:** For building an agent harness for a project or domain — creating an agent fleet or team, generating agents and skills for a codebase, setting up a multi-agent workflow, or extending, auditing, or porting an existing fleet across Claude Code, opencode, and goose, use the `harness-builder` skill. Simple questions can be answered directly.

**Handover gate:** `.claude/settings.json` registers a `SubagentStop` hook running `_fleet/local/scripts/validate-handoff.sh`, which blocks a fleet agent from finishing until its handoff file exists and carries every required section. Note that project-level hooks do not run until this workspace is trusted — until you accept that dialog the gate is silently skipped and the fleet degrades to advisory instructions.

**Protected paths:** a `PreToolUse` hook (`_fleet/local/scripts/guard-paths.sh`) blocks edits — by any session in this project — under `_fleet/local/scripts/**`, `test/eval-fleets/**`, `_fleet/shared/evals/**`, `_fleet/shared/evolution/protected.json`. These are the fleet's own gates and the inputs of its objective checks; change them by editing `fleet.guardrails.protectedPaths` in the spec and rebuilding, never by working around the block.

**Intent:** every run starts by writing `_fleet/local/handoffs/00-intent.md` — what was asked, by whom, and why — and every agent reads it first. Correct that file, not the agents, when a run is heading the wrong way.

**Changelog:** harness changes are recorded in `_fleet/shared/CHANGELOG.md` — append a row there rather than editing this file, which is regenerated on every build.
