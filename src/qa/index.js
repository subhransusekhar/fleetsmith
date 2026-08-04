import fs from 'node:fs';
import path from 'node:path';
import { validateSpec } from '../spec/validate.js';
import { lintSpec } from '../spec/lint.js';
import { ADAPTERS, DEFAULT_TARGETS, buildAll } from '../adapters/index.js';

/**
 * The deterministic verification battery — the EVALUATE stage's gate.
 *
 * The same checks previously lived as prose in the `harness-verification`
 * skill, executed by an agent. Two problems with that: CI cannot run prose,
 * and a fleet's only enforced gate (the Claude Code SubagentStop hook) covers
 * exactly one of three targets. Promotion gates therefore live here, in the
 * CLI, where they are target-independent and machine-checkable.
 *
 * Design rule, from the verifier-bottleneck result: a weaker verifier cannot
 * reliably assess a stronger candidate, so verifier quality caps how far any
 * self-improvement loop can go. Everything in this module is deterministic —
 * no LLM calls, no judgment. A judge may advise (see `eval --judge`) but must
 * never gate. Treat a false PASS here as a safety bug, not a quality bug: it
 * is the path by which a bad mutation reaches main.
 */

/** One check's outcome. `evidence` entries are `file:line`-style strings. */
function result(name, pass, evidence = [], detail = '') {
  return { name, pass, evidence, detail };
}

/**
 * Run every check. `builtDir` (optional) enables drift detection: the spec is
 * recompiled and compared against what is actually on disk.
 */
export function runQa(spec, { builtDir = null, targets = DEFAULT_TARGETS } = {}) {
  const checks = [];

  checks.push(checkSpecGate(spec));
  checks.push(checkLint(spec));
  for (const target of targets) checks.push(checkCompiles(spec, target));
  checks.push(checkHandoffGraph(spec));
  checks.push(checkCapabilityLeaks(spec));
  checks.push(checkLoopBounds(spec));
  checks.push(checkOriginMarkers(spec));
  if (builtDir) checks.push(checkDrift(spec, builtDir));

  return { checks, pass: checks.every((c) => c.pass) };
}

/** Spec gate: structural validation. Errors block; warnings do not. */
function checkSpecGate(spec) {
  const { errors, warnings } = validateSpec(spec);
  return result(
    'spec gate (validate)',
    errors.length === 0,
    errors,
    warnings.length ? `${warnings.length} warning(s)` : ''
  );
}

/** Design smells. Lint errors (e.g. parallel writers) are hard failures. */
function checkLint(spec) {
  const { errors, warnings } = lintSpec(spec);
  return result(
    'design lint',
    errors.length === 0,
    errors,
    warnings.length ? `${warnings.length} warning(s)` : ''
  );
}

/**
 * Compile gate: every target must produce output without throwing. An adapter
 * that throws on a valid spec is how a fleet silently loses a target.
 */
function checkCompiles(spec, target) {
  const build = ADAPTERS[target];
  if (!build) return result(`compile: ${target}`, false, [`unknown target "${target}"`]);
  try {
    const out = build(spec, {});
    const count = out.files.size;
    return result(`compile: ${target}`, count > 0, count > 0 ? [] : ['produced no files'], `${count} files`);
  } catch (e) {
    return result(`compile: ${target}`, false, [e.message]);
  }
}

/**
 * Handoff graph, checked against the COMPILED output rather than the spec.
 * validateSpec already rejects unknown handoff targets; what it cannot see is
 * an edge that survives validation but whose receiver never gets a file — the
 * failure mode that produces an agent nobody can delegate to at runtime.
 */
