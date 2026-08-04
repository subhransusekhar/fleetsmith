import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { computeHealth } from '../health/index.js';
import { runQa } from '../qa/index.js';
import { runEval, classifyDelta } from '../eval/index.js';
import { applyOps, PatchError } from './patch.js';
import { violations, CAPS } from './protected.js';
import { AUTO_APPLY, decisionDigest, readDecisions } from './promote.js';
import { parsePlaybook, renderPlaybook, addBullet, bump } from '../playbook/index.js';

/**
 * The evolution loop: OBSERVE -> EVALUATE -> MUTATE -> VALIDATE -> PROMOTE.
 *
 * Every earlier task exists to feed this one, and the ordering was not
 * incidental: without a gate (qa) and a fitness signal (eval), a loop like this
 * optimizes against agent self-assessment, which the orchestrator playbook
 * already warns against.
 *
 * Shape borrowed from GEPA (arXiv 2507.19457):
 *  - reflect over **rich textual feedback** — validator errors, QA findings
 *    with file:line, failing eval cases, gate-block reasons — serialized before
 *    being collapsed into a scalar. The proposer needs to see *why* something
 *    failed, not merely that a number moved.
 *  - round-robin across modules so every agent gets attention, not just the
 *    loudest one.
 *
 * Bounded by Decagon's production findings: one frontier-model call per
 * candidate, length caps encoded in the proposal prompt rather than trimmed
 * afterwards, and a deliberately small corpus.
 *
 * Safety posture, in order of how much it matters:
 *  1. `--propose` is the default. Nothing merges without a human unless every
 *     op is on the auto-apply whitelist.
 *  2. All work happens on a `fleet-evolve/*` branch. `main` is never touched.
 *  3. A candidate must clear qa, then eval stage 1, then a paired stage-2
 *     comparison exceeding the measured noise floor. Any failure deletes the
 *     branch and records the full failure text — the failure corpus is
 *     training signal, and systems that keep only successes learn less.
 *  4. The proposer is injected, so the loop is testable without a model and
 *     cannot silently acquire a network dependency.
 */

export async function evolve(spec, opts = {}) {
  const {
    specFile,
    cwd = process.cwd(),
    budget = 1,
    apply = false,
    propose,
    git = realGit(cwd),
    runId = `evolve-${Date.now()}`,
    force = false,
  } = opts;

  if (typeof propose !== 'function') throw new Error('evolve requires a proposer');

  const log = [];
  const say = (m) => {
    log.push(m);
    return m;
  };

  // A dirty tree means a candidate's diff would carry unrelated work into a
  // proposal, and a rejected candidate's cleanup could destroy it.
  if (!force && git.isDirty()) {
    return { status: 'blocked', reason: 'working tree has uncommitted changes', log };
  }

  // --- OBSERVE ---------------------------------------------------------------
  const runsDir = path.join(cwd, spec.fleet.local, 'runs');
  // The loop keeps its OWN baseline, separate from `fleetsmith health`'s
  // report. They answer different questions — "what changed since anyone last
  // looked" versus "what changed since the loop last considered acting" — and
  // sharing one file means an operator running a read-only report silently
  // disables the loop until something else moves.
  const healthPath = path.join(cwd, spec.fleet.local, 'health.evolved.json');
  const previous = fs.existsSync(healthPath) ? readJson(healthPath) : null;
  const health = computeHealth(spec, { runsDir, previous });

  // Record the baseline before deciding, so a run that exits early still moves
  // the mark and does not re-report the same delta forever.
  const persistBaseline = () => {
    fs.mkdirSync(path.dirname(healthPath), { recursive: true });
    fs.writeFileSync(healthPath, `${JSON.stringify(health, null, 2)}\n`);
  };

  if (!health.maintenanceNeeded) {
    persistBaseline();
    // SkillOps' early exit. A loop that re-derives "nothing changed" on every
    // invocation is a loop that costs money to stand still.
    say(`no maintenance needed (ΔH ${health.deltaH ?? 0}); nothing to evolve`);
    return { status: 'skipped', health, log };
  }

  const qa = runQa(spec, { builtDir: cwd, playbooks: allPlaybooks(cwd, spec) });
  const evalResult = runEval(spec, { stage: 2, fleetsDir: opts.fleetsDir ?? null });

  // --- SELECT ----------------------------------------------------------------
  const candidates = selectTargets(spec, health);
  if (candidates.length === 0) {
    say('nothing evolvable: every agent and skill is protected');
    return { status: 'skipped', health, log };
  }

  // What the reviewer has been declining. Feeding this back is the only
  // mechanism that reduces review volume over time rather than just capping it.
  const digest = decisionDigest(readDecisions(spec, cwd));

  const proposals = [];
  for (const target of candidates.slice(0, budget)) {
    const playbook = target.kind === 'playbook' ? loadPlaybook(cwd, spec, target.name) : [];
    // The proposer needs to know whether there is anything to count, not just
    // which ops exist in the abstract.
    const enriched = { ...target, hasBullets: playbook.length > 0 };
    const dossier = buildDossier({ spec, target: enriched, health, qa, evalResult, runsDir, playbook });

    let ops;
    try {
      ops = await propose({ target: enriched, dossier: dossier + digest, caps: CAPS, spec });
    } catch (e) {
      say(`proposer failed for ${target.name}: ${e.message}`);
      continue;
    }
    if (!Array.isArray(ops) || ops.length === 0) {
      say(`no ops proposed for ${target.name}`);
      continue;
    }

    const outcome = await tryCandidate({ spec, specFile, cwd, git, runId, target, ops, evalResult, opts });
    say(outcome.summary);
    proposals.push(outcome);
  }

  persistBaseline();
  const survivors = proposals.filter((p) => p.accepted);
  const autoApplied = apply ? survivors.filter((p) => p.ops.every((o) => AUTO_APPLY.has(o.op))) : [];

  return { status: 'done', health, proposals, survivors, autoApplied, log };
}

