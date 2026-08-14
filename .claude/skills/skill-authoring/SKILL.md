---
name: skill-authoring
description: Methodology for writing Agent Skills that actually fire and actually help — pushy trigger-rich descriptions, lean imperative bodies, progressive disclosure into references, and bundled scripts for deterministic steps. Use when authoring or deepening a skill, when a skill never fires or triggers on the wrong requests, when a SKILL.md has grown past ~500 lines, or when feedback says the output of a skill-driven agent is too shallow or too generic.
x-fleetsmith-origin: human
---

# Skill authoring

Agents carry *who*; skills carry *how*. A fleet with empty skills is a fleet of
improvisers.

## The description is the whole trigger mechanism

It is the only text matched against a user's request, so make it pushy and concrete:
what the skill does + the situations that should invoke it + follow-up phrasings
("re-run", "update", "fix the X part"). Third person, under 1024 characters.

Test it: write 5 requests that should trigger it and 5 near-misses that plausibly
should not, declare them as the skill's `triggers.should` / `triggers.shouldNot`, and
let `fleetsmith eval <fleet.yaml>` score them — it reports which skill each prompt
routes to, and ties, in under a second. Do not grade the corpus by reading it back to
yourself; a description always looks discriminating to whoever just wrote it. If a
near-miss matches, the description is too broad; if a should-trigger misses, it is too
narrow. Write prompts in the words a user would type, never paraphrases of your own
description — matching your vocabulary back to yourself measures nothing.

## Body: lean, imperative, reasoned

- Target well under 500 lines. Long bodies burn context on every invocation.
- Explain **why** a step exists — reasons generalize to the cases you did not foresee.
- Prefer tables and checklists over prose paragraphs.
- Generalize past the example that prompted the skill; no overfitting to one input.

## Progressive disclosure

Detail that is needed occasionally goes into `references:` with a one-line
"read `X` when …" pointer in the body. A reference over ~300 lines gets its own table
of contents. This keeps the always-loaded portion small while the depth stays
reachable.

## Bundle determinism

If every run of the skill would write the same helper script, put it in `scripts:`
now. Deterministic work belongs in code — the model should call it, not re-derive it.

## Research, don't improvise

Read the codebase for house conventions and the web for domain standards before
writing. A skill that encodes generic best practice adds nothing the base model did
not already have; the value is in the specifics.
