import { title } from './agent-prompt.js';

/**
 * Compile the orchestrator playbook body. The workflow logic is shared;
 * only the "how to invoke an agent" section is target-specific.
 */
export function compileOrchestratorBody(spec, target) {
  const o = spec.orchestrator;
  const s = [];

  s.push(`# ${title(o.name)}`);
  s.push('');
  s.push(`Orchestrator for the **${spec.fleet.name}** fleet` +
    (spec.fleet.domain ? ` — ${spec.fleet.domain}.` : '.'));
  s.push('');
  s.push(`- Pattern: **${spec.fleet.pattern}** · Execution: **${spec.fleet.execution}**`);
  s.push(`- Agents: ${spec.agents.map((a) => `\`${a.name}\``).join(', ')}`);
  s.push(`- Workspace: \`${spec.fleet.workspace}/\` (handoffs in \`${spec.handover.dir}/\`${spec.handover.ledger ? `, ledger at \`${spec.fleet.workspace}/LEDGER.md\`` : ''})`);

  s.push('');
  s.push('## Phase 0: Context check');
  s.push('');
  s.push(`Before anything, check \`${spec.fleet.workspace}/\`:`);
  s.push(`- Workspace exists **and** the user asks for a partial fix → **partial re-run**: invoke only the affected agent(s), passing the prior handoff files as input.`);
  s.push(`- Workspace exists **and** the user provides new input → **fresh run**: move the old workspace to \`${spec.fleet.workspace}_prev/\` first.`);
  s.push(`- No workspace → **initial run**: create \`${spec.handover.dir}/\`${spec.handover.ledger ? ' and seed the ledger from the template' : ''}.`);

  s.push('');
  s.push('## Invocation');
  s.push('');
  s.push(invocationSection(spec, target));

  s.push('');
  s.push('## Phases');
  for (const [i, phase] of (o.phases ?? []).entries()) {
    s.push('');
    s.push(`### Phase ${i + 1}: ${phase.name}`);
    if (phase.mode) s.push(`**Execution mode:** ${phase.mode}${phase.parallel ? ' (parallel)' : ''}`);
    s.push('');
    s.push(`Agents: ${phase.agents.map((n) => `\`${n}\``).join(', ')}.`);
    if (phase.parallel && phase.agents.length > 1) {
      s.push('Launch these agents concurrently; none depends on another within this phase.');
    }
    for (const n of phase.agents) {
      const a = spec.agents.find((x) => x.name === n);
      if (!a) continue;
      const outEdges = a.handoff.to.length
        ? ` Hands off to ${a.handoff.to.map((t) => `\`${t}\``).join(', ')}${a.handoff.artifact ? ` (artifact: \`${a.handoff.artifact}\`)` : ''}.`
        : ' Terminal agent — its output is (part of) the final deliverable.';
      s.push(`- \`${n}\`: ${a.goal || a.role}.${outEdges}`);
    }
    if (phase.gate) {
      s.push('');
      s.push(`**Gate before next phase:** ${phase.gate}`);
    }
  }

  s.push('');
  s.push('## Data flow');
  s.push('');
  s.push(`- Durable handovers are file-based: agents write \`${spec.handover.dir}/{seq}-{from}-to-{to}.md\` per the bundled template. Verify each expected handoff file exists before starting the next phase; a missing file means the phase is not done, whatever the agent claimed.`);
  if (spec.fleet.execution !== 'subagents' && target === 'claude-code') {
    s.push('- In team mode, messages and the shared task list coordinate timing; files remain the source of truth for content.');
  }
  s.push(`- Final deliverables go to the user-specified path; intermediates stay in \`${spec.fleet.workspace}/\` for audit.`);

  s.push('');
  s.push('## Error handling');
  s.push('');
  s.push('- Agent fails → retry once with the failure appended to its brief. Second failure → proceed without that output and record the gap in the ledger and the final report.');
  s.push('- Conflicting outputs from parallel agents → do not discard either; present both with sources and either resolve via a named criterion or escalate to the user.');
  s.push('- A handoff missing its acceptance criteria → send it back to the producing agent once; then accept with a `PARTIAL` marker.');

  s.push('');
  s.push('## Completion');
  s.push('');
  s.push(`1. Confirm every ledger row is done/dropped with a reason.`);
  s.push('2. Summarize deliverables + gaps for the user.');
  s.push('3. Ask one short feedback question ("anything to improve in the result or the fleet workflow?") — if feedback arrives, route it: output quality → the agent\'s skill; role gaps → agent definition; ordering → this orchestrator; then record the change in the harness changelog.');

  s.push('');
  s.push('## Test scenarios');
  s.push('');
  s.push(`- **Happy path:** ${o.happyPath ?? `run the full ${spec.fleet.pattern} across all agents on a small representative input; every handoff file exists and the ledger is fully done.`}`);
  s.push(`- **Failure path:** ${o.failurePath ?? 'kill one mid-pipeline agent (simulate by making its input unavailable); the run must complete with a documented gap, not stall.'}`);

  return s.join('\n');
}

function invocationSection(spec, target) {
  switch (target) {
    case 'claude-code':
      if (spec.fleet.execution === 'team') {
        return [
          'Run as an **agent team** (experimental — requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; the team forms when you spawn the first teammate, and you are the fixed lead). Spawn the fleet agents as teammates, create one shared task per ledger row with dependencies mirroring the handoff graph, and let teammates self-coordinate via messages. Monitor, unblock, verify gates; the team cleans up when the session ends.',
          '',
          `Teammates reuse the agent definitions in \`.claude/agents/\` (${spec.agents.map((a) => a.name).join(', ')}) — their tools and model apply; skill preloading does not, so teammates load skills per their prompt instructions.`,
          '',
          'If agent teams are unavailable, fall back to subagent execution below — the file protocol makes both modes equivalent in outcome.',
        ].join('\n');
      }
      if (spec.fleet.execution === 'hybrid') {
        return 'Hybrid execution: each phase below states its mode. For `subagents` phases use the Agent tool (background for parallel groups); for `team` phases create a team for that phase, then disband before the next.';
      }
      return 'Invoke each agent with the Agent tool using its definition in `.claude/agents/` (subagent_type matches the agent name). Launch parallel groups in one message with `run_in_background`; collect results before gated phases.';
    case 'opencode':
      return [
        'In opencode, fleet agents are **subagents** in `.opencode/agent/`. Invoke them with the Task tool (or let the user @-mention them). Run this orchestrator as the primary agent.',
        'Parallel phases: issue multiple Task calls in one turn.',
      ].join('\n');
    case 'goose':
      return [
        'In goose, each fleet agent is a **sub-recipe** registered on this orchestrator recipe. Execute phases with the subagent task tool: sequential phases run tasks one by one; parallel phases pass multiple tasks at once.',
        'Each sub-recipe already embeds its handover protocol; your job is sequencing, gate checks, and ledger upkeep.',
      ].join('\n');
    default:
      return 'Invoke each agent per your platform\'s subagent mechanism.';
  }
}
