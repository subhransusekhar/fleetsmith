import { FileSet } from '../lib/fs-utils.js';
import { title, isVerifier } from '../compile/agent-prompt.js';
import { claudeAgentFiles } from './claude-code.js';
import { DEFAULT_HANDOFF_SCHEMA } from '../spec/schema.js';

/**
 * Claude Code dynamic workflows — EXPERIMENTAL fourth target.
 *
 * Emits `.claude/workflows/<orchestrator>.js`: the same phase graph the
 * orchestrator skill describes in prose, expressed as a script that actually
 * executes it.
 *
 * Why this exists at all. The skill orchestrator asks a model to follow a
 * playbook: read the phases, invoke the right agents in the right order,
 * remember the gates. That works, but the sequencing lives in a context window
 * alongside everything else, and every intermediate result the model carries
 * forward is context it cannot spend on the actual work. A workflow moves the
 * control flow into JavaScript — loops are loops, phase order is program
 * order, and intermediate results sit in variables instead of the transcript.
 *
 * What it deliberately does NOT change: agents still write handoff files and
 * ledger rows. The file protocol remains the audit trail and the resume point,
 * because a workflow run that dies mid-phase should leave the same recoverable
 * state a skill-driven run does.
 *
 * Relationship to the other targets: additive. The workflow drives the same
 * `.claude/agents/` definitions the claude-code target emits, via `agentType`,
 * so prompts, tools, and model tiers are defined in exactly one place. Those
 * definitions are emitted here too (from the shared emitter, so the content is
 * identical) — otherwise a standalone `--target claude-workflow` build would
 * produce a script that throws on its first agent call.
 *
 * Constraints worth knowing before editing this file:
 *  - Workflow scripts are plain JavaScript, not TypeScript.
 *  - `meta` must be the first statement and a pure literal — no variables,
 *    calls, or interpolation. Discovery registers the workflow under
 *    `meta.name`, not the filename, so the two must agree.
 *  - There is no filesystem or Node API access inside a script, so a shell
 *    `check` cannot be run by the script itself — an agent runs it and reports
 *    the result back through a schema.
 *  - `Date.now()`, `Math.random()` and argless `new Date()` throw, since they
 *    would break run resumption. Anything that varies the prompt text between
 *    runs also destroys the resume cache, which is why every prompt here is
 *    built deterministically from the spec.
 *  - `parallel()` takes thunks, not promises, and `phase:` must be passed in
 *    each agent's opts inside a fan-out — the global `phase()` cursor races
 *    when calls are concurrent.
 */

// Same rule as the claude-code target: a tier becomes a concrete model only for
// the tiers the author actually named in `defaults.claudeModels`. Omitting
// `model` from the opts lets the agent definition — and ultimately the session —
// decide, instead of the workflow overriding both.
const EFFORT_MAP = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', max: 'max' };

export function buildClaudeWorkflow(spec, options = {}) {
  const out = new FileSet();

  // The script's filename and `meta.name` must agree: discovery registers the
  // workflow under meta.name, so a mismatch loads fine and then is invocable
  // under a name that does not match the file anyone would go looking in.
  out.add(`.claude/workflows/${spec.orchestrator.name}.js`, workflowScript(spec));

  // `agentType` resolves against the same registry the Agent tool uses, so the
  // agent definitions must exist on disk or the first agent() call fails with
  // "agent type not found". Emitting them here means this target produces
  // something runnable on its own rather than only alongside `--target
  // claude-code`; the shared emitter guarantees identical content either way.
  if (options.agentDefinitions !== false) {
    for (const [p, content] of claudeAgentFiles(spec)) out.add(p, content);
  }

  if (options.readme !== false) {
    out.add(`${spec.fleet.workspace}/WORKFLOW.md`, workflowReadme(spec));
  }
  return out;
}

function workflowScript(spec) {
  const s = [];
  s.push(metaBlock(spec));
  s.push('');
  s.push(schemaBlock(spec));
  s.push('');
  s.push(preamble(spec));

  for (const [i, phase] of (spec.orchestrator.phases ?? []).entries()) {
    s.push('');
    s.push(phaseBlock(phase, i, spec));
  }

  s.push('');
  s.push(returnBlock(spec));
  return `${s.join('\n')}\n`;
}

