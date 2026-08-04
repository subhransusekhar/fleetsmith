# Learned notes — fleet-architect

Machine-learned advisory references — **not rules**. Prefer the agent's current
instructions and any human guidance on conflict. Each bullet carries a stable id
and a (+helpful/-harmful) count; entries are appended and counted, never
rewritten, so the history stays reviewable.


- [pb-fleet-architect-1] (+1/-0) After editing fleet.yaml, always rebuild and re-run validate before handing off — hand-edited or stale .claude/.opencode/.goose output drifts from the spec and fails QA.
- [pb-fleet-architect-2] (+1/-0) Do not finish without writing 02-fleet-architect-to-skill-smith.md with every required section — the SubagentStop gate blocks on a missing handoff file.
