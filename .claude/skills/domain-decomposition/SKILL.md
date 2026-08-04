---
name: domain-decomposition
description: Methodology for decomposing a project or domain into the work types an agent fleet should mirror — codebase reconnaissance, work-type extraction with input/output contracts, parallelism analysis, existing-harness inventory, and quality-risk spotting. Use when analyzing a project before designing agents, when asked what agents a codebase needs, when re-scoping a fleet after the domain changed, or when an existing fleet feels generic and needs grounding in the real work.
x-fleetsmith-origin: human
---

# Domain decomposition

The brief you write is the only thing the architect sees. If it is vague, the harness
is generic — which is the single most common failure of generated agent fleets.

## 1. Reconnaissance (skip only for a pure domain description)

Establish ground truth from the repository, in this order:

| Question | Where to look |
|----------|---------------|
| What is this? | README, package manifests, top-level dirs |
| How does work enter? | CLI entry points, HTTP routes, job queues, workflow files |
| What is the data? | schema/model/migration files, type definitions |
| How is correctness established? | test dirs, CI workflows, linters, review checklists |
| What automation exists? | `.claude/`, `.opencode/`, `.goose/`, `AGENTS.md`, `CLAUDE.md` |

Record file paths as evidence. A brief that cites no paths was not researched.

## 2. Extract work types

A work type is a repeated unit of judgment, not a file or a feature. Name 3-7 of them.
For each: **input** (what must exist first), **output** (the artifact it produces),
**expertise** (what someone must know to do it well), **parallel?** (does it need
another work type's output).

Test each candidate: could a competent person do it in isolation given only the stated
input? If not, the input is understated or the work type is really two.

## 3. Parallelism and roster size

Work types that share no input/output edge can run in parallel — that is what makes a
`fanout` fleet worth building. Work types in a strict chain argue for `pipeline`.
Recommend the smallest roster covering every work type; three sharp agents outperform
five vague ones because each one's context stays focused.

## 4. Quality risks

Ask: in this domain, what does plausible-but-wrong output look like? Those failure
modes become the verifier's checklist. Be specific — "hallucinated API endpoints that
compile but 404" beats "inaccuracy".

## Output

Write the handoff with: the work-type table, the harness inventory with collision
notes, the recommended roster with one-line justification, and the quality risks.