/**
 * `meta` must be a pure literal — no variables, calls, or interpolation — so
 * everything here is JSON-serialized rather than templated.
 */
function metaBlock(spec) {
  const phases = (spec.orchestrator.phases ?? []).map((p) => ({
    title: p.name,
    detail: `${p.agents.join(', ')}${p.parallel && p.agents.length > 1 ? ' (parallel)' : ''}${p.loop ? ` — loops up to ${p.loop.max}x` : ''}`,
  }));
  const meta = {
    name: spec.orchestrator.name,
    description: `Run the ${spec.fleet.name} fleet${spec.fleet.domain ? ` for ${spec.fleet.domain}` : ''}.`,
    whenToUse: `Use for ${spec.orchestrator.trigger}, including re-runs and partial fixes.`,
    phases,
  };
  return `export const meta = ${JSON.stringify(meta, null, 2)}`;
}

function preamble(spec) {
  const dir = spec.handover.dir;
  const ledger = spec.handover.ledger ? `${spec.fleet.local}/LEDGER.md` : null;
  return [
    '// The request to run the fleet on. `args` is whatever the caller passed;',
    '// a bare string is the request itself.',
    "const request = typeof args === 'string' ? args : args?.request ?? 'Run the fleet on the current repository state.';",
    '',
    `const HANDOFF_DIR = ${JSON.stringify(dir)};`,
    ledger ? `const LEDGER = ${JSON.stringify(ledger)};` : '// no ledger configured for this fleet',
    '',
    '// Every agent gets the same framing: where the shared state lives, and the',
    '// reminder that its handoff file — not its reply — is what the next agent reads.',
    'const brief = (name, task, inputs) =>',
    '  [',
    `    \`You are the \${name} agent of the ${spec.fleet.name} fleet. Follow your agent definition.\`,`,
    '    `Request: ${request}`,',
    '    // In a refine loop the "upstream" file is the previous pass\'s output, so',
    '    // on the first pass it does not exist yet. Say so rather than sending the',
    '    // agent hunting for a file that was never written.',
    '    inputs.length ? `Read these upstream handoffs first, where they exist (on an initial pass some will not):\\n${inputs.map((p) => `- ${p}`).join(\'\\n\')}` : null,',
    '    task,',
    ledger
      ? '    `Write your handoff file(s) under ${HANDOFF_DIR}/ using the bundled template, and update your row in ${LEDGER}. The file is the durable artifact; your reply is only a summary of it.`,'
      : '    `Write your handoff file(s) under ${HANDOFF_DIR}/ using the bundled template. The file is the durable artifact; your reply is only a summary of it.`,',
    '  ]',
    '    .filter(Boolean)',
    '    .join(\'\\n\\n\');',
    '',
    '// Handoff paths are conventional, so the script can tell each agent exactly',
    '// which upstream files to read instead of making it search.',
    'const handoffPath = (from, to) => `${HANDOFF_DIR}/${from}-to-${to}.md`;',
    '',
    'const results = {};',
  ].join('\n');
}

function phaseBlock(phase, index, spec) {
  const lines = [];
  lines.push(`// ---------- Phase ${index + 1}: ${phase.name} ----------`);
  lines.push(`phase(${JSON.stringify(phase.name)})`);

  const body = phase.loop ? loopedPhase(phase, spec) : plainPhase(phase, spec);
  lines.push(body);

  if (phase.gate) {
    lines.push('');
    lines.push(`// Gate: ${phase.gate}`);
    lines.push(
      `const gate${index} = await agent(${JSON.stringify(
        `Check this gate before the fleet continues: ${phase.gate}\n\nInspect the artifacts under ${spec.handover.dir}/ and answer with evidence, not impressions.`
      )}, { label: 'gate:${slug(phase.name)}', phase: ${JSON.stringify(phase.name)}, schema: GATE_SCHEMA })`
    );
    lines.push(`if (gate${index} && !gate${index}.passed) {`);
    lines.push(`  log(\`Gate failed after ${phase.name}: \${gate${index}.reason}\`)`);
    lines.push(`  return { status: 'blocked', phase: ${JSON.stringify(phase.name)}, reason: gate${index}.reason, results }`);
    lines.push('}');
  }
  return lines.join('\n');
}

