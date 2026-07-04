import { FileSet } from '../lib/fs-utils.js';
import { mdWithFrontmatter } from '../lib/md.js';
import { compileAgentBody, title } from '../compile/agent-prompt.js';
import { handoffTemplate, ledgerTemplate } from '../handover/protocol.js';
import { compileOrchestratorBody } from '../compile/orchestrator.js';

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

export function buildClaudeCode(spec, options = {}) {
  const out = new FileSet();
  const team = spec.fleet.execution !== 'subagents';

  for (const agent of spec.agents) {
    out.add(`.claude/agents/${agent.name}.md`, agentFile(agent, spec, team));
  }

  for (const skill of spec.skills) {
    emitSkill(out, `.claude/skills/${skill.name}`, skill);
  }

  out.add(
    `.claude/skills/${spec.orchestrator.name}/SKILL.md`,
    orchestratorSkill(spec)
  );

  emitWorkspace(out, spec);

  if (options.claudeMd !== false) {
    out.add('CLAUDE.md', claudeMdPointer(spec, options.today));
  }

  return out;
}

function agentFile(agent, spec, team) {
  const tools = capsToTools(agent.capabilities);
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
    },
    compileAgentBody(agent, spec, { team })
  );
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
  return tools;
}

function emitSkill(out, dir, skill) {
  out.add(
    `${dir}/SKILL.md`,
    mdWithFrontmatter({ name: skill.name, description: skill.description }, skill.body || `# ${title(skill.name)}\n\n(TODO: methodology)`)
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
    },
    compileOrchestratorBody(spec, 'claude-code')
  );
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

**Changelog:**
| Date | Change | Target | Reason |
|------|--------|--------|--------|
| ${today} | Initial fleet build (fleetsmith) | all | - |
`;
}