function checkHandoffGraph(spec) {
  const evidence = [];
  const built = buildAll(spec, {});
  const emitted = new Set(
    [...built.files.keys()]
      .filter((p) => /^\.(claude|opencode)\/agents\//.test(p))
      .map((p) => path.basename(p, '.md'))
  );

  for (const agent of spec.agents) {
    for (const to of agent.handoff.to) {
      if (!spec.agents.some((a) => a.name === to)) {
        evidence.push(`${agent.name} hands off to unknown agent "${to}"`);
      } else if (!emitted.has(to) && to !== spec.orchestrator.name) {
        evidence.push(`${agent.name} hands off to "${to}", which no adapter emitted an agent file for`);
      }
    }
    // An agent that receives nothing and is not in a phase is unreachable.
    const isReceiver = spec.agents.some((a) => a.handoff.to.includes(agent.name));
    const inPhase = (spec.orchestrator.phases ?? []).some((p) => (p.agents ?? []).includes(agent.name));
    if (!isReceiver && !inPhase && agent.name !== spec.orchestrator.name) {
      evidence.push(`${agent.name} is unreachable: no incoming handoff and not in any phase`);
    }
  }
  return result('handoff graph (compiled)', evidence.length === 0, evidence);
}

/**
 * Capability leak: a generated agent must not be granted a tool its declared
 * capabilities do not imply. Checked on emitted frontmatter, because the leak
 * that matters is the one in the file the tool actually reads.
 */
function checkCapabilityLeaks(spec) {
  const evidence = [];
  const built = ADAPTERS['claude-code'](spec, {});
  const GATED = [
    { tool: 'Bash', cap: 'run' },
    { tool: 'Write', cap: 'edit' },
    { tool: 'Edit', cap: 'edit' },
    { tool: 'WebSearch', cap: 'web' },
    { tool: 'WebFetch', cap: 'web' },
  ];

  for (const agent of spec.agents) {
    const body = built.files.get(`.claude/agents/${agent.name}.md`);
    if (!body) continue;
    const tools = (body.match(/^tools:\s*(.*)$/m)?.[1] ?? '').split(',').map((t) => t.trim());
    for (const { tool, cap } of GATED) {
      if (tools.includes(tool) && !agent.capabilities[cap]) {
        evidence.push(`.claude/agents/${agent.name}.md: grants ${tool} without capability "${cap}"`);
      }
    }
  }
  return result('capability leaks', evidence.length === 0, evidence);
}

/**
 * Every iteration loop needs all three stop conditions. A loop with only a
 * success condition runs until the turn cap when the condition never becomes
 * true, which is the expensive way to discover a bad exit criterion.
 */
function checkLoopBounds(spec) {
  const evidence = [];
  for (const [i, phase] of (spec.orchestrator.phases ?? []).entries()) {
    if (!phase.loop) continue;
    const where = `orchestrator.phases[${i}] (${phase.name})`;
    if (!phase.loop.max || phase.loop.max < 1) evidence.push(`${where}: loop has no positive max`);
    if (!phase.loop.until) evidence.push(`${where}: loop has no exit condition (until)`);
    if (!phase.loop.noProgress) evidence.push(`${where}: loop has no no-progress bound`);
  }
  return result('loop bounds', evidence.length === 0, evidence);
}

/**
 * Provenance cross-check: every generated artifact's origin marker must match
 * the spec. This is what stops machine-authored content from being laundered
 * into a human-marked artifact, which would place it outside the evolution
 * loop's protected set while still being machine-written.
 */
function checkOriginMarkers(spec) {
  const evidence = [];
  const built = ADAPTERS['claude-code'](spec, {});
  for (const agent of spec.agents) {
    const declared = agent.origin ?? 'human';
    const body = built.files.get(`.claude/agents/${agent.name}.md`);
    if (!body) continue;
    const marked = body.match(/^x-fleetsmith-origin:\s*(\S+)$/m)?.[1];
    // The field is optional until T2 lands; only a MISMATCH is a failure.
    if (marked && marked !== declared) {
      evidence.push(`.claude/agents/${agent.name}.md: origin "${marked}" != spec "${declared}"`);
    }
  }
  return result('origin markers', evidence.length === 0, evidence);
}

/**
 * Drift: recompile the spec and compare against what is on disk. This makes
 * the harness-verification skill's fuzzy "detect drift between a fleet.yaml
 * and the files it generated" claim exact — a hand-edited generated file is
 * caught with the path that differs.
 *
 * Preserve-class files are skipped by design: they are seeded once and then
 * owned by the running fleet, so divergence there is the feature.
 */
function checkDrift(spec, builtDir) {
  const evidence = [];
  const built = buildAll(spec, {});
  for (const [rel, content] of built.files) {
    if (built.preserved.has(rel)) continue;
    const abs = path.join(builtDir, rel);
    if (!fs.existsSync(abs)) {
      evidence.push(`${rel}: missing on disk (run \`fleetsmith build\`)`);
      continue;
    }
    const onDisk = fs.readFileSync(abs, 'utf8');
    if (onDisk !== content) {
      evidence.push(`${rel}:1: differs from the spec (hand-edited, or the build is stale)`);
    }
  }
  return result('drift vs built output', evidence.length === 0, evidence);
}

/** Human-readable report. Returns the text; the CLI decides the exit code. */
export function formatQa({ checks, pass }) {
  const lines = [];
  for (const c of checks) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    lines.push(`${tag}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    for (const e of c.evidence) lines.push(`        ${e}`);
  }
  lines.push('');
  lines.push(pass ? 'qa: PASS' : `qa: FAIL (${checks.filter((c) => !c.pass).length} check(s))`);
  return lines.join('\n');
}
