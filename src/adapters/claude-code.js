import { FileSet } from '../lib/fs-utils.js';
import { mdWithFrontmatter } from '../lib/md.js';
import { compileAgentBody, title } from '../compile/agent-prompt.js';
import { handoffTemplate, ledgerTemplate, changelogTemplate } from '../handover/protocol.js';
import { compileOrchestratorBody } from '../compile/orchestrator.js';
import { settingsJson, validatorScript, loopMd, VALIDATOR_PATH } from './claude-settings.js';
import { skillEvals, evalsReadme } from '../compile/evals.js';
import { logEventScript, TELEMETRY_PATH } from '../compile/telemetry.js';

/**
 * Claude Code adapter.
 * Emits:
 *   .claude/agents/<name>.md          — subagent definitions
 *   .claude/skills/<name>/SKILL.md    — skills (+ references/scripts/assets)
 *   .claude/skills/<orch>/SKILL.md    — orchestrator skill
 *   <workspace>/…                     — handover scaffolding
 *   CLAUDE.md                         — harness pointer (trigger rule + changelog)
 */

const TOOL_MAP = {
  read: ['Read', 'Grep', 'Glob'],
  edit: ['Write', 'Edit'],
  run: ['Bash'],
  web: ['WebSearch', 'WebFetch'],
  spawn: ['Agent'],
};

/**
 * Abstract effort tiers → Claude Code's `effort` values. The platform has no
 * `minimal`, so it collapses onto `low`.
 */
const EFFORT_MAP = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', max: 'max' };

/** Frontmatter `color` values, cycled by roster order so a fleet is legible in the task panel. */
const COLORS = ['blue', 'green', 'purple', 'orange', 'cyan', 'pink', 'yellow', 'red'];

/**
 * Tools Claude Code strips from every subagent regardless of the `tools`
 * allowlist. Emitting them produces an agent that cannot do what its
 * definition claims, so the adapter refuses to generate them.
 */
const SUBAGENT_FORBIDDEN_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'Workflow']);

export function buildClaudeCode(spec, options = {}) {
  const out = new FileSet();

  for (const [p, content] of claudeAgentFiles(spec, options.playbooks ?? {})) out.add(p, content);

  for (const skill of spec.skills) {
    emitSkill(out, `.claude/skills/${skill.name}`, skill, spec);
  }
  if (spec.skills.length > 0) out.add(`${spec.fleet.local}/evals/README.md`, evalsReadme(spec));

  out.add(
    `.claude/skills/${spec.orchestrator.name}/SKILL.md`,
    orchestratorSkill(spec)
  );

  emitWorkspace(out, spec, options);

  // Deterministic layer: an allowlist so the fleet runs unattended, and a
  // SubagentStop gate so a missing handoff blocks the agent instead of
  // silently becoming the next agent's problem.
  const validatorPath = `${spec.fleet.local}/${VALIDATOR_PATH}`;
  out.add('.claude/settings.json', settingsJson(spec, { validatorPath }));
  out.add(validatorPath, validatorScript(spec));

  if (spec.fleet.schedule) out.add('.claude/loop.md', loopMd(spec));

  if (options.claudeMd !== false) {
    out.add('CLAUDE.md', claudeMdPointer(spec));
  }

  return out;
}

/**
 * The `.claude/agents/` definitions on their own, keyed by path.
 *
 * Exported because the workflow target resolves `agentType` against this same
 * registry: a workflow script whose agents are not on disk fails at the first
 * `agent()` call with "agent type not found". Sharing the emitter keeps the two
 * targets from drifting into subtly different definitions.
 */
export function claudeAgentFiles(spec, playbooks = {}) {
  const team = spec.fleet.execution !== 'subagents';
  const parallelEditors = parallelEditingAgents(spec);
  return new Map(
    spec.agents.map((agent, i) => [
      `.claude/agents/${agent.name}.md`,
      agentFile(agent, spec, team, i, parallelEditors, playbooks),
    ])
  );
}