/** One or more agents, run concurrently when the phase says so. */
function plainPhase(phase, spec) {
  const calls = phase.agents.map((n) => agentCall(n, spec, phase));
  if (phase.agents.length === 1) {
    return `results[${JSON.stringify(phase.agents[0])}] = ${calls[0]}`;
  }
  if (phase.parallel) {
    const lines = [
      '// Independent within this phase: nothing here reads another\'s output.',
      `const ${varName(phase.name)} = await parallel([`,
      ...calls.map((c) => `  () => ${c.replace(/^await /, '')},`),
      '])',
    ];
    phase.agents.forEach((n, i) => {
      lines.push(`results[${JSON.stringify(n)}] = ${varName(phase.name)}[${i}]`);
    });
    return lines.join('\n');
  }
  return phase.agents.map((n, i) => `results[${JSON.stringify(n)}] = ${calls[i]}`).join('\n');
}

/**
 * A phase loop becomes a real `while`, with all three stop conditions the
 * prose version describes — success, no-progress, and the hard cap — as actual
 * control flow rather than instructions the model has to honor.
 */
function loopedPhase(phase, spec) {
  const loop = phase.loop;
  const v = varName(phase.name);
  const lines = [];
  lines.push(`let ${v}Pass = 0`);
  lines.push(`let ${v}Stale = 0`);
  lines.push(`let ${v}Feedback = null`);
  lines.push(`let ${v}Done = false`);
  lines.push('');
  lines.push(`while (${v}Pass < ${loop.max} && !${v}Done) {`);
  lines.push(`  ${v}Pass++`);
  lines.push(`  log(\`${phase.name}: pass \${${v}Pass}/${loop.max}\`)`);
  lines.push('');

  for (const n of phase.agents) {
    // A producer is told to fix the last pass's findings; a reviewer is told to
    // re-check them. Handing "fix these" to the agent that reported them is how
    // a refine loop turns into two agents arguing about whose job it was.
    const agent = spec.agents.find((a) => a.name === n);
    const framing =
      agent && isVerifier(agent, spec)
        ? `\`Findings you reported on the previous pass — confirm each is genuinely resolved, and do not re-report anything already fixed:\\n\${${v}Feedback}\``
        : `\`Findings from the previous pass — fix these specifically, do not restart from scratch:\\n\${${v}Feedback}\``;
    lines.push(
      `  results[${JSON.stringify(n)}] = ${agentCall(n, spec, phase, {
        extra: `${v}Feedback ? ${framing} : null`,
      })}`
    );
  }

  lines.push('');
  if (loop.check) {
    lines.push('  // Objective signal. The script cannot run shell itself, so an agent runs');
    lines.push('  // it and reports the verbatim output — which is what goes in the ledger.');
    lines.push(
      `  const ${v}Check = await agent(${JSON.stringify(
        `Run exactly this command and report the result:\n\n    ${loop.check}\n\nReport its exit status and the last ~40 lines of output verbatim. Do not fix anything, do not interpret — just run and report. If the command cannot run at all, say so and treat it as a failure.`
      )}, { label: 'check:${slug(phase.name)}', phase: ${JSON.stringify(phase.name)}, schema: CHECK_SCHEMA, model: 'haiku' })`
    );
    lines.push(`  ${v}Done = !!${v}Check?.passed`);
    lines.push(`  ${v}Feedback = ${v}Done ? null : ${v}Check?.output ?? 'the check did not run'`);
  } else {
    lines.push(
      `  const ${v}Verdict = await agent(${JSON.stringify(
        `Assess whether this exit condition now holds: ${loop.until || 'the phase output meets its acceptance criteria'}\n\nRead the artifacts under ${spec.handover.dir}/ and judge the result on its own terms. Cite file:line or a command and its output for each outstanding gap. Flag only what affects correctness or the stated requirements; if the work is sound, say so rather than inventing findings.`
      )}, { label: 'verdict:${slug(phase.name)}', phase: ${JSON.stringify(phase.name)}, schema: VERDICT_SCHEMA })`
    );
    lines.push(`  ${v}Done = !!${v}Verdict?.satisfied`);
    lines.push(`  ${v}Feedback = ${v}Done ? null : (${v}Verdict?.gaps ?? []).join('\\n')`);
  }

  lines.push('');
  lines.push('  // A pass that changed nothing will not start changing things on the next one.');
  lines.push(`  if (!${v}Done && ${v}Feedback === ${v}PrevFeedback) ${v}Stale++`);
  lines.push(`  else ${v}Stale = 0`);
  lines.push(`  ${v}PrevFeedback = ${v}Feedback`);
  lines.push(`  if (${v}Stale >= ${loop.noProgress}) {`);
  lines.push(`    log(\`${phase.name}: ${loop.noProgress} passes with no progress — stopping early\`)`);
  lines.push('    break');
  lines.push('  }');
  lines.push('}');
  lines.push('');
  lines.push(`if (!${v}Done) log(\`${phase.name} finished unsatisfied after \${${v}Pass} pass(es) — recorded as a gap\`)`);

  // declared before the loop so the staleness comparison has something to read
  lines.unshift(`let ${v}PrevFeedback = null`);
  return lines.join('\n');
}

