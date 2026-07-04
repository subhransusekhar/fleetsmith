/**
 * Portable handover protocol.
 *
 * The lowest common denominator across Claude Code, opencode, and goose is
 * the filesystem — every tool's agents can read and write files. So the
 * durable handover layer is file-based, and richer channels (Claude Code
 * agent-team messages/tasks) are layered on top when available.
 *
 * Three artifacts:
 *  1. A protocol text block compiled into every agent's system prompt.
 *  2. A HANDOFF.md template each agent fills when passing work on.
 *  3. A ledger (LEDGER.md) the orchestrator owns: one row per task,
 *     giving any agent (or a human) a five-second view of fleet state.
 */

export function handoffTemplate() {
  return `# Handoff: {from} -> {to}

- **Date:** {date}
- **Task:** {one-line task statement}
- **Status:** ready | blocked | partial

## Context digest
{3-8 bullets: decisions made, constraints discovered, dead ends already tried.
Write for a reader with ZERO shared context — they did not see your conversation.}

## Artifacts
| Path | What it is | State |
|------|-----------|-------|
| {relative/path} | {description} | final / draft |

## Acceptance criteria
{What "done" looks like for the receiving agent, as checkable statements.}

## Open questions
{Anything unresolved the receiver must decide or escalate.}
`;
}

export function ledgerTemplate(fleetName) {
  return `# ${fleetName} — Task Ledger

Single source of truth for fleet progress. The orchestrator updates this
after every phase; agents append rows for work they spawn.

| # | Task | Owner | Depends on | Status | Artifact |
|---|------|-------|-----------|--------|----------|
| 1 | (example) analyze requirements | analyst | - | pending | handoffs/01-analyst.md |

Status values: pending / in-progress / done / blocked / dropped.
Never delete rows — mark them dropped with a reason.
`;
}

/**
 * The protocol block injected into every generated agent prompt.
 * `incoming` / `outgoing` are agent names for context wiring.
 */
export function protocolBlock({ agent, dir, ledgerPath, incoming, outgoing, artifact, criteria }) {
  const lines = [];
  lines.push('## Handover protocol');
  lines.push('');
  lines.push(
    `Coordination is file-based under \`${dir}/\`. You did not see other agents' conversations — the handoff files are your only shared memory, so treat them as the contract.`
  );
  lines.push('');
  lines.push('**On start:**');
  if (incoming.length > 0) {
    lines.push(
      `1. Read your incoming handoff(s) from ${incoming.map((n) => `\`${n}\``).join(', ')} in \`${dir}/\` (files matching \`*-to-${agent}.md\`). If one is missing or its acceptance criteria are unclear, say so in your output and proceed with explicit assumptions rather than silently guessing.`
    );
  } else {
    lines.push(`1. You are an entry-point agent: your input comes from the orchestrator's task brief.`);
  }
  if (ledgerPath) lines.push(`2. Read \`${ledgerPath}\` to see fleet state before starting.`);
  lines.push('');
  lines.push('**On finish:**');
  if (outgoing.length > 0) {
    const art = artifact ? ` Your primary artifact contract: \`${artifact}\`.` : '';
    lines.push(
      `1. Write one handoff file per receiver: ${outgoing
        .map((n) => `\`${dir}/{seq}-${agent}-to-${n}.md\``)
        .join(', ')} following the HANDOFF template in \`${dir}/HANDOFF.template.md\`.${art}`
    );
    lines.push(
      '2. The context digest must stand alone: decisions, constraints, dead ends. A receiver acting only on your handoff must not repeat work you already did.'
    );
  } else {
    lines.push('1. You are a terminal agent: write your final result to the path given in your task brief and summarize it in your reply.');
  }
  if (ledgerPath) lines.push(`${outgoing.length > 0 ? 3 : 2}. Update your row in \`${ledgerPath}\` (status + artifact path).`);
  if (criteria?.length) {
    lines.push('');
    lines.push('**Your handoffs are accepted only if:**');
    for (const c of criteria) lines.push(`- ${c}`);
  }
  return lines.join('\n');
}

/**
 * Extra block for Claude Code agent-team mode: layered on top of the
 * file protocol, not a replacement (messages are ephemeral; files survive).
 */
export function teamProtocolBlock({ incoming, outgoing }) {
  const lines = [];
  lines.push('## Team communication (Claude Code teams)');
  lines.push('');
  lines.push('When running as part of an agent team, also:');
  lines.push('- Track your assigned work via the shared task list (TaskUpdate: in_progress on start, completed on finish).');
  if (outgoing.length > 0) {
    lines.push(
      `- After writing a handoff file, SendMessage ${outgoing.map((n) => `\`${n}\``).join(' and ')} a one-paragraph pointer to it. The message is a doorbell; the file is the payload.`
    );
  }
  if (incoming.length > 0) {
    lines.push(
      `- If a message from ${incoming.map((n) => `\`${n}\``).join(' or ')} conflicts with their handoff file, the file wins; ask them to update the file.`
    );
  }
  lines.push('- Escalate blockers to the team lead instead of stalling.');
  return lines.join('\n');
}

/** Compute incoming edges per agent from the handoff graph. */
export function incomingMap(agents) {
  const map = new Map(agents.map((a) => [a.name, []]));
  for (const a of agents) {
    for (const to of a.handoff.to) {
      map.get(to)?.push(a.name);
    }
  }
  return map;
}
