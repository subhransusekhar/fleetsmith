/**
 * Eval scaffolding for generated skills.
 *
 * Whether a skill fires and whether its output is any good are separate
 * properties, and only the first can be measured from prompts alone. A skill
 * that never triggers looks identical to one that does not exist, so the
 * trigger corpus is the cheaper and more urgent of the two.
 *
 * The emitted files are deliberately small: 2–3 cases per skill is the
 * documented starting point, because early effect sizes are large enough to
 * see without a big corpus, and an eval suite nobody runs is worth nothing.
 */

/** `evals/evals.json` for one skill: the trigger corpus plus room for output cases. */
export function skillEvals(skill, spec) {
  const { should, shouldNot } = skill.triggers;
  return `${JSON.stringify(
    {
      skill: skill.name,
      description: skill.description,
      // Prompts that must route to this skill. Written the way a user would
      // actually type them, not the way the description phrases it — matching
      // your own vocabulary back to yourself proves nothing.
      should_trigger: should.length > 0 ? should : [`TODO: a request that must invoke ${skill.name}`],
      // Near-misses in the same domain. These are what catch a description so
      // broad it swallows requests meant for a sibling skill.
      should_not_trigger:
        shouldNot.length > 0
          ? shouldNot
          : [`TODO: a nearby request that must NOT invoke ${skill.name} (e.g. one belonging to another ${spec.fleet.name} skill)`],
      // Output quality: paired with/without-skill runs. Left empty on purpose —
      // you cannot write good assertions before seeing the skill run once.
      cases: [],
    },
    null,
    2
  )}\n`;
}

/** One README per fleet explaining how to run what was emitted. */
export function evalsReadme(spec) {
  const skills = spec.skills.map((s) => s.name);
  return `# Evaluating the ${spec.fleet.name} fleet's skills

Each skill has an \`evals/evals.json\` next to its \`SKILL.md\`${
    skills.length ? ` (${skills.join(', ')})` : ''
  }. There are two different questions to answer, and they need different methods.

## 1. Does the skill trigger?

A skill that never fires is indistinguishable from one that was never written, and
nothing in the run will tell you which happened. This is the check to run first.

For each prompt in \`should_trigger\`, start a **fresh** session and give the prompt
verbatim; the skill should be invoked. For each prompt in \`should_not_trigger\`, it
should not. Both directions matter — a description broad enough to always fire is
as wrong as one that never does.

When a prompt fails, edit the \`description\`, not the prompt. The description is the
entire routing signal: it needs what the skill does, when to use it, and the literal
words a user would type. Re-run the corpus after each edit.

A fresh session is not optional. Context left over from writing or discussing the
skill will make it fire for reasons that will not exist for a real user.

## 2. Is the output any better with the skill than without?

Run the same task twice — once with the skill available, once without — and compare.
The delta is the number that matters, not the absolute score: a skill that costs 13
extra seconds for a 50-point pass-rate gain is clearly worth it, and one that doubles
token usage for two points is not.

Write the assertions **after** you have watched the skill run once. You usually do not
know what "good" looks like until you have seen what "bad" looks like, and assertions
written in advance tend to describe the skill you imagined rather than the one you have.
Prefer assertions a script can check (file exists, valid JSON, row count, exit status)
over a model's judgment; reserve model grading for genuinely subjective qualities, and
require concrete evidence for a pass rather than giving the benefit of the doubt.

Three patterns worth watching for once you have results: an assertion that passes both
with and without the skill is measuring nothing and inflates the score — delete it; one
that fails both ways is probably broken itself; and a case with high variance between
runs means the instructions are ambiguous, not that the model is unreliable.

## When to re-run

Re-run the trigger corpus after editing any description, and both suites after a model
upgrade. Model changes move trigger behavior silently, and this corpus is the only thing
that will tell you it moved.
`;
}
