import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { normalizeSpec } from '../spec/schema.js';
import { runQa } from '../qa/index.js';
import { buildAll } from '../adapters/index.js';

/**
 * The eval runner — the EVALUATE stage's measurement, as opposed to its gate.
 *
 * `fleetsmith qa` answers "is this harness well-formed". This answers "is this
 * harness any *better*", which is the question a mutation has to clear before
 * it can be promoted. Without it the evolution loop would optimize against
 * agent self-assessment, which the orchestrator playbook itself warns against.
 *
 * Two suites, both deterministic so they run in CI with no model available:
 *
 *  1. **Trigger tests** — does each skill's description actually discriminate?
 *     A skill that never fires is indistinguishable from one that was never
 *     written, and nothing in a run reports which happened.
 *
 *  2. **Eval fleets** — held-out specs in test/eval-fleets/, each built and
 *     checked against declared expectations. This is the regression suite that
 *     catches a mutation breaking the compiler for everyone else.
 *
 * Honest limits, stated because a misread eval is worse than none:
 *  - Trigger scoring is a lexical proxy for the real router, not the router.
 *    It reliably catches the failure that matters — two descriptions so alike
 *    that a prompt meant for one matches the other — and cannot tell you how
 *    a given model would actually route. Treat a regression as a signal to
 *    look, not as proof.
 *  - Below ~30 cases, run-to-run variation is indistinguishable from real
 *    regression, which is why `--calibrate` exists and why deltas under the
 *    measured noise floor are reported as "no signal" rather than as wins.
 */

/** Stage ladder: cheap smoke first, full suite only for candidates that survive. */
const STAGE_LIMITS = { 1: 3, 2: 10, 3: Infinity };

export function runEval(spec, { stage = 1, fleetsDir = null, baseline = null } = {}) {
  const limit = STAGE_LIMITS[stage] ?? STAGE_LIMITS[1];

  const triggers = runTriggerTests(spec);
  const fleets = fleetsDir ? runEvalFleets(fleetsDir, limit) : { cases: [], skipped: 0 };

  const score = {
    trigger: ratio(triggers.cases),
    fleets: ratio(fleets.cases),
  };
  const all = [...triggers.cases, ...fleets.cases];
  const result = {
    stage,
    score,
    overall: ratio(all),
    cases: all,
    skipped: fleets.skipped,
    pass: all.every((c) => c.pass),
  };
  if (baseline) result.delta = compare(baseline, result);
  return result;
}

// --- 1. trigger tests -------------------------------------------------------

/**
 * For each declared prompt, score it against every skill description and check
 * that the intended skill wins.
 *
 * Scoring is deliberately simple and explainable: shared vocabulary weighted by
 * how rare each term is across the fleet's descriptions. Rare shared terms are
 * what make a description discriminating; common ones ("the", "use", "fleet")
 * are exactly the words that make two skills collide.
 */
export function runTriggerTests(spec) {
  const cases = [];
  const idf = buildIdf(spec.skills);

  for (const skill of spec.skills) {
    for (const prompt of skill.triggers.should) {
      if (/^TODO/i.test(prompt)) continue; // scaffolding, not a corpus
      const ranked = rank(prompt, spec.skills, idf);
      const winner = ranked[0];
      const tied = isTie(ranked);
      cases.push({
        suite: 'trigger',
        name: `${skill.name} <- "${truncate(prompt)}"`,
        pass: winner?.name === skill.name && !tied,
        detail: tied
          ? `ties with "${ranked[1].name}" — the prompt contains no term unique to either description`
          : winner?.name === skill.name
            ? ''
            : `routed to "${winner?.name ?? 'nothing'}" instead; the two descriptions share too much vocabulary`,
      });
    }
    for (const prompt of skill.triggers.shouldNot) {
      if (/^TODO/i.test(prompt)) continue;
      const ranked = rank(prompt, spec.skills, idf);
      const winner = ranked[0];
      cases.push({
        suite: 'trigger',
        name: `${skill.name} !<- "${truncate(prompt)}"`,
        pass: winner?.name !== skill.name,
        detail: winner?.name === skill.name ? `wrongly claimed by "${skill.name}" — description is too broad` : '',
      });
    }
  }
  return { cases };
}

function buildIdf(skills) {
  const docFreq = new Map();
  for (const s of skills) {
    for (const t of new Set(tokens(s.description))) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }
  const n = Math.max(skills.length, 1);
  const idf = new Map();
  for (const [t, df] of docFreq) idf.set(t, Math.log((n + 1) / (df + 0.5)));
  return idf;
}

/**
 * Ranked skills for a prompt. Ties are reported rather than broken: two
 * descriptions scoring identically means neither discriminates, and resolving
 * that by array order would make the verdict depend on how the author happened
 * to sort the spec.
 */
