# Proposal — learned note for "fleet-architect"

- Branch: `fleet-evolve/evolve-1785851610258-fleet-architect-playbook`
- Applied: added pb-fleet-architect-1; added pb-fleet-architect-2

This adds an **advisory** note to the agent's playbook. It does not modify
the agent definition, which is human-authored and protected.

## Rationale (as given by the proposer)

- **add-playbook-bullet** — The only failing check is drift between the spec and the compiled agent/recipe files across all three targets, which is exactly the gap between editing fleet.yaml and rebuilding. Since the definition is protected, an advisory bullet is the only lever. (confidence: 0.8)
- **add-playbook-bullet** — A gate_block event with reason 'no handoff file' is the sole observed block for this actor; the bullet names the exact artifact the contract already declares, without changing the contract. (confidence: 0.75)

## Evidence

- drift vs built output: .claude/agents/fleet-architect.md:1: differs from the spec (hand-edited, or the build is stale)
- drift vs built output: .opencode/agents/skill-smith.md:1: differs from the spec (hand-edited, or the build is stale)
- drift vs built output: .goose/recipes/fleet-architect.yaml:1: differs from the spec (hand-edited, or the build is stale)
- gate_block: no handoff file
- health.observed.blocks: 1, passes: 0

## Review

Learned notes are references, not rules, and accumulated memory measurably
degrades alignment — so this is not auto-applied. Merge or delete the branch.
