import YAML from 'yaml';
import { FileSet } from '../lib/fs-utils.js';
import { prune, mdWithFrontmatter } from '../lib/md.js';
import { compileAgentBody, title } from '../compile/agent-prompt.js';
import { handoffTemplate, ledgerTemplate } from '../handover/protocol.js';
import { compileOrchestratorBody } from '../compile/orchestrator.js';
import { agentsMdPointer } from '../compile/pointers.js';

/**
 * goose adapter (Block goose, recipe format v1.0.0, skills need goose >= 1.25).
 * Emits:
 *   .goose/recipes/<name>.yaml       — one recipe per fleet agent
 *   .goose/recipes/<orch>.yaml       — orchestrator recipe wiring sub_recipes
 *   .goose/skills/<name>/SKILL.md    — skills (suppressed in combined builds:
 *                                      goose auto-discovers .claude/skills/ too)
 *   AGENTS.md                        — tool-neutral pointer (goose loads
 *                                      AGENTS.md as a first-class context file,
 *                                      ahead of .goosehints)
 *   <workspace>/…                    — handover scaffolding
 *
 * Mapping notes:
 *  - goose has no per-tool permission granularity; capabilities map to which
 *    extensions a recipe enables, and read-only intent is a stated constraint
 *    in instructions, not a sandbox.
 *  - Skills are auto-discovered by goose's Summon extension from project
 *    skill directories (./.goose/skills/, ./.claude/skills/, ./.agents/skills/),
 *    so recipes reference skills by name only.
 *  - Handover rides the same file protocol — recipes inherit the working
 *    directory, so the fleet workspace behaves identically.
 */

const CAP_EXTENSIONS = {
  run: { type: 'builtin', name: 'developer' },
  edit: { type: 'builtin', name: 'developer' },
  web: { type: 'builtin', name: 'computercontroller' },
};

export function buildGoose(spec, options = {}) {
  const out = new FileSet();

  for (const agent of spec.agents) {
    out.add(`.goose/recipes/${agent.name}.yaml`, agentRecipe(agent, spec));
  }

  out.add(`.goose/recipes/${spec.orchestrator.name}.yaml`, orchestratorRecipe(spec));

  // In `--target all` builds, skills are emitted once to .claude/skills/,
  // which goose auto-discovers alongside .goose/skills/.
  if (options.emitSkills !== false) {
    for (const skill of spec.skills) {
      emitSkill(out, `.goose/skills/${skill.name}`, skill);
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

function agentRecipe(agent, spec) {
  const instructions = [compileAgentBody(agent, spec, { team: false }), readOnlyClause(agent)]
    .filter(Boolean)
    .join('\n\n');

  const recipe = {
    version: '1.0.0',
    title: `${title(agent.name)} — ${spec.fleet.name}`,
    description: (agent.role || agent.name).slice(0, 200),
    instructions,
    prompt: `Execute your role as ${agent.name}. Task brief: {{ task_brief }}`,
    parameters: [
      {
        key: 'task_brief',
        input_type: 'string',
        requirement: 'required',
        description: 'The task brief from the orchestrator (or the user), including where to find incoming handoffs.',
      },
    ],
    extensions: capsToExtensions(agent.capabilities),
  };
  return YAML.stringify(prune(recipe), { lineWidth: 0 });
}

function readOnlyClause(agent) {
  if (agent.capabilities.edit || agent.capabilities.run) return '';
  return (
    '## Access constraint\n' +
    'You are a read/analyze agent. Do not modify project files; your only writes are your handoff file(s) and ledger row under the fleet workspace.'
  );
}

function capsToExtensions(caps) {
  const seen = new Map();
  // developer is effectively always needed for file read/write of handoffs
  seen.set('developer', { type: 'builtin', name: 'developer' });
  for (const [cap, on] of Object.entries(caps)) {
    if (on && CAP_EXTENSIONS[cap]) {
      const ext = CAP_EXTENSIONS[cap];
      seen.set(ext.name, ext);
    }
  }
  return [...seen.values()];
}

function orchestratorRecipe(spec) {
  const recipe = {
    version: '1.0.0',
    title: `${title(spec.orchestrator.name)} — ${spec.fleet.name} orchestrator`,
    description: `Orchestrates the ${spec.fleet.name} fleet (${spec.agents.map((a) => a.name).join(', ')})`.slice(0, 200),
    instructions: compileOrchestratorBody(spec, 'goose'),
    prompt: 'Run the fleet on this request: {{ request }}',
    parameters: [
      {
        key: 'request',
        input_type: 'string',
        requirement: 'user_prompt',
        description: 'What should the fleet accomplish?',
      },
    ],
    extensions: [{ type: 'builtin', name: 'developer' }],
    sub_recipes: spec.agents.map((a) => ({
      name: a.name,
      path: `.goose/recipes/${a.name}.yaml`,
      description: (a.goal || a.role || a.name).slice(0, 200),
    })),
  };
  return YAML.stringify(prune(recipe), { lineWidth: 0 });
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
