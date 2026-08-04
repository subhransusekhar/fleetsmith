# Judge calibration — status: INCOMPLETE

**Bottom line: the skill-substance judge is built, wired as advisory-only, and
must not be aggregated or trusted as a metric.** It disagrees with itself on
19% of verdicts across identical runs, which caps its possible agreement with
any human rater below the level where a judge metric is believable. This
document records what was measured, what that implies, and what would have to
change.

## Why calibration gates trust, not shipping

The judge answers the one question deterministic checks cannot: *is this
skill's methodology substantive, or generic filler?* Judge-reliability research
is blunt about what happens without calibration — the gap between a naive and a
calibrated judge is wide enough to produce **opposite conclusions** about agent
quality, and the 2026 operational norm is a large rated sample with
Krippendorff's α near 0.8 before aggregate metrics are believed.

We will never have hundreds of rated fleet skills. That is precisely why the
judge is **advisory only** and why `fleetsmith` contains no code path in which a
judge score can influence a build, a patch, or a promotion — asserted by a test
that greps the gate modules for imports and calls, not just mentions.

## What was done

- **Rubric:** four binary criteria (`concrete-tools`, `domain-specifics`,
  `executable-steps`, `failure-modes`), not a holistic 1–10. Explicit
  pass/fail criteria are the rubric type that reproduces; holistic scores
  produce position and verbosity bias.
- **Corpus:** 24 real Agent Skills sampled from a 146-skill user-scope library,
  stratified across body length (26–370 lines) so the sample has genuine
  variance rather than being drawn from one quality band.
- **Tooling:** `fleetsmith eval <spec> --judge [--ratings FILE]` reports
  per-criterion verdicts and, when ratings are supplied, per-criterion raw
  agreement **and Cohen's κ**.

κ rather than raw agreement, because on a criterion nearly everything passes, a
judge that always answers `true` scores ~90% raw agreement while carrying no
information at all. There is a test asserting exactly that case.

## What was NOT done, and why

**No human ratings exist, so no agreement statistic could be computed.**

This is the honest blocker. The assistant that built the judge cannot also
supply the human half of a human-agreement measurement — rating the corpus
itself and reporting the result as calibration would be measuring the judge
against its own author, and reporting it as human agreement would be a
fabrication. The `--ratings` path, the κ computation, and the 0.8 threshold are
implemented and tested; the input is missing.

## Measured: the judge does discriminate

An early read on the first 3 skills was that the judge was **too lenient** —
all three scored 4/4, which would have meant a rubric carrying no information.
**That call was wrong, and it was wrong because n=3.** The full corpus shows a
real spread:

| Score | Skills |
|-------|--------|
| 1/4 | 3 |
| 2/4 | 4 |
| 3/4 | 7 |
| 4/4 | 10 |

Per-criterion pass rate (n=24, all judged successfully):

| Criterion | Pass rate |
|-----------|-----------|
| `concrete-tools` | 0.88 |
| `domain-specifics` | 0.79 |
| `executable-steps` | 0.67 |
| `failure-modes` | 0.67 |

No criterion is degenerate — none passes above 0.9 or below 0.1 — so each is
carrying some information rather than being decoration. The distribution is
skewed toward the top, which is expected for a curated skill library and is not
by itself evidence of leniency.

**This is still not calibration.** A judge that discriminates can discriminate
along the wrong axis. Spread proves the rubric is not vacuous; only agreement
with human ratings proves it is measuring what a human means by "substantive".

### Applied to our own skills

| Skill | Score | Criteria not met |
|-------|-------|------------------|
| `fleet-design` | 4/4 | — |
| `harness-verification` | 4/4 | — |
| `domain-decomposition` | 3/4 | `concrete-tools` |
| `skill-authoring` | 1/4 | `concrete-tools`, `domain-specifics`, `executable-steps` |

