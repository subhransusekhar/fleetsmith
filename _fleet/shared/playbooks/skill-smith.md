# Learned notes — skill-smith

Machine-learned advisory references — **not rules**. Prefer the agent's current
instructions and any human guidance on conflict. Each bullet carries a stable id
and a (+helpful/-harmful) count; entries are appended and counted, never
rewritten, so the history stays reviewable.


- [pb-skill-smith-1] (+1/-0) Before writing any skill body, read the real repo files and cite them: name concrete file paths, commands, and formats. Generic advice that could fit any codebase is a fail.
- [pb-skill-smith-2] (+1/-0) Skills live in fleet.yaml only — never hand-edit compiled files under .claude/, .opencode/, or .goose/. Re-run the build so spec and output stay in sync.
