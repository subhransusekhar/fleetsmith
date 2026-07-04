import { protocolBlock, teamProtocolBlock, incomingMap } from '../handover/protocol.js';

/**
 * Compile the tool-agnostic body of an agent's system prompt.
 * Adapters wrap this in their native frontmatter/schema; the body itself
 * is deliberately identical across tools so fleet behavior is portable.
 */
export function compileAgentBody(agent, spec, { team = false } = {}) {
  const incoming = incomingMap(spec.agents).get(agent.name) ?? [];
  const sections = [];

  sections.push(`# ${title(agent.name)}`);
  sections.push('');
  sections.push(`You are the **${agent.name}** agent of the *${spec.fleet.name}* fleet` +
    (spec.fleet.domain ? ` (domain: ${spec.fleet.domain}).` : '.'));
  sections.push('');
  sections.push('## Role');
  sections.push(agent.role || '(role not specified)');
  if (agent.goal) {
    sections.push('');
    sections.push('## Goal');
    sections.push(agent.goal);
  }

  if (agent.principles.length > 0) {
    sections.push('');
    sections.push('## Working principles');
    for (const p of agent.principles) sections.push(`- ${p}`);
  }

  if (agent.skills.length > 0) {
    sections.push('');
    sections.push('## Skills');
    sections.push(
      `Before starting, load your skill(s): ${agent.skills
        .map((s) => `**${s}**`)
        .join(', ')}. They carry the methodology; do not improvise a different process when a skill covers the task.`
    );
  }

  sections.push('');
  sections.push(
    protocolBlock({
      agent: agent.name,
      dir: spec.handover.dir,
      ledgerPath: spec.handover.ledger ? `${spec.fleet.workspace}/LEDGER.md` : null,
      incoming,
      outgoing: agent.handoff.to,
      artifact: agent.handoff.artifact,
      criteria: agent.handoff.criteria,
    })
  );

  if (team) {
    sections.push('');
    sections.push(teamProtocolBlock({ incoming, outgoing: agent.handoff.to }));
  }

  sections.push('');
  sections.push('## Error handling');
  sections.push(
    [
      '- Retry a failed step once with an adjusted approach; on second failure, record the failure in your handoff/ledger row and continue with what you have — a documented gap beats silent stalling.',
      '- Never fabricate data to fill a gap; mark it `MISSING:` with what you tried.',
      '- If a previous handoff exists from an earlier run, read it and improve on it instead of starting from scratch.',
    ].join('\n')
  );

  if (agent.prompt) {
    sections.push('');
    sections.push('## Additional instructions');
    sections.push(agent.prompt.trim());
  }

  return sections.join('\n');
}

export function title(slug) {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
