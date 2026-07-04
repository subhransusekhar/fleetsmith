import { FileSet } from '../lib/fs-utils.js';
import { mdWithFrontmatter } from '../lib/md.js';
import { compileAgentBody, title } from '../compile/agent-prompt.js';
import { handoffTemplate, ledgerTemplate } from '../handover/protocol.js';
import { compileOrchestratorBody } from '../compile/orchestrator.js';
import { agentsMdPointer } from '../compile/pointers.js';

/**
 * opencode adapter (opencode.ai — anomalyco/opencode).
 * Emits:
 *   .opencode/agents/<name>.md        — fleet agents as subagents (plural dirs
 *                                       are the current convention)
 *   .opencode/agents/<orch>.md        — orchestrator as a primary agent
 *   .opencode/commands/<orch>.md      — /command to kick off the fleet
 *   .opencode/skills/<name>/SKILL.md  — skills (suppressed in combined builds:
 *                                       opencode natively reads .claude/skills/)
 *   AGENTS.md                         — tool-neutral harness pointer
 *   <workspace>/…                     — handover scaffolding
 *
 * Permission model: the `tools:` frontmatter map is deprecated upstream, so
 * capabilities compile to `permission:` allow/deny actions instead.
 *
 * opencode has no agent-team runtime, so `team` execution degrades gracefully:
 * the orchestrator runs as a primary agent driving subagents via the task
 * tool; coordination rides entirely on the file protocol.
 */

export function buildOpencode(spec, options = {}) {
  const out = new FileSet();

  for (const agent of spec.agents) {
    out.add(`.opencode/agents/${agent.name}.md`, agentFile(agent, spec));
  }

  out.add(`.opencode/agents/${spec.orchestrator.name}.md`, orchestratorAgent(spec));
  out.add(`.opencode/commands/${spec.orchestrator.name}.md`, kickoffCommand(spec));

  // In `--target all` builds, skills are emitted once to .claude/skills/,
  // which opencode reads natively (Claude-compatible search path).
  if (options.emitSkills !== false) {
    for (const skill of spec.skills) {
      emitSkill(out, `.opencode/skills/${skill.name}`, skill);
    }
  }

  out.add(`${spec.handover.dir}/HANDOFF.template.md`, handoffTemplate());
  if (spec.handover.ledger) {
    out.add(`${spec.fleet.workspace}/LEDGER.md`, ledgerTemplate(spec.fleet.name));
  }

  if (options.agentsMd !== false) {
    out.add('AGENTS.md', agentsMdPointer(spec, options.today));
  }

  return out;
}

function agentFile(agent, spec) {
  return mdWithFrontmatter(
    {
      description: agentDescription(agent, spec),
      mode: 'subagent',
      temperature: 0.2,
      permission: capsToPermission(agent.capabilities, spec.fleet.workspace),
    },
    compileAgentBody(agent, spec, { team: false })
  );
}

function agentDescription(agent, spec) {
  const domain = spec.fleet.domain ? ` for ${spec.fleet.domain}` : '';
  return `${title(agent.name)} of the ${spec.fleet.name} fleet${domain}. ${agent.role}`.replace(/\s+/g, ' ').trim();
}

/**
 * Map abstract capabilities onto opencode's permission keys.
 * `edit` gates write/edit/apply_patch; read-family tools default to allow.
 * Handoff files must remain writable even for read-only agents, so `edit`
 * is scoped: deny everywhere except the fleet workspace.
 */
function capsToPermission(caps, workspace) {
  const allow = (on) => (on ? 'allow' : 'deny');
  return {
    read: 'allow',
    edit: caps.edit ? 'allow' : { '*': 'deny', [`${workspace}/**`]: 'allow' },
    bash: allow(caps.run),
    webfetch: allow(caps.web),
    websearch: allow(caps.web),
    task: allow(caps.spawn),
  };
}

function orchestratorAgent(spec) {
  return mdWithFrontmatter(
    {
      description:
        `Orchestrates the ${spec.fleet.name} fleet${spec.fleet.domain ? ` for ${spec.fleet.domain}` : ''} ` +
        `(${spec.agents.map((a) => a.name).join(', ')}). Use for ${spec.orchestrator.trigger}, including re-runs and partial fixes.`,
      mode: 'primary',
      permission: {
        read: 'allow',
        edit: 'allow',
        bash: 'allow',
        task: { '*': 'deny', ...Object.fromEntries(spec.agents.map((a) => [a.name, 'allow'])) },
      },
    },
    compileOrchestratorBody(spec, 'opencode')
  );
}

function kickoffCommand(spec) {
  return mdWithFrontmatter(
    {
      description: `Run the ${spec.fleet.name} fleet`,
      agent: spec.orchestrator.name,
    },
    `Run the ${spec.fleet.name} fleet on the following request:\n\n$ARGUMENTS\n\nFollow your orchestrator playbook: Phase 0 context check first, then execute the phases, keep the ledger current, and finish with the completion checklist.`
  );
}

function emitSkill(out, dir, skill) {
  out.add(
    `${dir}/SKILL.md`,
    mdWithFrontmatter({ name: skill.name, description: skill.description }, skill.body || `# ${title(skill.name)}\n\n(TODO: methodology)`)
  );
  for (const [file, content] of Object.entries(skill.references)) out.add(`${dir}/references/${file}`, content);
  for (const [file, content] of Object.entries(skill.scripts)) out.add(`${dir}/scripts/${file}`, content);
  for (const [file, content] of Object.entries(skill.assets)) out.add(`${dir}/assets/${file}`, content);
}
