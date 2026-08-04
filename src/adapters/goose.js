import YAML from 'yaml';
import { FileSet } from '../lib/fs-utils.js';
import { prune, mdWithFrontmatter } from '../lib/md.js';
import { compileAgentBody, title, isVerifier } from '../compile/agent-prompt.js';
import { handoffTemplate, ledgerTemplate, changelogTemplate } from '../handover/protocol.js';
import { compileOrchestratorBody } from '../compile/orchestrator.js';
import { agentsMdPointer } from '../compile/pointers.js';
import { skillEvals, evalsReadme } from '../compile/evals.js';
import { logEventScript, TELEMETRY_PATH } from '../compile/telemetry.js';

/**
 * goose adapter (aaif-goose/goose, recipe format v1.0.0, skills need goose >= 1.25).
 * Emits:
 *   .goose/recipes/<name>.yaml       — one recipe per fleet agent
 *   .goose/recipes/<orch>.yaml       — orchestrator recipe wiring sub_recipes
 *   .agents/checks/<verifier>.md     — `goose review` checks for verifier roles
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
 *  - Every fleet agent needs a recipe even though goose reads `.claude/agents/`
 *    natively: only a recipe can be the target of a `sub_recipes` entry and
 *    take a pinned `task_brief` parameter, which is how the orchestrator
 *    delegates. The overlap is the delegation contract, not duplication.
 *  - Different sub-recipes run SEQUENTIALLY unless the prompt asks otherwise,
 *    and there is no YAML key for it — hence `parallelPrompt()`. Without it a
 *    fleet's declared parallel phases silently run one at a time.
 *  - Skills are auto-discovered by goose's Summon extension from project
 *    skill directories (./.goose/skills/, ./.claude/skills/, ./.agents/skills/),
 *    so recipes reference skills by name only.
 *  - Handover rides the same file protocol — recipes inherit the working
 *    directory, so the fleet workspace behaves identically.
 *  - Loop engineering: a phase iteration loop that declares a shell `check`
 *    compiles to goose's native recipe-level `retry` block (max_retries +
 *    shell checks), so the loop is enforced deterministically, not just in
 *    prose. Loops without a check, and recurring `schedule`, stay in the
 *    orchestrator instructions (shared prose).
 */

const CAP_EXTENSIONS = {
  run: { type: 'builtin', name: 'developer' },
  edit: { type: 'builtin', name: 'developer' },
  web: { type: 'builtin', name: 'computercontroller' },
};

export function buildGoose(spec, options = {}) {
  const out = new FileSet();

  const orchestratorIsAgent = spec.agents.some((a) => a.name === spec.orchestrator.name);

  for (const agent of spec.agents) {
    // When the orchestrator name collides with an agent name, the orchestrator
    // recipe replaces the agent recipe — a recipe cannot be both a sub_recipe
    // target and the top-level orchestrator, so the orchestrator wins.
    if (orchestratorIsAgent && agent.name === spec.orchestrator.name) {
      continue;
    }
    out.add(`.goose/recipes/${agent.name}.yaml`, agentRecipe(agent, spec, options.playbooks ?? {}));
  }

  out.add(`.goose/recipes/${spec.orchestrator.name}.yaml`, orchestratorRecipe(spec));

  // Verifier agents also get a `goose review` check, which runs reviewers in
  // parallel with per-check model overrides — strictly better than driving the
  // same verification serially through a sub-recipe.
  for (const agent of spec.agents.filter((a) => isVerifier(a, spec))) {
    out.add(`.agents/checks/${agent.name}.md`, reviewCheck(agent, spec));
  }

  // In `--target all` builds, skills are emitted once to .claude/skills/,
  // which goose auto-discovers alongside .goose/skills/.
  if (options.emitSkills !== false) {
    for (const skill of spec.skills) {
      emitSkill(out, `.goose/skills/${skill.name}`, skill, spec);
    }
    if (spec.skills.length > 0) out.add(`${spec.fleet.local}/evals/README.md`, evalsReadme(spec));
  }

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

  if (options.agentsMd !== false) {
    out.add('AGENTS.md', agentsMdPointer(spec));
  }

  return out;
}

function agentRecipe(agent, spec, playbooks = {}) {
  const instructions = [compileAgentBody(agent, spec, { team: false, playbook: playbooks[agent.name] ?? [] }), readOnlyClause(agent)]
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
    settings: agentSettings(agent, spec),
    response: handoffResponseSchema(agent),
  };
  return YAML.stringify(prune(recipe), { lineWidth: 0 });
}

/**
 * Per-agent model tier and turn cap. A model id is emitted only when the
 * author mapped tiers to concrete goose model names — guessing one produces a
 * recipe that fails at load. `max_turns` is worth setting regardless: without
 * it a sub-recipe inherits a bound generous enough to be no bound at all.
 */
function agentSettings(agent, spec) {
  const settings = {};
  const model = spec.defaults.gooseModels?.[agent.model];
  if (model) settings.goose_model = model;
  if (agent.turns) settings.max_turns = agent.turns;
  return Object.keys(settings).length > 0 ? settings : undefined;
}

/**
 * A declared handoff schema becomes goose's native structured output: goose
 * validates the final message against it and re-prompts itself when it does
 * not conform, so the contract is enforced by the runtime rather than by the
 * agent remembering. The markdown handoff file remains the durable artifact;
 * this is the machine-checkable summary of it.
 */