/**
 * One agent invocation. `agentType` points at the emitted
 * `.claude/agents/<name>.md`, so the workflow inherits that definition's
 * prompt, tools, and model rather than restating any of it here.
 */
function agentCall(name, spec, phase, { extra = null, indent = '' } = {}) {
  const agent = spec.agents.find((a) => a.name === name);
  if (!agent) return `null /* unknown agent ${name} */`;

  const inputs = spec.agents
    .filter((a) => a.handoff.to.includes(name))
    .map((a) => `handoffPath(${JSON.stringify(a.name)}, ${JSON.stringify(name)})`);

  const task = agent.goal || agent.role || `Carry out your role as ${name}.`;
  const opts = [`label: ${JSON.stringify(name)}`, `phase: ${JSON.stringify(phase.name)}`];
  if (agent.name) opts.push(`agentType: ${JSON.stringify(name)}`);
  const model = spec.defaults.claudeModels?.[agent.model] ?? null;
  if (model) opts.push(`model: ${JSON.stringify(model)}`);
  if (agent.effort) opts.push(`effort: ${JSON.stringify(EFFORT_MAP[agent.effort])}`);
  if (isParallelEditor(agent, spec)) opts.push("isolation: 'worktree'");
  opts.push(`schema: ${schemaConstName(agent)}`);

  const briefArgs = [
    JSON.stringify(name),
    extra ? `[${JSON.stringify(task)}, ${extra}].filter(Boolean).join('\\n\\n')` : JSON.stringify(task),
    `[${inputs.join(', ')}]`,
  ];
  return `await agent(brief(${briefArgs.join(', ')}), { ${opts.join(', ')} })`;
}

function isParallelEditor(agent, spec) {
  if (spec.fleet.allowParallelWrites || !agent.capabilities.edit) return false;
  return (spec.orchestrator.phases ?? []).some(
    (p) =>
      p.parallel &&
      p.agents.includes(agent.name) &&
      p.agents.filter((n) => spec.agents.find((a) => a.name === n)?.capabilities.edit).length > 1
  );
}

/** Per-agent output schema, so results arrive structured instead of as prose. */
function schemaConstName(agent) {
  return `SCHEMA_${agent.name.replace(/[^a-z0-9]+/gi, '_').toUpperCase()}`;
}

function returnBlock(spec) {
  return [
    '// The workflow returns a summary; the durable artifacts are the handoff',
    '// files and the ledger, exactly as in a skill-driven run.',
    'return {',
    "  status: 'complete',",
    `  fleet: ${JSON.stringify(spec.fleet.name)},`,
    '  request,',
    '  results,',
    `  artifacts: ${JSON.stringify(spec.handover.dir)},`,
    '}',
  ].join('\n');
}

