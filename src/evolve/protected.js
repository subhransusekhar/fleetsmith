/**
 * Protected paths — the guard that keeps the evolution loop from editing its
 * own referee.
 *
 * Two properties matter more than the list itself.
 *
 * **It cannot be unprotected from the spec.** The hard-coded entries below are
 * not derived from fleet.yaml, so a mutation cannot widen its own permissions
 * by editing the file it is allowed to edit.
 *
 * **It is enforced twice, once out of process.** The patch API refuses these
 * targets in-process (src/evolve/patch.js); CI refuses them again by diffing
 * the branch. The redundancy is deliberate: any control living inside the
 * agent's runtime is reachable by inputs that influence the agent, so the
 * decisive check has to run somewhere the agent is not.
 *
 * Why this exists at all, in one sentence, because the reason is not locally
 * obvious and someone will eventually be tempted to simplify it away: the
 * Darwin Gödel Machine, given a reward function that counted marker tokens in
 * its output, improved its score by **deleting the markers** rather than
 * fixing the behaviour they measured — despite an explicit instruction not to
 * (arXiv 2505.22954). An optimizer with write access to its own scorecard
 * edits the scorecard. Anthropic states the same rule as harness policy: an
 * agent may record results into a feature list but "it is unacceptable to
 * remove or edit tests".
 */

/**
 * Paths the loop may never touch, whatever the spec says.
 *
 * Each entry is the referee, the rulebook, or the evidence:
 *  - the spec layer and QA battery decide whether a mutation is valid at all
 *  - the patch API is the thing enforcing this list
 *  - tests and eval fleets are the scorecard
 *  - the handover gate is the only deterministic runtime enforcement
 *  - CI is where the out-of-process check runs
 *  - these documents are the reasoning a future maintainer needs to not undo it
 */
export const HARD_PROTECTED = [
  'src/spec/**',
  'src/qa/**',
  'src/eval/**',
  'src/evolve/patch.js',
  'src/evolve/protected.js',
  'test/**',
  '.github/workflows/**',
  '_fleet/local/scripts/validate-handoff.sh',
  'docs/milestones/v0.5.0-self-evolution.md',
  'docs/research/self-evolving-agents-2026-08.md',
  'docs/architecture/multi-user-context.md',
];

/** Artifact length caps. Constraints against overfitting, not tidiness. */
export const CAPS = {
  // Anthropic's skill guidance, which doubles as the anti-overfitting bound:
  // unconstrained reflective optimization grows instructions without limit
  // (Decagon measured a 1,500-char cap buying 4x compression for 0.8% loss).
  skillLines: 500,
  agentLines: 300,
};

/** The manifest written to the workspace for CI and for humans to read. */
export function protectedManifest(spec) {
  const fromSpec = [
    ...spec.agents.filter((a) => a.protected).map((a) => `agent:${a.name}`),
    ...spec.skills.filter((s) => s.protected).map((s) => `skill:${s.name}`),
  ];
  return {
    note:
      'Paths and artifacts the evolution loop may not modify. The paths list is hard-coded in ' +
      'src/evolve/protected.js and cannot be widened from fleet.yaml — a mutation must not be able to ' +
      'grant itself permission. Enforced in-process by the patch API and again, out of process, by CI.',
    why:
      'An optimizer with write access to its own scorecard edits the scorecard: the Darwin Godel Machine ' +
      'deleted the marker tokens its reward function counted rather than fix the behaviour they measured. ' +
      'Do not remove entries from this list to make a build pass.',
    paths: HARD_PROTECTED,
    artifacts: fromSpec,
    caps: CAPS,
  };
}

/**
 * Which of `changed` are protected. Used by CI against a branch diff.
 *
 * Glob support is deliberately limited to the two forms actually used —
 * trailing `/**` and exact paths. A general glob engine would be a dependency
 * and a source of subtle mismatches in a check that must not be subtle.
 */
export function violations(changedPaths, patterns = HARD_PROTECTED) {
  const hits = [];
  for (const file of changedPaths) {
    const normalized = String(file).trim().replace(/^\.\//, '');
    if (!normalized) continue;
    for (const pattern of patterns) {
      if (matches(normalized, pattern)) {
        hits.push({ file: normalized, pattern });
        break;
      }
    }
  }
  return hits;
}

function matches(file, pattern) {
  if (pattern.endsWith('/**')) return file.startsWith(pattern.slice(0, -2));
  return file === pattern;
}

/** Refuse an over-long artifact at patch time, with the cap in the message. */
export function assertWithinCaps(kind, text, where = '') {
  const cap = kind === 'skill' ? CAPS.skillLines : CAPS.agentLines;
  const lines = String(text ?? '').split('\n').length;
  if (lines > cap) {
    throw new Error(
      `${where}${where ? ': ' : ''}${kind} body is ${lines} lines; the cap is ${cap}. ` +
        'Length limits stop learned context from overfitting to the runs that produced it — ' +
        'cut the body, do not raise the cap.'
    );
  }
}
