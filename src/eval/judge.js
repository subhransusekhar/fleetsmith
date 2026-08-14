import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mapPool } from '../lib/pool.js';

const run = promisify(execFile);

/**
 * The advisory skill-substance judge.
 *
 * Deterministic checks answer "is this harness well-formed" and "does this
 * skill route correctly". Neither can answer the question that actually
 * decides whether a skill is worth having: **is the methodology substantive,
 * or is it generic filler that adds nothing the base model did not already
 * know?** That is what this judges, and it is the only subjective axis in the
 * system.
 *
 * Three constraints, all from judge-reliability research, all load-bearing:
 *
 *  1. **Binary criteria, never a holistic score.** Explicit objective criteria
 *     with clear pass/fail thresholds are the rubric type that reproduces;
 *     subjective quality judgments and anything requiring inference of intent
 *     do not. "Rate this 1-10" produces position and verbosity bias.
 *  2. **Advisory only. It must never gate.** A gate is only as good as its
 *     verifier, and an uncalibrated judge lowers that ceiling while feeling
 *     like progress. Nothing in this codebase may branch on a judge score —
 *     there is a test asserting exactly that.
 *  3. **Calibrate before believing it.** The gap between a naive and a
 *     calibrated judge is wide enough to produce opposite conclusions about
 *     agent quality. `docs/research/judge-calibration.md` records where this
 *     one actually stands.
 *
 * The judge function is injected, so this is testable without a model and
 * cannot silently acquire a network dependency.
 */

/**
 * The rubric. Each criterion is a yes/no question about something observable
 * in the text, not an opinion about how good it feels.
 */
export const CRITERIA = [
  {
    id: 'concrete-tools',
    question:
      'Does the body name specific tools, commands, file paths, or formats (e.g. `npm test`, `.claude/agents/`), rather than only categories like "the test suite" or "the config"?',
  },
  {
    id: 'domain-specifics',
    question:
      'Does it cite domain standards, codebase specifics, or named conventions that a general-purpose model would not already apply by default?',
  },
  {
    id: 'executable-steps',
    question:
      'Can each step be carried out without further interpretation — is it clear what to actually do, rather than what to value?',
  },
  {
    id: 'failure-modes',
    question:
      'Does it name concrete failure modes, counter-examples, or things NOT to do, rather than describing only the happy path?',
  },
];

export function buildJudgePrompt(skill) {
  return `You are auditing one Agent Skill for substance. Answer only the questions asked.

## Skill: ${skill.name}

### Description
${skill.description || '(none)'}

### Body
${skill.body || '(empty)'}

## Questions

Answer each with true or false, judging ONLY what is present in the text above. Do not reward good intentions, aspirations, or restatements of the skill's purpose — a body that says "research thoroughly" without saying what to read scores false on executable-steps.

${CRITERIA.map((c, i) => `${i + 1}. ${c.id}: ${c.question}`).join('\n\n')}

## Output

Reply with ONLY a JSON object, no markdown fence, no commentary:
{"concrete-tools": true|false, "domain-specifics": true|false, "executable-steps": true|false, "failure-modes": true|false, "notes": "one sentence naming the weakest criterion and why"}`;
}

/**
 * Per-call timeout, and why it is far below the old 120s.
 *
 * Measured over eight consecutive calls on this repo's own skills: every one
 * completed in 8-16s at `num_turns: 1`. The judge does not explore — it grades
 * the text it was handed, and running it in a scratch directory instead of the
 * project changed nothing (13.7s vs 11.1s), so the prompt is the whole workload.
 *
 * Against a p50 near 10s, a 120s ceiling is not patience, it is a hole in the
 * report: an intermittent stall consumed two minutes and then returned an
 * unmeasured row, once per full run in both runs observed. A ceiling at 6x p50
 * plus one retry gives two independent chances inside the same worst case, and
 * an intermittent stall is exactly the failure a retry fixes.
 */
export const DEFAULT_JUDGE_TIMEOUT = 60_000;

/**
 * Ask Claude Code headlessly. Returns null when every attempt fails — advisory
 * means optional, and a null row is reported as unmeasured, never as a pass.
 *
 * Async on purpose. Each call is a whole headless session, so sequentially this
 * is minutes for a rubric of four booleans; the caller can only fan them out if
 * they do not block the event loop.
 *
 * The model is left unpinned by default. A cheaper tier is the obvious guess and
 * it is wrong on latency — Haiku measured *slower* than the session default here
 * (22.9s vs 8.9s) while costing 5.5x less, so the tier is a cost decision for the
 * caller to make with `--model`, not a speed win to bake in.
 *
 * A retry also covers an unparseable reply, not just a timeout: a verdict that
 * cannot be parsed is indistinguishable from no verdict, and re-asking is
 * cheaper than reporting a hole.
 */
export function claudeJudge({
  command = 'claude',
  model = null,
  timeout = DEFAULT_JUDGE_TIMEOUT,
  attempts = 2,
  // The transport is injectable so the retry loop is testable without a model
  // and without shelling out. Default is the real headless CLI.
  exec = (cmd, args, opts) => run(cmd, args, opts).then((r) => r.stdout),
} = {}) {
  return async (skill) => {
    const args = ['-p', buildJudgePrompt(skill), '--output-format', 'json'];
    if (model) args.push('--model', model);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const verdict = parseVerdict(await exec(command, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 }));
        if (verdict) return verdict;
      } catch {
        /* fall through to the retry */
      }
    }
    return null;
  };
}