function agentFile(agent, spec, team, index = 0, parallelEditors = new Set(), playbooks = {}) {
  const tools = capsToTools(agent.capabilities);
  // A worktree keeps concurrent editors off each other's files. It branches
  // from the repo's default branch (not the caller's HEAD) and is discarded
  // when the agent changed nothing, so it costs nothing for a no-op pass.
  const isolate = parallelEditors.has(agent.name) && !spec.fleet.allowParallelWrites;
  return mdWithFrontmatter(
    {
      name: agent.name,
      description: agentDescription(agent, spec),
      tools: tools.join(', '),
      model: resolveModel(agent, spec),
      // Preloads skill content into the subagent's context. Note: when the
      // definition is reused as an agent-team teammate, Claude Code ignores
      // this field — the body's "load your skills" instruction covers that path.
      skills: agent.skills.length > 0 ? agent.skills : undefined,
      effort: agent.effort ? EFFORT_MAP[agent.effort] : undefined,
      maxTurns: agent.turns ?? undefined,
      permissionMode: permissionModeFor(agent),
      memory: agent.memory ? 'project' : undefined,
      isolation: isolate ? 'worktree' : undefined,
      color: COLORS[index % COLORS.length],
      // Provenance travels into the generated file so `fleetsmith qa` can
      // detect machine-authored content laundered into a human-marked
      // artifact — which would place it outside the evolution loop's
      // protected set while still being machine-written.
      'x-fleetsmith-origin': agent.origin,
    },
    [compileAgentBody(agent, spec, { team, playbook: playbooks[agent.name] ?? [] }), isolate ? worktreeClause() : '']
      .filter(Boolean)
      .join('\n\n')
  );
}

/**
 * Agents that both edit and run concurrently with another editor. Parallel
 * writers diverge on implicit decisions no brief captures and can clobber each
 * other's files; isolating them is the documented mitigation.
 */
function parallelEditingAgents(spec) {
  const editors = new Set();
  for (const phase of spec.orchestrator.phases ?? []) {
    if (!phase.parallel) continue;
    const writing = (phase.agents ?? []).filter(
      (n) => spec.agents.find((a) => a.name === n)?.capabilities.edit
    );
    if (writing.length > 1) for (const n of writing) editors.add(n);
  }
  return editors;
}

function worktreeClause() {
  return [
    '## Isolation',
    'You run in your own git worktree because another agent edits files in the same phase. It branches from the repository default branch, not the caller\'s working tree, so do not assume uncommitted work from earlier phases is present — read what you need from the handoff files. Commands that try to escape the worktree fail rather than touching the main checkout.',
  ].join('\n');
}

/**
 * `inherit` unless the author named a model for this agent's tier.
 *
 * No tier ever resolves to a name the author did not write. There used to be a
 * fallback table (`smart`→opus, `fast`→sonnet, `cheap`→haiku) applied to any
 * tier left unnamed once `defaults.claudeModels` existed at all, so pinning one
 * tier silently stamped provider-specific model names onto every other agent.
 * That is wrong for a spec whose whole purpose is to compile unchanged for
 * opencode and goose, where the same fleet runs on entirely different models:
 * the compiler was inventing bindings for an agent the author never configured,
 * and a name is an override, not a preference — it beats the session's own
 * choice and hard-fails wherever that model is not available.
 *
 * So `{smart: 'some-model-id'}` pins exactly the `smart` agents; `cheap` and
 * `fast` agents keep inheriting. Tier stays an intent; binding it to a name is
 * per-target and explicit. Same rule as opencode and goose, which omit the
 * field entirely when unnamed.
 */
function resolveModel(agent, spec) {
  return spec.defaults.claudeModels?.[agent.model] ?? 'inherit';
}

/**
 * Derive the permission mode from declared capabilities: an agent that only
 * reads has nothing to approve and plans; an agent that edits would otherwise
 * stop at every write for a prompt nobody is watching.
 */
function permissionModeFor(agent) {
  if (agent.capabilities.edit) return 'acceptEdits';
  if (!agent.capabilities.run) return 'plan';
  return undefined;
}

