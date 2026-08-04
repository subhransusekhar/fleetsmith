# Proposal — learned note for "skill-smith"

- Branch: `fleet-evolve/evolve-1785851610258-skill-smith-playbook`
- Applied: added pb-skill-smith-1; added pb-skill-smith-2

This adds an **advisory** note to the agent's playbook. It does not modify
the agent definition, which is human-authored and protected.

## Rationale (as given by the proposer)

- **add-playbook-bullet** — The single observed feedback event says the methodology 'felt generic on the first pass'. The agent's own goal demands methodology 'researched from the codebase', so the missing behavior is a hard grounding requirement — cite real artifacts — which is exactly what an advisory bullet can enforce without touching the protected definition. (confidence: 0.72)
- **add-playbook-bullet** — The failing 'drift vs built output' check flags skill-smith.md differing from the spec across all three targets. skill-smith has edit+run capability and writes inside fleet.yaml, so the reusable lesson is to edit the source of truth and rebuild rather than touch compiled artifacts. (confidence: 0.55)

## Evidence

- feedback: skill: methodology felt generic on the first pass
- goal: Every skill carries real methodology researched from the codebase and domain standards, not vibes.
- drift vs built output: .claude/agents/skill-smith.md:1: differs from the spec (hand-edited, or the build is stale)
- drift vs built output: .opencode/agents/skill-smith.md:1 and .goose/recipes/skill-smith.yaml:1 differ from the spec
- role: ... inside fleet.yaml

## Review

Learned notes are references, not rules, and accumulated memory measurably
degrades alignment — so this is not auto-applied. Merge or delete the branch.
