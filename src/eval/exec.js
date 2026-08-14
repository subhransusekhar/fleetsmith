import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { buildAll } from '../adapters/index.js';
import { mapPool } from '../lib/pool.js';

const execFileAsync = promisify(execFile);

/**
 * Live case execution — the measurement `fleetsmith eval` deliberately does
 * not make.
 *
 * The deterministic suites answer "does this skill route correctly" and "does
 * the compiler still work". Neither answers "is the output any better with the
 * skill than without", which needs a real session with a real model.
 *
 * **This never gates.** It is invoked only by `fleetsmith eval --exec`, never
 * by `runEval`, and therefore never by `fleetsmith evolve`. That separation is
 * the whole reason this is a separate module rather than a flag inside the
 * eval runner: a promotion gate must be reproducible in CI with no model, no
 * API key, and no wall-clock cost, and this is none of those things. A test
 * asserts the gate path does not reach here.
 *
 * Design rules that follow from being a measurement rather than a gate:
 *  - **Skip loudly.** A case that could not run is reported as `skipped`, never
 *    as a pass. Silent skips are how a suite reports green while measuring
 *    nothing.
 *  - **Deterministic assertions first.** Model grading is opt-in per case,
 *    because an assertion a script can check is always the better one.
 *  - **Run in a TRUSTED workspace.** Claude Code ignores a project's
 *    `settings.json` — the permission allowlist and the SubagentStop gate —
 *    until the workspace has been trusted interactively. A freshly created
 *    temp directory never has been, so measuring there measures a degraded
 *    harness with no gate, and in practice stalls waiting on permissions.
 *    So the default is the project directory, which a user has already
 *    trusted. `--fresh` opts into per-case isolation and says plainly that
 *    the result is degraded.
 *
 * Each case is a separate headless session, so no case inherits another's
 * conversation context. Only the filesystem is shared in the default mode,
 * which is the same filesystem a real user would be working in.
 */

/** Claude Code's warning when a workspace has not been trusted. */
const UNTRUSTED = /has not been trusted/i;

/** How to drive each target headlessly, and how to tell whether it is present. */
export const RUNNERS = {
  'claude-code': {
    bin: 'claude',
    args: (query) => ['-p', query],
  },
  opencode: {
    bin: 'opencode',
    args: (query) => ['run', query],
  },
  goose: {
    bin: 'goose',
    // goose drives a recipe rather than a bare prompt; the orchestrator recipe
    // is the entry point a user would actually invoke.
    args: (query, spec) => ['run', '--recipe', `.goose/recipes/${spec.orchestrator.name}.yaml`, '--params', `task_brief=${query}`],
  },
};