/** Schema constants, emitted once at the top of the script. */
function schemaBlock(spec) {
  const lines = [];
  for (const agent of spec.agents) {
    const fields = agent.handoff.schema ?? (agent.handoff.to.length > 0 ? DEFAULT_HANDOFF_SCHEMA : null);
    const props = {
      summary: { type: 'string', description: 'Distilled result: what you found or produced, in a few hundred words at most.' },
      ...(fields
        ? Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { type: 'string', description: v }]))
        : {}),
      handoff_file: { type: 'string', description: 'Path to the handoff file you wrote (empty for a terminal agent).' },
      gaps: { type: 'array', items: { type: 'string' }, description: 'Anything you could not complete, and why.' },
    };
    lines.push(
      `const ${schemaConstName(agent)} = ${JSON.stringify(
        { type: 'object', required: ['summary'], properties: props },
        null,
        2
      )}`
    );
  }
  lines.push(
    `const CHECK_SCHEMA = ${JSON.stringify(
      {
        type: 'object',
        required: ['passed', 'output'],
        properties: {
          passed: { type: 'boolean', description: 'True only if the command exited 0.' },
          output: { type: 'string', description: 'Verbatim tail of the command output.' },
        },
      },
      null,
      2
    )}`
  );
  lines.push(
    `const VERDICT_SCHEMA = ${JSON.stringify(
      {
        type: 'object',
        required: ['satisfied'],
        properties: {
          satisfied: { type: 'boolean', description: 'True if the exit condition holds.' },
          gaps: { type: 'array', items: { type: 'string' }, description: 'Outstanding gaps, each with evidence.' },
        },
      },
      null,
      2
    )}`
  );
  lines.push(
    `const GATE_SCHEMA = ${JSON.stringify(
      {
        type: 'object',
        required: ['passed'],
        properties: {
          passed: { type: 'boolean', description: 'True if the gate condition is met.' },
          reason: { type: 'string', description: 'Why it failed, with evidence.' },
        },
      },
      null,
      2
    )}`
  );
  return lines.join('\n\n');
}

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function varName(phaseName) {
  const parts = slug(phaseName).split('-').filter(Boolean);
  return parts
    .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join('')
    .replace(/^[0-9]/, 'p$&') || 'phase';
}

function workflowReadme(spec) {
  return `# Workflow target — ${spec.fleet.name}

\`.claude/workflows/${spec.orchestrator.name}.js\` runs this fleet as a **dynamic
workflow**: the phase graph as executable JavaScript rather than a playbook a
model reads and follows.

Invoke it with \`/${spec.orchestrator.name}\` in Claude Code, or watch a run with
\`/workflows\`.

Invoke it as \`/${spec.orchestrator.name}\` — workflows are registered under
\`meta.name\`, which this generator keeps equal to the filename.

## How it relates to the rest of the harness

The workflow does not replace the skill orchestrator — both drive the same
agents. Each agent call uses \`agentType\`, which resolves against the same
registry the Agent tool uses, so \`.claude/agents/<name>.md\` supplies the
prompt, tools, model, and permission mode. Those definitions are emitted
alongside this script for that reason; if you delete them, every agent call
fails with "agent type not found".

One consequence worth knowing: an \`Agent(<name>)\` deny rule in
\`.claude/settings.json\` will also block the workflow from invoking that agent,
since both go through the same permission check.

Agents still write handoff files under \`${spec.handover.dir}/\`${
    spec.handover.ledger ? ` and update \`${spec.fleet.local}/LEDGER.md\`` : ''
  }.
That is deliberate: a workflow run that dies mid-phase leaves the same
recoverable state a skill-driven run does, and the files remain the audit
trail. The script additionally keeps structured results in variables, so
passing work between phases costs no context.

## When the workflow is the better choice

- Many agents, or many passes of a refinement loop — intermediate results stay
  out of the context window entirely.
- The sequencing must be exact. Loop bounds, gates, and phase order are program
  control flow here, not instructions a model may reinterpret.
- Long runs you want to resume: re-running caches completed agents up to the
  first one that did not finish.

## When the skill orchestrator is the better choice

- The work needs judgment about what to do next — a workflow's graph is fixed
  at build time, so it cannot decide to skip a phase or add one.
- You are on opencode or goose. This target is Claude Code only.
- Workflows require a paid plan; the skill works everywhere.

## Regenerating

This file is generated. Edit \`fleet.yaml\` and rebuild rather than editing the
script — but do read the script: if what it does is not what you meant, the
spec is wrong, and that is worth knowing before a run rather than after.
`;
}
