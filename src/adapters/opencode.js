import { FileSet } from '../lib/fs-utils.js';
import { mdWithFrontmatter } from '../lib/md.js';
import { compileAgentBody, title } from '../compile/agent-prompt.js';
import { handoffTemplate, ledgerTemplate, changelogTemplate } from '../handover/protocol.js';
import { compileOrchestratorBody } from '../compile/orchestrator.js';
import { agentsMdPointer } from '../compile/pointers.js';
import { skillEvals, evalsReadme } from '../compile/evals.js';

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
 * capabilities compile to `permission:` allow/deny actions instead. The
 * handoff graph compiles into `permission.task` and the skill attachments into
 * `permission.skill`, which makes both enforced rather than advisory.
 *
 * opencode has no agent-team runtime, so `team` execution degrades gracefully:
 * the orchestrator runs as a primary agent driving subagents via the task
 * tool; coordination rides entirely on the file protocol.
 */

/**
 * Abstract effort tiers → opencode reasoning variants. opencode ships `high`
 * (default) and `max` for Anthropic models; the lower tiers have no built-in
 * variant, so they are left unset rather than pointed at a name that may not
 * resolve in the user's provider config.
 */
const EFFORT_VARIANT = { minimal: undefined, low: undefined, medium: undefined, high: 'high', max: 'max' };

export function buildOpencode(spec, options = {}) {
  const out = new FileSet();

  const orchestratorIsAgent = spec.agents.some((a) => a.name === spec.orchestrator.name);

  for (const agent of spec.agents) {
    // When the orchestrator name collides with an agent name, the orchestrator
    // file overwrites the agent file rather than sitting beside it — the
    // orchestrator IS that agent, promoted to primary mode.
    if (orchestratorIsAgent && agent.name === spec.orchestrator.name) {
      out.add(`.opencode/agents/${agent.name}.md`, orchestratorAgent(spec));
    } else {
      out.add(`.opencode/agents/${agent.name}.md`, agentFile(agent, spec));
    }
  }

  if (!orchestratorIsAgent) {
    out.add(`.opencode/agents/${spec.orchestrator.name}.md`, orchestratorAgent(spec));
  }
  out.add(`.opencode/commands/${spec.orchestrator.name}.md`, kickoffCommand(spec));
  out.add('.opencode/commands/fleet-status.md', statusCommand(spec));
  out.add('opencode.json', opencodeConfig(spec));

  // In `--target all` builds, skills are emitted once to .claude/skills/,
  // which opencode reads natively (Claude-compatible search path).
  if (options.emitSkills !== false) {
    for (const skill of spec.skills) {
      emitSkill(out, `.opencode/skills/${skill.name}`, skill, spec);
    }
    if (spec.skills.length > 0) out.add(`${spec.fleet.workspace}/evals/README.md`, evalsReadme(spec));
  }

  out.add(`${spec.handover.dir}/HANDOFF.template.md`, handoffTemplate());
  if (spec.handover.ledger) {
    out.add(`${spec.fleet.workspace}/LEDGER.md`, ledgerTemplate(spec.fleet.name));
  }
  out.add(
    `${spec.fleet.workspace}/CHANGELOG.md`,
    changelogTemplate(spec.fleet.name, options.today),
    { preserve: true }
  );

  if (options.agentsMd !== false) {
    out.add('AGENTS.md', agentsMdPointer(spec));
  }

  return out;
}

