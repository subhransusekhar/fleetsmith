import fs from 'node:fs';
import path from 'node:path';

/**
 * Promotion — turning a surviving candidate into a merged generation, and
 * learning from what the human says about it.
 *
 * The hard part here is not the mechanics, it is the human. Defence-in-depth
 * literature on self-modifying systems flags **automation bias**: reviewers
 * miss subtle bad changes when the model is right most of the time, and the
 * effect is accelerated by volume. Any design that produces a steady stream of
 * approvals decays into rubber-stamping, at which point the human gate is
 * theatre and the system is effectively unsupervised.
 *
 * So three rules shape this module:
 *
 *  1. **Few, ranked, confidence-scored.** Proposals are presented one at a
 *     time, ordered by measured eval delta times stated confidence — not by
 *     recency, and not all at once.
 *  2. **Auto-apply only what a validator fully decides.** Ops whose
 *     correctness is mechanically checkable never reach a human at all, which
 *     keeps the review queue short enough to actually read.
 *  3. **Learn from rejections.** Categories the user keeps declining are
 *     deprioritized in later proposals. This is the second-order loop from
 *     `claude-improve`: the improver learns which of its own suggestions are
 *     worth making, which is the only mechanism here that actually reduces
 *     review volume over time rather than just capping it.
 *
 * Canary: a merged generation stays provisional until later runs confirm no
 * gate-block regression against the health baseline. `git revert` of the
 * generation tag is the rollback — the thing SkillOps and SkillOS explicitly
 * lack, and which we get for free by being file-based and git-versioned.
 */

/** Ops applied without asking, because a validator fully decides them. */
export const AUTO_APPLY = new Set(['update-bullet-counter', 'add-validator']);

const DECISIONS = 'evolution/decisions.jsonl';

export function decisionsPath(spec) {
  return path.join(spec.fleet.shared, DECISIONS);
}

/**
 * Rank surviving proposals for review.
 *
 * delta x confidence, because a large improvement proposed with low confidence
 * and a marginal one proposed with high confidence are genuinely different
 * asks, and the reviewer's attention is the scarce resource being allocated.
 * Categories the user has been rejecting are pushed down.
 */
export function rankProposals(proposals, history = []) {
  const penalty = rejectionRates(history);
  return [...proposals]
    .map((p) => {
      const confidence = avg(p.ops.map((o) => (typeof o.confidence === 'number' ? o.confidence : 0.5)));
      const delta = p.delta?.delta ?? 0;
      const rejectionPenalty = avg(p.ops.map((o) => penalty.get(o.op) ?? 0));
      return { ...p, score: delta * confidence * (1 - rejectionPenalty), confidence, rejectionPenalty };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Per-op rejection rate from the decision log, used both to rank and to tell
 * the proposer what not to bother suggesting.
 *
 * Requires a minimum sample: two rejections out of two is not evidence that a
 * category is unwanted, and treating it as such would let one bad afternoon
 * permanently disable an op.
 */
export function rejectionRates(history, minSamples = 3) {
  const seen = new Map();
  for (const d of history) {
    for (const op of d.ops ?? []) {
      const rec = seen.get(op) ?? { total: 0, rejected: 0 };
      rec.total++;
      if (d.verdict === 'reject') rec.rejected++;
      seen.set(op, rec);
    }
  }
  const rates = new Map();
  for (const [op, rec] of seen) {
    if (rec.total >= minSamples) rates.set(op, rec.rejected / rec.total);
  }
  return rates;
}

export function readDecisions(spec, cwd = '.') {
  const file = path.join(cwd, decisionsPath(spec));
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

/** Append-only, one record per line — the format that merges across developers. */
export function recordDecision(spec, decision, cwd = '.') {
  const file = path.join(cwd, decisionsPath(spec));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(decision)}\n`);
  return file;
}

/**
 * What the proposer is told about past decisions.
 *
 * Deliberately terse and only about *categories*, never about specific past
 * content: the point is to stop suggesting kinds of change the user does not
 * want, not to teach the model to imitate previously accepted text.
 */
export function decisionDigest(history) {
  if (history.length === 0) return '';
  const rates = rejectionRates(history);
  const declined = [...rates.entries()].filter(([, r]) => r >= 0.5).map(([op]) => op);
  if (declined.length === 0) return '';
  return [
    '',
    '## Reviewer history',
    '',
    `The reviewer has consistently declined these operation types: ${declined.join(', ')}.`,
    'Do not propose them unless the evidence is unusually strong, and say why it differs from previous cases.',
  ].join('\n');
}

/**
 * Canary status for a merged generation.
 *
 * A generation is provisional until N runs have completed without gate-block
 * regression against the baseline captured at merge. This is the stage that
 * catches what CI could not: a change that passes every deterministic check
 * and still makes real runs worse.
 */
export function canaryStatus(baseline, current, { runsRequired = 3 } = {}) {
  const runsSince = (current.runs ?? 0) - (baseline.runs ?? 0);
  const before = baseline.aggregate ?? 0;
  const after = current.aggregate ?? 0;
  // aggregate is a badness score: lower is healthier.
  const regressed = after > before;

  if (regressed) {
    return {
      state: 'regressed',
      runsSince,
      detail: `harness health worsened (${before} -> ${after}); revert the generation tag`,
    };
  }
  if (runsSince < runsRequired) {
    return { state: 'provisional', runsSince, detail: `${runsSince}/${runsRequired} runs since promotion` };
  }
  return { state: 'confirmed', runsSince, detail: `${runsSince} runs with no regression` };
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
