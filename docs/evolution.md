# Self-evolution

fleetsmith can improve its own harness: observe what runs did, evaluate the
result, propose a change, validate it, and hand you a reviewable branch. This
document is what an operator needs; the design reasoning is in
`docs/milestones/v0.5.0-self-evolution.md` and the evidence in
`docs/research/self-evolving-agents-2026-08.md`.

**Honest framing first.** There is exactly **one** model call in the entire
system — the proposer. Everything else is deterministic: telemetry, health
metrics, verification, evaluation, patching, merging. The model proposes;
deterministic checks dispose. Nothing merges without a human unless every
operation in it is one a validator fully decides.

## The loop

| Stage | Command | What it does |
|-------|---------|--------------|
| **Observe** | (automatic) | `_fleet/local/scripts/log-event.sh` records run events; the handover gate records its verdicts |
| | `fleetsmith health` | aggregates events into per-agent and per-skill metrics |
| **Evaluate** | `fleetsmith qa` | deterministic verification — the gate |
| | `fleetsmith eval` | trigger discrimination + held-out fleet corpus — the fitness signal |
| **Mutate** | `fleetsmith evolve` | one reflective proposal, applied on a branch |
| **Validate** | (inside `evolve`) | qa → eval stage 1 → paired stage 2 above the noise floor |
| **Promote** | `fleetsmith evolve --review` | one proposal at a time; accept tags a generation |

A cycle costs nothing when nothing changed: `evolve` exits at the ΔH check
before making any model call.

## The invariants

These are not style preferences. Each one is a response to a documented
failure, and removing one re-opens it.

1. **Evolution may only modify what evolution generated.** Human-authored
   *definitions*, the validator, the QA battery, the eval corpus, and the tests
   are immutable to the loop. The Darwin Gödel Machine, scored by a function
   counting marker tokens, improved its score by deleting the markers.
2. **A protected agent is still reachable for advisory notes.** Its definition
   cannot be edited, but a learned note can be attached — that lives in its own
   file, is capped, and needs review. Without this the loop is unreachable on
   every fleet, because `init` produces nothing machine-authored.
3. **Handoff contracts are rails.** Instruction bodies evolve freely; declared
   inputs, outputs, and required sections change only via an explicit
   `contract-change`, which is never auto-applied.
4. **Learned content is advisory, capped, and visibly machine-authored.**
   Accumulated memory measurably degrades alignment; framing it as references
   rather than rules was the only mitigation that measurably helped.
5. **Deterministic checks carry every gate.** A judge may advise; it may never
   gate. Verifier quality caps how far self-improvement can go.
6. **Few, ranked, confidence-scored review requests.** High approval volume
   decays into rubber-stamping.
7. **Learned state reaches a prompt only via the spec and a rebuild** — never
   per-run injection, which would break prompt caching.
8. **Git is the archive.** Every mutation is a branch, every promotion a tagged
   merge, `git revert` the rollback.

## Operations

The loop can only make these changes. A fixed vocabulary is what makes every
change classifiable and reviewable.

| Op | Target | Auto-apply |
|----|--------|-----------|
| `add-skill` | new skill | no |
| `update-skill-body` / `repair-skill` | evolved skill | no |
| `update-skill-description` | evolved skill | no |
| `merge-skills` | evolved skill | no — unless bodies are identical |
| `retire-skill` | evolved skill | no |
| `add-validator` | skill | **yes** |
| `update-agent-body` | evolved agent | no |
| `add-playbook-bullet` | any agent | no |
| `update-bullet-counter` | any agent | **yes** |
| `contract-change` | agent | **never** — requires `--allow-contract-change` |

Auto-apply is limited to operations whose correctness a validator fully
decides. That is what keeps the review queue short enough to actually read.

## Running it

```bash
fleetsmith evolve fleet.yaml --budget 1        # propose (default)
fleetsmith evolve fleet.yaml --review          # next proposal + diffstat
fleetsmith evolve fleet.yaml --accept <branch> # merge + tag fleet-gen/N
fleetsmith evolve fleet.yaml --reject <branch> --reason "..."
```

`evolve` refuses to run on a dirty tree: a candidate's diff would otherwise
carry unrelated work, and a rejected candidate's cleanup could destroy it.

**Always give a reason when rejecting.** Rejected operation categories are
deprioritized in later proposals and named to the proposer, so it stops
suggesting them. That is the only mechanism that reduces review volume over
time rather than merely capping it.

Cadence guidance is in `docs/evolution-cadence.md`. The rule that matters most:
never schedule `--apply` outside the auto-apply whitelist.

## Rollback

```bash
git revert fleet-gen/<n>
fleetsmith build fleet.yaml --target all --force
fleetsmith qa fleet.yaml --built .
```

A merged generation is **provisional** until later runs confirm no health
regression — `fleetsmith health` reports `provisional`, `confirmed`, or
`regressed`. The last is the case CI cannot catch: a change that passes every
deterministic check and still makes real runs worse.

## What it does not do

- **It does not measure output quality.** Trigger discrimination is measured;
  whether a skill produces *better work* is not. See issue #26.
- **Trigger scoring is a lexical proxy**, not the real router. It catches two
  descriptions so alike that a prompt meant for one matches the other; it
  cannot tell you how a given model would route.
- **Dedupe cannot detect paraphrase.** Near-identical restatements merge;
  differently-worded versions of one lesson accumulate as separate bullets.
- **It cannot rewrite human-authored definitions**, by design. To let it edit
  something, mark that artifact `origin: evolved` deliberately.