function handoffResponseSchema(agent) {
  const schema = agent.handoff.schema;
  if (!schema || agent.handoff.to.length === 0) return undefined;
  const fields = Object.keys(schema);
  return {
    json_schema: {
      type: 'object',
      required: [...fields, 'handoff_file'],
      properties: {
        ...Object.fromEntries(fields.map((f) => [f, { type: 'string', description: schema[f] }])),
        handoff_file: { type: 'string', description: 'Path to the handoff markdown file you wrote.' },
      },
    },
  };
}

/**
 * A `goose review` check: the same acceptance criteria the verifier agent
 * enforces, in the form goose's own review orchestrator can run. Checks run in
 * parallel and each may pin its own model, so a fleet with several verifiers
 * gets concurrency for free.
 *
 * The filename must equal `name`, and the body is the reviewer's instructions.
 */
function reviewCheck(agent, spec) {
  const criteria = agent.handoff.criteria ?? [];
  const body = [
    `# ${title(agent.name)}`,
    '',
    agent.role || `Reviews work produced by the ${spec.fleet.name} fleet.`,
    '',
    '## What to check',
    '',
    ...(criteria.length > 0
      ? criteria.map((c) => `- ${c}`)
      : [`- ${agent.goal || 'The work satisfies the requirements it was given.'}`]),
    '',
    '## How to report',
    '',
    'Flag only what affects correctness or the stated requirements. A reviewer asked for problems will always produce some; reporting weak findings as defects sends the fleet into rework it does not need, so mark anything else optional.',
    '',
    'Every finding needs reproducible evidence — a command and its output, or `file:line`. Where the acceptance test is a command, confirm the work actually does what was asked rather than only that the command exits 0.',
  ].join('\n');

  return mdWithFrontmatter(
    {
      name: agent.name,
      description: (agent.goal || agent.role || `Review gate for ${spec.fleet.name}`).slice(0, 200),
      model: spec.defaults.gooseModels?.[agent.model] ?? undefined,
      'turn-limit': agent.turns ?? 25,
    },
    body
  );
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
  // Declaring an `extensions:` block at all suppresses goose's default
  // platform extensions, which is where `summon` — and therefore delegation —
  // lives. Recipes that declare `sub_recipes` get it re-injected automatically;
  // an agent recipe that spawns does not, and would silently lose the ability.
  if (caps.spawn) seen.set('summon', { type: 'platform', name: 'summon' });
  return [...seen.values()];
}

function orchestratorRecipe(spec) {
  const recipe = {
    version: '1.0.0',
    title: `${title(spec.orchestrator.name)} — ${spec.fleet.name} orchestrator`,
    description: `Orchestrates the ${spec.fleet.name} fleet (${spec.agents.map((a) => a.name).join(', ')})`.slice(0, 200),
    instructions: compileOrchestratorBody(spec, 'goose'),
    prompt: `Run the fleet on this request: {{ request }}${parallelPrompt(spec)}`,
    parameters: [
      {
        key: 'request',
        input_type: 'string',
        requirement: 'user_prompt',
        description: 'What should the fleet accomplish?',
      },
    ],
    extensions: [{ type: 'builtin', name: 'developer' }],
    retry: retryBlock(spec),
    sub_recipes: spec.agents
      .filter((a) => a.name !== spec.orchestrator.name)
      .map((a) => ({
        name: a.name,
        path: `.goose/recipes/${a.name}.yaml`,
        description: (a.goal || a.role || a.name).slice(0, 200),
      })),
  };
  return YAML.stringify(prune(recipe), { lineWidth: 0 });
}

/**
 * goose runs *different* sub-recipes sequentially unless the prompt says
 * otherwise — there is no YAML key for it, and the request has to be in the
 * prompt rather than the instructions to reliably take effect. Without this,
 * a fleet whose phases are declared parallel still executes one agent at a
 * time and the declared concurrency is silently lost.
 */
function parallelPrompt(spec) {
  const parallel = (spec.orchestrator.phases ?? []).filter((p) => p.parallel && (p.agents ?? []).length > 1);
  if (parallel.length === 0) return '';
  const groups = parallel
    .map((p) => `${p.name} (${p.agents.map((n) => `\`${n}\``).join(', ')})`)
    .join('; ');
  return (
    `\n\nRun these phases' sub-recipes **in parallel** — launch them simultaneously in one step rather than one after another: ${groups}. ` +
    'Every other phase runs sequentially, and a phase does not start until the previous one is verified complete.'
  );
}

/**
 * Translate phase iteration loops that carry a shell `check` into goose's
 * native recipe-level `retry`. goose retries the whole recipe until every
 * check passes (exit 0) or `max_retries` is hit — the deterministic backstop
 * behind the orchestrator's prose loop. Loops without a check stay prose-only.
 */
function retryBlock(spec) {
  const checked = (spec.orchestrator.phases ?? []).filter((p) => p.loop && p.loop.check);
  if (checked.length === 0) return undefined;
  return {
    max_retries: Math.max(...checked.map((p) => p.loop.max)),
    checks: checked.map((p) => ({ type: 'shell', command: p.loop.check })),
    on_failure: 'Record the unmet check in the ledger and final report, then stop — never loop unbounded.',
  };
}

function emitSkill(out, dir, skill, spec) {
  out.add(`${dir}/evals/evals.json`, skillEvals(skill, spec));
  out.add(
    `${dir}/SKILL.md`,
    mdWithFrontmatter({ name: skill.name, description: skill.description }, skill.body || `# ${title(skill.name)}\n\n(TODO: methodology)`)
  );
  for (const [file, content] of Object.entries(skill.references)) out.add(`${dir}/references/${file}`, content);
  for (const [file, content] of Object.entries(skill.scripts)) out.add(`${dir}/scripts/${file}`, content);
  for (const [file, content] of Object.entries(skill.assets)) out.add(`${dir}/assets/${file}`, content);
}
