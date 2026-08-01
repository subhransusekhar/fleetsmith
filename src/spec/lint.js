/**
 * Design-smell lint for a normalized fleet spec.
 *
 * These checks encode failure modes that are cheap to detect at build time and
 * expensive to discover at run time — a fleet whose skills silently stop
 * triggering, or whose parallel agents overwrite each other, looks fine until
 * it is running unattended.
 *
 * Split from validate.js because these are judgments about fleet *design*
 * rather than structural correctness. validate.js answers "will this compile";
 * this answers "will this work well".
 */

/**
 * Claude Code truncates each skill's description (plus `when_to_use`) at this
 * many characters in the skill listing. A description cut mid-sentence loses
 * exactly the trigger vocabulary that makes the skill fire.
 */
export const SKILL_DESCRIPTION_MAX = 1536;

/**
 * The listing itself is budgeted at ~1% of the context window. Past that,
 * descriptions are dropped starting with the least-used skills — so a fleet
 * can silently lose its own triggers. This is a conservative proxy for that
 * budget in characters.
 */
export const SKILL_LISTING_BUDGET = 8000;

export function lintSpec(spec) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  lintParallelWriters(spec, err);
  lintSkillBudgets(spec, err, warn);
  lintSkillContent(spec, warn);
  lintDecomposition(spec, warn);

  return { errors, warnings };
}

/**
 * Concurrent writers are the documented way a multi-agent run destroys work:
 * two agents editing the same tree diverge on implicit decisions no brief
 * captures, and the loser's changes vanish. Readers and reviewers parallelize
 * safely; writers need isolation or sequencing.
 *
 * Claude Code gets `isolation: worktree` automatically, but that does not make
 * the design right on targets without worktrees, so this stays an error with
 * an explicit opt-out.
 */
function lintParallelWriters(spec, err) {
  if (spec.fleet.allowParallelWrites) return;
  for (const phase of spec.orchestrator.phases ?? []) {
    if (!phase.parallel) continue;
    const writers = (phase.agents ?? []).filter(
      (n) => spec.agents.find((a) => a.name === n)?.capabilities.edit
    );
    if (writers.length > 1) {
      err(
        `Phase "${phase.name}" runs ${writers.length} editing agents in parallel (${writers.join(', ')}). ` +
          'Concurrent writers overwrite each other and diverge on decisions no brief captures. ' +
          'Sequence them, make all but one read-only, or set fleet.allowParallelWrites: true if they provably touch disjoint paths.'
      );
    }
  }
}

function lintSkillBudgets(spec, err, warn) {
  let total = 0;
  for (const s of spec.skills) {
    const len = (s.description ?? '').length;
    total += len;
    if (len > SKILL_DESCRIPTION_MAX) {
      err(
        `Skill "${s.name}" description is ${len} chars; Claude Code truncates at ${SKILL_DESCRIPTION_MAX} in the skill listing, ` +
          'which would cut off its trigger vocabulary. Lead with the primary use case and cut the rest.'
      );
    }
  }
  if (total > SKILL_LISTING_BUDGET) {
    warn(
      `Skill descriptions total ${total} chars across ${spec.skills.length} skills. The skill listing is budgeted at ~1% of the ` +
        'context window, and on overflow descriptions are dropped starting with the least-used skills — so some of this fleet\'s ' +
        'skills would stop being discoverable without any error. Tighten descriptions or merge overlapping skills.'
    );
  }
}

/** Mechanically detectable skill-authoring anti-patterns. */
function lintSkillContent(spec, warn) {
  for (const s of spec.skills) {
    const body = s.body ?? '';
    const desc = s.description ?? '';

    if (/^\s*(I |I'll|I will)\b/.test(desc) || /\byou can ask me\b/i.test(desc)) {
      warn(`Skill "${s.name}" description is written in first person; skill matching expects third person ("Extracts…", "Use when…")`);
    }
    // "Use when", "Use this skill when", "Use whenever", "Triggers on …"
    if (!/\buse\b[^.!?]{0,40}?\bwhen|\btrigger/i.test(desc)) {
      warn(`Skill "${s.name}" description says what it does but not when to use it — add an explicit "Use when …" clause with the words a user would actually type`);
    }
    if (/(^|[\s(])[A-Za-z]:\\|\\\\/.test(body)) {
      warn(`Skill "${s.name}" body contains Windows-style paths — use forward slashes, which work on every platform`);
    }
    if (/\b(before|after|as of|until)\s+(January|February|March|April|May|June|July|August|September|October|November|December|20\d\d)\b/i.test(body)) {
      warn(`Skill "${s.name}" body contains time-sensitive wording (dated guidance) — it will quietly become wrong; state the rule, not the date it changed`);
    }
    for (const m of body.matchAll(/\bmcp__(\w+)\b/g)) {
      if (!m[1].includes('_')) {
        warn(`Skill "${s.name}" references MCP tool "${m[0]}" without a server-qualified name — write ServerName:tool_name so it resolves`);
      }
    }
    if (/^(helper|utils?|misc|stuff|tools?)$/i.test(s.name)) {
      warn(`Skill name "${s.name}" is vague — name it for what it does ("processing-pdfs", "reviewing-migrations") so it can be matched`);
    }

    // Progressive disclosure is one level deep: Claude may only partially read
    // files reached from other referenced files, so a reference chain hides
    // content behind a preview.
    for (const [file, content] of Object.entries(s.references ?? {})) {
      const linksOut = [...String(content).matchAll(/\[[^\]]*\]\(([^)]+\.md)\)/g)].map((m) => m[1]);
      const chained = linksOut.filter((l) => !l.startsWith('http'));
      if (chained.length > 0) {
        warn(
          `Skill "${s.name}" reference "${file}" links to further reference(s) (${chained.join(', ')}). ` +
            'Referenced files are loaded one level deep — link them from SKILL.md instead so they are read in full.'
        );
      }
      const lines = String(content).split('\n').length;
      if (lines > 100 && !/^#{1,3}\s*(contents|table of contents|toc)\b/im.test(content)) {
        warn(`Skill "${s.name}" reference "${file}" is ${lines} lines with no contents heading — a partial read would not reveal what is in it`);
      }
    }
  }
}

/**
 * Context-centric decomposition: splitting one body of work into sequential
 * agents that need the same inputs buys coordination overhead and handoff loss
 * without buying isolation. Two adjacent phases whose agents consume exactly
 * the same artifacts are usually one agent with a checklist.
 */
function lintDecomposition(spec, warn) {
  const phases = (spec.orchestrator.phases ?? []).filter((p) => (p.agents ?? []).length === 1);
  for (let i = 1; i < phases.length; i++) {
    const prev = phases[i - 1];
    const cur = phases[i];
    const prevAgent = spec.agents.find((a) => a.name === prev.agents[0]);
    const curAgent = spec.agents.find((a) => a.name === cur.agents[0]);
    if (!prevAgent || !curAgent) continue;
    // Same declared inputs and neither feeds the other: they are two views of
    // one context, not two stages of a pipeline.
    const sameInputs =
      prevAgent.handoff.accepts.length > 0 &&
      JSON.stringify([...prevAgent.handoff.accepts].sort()) === JSON.stringify([...curAgent.handoff.accepts].sort());
    const chained = prevAgent.handoff.to.includes(curAgent.name);
    if (sameInputs && !chained) {
      warn(
        `Phases "${prev.name}" and "${cur.name}" run agents that consume the same inputs and do not hand off to each other — ` +
          'that is one context split in two, which costs a handoff and gains no isolation. Consider merging them into one agent with a checklist.'
      );
    }
  }
}