function agentFile(agent, spec) {
  return mdWithFrontmatter(
    {
      description: agentDescription(agent, spec),
      mode: 'subagent',
      temperature: 0.2,
      // opencode needs provider-qualified ids (`anthropic/claude-opus-5`), so a
      // tier alone is not enough to emit one. Without a supplied mapping the
      // field is omitted and the subagent inherits its invoker's model, which
      // is a working default — a guessed provider string is not.
      model: spec.defaults.opencodeModels?.[agent.model] ?? undefined,
      variant: agent.effort ? EFFORT_VARIANT[agent.effort] : undefined,
      steps: agent.turns ?? undefined,
      hidden: agent.hidden || undefined,
      permission: capsToPermission(agent, spec),
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
 *
 * `task` and `skill` compile the fleet's own graphs. A subagent denied under
 * `task` is dropped from the task tool's description entirely, so the handoff
 * graph stops being advice the model may ignore and becomes the only set of
 * delegations it can see — which also keeps that description short.
 */
function capsToPermission(agent, spec) {
  const caps = agent.capabilities;
  const allow = (on) => (on ? 'allow' : 'deny');
  return {
    read: 'allow',
    edit: caps.edit ? 'allow' : { '*': 'deny', [`${spec.fleet.workspace}/**`]: 'allow' },
    bash: allow(caps.run),
    webfetch: allow(caps.web),
    websearch: allow(caps.web),
    // Only the agents this one actually hands work to. `*` first: last match wins.
    task:
      caps.spawn || agent.handoff.to.length > 0
        ? { '*': 'deny', ...Object.fromEntries(agent.handoff.to.map((n) => [n, 'allow'])) }
        : 'deny',
    // Same idea for skills: an agent sees only the methodology it was given.
    skill: agent.skills.length > 0 ? { '*': 'deny', ...Object.fromEntries(agent.skills.map((s) => [s, 'allow'])) } : 'deny',
  };
}

function orchestratorAgent(spec) {
  return mdWithFrontmatter(
    {
      description:
        `Orchestrates the ${spec.fleet.name} fleet${spec.fleet.domain ? ` for ${spec.fleet.domain}` : ''} ` +
        `(${spec.agents.map((a) => a.name).join(', ')}). Use for ${spec.orchestrator.trigger}, including re-runs and partial fixes.`,
      mode: 'primary',
      model: spec.defaults.opencodeModels?.smart ?? undefined,
      permission: {
        read: 'allow',
        edit: 'allow',
        bash: 'allow',
        task: { '*': 'deny', ...Object.fromEntries(spec.agents.filter((a) => a.name !== spec.orchestrator.name).map((a) => [a.name, 'allow'])) },
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
      // Force subagent isolation even though the orchestrator is a primary
      // agent: a full fleet run is long, and its intermediate reasoning has no
      // business filling the session the user is working in.
      subtask: true,
    },
    `Run the ${spec.fleet.name} fleet on the following request:\n\n$ARGUMENTS\n\nFollow your orchestrator playbook: Phase 0 context check first, then execute the phases, keep the ledger current, and finish with the completion checklist.`
  );
}

/**
 * Project config. The load-bearing key is `subagent_depth`: it defaults to 1,
 * which stops subagents from launching subagents. A fleet whose orchestrator
 * runs as a subagent — which is what happens when a command uses `subtask` or
 * a parent delegates into it — would silently execute with no fleet at all.
 * Hierarchical fleets need one more level again.
 */
function opencodeConfig(spec) {
  const config = {
    $schema: 'https://opencode.ai/config.json',
    default_agent: spec.orchestrator.name,
    subagent_depth: spec.fleet.pattern === 'hierarchical' ? 3 : 2,
    instructions: ['AGENTS.md'],
  };

  // Long refinement loops and scheduled re-runs are exactly the sessions that
  // hit the context ceiling; pruning stale tool output buys turns, and a wider
  // tail keeps enough recent conversation to resume coherently.
  const longRunning = !!spec.fleet.schedule || (spec.orchestrator.phases ?? []).some((p) => p.loop);
  if (longRunning) config.compaction = { prune: true, tail_turns: 4 };

  if (spec.defaults.opencodeModels?.cheap) config.small_model = spec.defaults.opencodeModels.cheap;

  if (spec.fleet.mcp) {
    config.mcp = Object.fromEntries(
      Object.entries(spec.fleet.mcp).map(([name, m]) => [
        name,
        m.url
          ? { type: 'remote', url: m.url, enabled: true }
          : { type: 'local', command: [m.command, ...m.args], enabled: true, ...(m.env ? { environment: m.env } : {}) },
      ])
    );
  }

  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * A status command that arrives with the answer already in it: `!` runs the
 * shell at expansion time and `@` inlines a file, so the model starts from
 * real workspace state instead of spending its first turn collecting it.
 */
function statusCommand(spec) {
  const ledger = spec.handover.ledger ? `${spec.fleet.workspace}/LEDGER.md` : null;
  const body = [
    `Report the current state of the ${spec.fleet.name} fleet.`,
    '',
    'Handoffs written so far:',
    '',
    `!\`ls -1 ${spec.handover.dir}/*.md 2>/dev/null | grep -v HANDOFF.template || echo "(none yet)"\``,
    '',
  ];
  if (ledger) body.push('Ledger:', '', `@${ledger}`, '');
  body.push(
    'From that state: say which phase the fleet is in, which agents have finished, what is outstanding, and anything that looks stalled or contradictory. Do not start any fleet work — this is a status report.'
  );
  return mdWithFrontmatter(
    { description: `Status of the ${spec.fleet.name} fleet`, agent: spec.orchestrator.name },
    body.join('\n')
  );
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