/**
 * Evolvable modules, most-broken first.
 *
 * Round-robin is the GEPA default so no module is starved, but a fleet with a
 * clearly failing agent should not spend its budget elsewhere first — so the
 * order is by failure risk, and the caller's budget decides how far down it
 * gets. Protected artifacts are excluded here as well as in the patch API;
 * this is the cheap filter, not the guarantee.
 */
export function selectTargets(spec, health) {
  const targets = [];
  for (const skill of spec.skills) {
    if (skill.protected) continue;
    targets.push({ kind: 'skill', name: skill.name, risk: 1 - (health.skills[skill.name]?.utility ?? 1) });
  }
  for (const agent of spec.agents) {
    const risk = health.agents[agent.name]?.failureRisk ?? 0;
    // A protected agent's DEFINITION is immutable, but a learned note is not
    // part of that definition: it lives in its own file, is advisory, capped,
    // and needs review before it lands. Without this the loop is unreachable
    // on every fleet that exists — `init` produces nothing machine-authored,
    // so nothing would ever be evolvable and the loop could never begin.
    // Invariant 1 exists to stop the loop editing its referee and rewriting
    // human-authored definitions; it is not served by making the loop inert.
    targets.push(agent.protected ? { kind: 'playbook', name: agent.name, risk } : { kind: 'agent', name: agent.name, risk });
  }
  return targets.sort((a, b) => b.risk - a.risk);
}

/** Ops a target of each kind may legally receive. */
const LEGAL_OPS = {
  playbook: new Set(['add-playbook-bullet', 'update-bullet-counter']),
};

/**
 * The reflection dossier: raw failure text, not summaries.
 *
 * This is GEPA's central claim and the reason the loop can work at all on a
 * small corpus — a proposer that sees "score dropped 4pp" can only guess,
 * while one that sees the validator error and the failing case knows what to
 * change.
 */