export function parseVerdict(raw) {
  let text = String(raw ?? '').trim();
  if (!text) return null;
  try {
    const outer = JSON.parse(text);
    if (outer && typeof outer === 'object' && !Array.isArray(outer)) {
      if (CRITERIA.some((c) => c.id in outer)) return coerce(outer);
      text = String(outer.result ?? outer.content ?? outer.text ?? text);
    }
  } catch {
    /* fall through to extraction */
  }
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return coerce(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return null;
  }
}

function coerce(obj) {
  const verdict = { criteria: {}, notes: typeof obj.notes === 'string' ? obj.notes : '' };
  for (const c of CRITERIA) verdict.criteria[c.id] = obj[c.id] === true;
  verdict.score = Object.values(verdict.criteria).filter(Boolean).length;
  return verdict;
}

/**
 * Judge every skill in a spec. Returns advisory records — never a pass/fail.
 *
 * The absence of a `pass` field is deliberate: there is nothing here for a
 * caller to gate on even by accident.
 *
 * Skills are judged concurrently because no verdict depends on another — the
 * rubric is per-skill by construction. Rows keep spec order regardless of which
 * call returns first, so the output stays diffable against a previous run.
 * `onProgress` exists because a suite that prints nothing for two minutes is
 * indistinguishable from one that has hung, and the reasonable response to a
 * hang is Ctrl-C.
 */
export async function judgeSkills(spec, judge, { concurrency = 4, onProgress = null } = {}) {
  let done = 0;
  const settled = await mapPool(spec.skills, concurrency, async (skill) => {
    const verdict = await judge(skill);
    onProgress?.({ skill: skill.name, done: ++done, total: spec.skills.length });
    return verdict;
  });

  return spec.skills.map((skill, i) => {
    // A thrown judge is an unavailable judge: advisory means a broken row, not
    // a broken run.
    const verdict = settled[i]?.error ? null : settled[i]?.value;
    return {
      skill: skill.name,
      score: verdict ? verdict.score : null,
      of: CRITERIA.length,
      criteria: verdict ? verdict.criteria : null,
      notes: verdict ? verdict.notes : 'judge unavailable',
    };
  });
}

/**
 * Agreement between the judge and human ratings, per criterion.
 *
 * Raw agreement is reported but is not the number that matters: on a criterion
 * almost everything passes, a judge that always says true scores ~90% while
 * being useless. Cohen's kappa corrects for agreement expected by chance,
 * which is why the threshold below is stated on kappa.
 */
export function agreement(judged, human) {
  const perCriterion = {};
  for (const c of CRITERIA) {
    let a = 0;
    let n = 0;
    let jTrue = 0;
    let hTrue = 0;
    for (const j of judged) {
      const h = human[j.skill];
      if (!h || !j.criteria || !(c.id in h)) continue;
      n++;
      if (j.criteria[c.id] === h[c.id]) a++;
      if (j.criteria[c.id]) jTrue++;
      if (h[c.id]) hTrue++;
    }
    if (n === 0) {
      perCriterion[c.id] = { n: 0, raw: null, kappa: null };
      continue;
    }
    const po = a / n;
    // Expected agreement from the marginals.
    const pe = (jTrue / n) * (hTrue / n) + (1 - jTrue / n) * (1 - hTrue / n);
    const kappa = pe === 1 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe);
    perCriterion[c.id] = { n, raw: round(po), kappa: round(kappa) };
  }
  const kappas = Object.values(perCriterion).map((v) => v.kappa).filter((k) => k !== null);
  const mean = kappas.length ? round(kappas.reduce((x, y) => x + y, 0) / kappas.length) : null;
  return {
    perCriterion,
    meanKappa: mean,
    // The 2026 operational norm for trusting an aggregate judge metric.
    trustworthy: mean !== null && mean >= 0.8,
    sample: judged.filter((j) => human[j.skill]).length,
  };
}

export function formatJudge(results) {
  const lines = ['skill                            score  weakest'];
  let unjudged = 0;
  for (const r of results) {
    // An unjudged skill has no criteria, so the "failed criteria" list is empty
    // — which must never render as "(all criteria met)". That is the same
    // unmeasured-reads-as-passing failure the exec suite guards against, and it
    // is worse here because the score column showing `--` is easy to skim past.
    let weakest;
    if (!r.criteria) {
      unjudged++;
      weakest = 'NOT JUDGED — no verdict, not a pass';
    } else {
      const failed = Object.entries(r.criteria).filter(([, v]) => !v).map(([k]) => k);
      weakest = failed.join(', ') || '(all criteria met)';
    }
    lines.push(`${r.skill.padEnd(32)} ${r.score === null ? ' -- ' : `${r.score}/${r.of} `}  ${weakest}`);
  }
  lines.push('');
  if (unjudged > 0) {
    lines.push(
      `${unjudged} skill(s) returned no verdict — most often the per-call timeout. Those rows are unmeasured, not passing.`
    );
  }
  lines.push('ADVISORY ONLY — this score gates nothing. See docs/research/judge-calibration.md');
  return lines.join('\n');
}

const round = (n) => Math.round(n * 1000) / 1000;