function rank(prompt, skills, idf) {
  const p = new Set(tokens(prompt));
  return skills
    .map((s) => {
      const d = new Set(tokens(s.description));
      let score = 0;
      for (const t of p) if (d.has(t)) score += idf.get(t) ?? 0;
      return { name: s.name, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** True when the top two skills are indistinguishable on this prompt. */
function isTie(ranked) {
  return ranked.length > 1 && Math.abs(ranked[0].score - ranked[1].score) < 1e-9;
}

const STOP = new Set(
  'a an the and or of to for in on with when use used using this that it is are be as at by from into your you my'.split(' ')
);
function tokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

// --- 2. eval fleets ---------------------------------------------------------

/**
 * Held-out specs, each with declared expectations, built and checked.
 *
 * This is the regression suite a mutation must not break: it exercises the
 * compiler across patterns the meta-fleet itself does not use, so a change
 * that happens to suit one fleet shape but breaks another is caught here
 * rather than by a user.
 *
 * The directory is on the protected path list. The loop may propose adding
 * cases; it may never edit or remove existing ones. Given a scored detector,
 * an optimizer deletes the detector.
 */
export function runEvalFleets(dir, limit = Infinity) {
  const cases = [];
  if (!fs.existsSync(dir)) return { cases, skipped: 0 };

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort();
  const selected = files.slice(0, limit === Infinity ? files.length : limit);
  const skipped = files.length - selected.length;

  for (const file of selected) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    const parsed = YAML.parse(raw);
    const expect = parsed.expect ?? {};
    delete parsed.expect;

    let spec;
    try {
      spec = normalizeSpec(parsed);
    } catch (e) {
      cases.push({ suite: 'fleet', name: file, pass: false, detail: `does not normalize: ${e.message}` });
      continue;
    }

    const qa = runQa(spec);
    const failures = qa.checks.filter((c) => !c.pass);
    const problems = failures.map((c) => `${c.name}: ${c.evidence[0] ?? ''}`);

    // Declared expectations beyond well-formedness.
    if (expect.agents !== undefined && spec.agents.length !== expect.agents) {
      problems.push(`expected ${expect.agents} agents, got ${spec.agents.length}`);
    }
    if (expect.skills !== undefined && spec.skills.length !== expect.skills) {
      problems.push(`expected ${expect.skills} skills, got ${spec.skills.length}`);
    }
    if (expect.pattern && spec.fleet.pattern !== expect.pattern) {
      problems.push(`expected pattern ${expect.pattern}, got ${spec.fleet.pattern}`);
    }
    for (const needle of expect.emits ?? []) {
      const built = qa.checks.find((c) => c.name.startsWith('compile'));
      if (!built?.pass) continue; // already reported
      if (!specEmits(spec, needle)) problems.push(`expected output to include ${needle}`);
    }

    cases.push({ suite: 'fleet', name: file, pass: problems.length === 0, detail: problems.join('; ') });
  }
  return { cases, skipped };
}

function specEmits(spec, relPath) {
  return buildAll(spec, {}).files.has(relPath);
}

// --- scoring, noise floor, comparison ---------------------------------------

function ratio(cases) {
  if (cases.length === 0) return null;
  return cases.filter((c) => c.pass).length / cases.length;
}

/**
 * Paired comparison against a baseline run.
 *
 * Reported per case rather than as a single number, because "3 fixed, 2 broken"
 * and "1 fixed" have the same aggregate delta and mean completely different
 * things to whoever has to decide whether to promote.
 */
export function compare(baseline, current) {
  const before = new Map(baseline.cases.map((c) => [c.name, c.pass]));
  const fixed = [];
  const broken = [];
  for (const c of current.cases) {
    if (!before.has(c.name)) continue;
    if (c.pass && !before.get(c.name)) fixed.push(c.name);
    if (!c.pass && before.get(c.name)) broken.push(c.name);
  }
  const delta = (current.overall ?? 0) - (baseline.overall ?? 0);
  return { delta, fixed, broken, comparable: before.size };
}

/**
 * Classify a delta against a measured noise floor.
 *
 * Anything at or under the floor is "no signal" — never a win. This is the
 * guard against the loop promoting a mutation that changed nothing but caught
 * a lucky run, which on a small corpus is the default outcome.
 */
export function classifyDelta(delta, noise) {
  const floor = noise?.floor ?? 0;
  if (Math.abs(delta) <= floor) return { verdict: 'no signal', floor };
  return { verdict: delta > 0 ? 'improvement' : 'regression', floor };
}

/** Run the same evaluation twice and record how much it moved on its own. */
export function calibrate(runOnce) {
  const a = runOnce();
  const b = runOnce();
  const disagreed = a.cases.filter((c, i) => c.pass !== b.cases[i]?.pass).map((c) => c.name);
  const floor = a.cases.length ? disagreed.length / a.cases.length : 0;
  return {
    floor,
    unstable: disagreed,
    cases: a.cases.length,
    note:
      disagreed.length === 0
        ? 'Deterministic across two runs; any non-zero delta is real. Re-measure once cases execute live agents.'
        : `${disagreed.length} case(s) flipped between identical runs — treat deltas at or below ${floor.toFixed(3)} as noise.`,
  };
}

export function formatEval(result) {
  const lines = [];
  for (const c of result.cases) {
    lines.push(`${c.pass ? 'PASS' : 'FAIL'}  [${c.suite}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  lines.push('');
  if (result.score.trigger !== null) lines.push(`trigger: ${pct(result.score.trigger)}`);
  if (result.score.fleets !== null) lines.push(`fleets:  ${pct(result.score.fleets)}`);
  if (result.skipped > 0) {
    // Never let a stage limit read as full coverage.
    lines.push(`skipped: ${result.skipped} fleet(s) not run at stage ${result.stage}`);
  }
  if (result.delta) {
    const d = result.delta;
    lines.push(`delta:   ${d.delta >= 0 ? '+' : ''}${(d.delta * 100).toFixed(1)}pp vs baseline (${d.comparable} comparable)`);
    if (d.fixed.length) lines.push(`  fixed:  ${d.fixed.join(', ')}`);
    if (d.broken.length) lines.push(`  broken: ${d.broken.join(', ')}`);
    if (d.verdict) lines.push(`  verdict: ${d.verdict}${d.floor ? ` (noise floor ${d.floor.toFixed(3)})` : ''}`);
  }
  lines.push(result.pass ? 'eval: PASS' : `eval: FAIL (${result.cases.filter((c) => !c.pass).length} case(s))`);
  return lines.join('\n');
}

const pct = (r) => `${(r * 100).toFixed(1)}%`;
const truncate = (s, n = 48) => (s.length > n ? `${s.slice(0, n)}…` : s);
