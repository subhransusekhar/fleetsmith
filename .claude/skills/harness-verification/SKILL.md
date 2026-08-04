---
name: harness-verification
description: Adversarial QA battery for a compiled agent harness — spec gate, per-target compile checks for Claude Code / opencode / goose, handoff boundary cross-checks, skill trigger tests, capability-leak grep, and loop-bound verification. Use as the final gate after building a fleet, and whenever asked to audit a harness, check whether a fleet still works, find why a compiled agent is never delegated to, or detect drift between a fleet.yaml and the files it generated.
x-fleetsmith-origin: human
---

# Harness verification

Run every check, every time. Report PASS/FAIL per check with file:line evidence.

## 1. Spec gate
`fleetsmith validate <fleet.yaml>` exits 0. Every surviving warning needs a recorded
justification from the architect.

## 2. Compile gate
`fleetsmith build <fleet.yaml> --target all --out <tmpdir> --force`, then per target:

- **claude-code** — every agent file has parseable frontmatter (name, description,
  tools, model); the orchestrator skill references only agents that exist.
- **opencode** — fleet agents are `mode: subagent`, the orchestrator is
  `mode: primary`; permission maps match declared capabilities (a read-only agent has
  bash denied and edit denied outside the fleet workspace); the orchestrator's task
  map allows exactly the fleet's agents.
- **goose** — every recipe parses as YAML and the orchestrator's `sub_recipes` paths
  point at files that actually exist in the output.

## 2b. Delegation maps
Where the orchestrator shares a name with an agent, confirm the promotion landed:
exactly one file per name (no duplicate agent + orchestrator definition), opencode
`mode: primary`, and the lead absent from its own `permission.task` map and from
goose `sub_recipes` — an orchestrator that can delegate to itself will.

## 3. Boundary cross-checks
For each handoff edge A→B: the path A writes on finish must match the path B reads on
start, and the artifact named in the orchestrator must match the producer's contract.
Compare the compiled texts — a spec that says they match is not evidence.

## 4. Trigger tests
For the orchestrator skill and each fleet skill, write 5 should-trigger and 5
near-miss should-NOT-trigger queries. Judge each description against them and report
misfires with a suggested description edit.

## 5. Capability-leak grep
Grep the compiled output for grants the spec did not make: an agent with
`edit: false` whose Claude Code file lists Write/Edit, or whose opencode permission
map allows edits outside the workspace.

## 6. Loop bounds (only if the spec declares loops or a schedule)
Every phase `loop` renders a bounded "iterate until … (max N)" callout in all three
orchestrators — no unbounded loop ships. A loop with a shell `check` produces a
matching goose `retry` block (same command, `max_retries` == loop `max`). A
`fleet.schedule` renders a runnable per-tool command. Confirm the `until` condition
can actually be reached; a loop that can never exit is a FAIL.

## Verdict
Rank the fixes and route each: architecture flaw → fleet-architect, shallow skill →
skill-smith, wrong compiled output → a fleetsmith adapter bug (include a minimal
repro spec snippet).