function agentDescription(agent, spec) {
  const domain = spec.fleet.domain ? ` for ${spec.fleet.domain}` : '';
  const goal = agent.goal ? ` ${agent.goal}` : '';
  return (
    `${title(agent.name)} of the ${spec.fleet.name} fleet${domain}. ${agent.role}${goal} ` +
    `Use when the ${spec.orchestrator.name} workflow reaches its ${agent.name} step, or when the user asks for this agent by name.`
  ).replace(/\s+/g, ' ').trim();
}

function capsToTools(caps) {
  const tools = [];
  for (const [cap, on] of Object.entries(caps)) {
    if (on && TOOL_MAP[cap]) tools.push(...TOOL_MAP[cap]);
  }
  if (!tools.includes('Read')) tools.unshift('Read'); // an agent that can read nothing can do nothing
  // Subagents run in the background by default and never receive these, so an
  // allowlist naming one would describe an agent that cannot exist.
  return tools.filter((t) => !SUBAGENT_FORBIDDEN_TOOLS.has(t));
}

function emitSkill(out, dir, skill, spec) {
  out.add(`${dir}/evals/evals.json`, skillEvals(skill, spec));
  out.add(
    `${dir}/SKILL.md`,
    mdWithFrontmatter(
      {
        name: skill.name,
        description: skill.description,
        // Pre-approve the skill's own bundled scripts so they run without a
        // permission prompt. The grant is scoped to this skill's directory and
        // lasts only for the invoking turn.
        'allowed-tools': scriptGrants(skill),
        'x-fleetsmith-origin': skill.origin,
      },
      skillBody(skill)
    )
  );
  for (const [file, content] of Object.entries(skill.references)) {
    out.add(`${dir}/references/${file}`, content);
  }
  for (const [file, content] of Object.entries(skill.scripts)) {
    out.add(`${dir}/scripts/${file}`, content);
  }
  for (const [file, content] of Object.entries(skill.assets)) {
    out.add(`${dir}/assets/${file}`, content);
  }
}

/**
 * `Bash(${CLAUDE_SKILL_DIR}/scripts/x.sh *)` per bundled script. Running a
 * script beats re-deriving its logic in tokens every invocation, but only if
 * it runs without stopping to ask.
 */
function scriptGrants(skill) {
  const names = Object.keys(skill.scripts ?? {});
  if (names.length === 0) return undefined;
  return names.map((f) => `Bash(\${CLAUDE_SKILL_DIR}/scripts/${f} *)`).join(', ');
}

/**
 * Frame the methodology by how much latitude it should allow. Low-freedom
 * skills guard fragile, consistency-critical sequences where improvisation is
 * the failure mode; high-freedom ones describe heuristics for work with many
 * valid routes.
 */
function skillBody(skill) {
  const body = skill.body || `# ${title(skill.name)}\n\n(TODO: methodology)`;
  if (skill.freedom === 'low') {
    return `${body}\n\n## Execution discipline\n\nRun the commands in this skill exactly as written — do not modify them, add flags, or substitute an equivalent you prefer. These steps are order-dependent and have been verified as a sequence; a local improvement to one step tends to break a later one. If a step fails, report the failure rather than routing around it.`;
  }
  if (skill.freedom === 'high') {
    return `${body}\n\n## Applying this skill\n\nTreat the above as heuristics, not a script. Many routes through this work are valid; choose based on what you find and say which route you took and why. Where this guidance does not fit the situation in front of you, follow your judgment and note the deviation.`;
  }
  return body;
}