export function buildDossier({ spec, target, health, qa, evalResult, runsDir, playbook = [] }) {
  const lines = [];
  lines.push(`# Evolution dossier — ${target.kind} "${target.name}"`);
  lines.push('');
  lines.push('## Current definition');
  const current =
    target.kind === 'skill'
      ? spec.skills.find((s) => s.name === target.name)
      : spec.agents.find((a) => a.name === target.name);
  lines.push('```yaml');
  lines.push(JSON.stringify(current, null, 2));
  lines.push('```');

  lines.push('');
  lines.push('## Health');
  lines.push('```json');
  lines.push(JSON.stringify(target.kind === 'skill' ? health.skills[target.name] : health.agents[target.name], null, 2));
  lines.push('```');

  const qaFailures = qa.checks.filter((c) => !c.pass);
  if (qaFailures.length) {
    lines.push('');
    lines.push('## Failing verification checks (verbatim)');
    for (const c of qaFailures) {
      lines.push(`- ${c.name}`);
      for (const e of c.evidence) lines.push(`    ${e}`);
    }
  }

  const evalFailures = evalResult.cases.filter((c) => !c.pass);
  if (evalFailures.length) {
    lines.push('');
    lines.push('## Failing eval cases (verbatim)');
    for (const c of evalFailures) lines.push(`- [${c.suite}] ${c.name} — ${c.detail}`);
  }

  if (target.kind === 'playbook') {
    lines.push('');
    lines.push('## Current learned notes');
    if (playbook.length === 0) {
      // Without this the proposer cannot know that counter ops are impossible,
      // and will propose them against bullets that do not exist.
      lines.push('(none yet — this playbook is empty, so only add-playbook-bullet is possible)');
    } else {
      for (const b of playbook) lines.push(`- [${b.id}] (+${b.helpful}/-${b.harmful}) ${b.text}`);
    }
  }

  const runEvents = recentEvents(runsDir, target.name);
  if (runEvents.length) {
    lines.push('');
    lines.push('## Recent run events for this target (verbatim)');
    for (const e of runEvents) lines.push(`- ${e.event}: ${e.detail || '(no detail)'}`);
  }

  return lines.join('\n');
}

function allPlaybooks(cwd, spec) {
  const out = {};
  for (const a of spec.agents) {
    const b = loadPlaybook(cwd, spec, a.name);
    if (b.length) out[a.name] = b;
  }
  return out;
}

function loadPlaybook(cwd, spec, agent) {
  const file = path.join(cwd, spec.fleet.shared, 'playbooks', `${agent}.md`);
  return fs.existsSync(file) ? parsePlaybook(fs.readFileSync(file, 'utf8')) : [];
}

function recentEvents(runsDir, name, limit = 20) {
  if (!fs.existsSync(runsDir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(runsDir)) {
    const file = path.join(runsDir, entry, 'events.jsonl');
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.agent === name && ['gate_block', 'execute_tool_error', 'feedback'].includes(e.event)) out.push(e);
      } catch {
        /* a truncated in-flight line must not break the dossier */
      }
    }
  }
  return out.slice(-limit);
}

/**
 * Apply one candidate on a branch and run it up the validation ladder.
 * Returns without leaving a branch behind unless the candidate survived.
 */
