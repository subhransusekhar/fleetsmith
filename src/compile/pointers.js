/**
 * AGENTS.md — the tool-neutral harness pointer.
 *
 * AGENTS.md is the open cross-tool instruction standard (agents.md, Linux
 * Foundation): opencode reads it natively (project > global precedence),
 * goose loads it as a first-class context file (before .goosehints), and
 * 20+ other tools honor it. One shared generator keeps content identical
 * across adapters so combined builds deduplicate cleanly.
 * Claude Code keeps its own CLAUDE.md pointer (it reads AGENTS.md only via
 * @import or symlink).
 */
export function agentsMdPointer(spec, today = 'YYYY-MM-DD') {
  return `# ${spec.fleet.name} — agent harness

**Goal:** ${spec.fleet.domain || spec.fleet.name}

For ${spec.orchestrator.trigger}, run the fleet orchestrator instead of working solo. Simple questions can be answered directly.

## Invoking the fleet

- **opencode:** run \`/${spec.orchestrator.name}\`, or switch to the \`${spec.orchestrator.name}\` primary agent (fleet subagents live in \`.opencode/agents/\`).
- **goose:** \`goose run --recipe .goose/recipes/${spec.orchestrator.name}.yaml\`
- **Claude Code:** the \`${spec.orchestrator.name}\` skill triggers on domain requests (see CLAUDE.md).

## Coordination

Fleet coordination is file-based under \`${spec.fleet.workspace}/\`: handoff documents in \`${spec.handover.dir}/\` (template provided) and a task ledger${spec.handover.ledger ? ` at \`${spec.fleet.workspace}/LEDGER.md\`` : ''}. Handoff files are the source of truth between agents — read them before resuming or auditing fleet work, and never delete them mid-run.

## Changelog

| Date | Change | Target | Reason |
|------|--------|--------|--------|
| ${today} | Initial fleet build (fleetsmith) | all | - |
`;
}
