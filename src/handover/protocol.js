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

- **Task:** {one-line task statement}
- **Status:** ready | blocked | partial

## Objective
{What the receiving agent must accomplish, in one sentence. Not what you did —
what they now have to do.}

## Output format
{The exact shape the receiver should produce: file, sections, schema, length.}

## Sources and tools
{Where to look and what to use — file paths, queries, commands, URLs. Carry
POINTERS, not pasted contents: a path the receiver reads on demand beats a wall
of text they must re-read every turn.}

## Boundaries
{Explicit out-of-scope items and stopping conditions, so two agents do not
independently do the same work or wander past the edge of the task.}

## Context digest
{3-8 bullets: decisions made and why, constraints discovered, assumptions in
force. Write for a reader with ZERO shared context — they did not see your
conversation and cannot ask you.}

## Failed approaches
{What you tried that did not work, and how it failed. Keep this even when it
looks like noise: without the evidence, the receiver repeats your dead ends.
When context is compacted, preserve this section.}

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
 * The harness changelog — the fleet's own learning record.
 *
 * It lives in the workspace, not in CLAUDE.md/AGENTS.md, because those are
 * regenerated on every build: a changelog kept there is destroyed by the next
 * `build --force`, taking every recorded learning with it. This file is
 * emitted in the "preserve" class (seeded once, never overwritten), so rows
 * appended by a run — or by an evolution proposal — survive rebuilds.
 */
export function changelogTemplate(fleetName, today = 'YYYY-MM-DD') {
  return `# ${fleetName} — Harness Changelog

Append-only record of changes to this harness: what changed, where it landed,
and why. The orchestrator writes a row whenever feedback is routed into a
skill, agent, or orchestrator change. Never rewrite history — add a row.

\`Origin\` is \`human\` for hand-authored changes and \`evolved\` for changes
proposed by an automated evolution cycle.

| Date | Change | Target | Origin | Reason |
|------|--------|--------|--------|--------|
| ${today} | Initial fleet build (fleetsmith) | all | human | - |
`;
}

/**
 * The protocol block injected into every generated agent prompt.
 * `incoming` / `outgoing` are agent names for context wiring. `gridPath`
 * (G4.1) is set only when the spec has a `grid:` block — compiled
 * conditionally so a grid-disabled fleet's output is byte-identical to a
 * build with no grid awareness at all. Like `ledgerPath`, only ever a path:
 * the cache-stability invariant (`src/compile/agent-prompt.js`'s own doc
 * comment) forbids anything run-varying — never GRID.md's actual content —
 * from entering a compiled prompt.
 */
export function protocolBlock({ agent, dir, ledgerPath, gridPath, incoming, outgoing, artifact, criteria, schema }) {
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
  if (outgoing.length > 0 && schema) {
    lines.push('');
    lines.push('**Required sections in your handoff file** (a gate checks these; a missing one sends you back):');
    for (const [field, desc] of Object.entries(schema)) {
      lines.push(`- \`${sectionHeading(field)}\` — ${desc}`);
    }
  }
  if (gridPath) {
    lines.push('');
    lines.push('**Grid awareness** (multi-developer sync is enabled for this fleet):');
    lines.push(
      `Before claiming a task, read \`${gridPath}\`. If another actor's in-progress task declares files or symbols overlapping yours: say so in your handoff's Context digest, and prefer declaring a dependency on their artifact (\`depends on: @<actor>#<task-seq>\` in your ledger row) over re-implementing. Grid state is advisory and may be stale — the files in this checkout are the truth. If \`${gridPath}\` is missing or marked unreachable, proceed exactly as if the grid did not exist.`
    );
  }
  lines.push('');
  lines.push('**What you return to the orchestrator:**');
  lines.push(
    'A distilled summary of roughly 1,000–2,000 tokens: what you found or produced, the artifact paths, and open questions. Not your search trace, not the file contents — the files are already on disk and re-narrating them costs the orchestrator context it needs for every remaining phase.'
  );
  return lines.join('\n');
}

/** `output_format` -> `Output format`: schema field names as template headings. */
function sectionHeading(field) {
  const words = String(field).replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
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