async function tryCandidate({ spec, specFile, cwd, git, runId, target, ops, evalResult, opts }) {
  const branch = `fleet-evolve/${runId}-${target.name}`;
  const source = fs.readFileSync(specFile, 'utf8');

  // Contract changes are never auto-proposed; a proposer emitting one is a
  // proposer that misread its instructions.
  // A playbook target may only receive playbook ops — anything else would be
  // an edit to a protected definition arriving through the back door.
  const allowed = LEGAL_OPS[target.kind];
  if (allowed) {
    const outside = ops.filter((o) => !allowed.has(o.op));
    if (outside.length) {
      const names = outside.map((o) => o.op).join(', ');
      return {
        target,
        ops,
        accepted: false,
        reason: `proposed ${names} against a protected definition`,
        summary: `${target.name}: rejected — ${names} may not be applied to a protected definition`,
      };
    }
    return tryPlaybookCandidate({ spec, cwd, git, runId, target, ops });
  }

  const illegal = ops.filter((o) => o.op === 'contract-change');
  if (illegal.length) {
    return { target, ops, accepted: false, reason: 'proposed a contract change', summary: `${target.name}: rejected — proposed a contract change, which is human-reviewed only` };
  }

  let patched;
  try {
    ({ source: patched } = applyOps(source, ops));
  } catch (e) {
    const why = e instanceof PatchError ? e.message : `${e}`;
    return { target, ops, accepted: false, reason: why, summary: `${target.name}: rejected at patch — ${why}` };
  }

  git.createBranch(branch);
  try {
    fs.writeFileSync(specFile, patched);

    // Regenerate, then check that what the loop produced is still a harness.
    opts.build?.(specFile);

    const changed = git.changedFiles();
    const hits = violations(changed);
    if (hits.length) {
      // Belt and braces: the patch API already refuses protected targets, but
      // a build could in principle write somewhere it should not.
      return abort(git, branch, source, specFile, {
        target,
        ops,
        reason: `touched protected paths: ${hits.map((h) => h.file).join(', ')}`,
      });
    }

    const newSpec = opts.reload(specFile);
    const qa2 = runQa(newSpec, { builtDir: cwd, playbooks: allPlaybooks(cwd, spec) });
    if (!qa2.pass) {
      const failed = qa2.checks.filter((c) => !c.pass);
      return abort(git, branch, source, specFile, {
        target,
        ops,
        reason: `qa failed: ${failed.map((c) => `${c.name} (${c.evidence[0] ?? ''})`).join('; ')}`,
      });
    }

    const smoke = runEval(newSpec, { stage: 1, fleetsDir: opts.fleetsDir ?? null });
    if (!smoke.pass) {
      return abort(git, branch, source, specFile, {
        target,
        ops,
        reason: `eval stage 1 failed: ${smoke.cases.filter((c) => !c.pass).map((c) => c.name).join(', ')}`,
      });
    }

    const paired = runEval(newSpec, { stage: 2, fleetsDir: opts.fleetsDir ?? null, baseline: evalResult });
    const verdict = classifyDelta(paired.delta.delta, opts.noise ?? null);
    if (paired.delta.broken.length > 0) {
      return abort(git, branch, source, specFile, {
        target,
        ops,
        reason: `regressed: ${paired.delta.broken.join(', ')}`,
      });
    }
    if (verdict.verdict === 'no signal' && paired.delta.fixed.length === 0) {
      return abort(git, branch, source, specFile, {
        target,
        ops,
        reason: `no measurable improvement (delta ${paired.delta.delta.toFixed(3)} within noise floor ${verdict.floor})`,
      });
    }

    const proposal = writeProposal({ cwd, spec, runId, target, ops, paired, verdict, branch });
    git.commit(`evolve(${target.name}): ${ops.map((o) => o.op).join(', ')}`);
    git.returnToBase?.();
    return {
      target,
      ops,
      accepted: true,
      branch,
      proposal,
      delta: paired.delta,
      summary: `${target.name}: accepted on ${branch} (${paired.delta.fixed.length} fixed, delta ${paired.delta.delta.toFixed(3)})`,
    };
  } catch (e) {
    return abort(git, branch, source, specFile, { target, ops, reason: `error: ${e.message}` });
  }
}

/**
 * Playbook candidates take a shorter ladder: a bullet cannot break the build,
 * so there is nothing to compile or re-verify. What it can do is degrade
 * behaviour, which is why it is capped, framed as advisory, and still needs
 * human review — `add-playbook-bullet` is deliberately off the auto-apply
 * whitelist.
 */