function orchestratorSkill(spec) {
  const o = spec.orchestrator;
  return mdWithFrontmatter(
    {
      name: o.name,
      description:
        `Orchestrates the ${spec.fleet.name} agent fleet${spec.fleet.domain ? ` for ${spec.fleet.domain}` : ''}: ` +
        `${spec.agents.map((a) => a.name).join(', ')}. ` +
        // "Use for any <trigger> request" only parses when the trigger is a
        // short noun phrase. Real triggers are long clauses with their own
        // dashes and lists, and jamming "request" onto the end produces
        // "…across Claude Code, opencode, and goose request" — the first thing
        // the router reads, ungrammatical.
        `Use when the request is about ${o.trigger}. This includes re-runs, updates, partial fixes ("redo the X part"), and improvements to previous results. ` +
        `Simple factual questions can be answered directly without the fleet.`,
      'argument-hint': '[what the fleet should work on]',
      // A scheduled fleet fires with nobody watching, so a question that waits
      // for an answer is a hang. Removing the tool is more reliable than
      // instructing the model not to reach for it.
      'disallowed-tools': spec.fleet.schedule ? 'AskUserQuestion' : undefined,
    },
    [compileOrchestratorBody(spec, 'claude-code'), liveStateBlock(spec)].join('\n\n')
  );
}

/**
 * Inject current fleet state into the skill at expansion time. `` !`cmd` ``
 * output is inlined before the model reads the prompt, so the run starts
 * already knowing whether a previous workspace exists rather than spending a
 * turn discovering it — which is exactly what Phase 0 branches on.
 *
 * The syntax is the inline backtick form, NOT a ` ```! ` fenced block. A fenced
 * block is not an injection anywhere in Claude Code: it renders as literal
 * shell source under a heading promising live state, so the model reads a
 * contradiction and re-derives the state with its own tool calls — strictly
 * worse than not making the promise, because Phase 0 now runs against text that
 * claims to be an answer. Keep this identical in form to the opencode
 * `fleet-status` command, which uses the same mechanism correctly.
 *
 * Kept last: the invariant playbook above it stays identical between runs, and
 * the one part that changes lands closest to the user's request.
 */
function liveStateBlock(spec) {
  const dir = spec.handover.dir;
  const ledger = spec.handover.ledger ? `${spec.fleet.local}/LEDGER.md` : null;
  const lines = ['## Workspace state, as of right now', '', 'Handoffs written so far:', ''];
  lines.push(
    `!\`ls -1 ${dir}/*.md 2>/dev/null | grep -v HANDOFF.template || echo "(no handoffs yet — this is an initial run)"\``
  );
  if (ledger) {
    lines.push('');
    lines.push('Ledger:');
    lines.push('');
    lines.push(`!\`cat ${ledger} 2>/dev/null || echo "(no ledger yet)"\``);
  }
  lines.push('');
  lines.push('This is the real state of the workspace for this invocation. Run the Phase 0 check against it rather than re-reading the same files.');
  return lines.join('\n');
}

function emitWorkspace(out, spec, options = {}) {
  out.add(`${spec.handover.dir}/HANDOFF.template.md`, handoffTemplate());
  if (spec.handover.ledger) {
    out.add(`${spec.fleet.local}/LEDGER.md`, ledgerTemplate(spec.fleet.name));
  }
  out.add(
    `${spec.fleet.shared}/CHANGELOG.md`,
    changelogTemplate(spec.fleet.name, options.today),
    { preserve: true }
  );
  out.add(`${spec.fleet.local}/${TELEMETRY_PATH}`, logEventScript(spec));
}

function claudeMdPointer(spec) {
  return `## Harness: ${spec.fleet.name}

**Goal:** ${spec.fleet.domain || spec.fleet.name}

**Trigger:** For ${spec.orchestrator.trigger}, use the \`${spec.orchestrator.name}\` skill. Simple questions can be answered directly.

**Handover gate:** \`.claude/settings.json\` registers a \`SubagentStop\` hook running \`${spec.fleet.local}/${VALIDATOR_PATH}\`, which blocks a fleet agent from finishing until its handoff file exists and carries every required section. Note that project-level hooks do not run until this workspace is trusted — until you accept that dialog the gate is silently skipped and the fleet degrades to advisory instructions.

**Changelog:** harness changes are recorded in \`${spec.fleet.shared}/CHANGELOG.md\` — append a row there rather than editing this file, which is regenerated on every build.
`;
}
