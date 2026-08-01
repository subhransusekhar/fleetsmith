import { FileSet } from '../lib/fs-utils.js';
import { mdWithFrontmatter } from '../lib/md.js';
import { compileAgentBody, title } from '../compile/agent-prompt.js';
import { handoffTemplate, ledgerTemplate } from '../handover/protocol.js';
import { compileOrchestratorBody } from '../compile/orchestrator.js';
import { settingsJson, validatorScript, loopMd, VALIDATOR_PATH } from './claude-settings.js';
import { skillEvals, evalsReadme } from '../compile/evals.js';

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

const MODEL_MAP = { smart: 'opus', fast: 'sonnet', cheap: 'haiku', inherit: 'inherit' };

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
  const team = spec.fleet.execution !== 'subagents';

  const parallelEditors = parallelEditingAgents(spec);
  for (const [i, agent] of spec.agents.entries()) {
    out.add(`.claude/agents/${agent.name}.md`, agentFile(agent, spec, team, i, parallelEditors));
  }

  for (const skill of spec.skills) {
    emitSkill(out, `.claude/skills/${skill.name}`, skill, spec);
  }
  if (spec.skills.length > 0) out.add(`${spec.fleet.workspace}/evals/README.md`, evalsReadme(spec));

  out.add(
    `.claude/skills/${spec.orchestrator.name}/SKILL.md`,
    orchestratorSkill(spec)
  );

  emitWorkspace(out, spec);

  // Deterministic layer: an allowlist so the fleet runs unattended, and a
  // SubagentStop gate so a missing handoff blocks the agent instead of
  // silently becoming the next agent's problem.
  const validatorPath = `${spec.fleet.workspace}/${VALIDATOR_PATH}`;
  out.add('.claude/settings.json', settingsJson(spec, { validatorPath }));
  out.add(validatorPath, validatorScript(spec));

  if (spec.fleet.schedule) out.add('.claude/loop.md', loopMd(spec));

  if (options.claudeMd !== false) {
    out.add('CLAUDE.md', claudeMdPointer(spec, options.today));
  }

  return out;
}

function agentFile(agent, spec, team, index = 0, parallelEditors = new Set()) {
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
      model: MODEL_MAP[agent.model] ?? 'inherit',
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
    },
    [compileAgentBody(agent, spec, { team }), isolate ? worktreeClause() : '']
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
        `Use for any ${o.trigger} request — including re-runs, updates, partial fixes ("redo the X part"), and improvements to previous results. ` +
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
 * Inject current fleet state into the skill at expansion time. `!` command
 * output is inlined before the model reads the prompt, so the run starts
 * already knowing whether a previous workspace exists rather than spending a
 * turn discovering it — which is exactly what Phase 0 branches on.
 *
 * Kept last: the invariant playbook above it stays identical between runs, and
 * the one part that changes lands closest to the user's request.
 */
function liveStateBlock(spec) {
  const dir = spec.handover.dir;
  const ledger = spec.handover.ledger ? `${spec.fleet.workspace}/LEDGER.md` : null;
  const lines = ['## Workspace state, as of right now', '', '```!'];
  lines.push(`ls -1 ${dir}/*.md 2>/dev/null | grep -v HANDOFF.template || echo "(no handoffs yet — this is an initial run)"`);
  if (ledger) lines.push(`echo "--- ledger ---"; cat ${ledger} 2>/dev/null || echo "(no ledger yet)"`);
  lines.push('```');
  lines.push('');
  lines.push('This is the real state of the workspace for this invocation. Run the Phase 0 check against it rather than re-reading the same files.');
  return lines.join('\n');
}

function emitWorkspace(out, spec) {
  out.add(`${spec.handover.dir}/HANDOFF.template.md`, handoffTemplate());
  if (spec.handover.ledger) {
    out.add(`${spec.fleet.workspace}/LEDGER.md`, ledgerTemplate(spec.fleet.name));
  }
}

function claudeMdPointer(spec, today = 'YYYY-MM-DD') {
  return `## Harness: ${spec.fleet.name}

**Goal:** ${spec.fleet.domain || spec.fleet.name}

**Trigger:** For ${spec.orchestrator.trigger}, use the \`${spec.orchestrator.name}\` skill. Simple questions can be answered directly.

**Handover gate:** \`.claude/settings.json\` registers a \`SubagentStop\` hook running \`${spec.fleet.workspace}/${VALIDATOR_PATH}\`, which blocks a fleet agent from finishing until its handoff file exists and carries every required section. Note that project-level hooks do not run until this workspace is trusted — until you accept that dialog the gate is silently skipped and the fleet degrades to advisory instructions.

**Changelog:**
| Date | Change | Target | Reason |
|------|--------|--------|--------|
| ${today} | Initial fleet build (fleetsmith) | all | - |
`;
}
