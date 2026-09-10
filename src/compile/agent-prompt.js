import { protocolBlock, teamProtocolBlock, incomingMap, INTENT_FILE } from '../handover/protocol.js';
import { playbookSection } from '../playbook/index.js';
import { DEFAULT_HANDOFF_SCHEMA } from '../spec/schema.js';
import { guardrailsBlock } from './guardrails.js';

/**
 * Compile the tool-agnostic body of an agent's system prompt.
 * Adapters wrap this in their native frontmatter/schema; the body itself
 * is deliberately identical across tools so fleet behavior is portable.
 *
 * Cache discipline: this body is a system prompt, and a system prompt that
 * changes between runs invalidates the prompt cache for everything after it —
 * roughly a 10x cost difference on a fleet that runs repeatedly. So everything
 * here is invariant for a given spec: no dates, no run counters, no phase
 * state. Per-run variance belongs in the handoff files, which are read as
 * ordinary content and cost nothing to change.
 */
export function compileAgentBody(agent, spec, { team = false, playbook = [], guardrailsEnforced = true } = {}) {
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
      ledgerPath: spec.handover.ledger ? `${spec.fleet.local}/LEDGER.md` : null,
      gridPath: spec.fleet.grid ? `${spec.fleet.local}/grid/GRID.md` : null,
      incoming,
      outgoing: agent.handoff.to,
      artifact: agent.handoff.artifact,
      criteria: agent.handoff.criteria,
      schema: agent.handoff.schema ?? DEFAULT_HANDOFF_SCHEMA,
    })
  );

  const checks = checksFor(agent, spec);
  if (checks.length > 0) {
    sections.push('');
    sections.push('## Verifying your work');
    sections.push(
      [
        `Before you finish, run ${checks.map((c) => `\`${c}\``).join(' and ')} yourself and paste the literal output under \`## Verification\` in your handoff (or in your final reply if you are a terminal agent). Exit 0 is the bar. The evidence has to come from the toolchain, not from your reading of the work — a verifier will run the same command, and a mismatch between your paste and their run is itself a finding.`,
        'If a check fails, fix the work, not the check: never edit, skip or delete a failing test or fixture to get green. Where the command passes but the requirement is plainly not met, say so rather than reporting done — a check can be satisfied without the work being right.',
      ].join('\n')
    );
  }

  sections.push('');
  sections.push(guardrailsBlock(spec, { enforced: guardrailsEnforced }));

  if (agent.memory) {
    sections.push('');
    sections.push('## Durable notes');
    sections.push(
      `You persist notes across runs. Keep them in \`${spec.fleet.local}/notes/${agent.name}.md\` — decisions that outlive a single run, recurring pitfalls, and stable facts about this project. Read it before starting and update it when something you learned will still be true next run. Keep it short enough to reread; it is a working memory, not a log.`
    );
  }

  if (team) {
    sections.push('');
    sections.push(teamProtocolBlock({ incoming, outgoing: agent.handoff.to }));
  }

  if (isVerifier(agent, spec)) {
    sections.push('');
    sections.push('## Reviewing');
    sections.push(
      [
        'You review work you did not produce, and you see the artifact and the criteria rather than the reasoning behind them. That is deliberate: judging the result on its own terms is the point, so do not go asking the producer what they meant.',
        '',
        'Run three passes and tag every finding with its pass:',
        '- **Defects** — the artifact is wrong: logic errors, broken edge cases, claims the evidence does not support.',
        `- **Compliance** — the artifact does what \`${spec.handover.dir}/${INTENT_FILE}\` asked and meets the producer's acceptance criteria; scope creep and silently dropped constraints belong here.`,
        '- **Policy** — the methodology in the skills was followed, and nothing under a protected path was touched.',
        '',
        'Rank findings by severity. Reserve **Important** for what would make the deliverable wrong, breach a constraint in the intent, or violate a policy; everything else is a **Nit**. Report at most five nits and summarize the rest as a count. Do not report what a deterministic check already enforces — the handover gate, `fleetsmith qa`, a passing `check` command — repeating it adds noise and no information.',
        '',
        'Flag only gaps that affect correctness or the stated requirements. Anything else — style, alternative designs you would have preferred, hypothetical futures — is optional and must be labelled as such. A reviewer asked to find problems will always find some; reporting weak findings as though they were defects sends the fleet into rework it does not need.',
        '',
        'Every defect needs reproducible evidence: a command and its output, or `file:line`. "This looks fragile" is not a finding. Where the acceptance test is a command, run it yourself and confirm the work actually does what was asked rather than only that the command exits 0 — and compare your output with what the producer pasted under `## Verification`; a mismatch is a finding in its own right.',
        '',
        'A finding you are making for the second time — the same class of mistake in a previous pass or a previous run — is a harness defect, not an output defect. Say so explicitly so the orchestrator routes the correction into the skill or agent definition instead of only fixing the artifact.',
      ].join('\n')
    );
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

  // Learned notes go last: everything above is human-authored and takes
  // precedence, which is the order a reader should encounter them in.
  const learned = playbookSection(agent.name, playbook);
  if (learned) {
    sections.push('');
    sections.push(learned);
  }

  return sections.join('\n');
}

/**
 * Reviewer detection, for the guidance that only helps agents who judge work
 * rather than produce it.
 *
 * A declared review role is the direct signal. Failing that, an agent on a
 * mutual handoff edge (work in, findings back) that cannot edit is a checker:
 * both sides of a refine loop share the edge, but only the side that writes
 * nothing is the one reviewing.
 */
export function isVerifier(agent, spec) {
  if (/\b(verif|review|check|qa|audit)/i.test(`${agent.name} ${agent.role}`)) return true;
  if (agent.capabilities.edit) return false;
  const handsBackTo = new Set(agent.handoff.to);
  return spec.agents.some((a) => handsBackTo.has(a.name) && a.handoff.to.includes(agent.name));
}

/**
 * The objective checks an agent is accountable to: the `loop.check` of every
 * phase it runs in, plus those of any phase it hands work into. The second
 * half is the point — the producer being verified should run the verifier's
 * command before handing off, so what reaches the verifier has already passed
 * it (the playbook's "feedback loop", as distinct from the verifier subagent).
 */
export function checksFor(agent, spec) {
  const phases = spec.orchestrator.phases ?? [];
  const receivers = new Set(agent.handoff.to);
  const checks = [];
  for (const p of phases) {
    if (!p.loop?.check) continue;
    const agents = p.agents ?? [];
    if (agents.includes(agent.name) || agents.some((n) => receivers.has(n))) checks.push(p.loop.check);
  }
  return [...new Set(checks)];
}

export function title(slug) {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