export function runnerAvailable(target) {
  const r = RUNNERS[target];
  if (!r) return false;
  try {
    execFileSync('command', ['-v', r.bin], { shell: true, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute every declared case for every skill.
 *
 * Returns records with an explicit `status` of pass / fail / skipped — not a
 * boolean — so a skipped case cannot be mistaken for a passing one by a caller
 * that only checks truthiness.
 */
/**
 * Default per-case timeout.
 *
 * Deliberately short. A case whose query triggers the fleet ORCHESTRATOR runs
 * the entire fleet, which takes many minutes — measured here at >6 minutes with
 * no result. That is a badly-scoped case, not a slow model, and it should be
 * reported as such rather than left to hang. Scope cases at a single skill's
 * methodology; raise this only when you know why you need to.
 */
export const DEFAULT_CASE_TIMEOUT = 120_000;

/**
 * How many cases may run at once, and why the default depends on isolation.
 *
 * Under `--fresh` each case owns a temp workspace, so cases are independent and
 * concurrency is pure wall-clock: N sessions cost roughly one session's latency.
 *
 * In the default shared-workspace mode they are NOT independent. Cases run in
 * the real project directory and may write files; `expect.file` then asks "does
 * this path exist", which a concurrent case's session can satisfy or clobber.
 * Running two at once would make that assertion depend on scheduling, so the
 * default stays 1 — a suite that is fast and wrong is worse than one that is
 * slow. `--concurrency` overrides it for anyone who knows their cases only read.
 */
export const DEFAULT_CONCURRENCY = { shared: 1, fresh: 4 };

export async function runExecCases(
  spec,
  {
    target = 'claude-code',
    timeout = DEFAULT_CASE_TIMEOUT,
    cwd = null,
    fresh = false,
    run = null,
    concurrency = null,
    onProgress = null,
  } = {}
) {
  const cases = spec.skills.flatMap((s) => s.evals.map((c) => ({ skill: s.name, ...c })));
  if (cases.length === 0) return { results: [], target, ran: 0, skipped: 0 };

  const runner = RUNNERS[target];
  const exec = run ?? defaultRun;
  const available = run ? true : runnerAvailable(target);

  if (!available) {
    // One decision for the whole suite rather than one per case: the binary is
    // either on PATH or it is not, and re-probing per case measures nothing.
    const results = cases.map((c) => ({
      skill: c.skill,
      query: c.query,
      status: 'skipped',
      detail: `${runner?.bin ?? target} not found on PATH — case not measured`,
    }));
    return { results, target, ran: 0, skipped: results.length };
  }

  const width = Number(concurrency) || (fresh ? DEFAULT_CONCURRENCY.fresh : DEFAULT_CONCURRENCY.shared);
  let done = 0;

  const settled = await mapPool(cases, width, async (c) => {
    const workspace = fresh ? freshWorkspace(spec) : (cwd ?? process.cwd());
    try {
      const output = await exec({ target, query: c.query, cwd: workspace, spec, timeout });
      return { skill: c.skill, query: c.query, ...assess(c, output, workspace) };
    } catch (e) {
      const timedOut = /ETIMEDOUT|timed out|SIGTERM/i.test(e.message);
      return {
        skill: c.skill,
        query: c.query,
        status: 'skipped',
        detail: timedOut
          ? `no result in ${Math.round(timeout / 1000)}s — a query that triggers the orchestrator runs the whole fleet; scope the case at one skill`
          : `runner failed: ${e.message}`,
      };
    } finally {
      if (fresh) fs.rmSync(workspace, { recursive: true, force: true });
      onProgress?.({ skill: c.skill, done: ++done, total: cases.length });
    }
  });

  // mapPool only rejects on a throw outside the per-case try above; fold it into
  // the same skipped shape so no caller sees an undefined row.
  const results = settled.map((s, i) =>
    s.error
      ? { skill: cases[i].skill, query: cases[i].query, status: 'skipped', detail: `runner failed: ${s.error.message}` }
      : s.value
  );

  return {
    results,
    target,
    ran: results.filter((r) => r.status !== 'skipped').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
  };
}

/** Deterministic assertions. Model grading, when opted into, is layered by the CLI. */
function assess(c, output, workspace) {
  const problems = [];
  const text = String(output);
  for (const m of c.expect.mentions) {
    if (!text.toLowerCase().includes(m.toLowerCase())) problems.push(`missing expected mention: "${m}"`);
  }
  for (const m of c.expect.notMentions) {
    if (text.toLowerCase().includes(m.toLowerCase())) problems.push(`contains forbidden mention: "${m}"`);
  }
  if (c.expect.file && !fs.existsSync(path.join(workspace, c.expect.file))) {
    problems.push(`expected file not written: ${c.expect.file}`);
  }
  // A degraded harness is not a valid measurement, whatever the assertions say.
  if (UNTRUSTED.test(text)) {
    return {
      status: 'skipped',
      detail:
        'workspace is untrusted, so the permission allowlist and the SubagentStop gate were inert — ' +
        'this would measure a degraded harness. Run in a trusted directory (the default) rather than --fresh.',
      output: text.slice(0, 2000),
    };
  }
  return { status: problems.length === 0 ? 'pass' : 'fail', detail: problems.join('; '), output: text.slice(0, 2000) };
}

/** A fresh checkout of the compiled harness, so no case inherits another's context. */
function freshWorkspace(spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-exec-'));
  buildAll(spec, {}).write(dir, { force: true });
  return dir;
}

async function defaultRun({ target, query, cwd, spec, timeout }) {
  const r = RUNNERS[target];
  const { stdout } = await execFileAsync(r.bin, r.args(query, spec), {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Stability over repeated runs — the noise floor for a stochastic suite.
 *
 * The deterministic suites measured a floor of 0.000, which is meaningless
 * here: live runs vary. Until this is measured for a given corpus, a delta
 * between two `--exec` runs says nothing.
 *
 * Measured for the meta-fleet's own four cases: **0 of 4 flipped across 2
 * runs**. That is "no instability observed", NOT "no instability exists" — a
 * floor computed from 4 binary outcomes over 2 runs cannot resolve a flip rate
 * below roughly 25%, so it is not evidence that small deltas are meaningful.
 * Compare the judge, where instability only became visible at 16 verdicts
 * across 3 runs. Treat this floor as provisional until the corpus grows.
 */
export function execStability(runs) {
  const keys = runs[0]?.results.map((r) => `${r.skill}::${r.query}`) ?? [];
  let flipped = 0;
  const unstable = [];
  for (const [i, key] of keys.entries()) {
    const statuses = runs.map((r) => r.results[i]?.status);
    if (new Set(statuses).size > 1) {
      flipped++;
      unstable.push(key);
    }
  }
  return {
    cases: keys.length,
    runs: runs.length,
    flipped,
    floor: keys.length ? flipped / keys.length : 0,
    unstable,
  };
}

export function formatExec({ results, target, ran, skipped }) {
  const lines = [`live case execution — target: ${target}`, ''];
  for (const r of results) {
    const tag = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIP';
    lines.push(`${tag}  [${r.skill}] "${r.query.slice(0, 52)}"${r.detail ? ` — ${r.detail}` : ''}`);
  }
  lines.push('');
  lines.push(`${ran} case(s) measured, ${skipped} skipped`);
  if (skipped > 0) {
    // Never let an unmeasured case read as a passing one.
    lines.push('Skipped cases were NOT measured. They are not passes.');
  }
  lines.push('ADVISORY — live execution gates nothing; promotion uses the deterministic suites.');
  return lines.join('\n');
}
