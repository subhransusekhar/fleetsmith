---
name: fleet-design
description: Methodology for designing an agent fleet as a fleet.yaml — choosing the pattern from the data flow, setting execution mode, drawing the handoff graph with artifact contracts, granting least capability, and declaring iteration and recurring loops. Use when designing or restructuring an agent fleet, choosing between pipeline / fanout / generate-verify / supervisor / expert-pool, deciding which agents to split or merge, adding an agent to an existing fleet, or fixing fleetsmith validator errors.
x-fleetsmith-origin: human
---

# Fleet design

## Pattern from the data flow

| Data flow | Pattern |
|-----------|---------|
| Each stage needs the previous stage's output | `pipeline` |
| Independent slices explored, then merged | `fanout` |
| An artifact plus an adversarial check on it | `generate-verify` |
| A lead owns shared state and delegates dynamically | `supervisor` |
| Heterogeneous requests routed to specialists | `expert-pool` |

Pick from the brief's parallelism column, not from what sounds sophisticated.

## Execution mode

`team` when agents benefit from cross-referencing mid-flight; `subagents` when results
simply flow forward as files; `hybrid` when phases genuinely differ. Prefer
`subagents` — it is the mode every target supports natively.

## Splitting agents

Split on exactly four axes: distinct **expertise**, real **parallelism**, needed
**context isolation**, or **reusability** elsewhere. A split serving none of these
just adds handoff overhead — merge it.

## Capabilities

Grant the minimum: analysts get `read` (plus `web` if research is part of the job),
builders add `edit` and `run`, verifiers get `read` + `run` but never `edit` — a
verifier that can edit will fix instead of report, and the defect disappears from the
record.

## Handoff contracts

Every edge carries an `artifact` filename and 2-4 `criteria`. Criteria must be
checkable by reading the artifact: "every finding cites file:line and a repro command"
is checkable; "high quality analysis" is not.

## Loop engineering

- **Iteration loop** — a phase that must repeat until quality holds gets
  `loop: { until, max, check? }`. Keep `max` tight (≤ 5). Add a shell `check`
  (`npm test`, a linter) whenever a deterministic pass/fail signal exists: it compiles
  to goose's native `retry` and becomes the objective signal every target defers to.
- **Recurring loop** — a fleet meant to run on a schedule gets
  `fleet.schedule: { cron | interval | note }`. Omit it for one-shot fleets.
- Never bury "loop back up to N times" in a `gate` string. A loop that cannot exit is
  a design bug, so state the exit condition first and the bound second.

## Naming the orchestrator

Give the orchestrator its own name (`run-<fleet>`, `build-<thing>`) unless the lead
agent genuinely *is* the orchestrator. In a `supervisor` fleet that identity is often
real — then reuse the agent's name deliberately and expect the validator warning: the
orchestrator file replaces the agent file, promoted to primary mode, and the lead is
excluded from its own delegation map. Anywhere else, a shared name is an accident that
silently costs you an agent definition.

## Skills

Every producing agent gets 1-N skills carrying its methodology. Name skills by method
(`api-contract-review`), never by agent (`reviewer-skill`) — that is what makes them
reusable across fleets.

## Validate before handing off

`fleetsmith validate fleet.yaml` must exit 0. Warnings are design smells — orphaned
agents, missing artifact contracts, unused skills, over-long descriptions. Fix them or
justify each one in writing.