function tryPlaybookCandidate({ spec, cwd, git, runId, target, ops }) {
  const branch = `fleet-evolve/${runId}-${target.name}-playbook`;
  const file = path.join(cwd, spec.fleet.shared, 'playbooks', `${target.name}.md`);
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;

  git.createBranch(branch);
  try {
    let bullets = before ? parsePlaybook(before) : [];
    const applied = [];
    for (const op of ops) {
      if (op.op === 'add-playbook-bullet') {
        const text = op.body ?? op.payload?.text ?? '';
        const res = addBullet(target.name, bullets, text);
        bullets = res.bullets;
        applied.push(res.added ? `added ${res.added}` : `merged into ${res.merged}`);
      } else {
        bullets = bump(bullets, op.payload?.id ?? op.target, op.payload?.kind ?? 'helpful');
        applied.push(`counted ${op.payload?.id}`);
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderPlaybook(target.name, bullets));

    const proposal = writePlaybookProposal({ cwd, spec, runId, target, ops, applied, branch });
    git.commit(`evolve(${target.name}): ${ops.map((o) => o.op).join(', ')}`);
    git.returnToBase?.();
    return {
      target,
      ops,
      accepted: true,
      branch,
      proposal,
      delta: { delta: 0, fixed: [], broken: [], comparable: 0 },
      summary: `${target.name}: learned note proposed on ${branch} (${applied.join('; ')})`,
    };
  } catch (e) {
    if (before === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, before);
    git.discardBranch(branch);
    return { target, ops, accepted: false, reason: e.message, summary: `${target.name}: rejected — ${e.message}` };
  }
}

function writePlaybookProposal({ cwd, spec, runId, target, ops, applied, branch }) {
  const dir = path.join(cwd, spec.fleet.shared, 'evolution/proposals');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId}-${target.name}-playbook.md`);
  fs.writeFileSync(
    file,
    [
      `# Proposal — learned note for "${target.name}"`,
      '',
      `- Branch: \`${branch}\``,
      `- Applied: ${applied.join('; ')}`,
      '',
      'This adds an **advisory** note to the agent\'s playbook. It does not modify',
      'the agent definition, which is human-authored and protected.',
      '',
      '## Rationale (as given by the proposer)',
      '',
      ...ops.map((o) => `- **${o.op}** — ${o.rationale ?? '(none given)'} (confidence: ${o.confidence ?? 'unstated'})`),
      '',
      '## Evidence',
      '',
      ...ops.flatMap((o) => (o.evidence ?? []).map((e) => `- ${e}`)),
      '',
      '## Review',
      '',
      'Learned notes are references, not rules, and accumulated memory measurably',
      'degrades alignment — so this is not auto-applied. Merge or delete the branch.',
    ].join('\n') + '\n'
  );
  return file;
}

/** Undo everything this candidate touched and record why it died. */
function abort(git, branch, source, specFile, { target, ops, reason }) {
  fs.writeFileSync(specFile, source);
  git.discardBranch(branch);
  return { target, ops, accepted: false, reason, summary: `${target.name}: rejected — ${reason}` };
}

function writeProposal({ cwd, spec, runId, target, ops, paired, verdict, branch }) {
  const dir = path.join(cwd, spec.fleet.shared, 'evolution/proposals');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId}-${target.name}.md`);
  const lines = [
    `# Proposal — ${target.kind} "${target.name}"`,
    '',
    `- Branch: \`${branch}\``,
    `- Ops: ${ops.map((o) => `\`${o.op}\``).join(', ')}`,
    `- Eval delta: ${paired.delta.delta.toFixed(3)} (${verdict.verdict}, noise floor ${verdict.floor})`,
    `- Fixed: ${paired.delta.fixed.join(', ') || '(none)'}`,
    `- Broken: ${paired.delta.broken.join(', ') || '(none)'}`,
    '',
    '## Rationale (as given by the proposer)',
    '',
    ...ops.map((o) => `- **${o.op}** — ${o.rationale ?? '(none given)'} (confidence: ${o.confidence ?? 'unstated'})`),
    '',
    '## Evidence',
    '',
    ...ops.flatMap((o) => (o.evidence ?? []).map((e) => `- ${e}`)),
    '',
    '## Review',
    '',
    'This branch is not merged. Review the diff, then merge or delete the branch.',
    'A merged generation stays provisional until the next runs confirm no regression.',
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Real git, isolated behind an interface so tests never shell out. */
export function realGit(cwd) {
  const run = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  // The base is captured ONCE, at construction. Re-reading it per candidate
  // meant that after one candidate was accepted (and left checked out), the
  // next branched off it — so proposals were not independent and a diff
  // carried the previous candidate's changes.
  const base = run('rev-parse', '--abbrev-ref', 'HEAD');
  return {
    base,
    isDirty: () => run('status', '--porcelain').length > 0,
    current: () => run('rev-parse', '--abbrev-ref', 'HEAD'),
    createBranch(branch) {
      run('switch', '-c', branch, base);
    },
    /** Leave the branch intact but return HEAD to where the user was. */
    returnToBase() {
      run('switch', base);
    },
    changedFiles: () => run('status', '--porcelain').split('\n').filter(Boolean).map((l) => l.slice(3)),
    commit(message) {
      run('add', '-A');
      run('commit', '-m', message);
    },
    discardBranch(branch) {
      run('checkout', '--', '.');
      run('clean', '-fd');
      run('switch', base);
      run('branch', '-D', branch);
    },
  };
}