The `skill-authoring` verdict is the interesting one and reads as defensible:
it is a methodology *about* writing skills, and it advises ("explain why a step
exists", "research, don't improvise") far more than it instructs with named
commands or paths. Whether that is a defect or the nature of the subject is
exactly the judgment a human rater has to supply — which is the point.

Raw verdicts: `docs/research/judge-corpus/verdicts.json`.

## Decisive: the judge disagrees with *itself*

Run three times over the same four skills, with identical input:

| Skill | Run 1 | Run 2 | Run 3 |
|-------|-------|-------|-------|
| `domain-decomposition` | 4 | 4 | 4 |
| `fleet-design` | 4 | 4 | 4 |
| **`skill-authoring`** | **3** | **1** | **3** |
| `harness-verification` | 4 | 4 | 4 |

**19% of individual criterion verdicts flipped between identical runs** (3 of
16), and one skill swung two points.

This settles the calibration question without needing a single human rating,
because **self-consistency bounds agreement from above**: a judge that
disagrees with itself on ~19% of verdicts cannot agree with a human rater more
than ~81% of the time, which places κ far below the 0.8 threshold no matter how
good the rubric is. Measuring agreement before fixing stability would be
measuring noise.

**The failure profile is the worst possible shape.** The three skills that were
stable are the clear-cut ones. The one that varied — `skill-authoring` — is the
genuinely borderline case: an abstract methodology *about* writing methodology,
where "is this concrete enough" is a real judgment call. **The judge is stable
where the answer is obvious and unstable exactly where judgment is needed**,
which is where a judge would otherwise add value.

Raw data: `docs/research/judge-corpus/stability.json`.

### What would have to change

1. **Majority of k runs** per verdict (k=3 or 5) — the standard mitigation, at
   3–5× the cost. Measure the flip rate again afterwards; if it does not fall
   well below 10%, the rubric is the problem, not the sampling.
2. **Tighter criteria.** `executable-steps` and `failure-modes` (both 0.67 pass
   rate) are the likeliest sources of ambiguity — they ask a question with a
   genuinely fuzzy boundary. Rewriting them as countable tests ("names at least
   two runnable commands", "contains an explicit 'do not' or counter-example")
   would remove the judgment the model is being inconsistent about.
3. Only then is measuring κ against human ratings worth the effort.

## Verdict for v0.5.0

**Ship the judge, advisory only, and do not aggregate its scores.** That is the
outcome the milestone pre-approved, and the measurement above is the artifact
justifying it. Concretely:

- Read an individual verdict as *a prompt to go look at a skill*, never as
  evidence about it.
- Do not compute averages across skills or track the score over time — both
  would be reporting a 19% coin-flip as a trend.
- Nothing gates on it, enforced by a test.

## To finish calibration

A ready-to-fill template with all 24 judged skills is at
`docs/research/judge-corpus/ratings.template.json` (every value `null`).

1. Rate ≥20 skills by hand — for each, answer the four criteria `true`/`false`:

   ```json
   {
     "skill-name": {
       "concrete-tools": true,
       "domain-specifics": false,
       "executable-steps": true,
       "failure-modes": false
     }
   }
   ```

2. Run `fleetsmith eval fleet.yaml --judge --ratings ratings.json`.
3. Record the per-criterion κ here.
4. **Decide:**
   - mean κ ≥ 0.8 → the judge is usable as an advisory metric; say so here.
   - mean κ < 0.8 → either tighten the rubric and re-measure, or close the
     judge as not adopted. The milestone pre-approves that outcome, with this
     document as the artifact.

Rate the skills **before** looking at the judge's verdicts. Reading them first
contaminates the ratings, and a calibration measured against contaminated
ratings is worse than none because it looks rigorous.

## Current status

| | |
|---|---|
| Judge implemented | yes |
| Wired to any gate | **no, by design** (test-enforced) |
| Corpus assembled | yes — 24 real skills, 26–370 lines |
| Corpus judged | 24 of 24 |
| Score spread | 1/4 to 4/4 — discriminates |
| Self-consistency | **19% of verdicts flip between identical runs** |
| Human ratings | **none** |
| Agreement (κ) | **not computed — instability makes it unmeasurable** |
| Recommended use | read individual verdicts as prompts to look at a skill; do not aggregate, do not gate |
