import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { rankAgainst, descriptionOverlap } from '../eval/index.js';

/**
 * Vocabulary-overlap threshold above which two descriptions are the same skill
 * wearing two names. Measured, not guessed: see the note at the near-duplicate
 * pass below for the separation this sits inside.
 */
export const NEAR_DUPLICATE = 0.45;

/**
 * Ambient-install hygiene — the check that catches a harness competing with an
 * older copy of itself.
 *
 * `runQa` verifies a spec against the files it generates. It cannot see the
 * environment those files land in, and that environment is where the worst
 * failure of this whole system lives: a stale user-scope install left over from
 * a rename.
 *
 * The observed failure, in full, because it is not obvious from any one file:
 * this fleet was once named `harness-init` with an orchestrator called
 * `build-harness` and handoffs at `_fleet/handoffs/`. After the rename to
 * `fleetsmith` / `harness-builder` / `_fleet/local/handoffs/`, the old copy
 * stayed in `~/.claude/skills/build-harness/`. Because the DIRECTORY names
 * differ, scope precedence never applies — nothing shadows anything, the two
 * simply coexist and compete. Both descriptions were generated from the same
 * template, so they share essentially all their vocabulary: measured with the
 * trigger scorer, six of six realistic prompts tied. Half the time routing lands
 * on the stale playbook, whose agents write to `_fleet/handoffs/` while the
 * SubagentStop hook validates `_fleet/local/handoffs/` — so every fleet agent is
 * blocked by the gate and retries. From the outside this reads as "the
 * orchestrator takes forever to start", with nothing in any report to explain it.
 *
 * Deliberately NOT part of `runQa`:
 *  - It reads `$HOME` and the live filesystem, so its verdict depends on the
 *    machine. A promotion gate that fails on one developer's laptop and passes
 *    in CI is worse than no gate. This is opt-in via `qa --installed`.
 *  - It is advisory in the same sense: the answer is "your machine has drifted",
 *    not "this spec is wrong".
 */

/** Where Claude Code resolves skills and subagents from, nearest scope first. */
export function installRoots({ home = os.homedir(), cwd = process.cwd() } = {}) {
  return [
    { scope: 'project', dir: path.join(cwd, '.claude') },
    { scope: 'user', dir: path.join(home, '.claude') },
  ];
}

/**
 * Read a markdown file's frontmatter.
 *
 * Parsed as YAML rather than pattern-matched. Descriptions in the wild are
 * routinely block scalars (`|-`, `>-`) spanning several lines, and a regex that
 * stops at the first newline silently reads a fraction of the vocabulary — which
 * on this check means a real collision scores as clean. A malformed file yields
 * an empty description rather than throwing: one bad skill on the machine must
 * not take out the report.
 */
function frontmatter(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return { description: '' };
  let parsed;
  try {
    parsed = YAML.parse(m[1]);
  } catch {
    return { description: '' };
  }
  const description = parsed && typeof parsed === 'object' ? parsed.description : '';
  return { description: String(description ?? '').replace(/\s+/g, ' ').trim() };
}

/** Every skill installed at any scope, as {name, scope, file, description}. */
export function installedSkills(opts = {}) {
  const found = [];
  for (const { scope, dir } of installRoots(opts)) {
    const skills = path.join(dir, 'skills');
    if (!fs.existsSync(skills)) continue;
    for (const entry of fs.readdirSync(skills, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(skills, entry.name, 'SKILL.md');
      const fm = frontmatter(file);
      if (!fm) continue;
      // Invocation name is the DIRECTORY name, not the frontmatter `name`.
      found.push({ name: entry.name, scope, file, description: fm.description });
    }
  }
  return found;
}

/** Every subagent installed at any scope. */
export function installedAgents(opts = {}) {
  const found = [];
  for (const { scope, dir } of installRoots(opts)) {
    const agents = path.join(dir, 'agents');
    if (!fs.existsSync(agents)) continue;
    for (const f of fs.readdirSync(agents)) {
      if (!f.endsWith('.md')) continue;
      const file = path.join(agents, f);
      const fm = frontmatter(file);
      if (!fm) continue;
      found.push({ name: f.replace(/\.md$/, ''), scope, file, description: fm.description });
    }
  }
  return found;
}

/**
 * Two findings, because the two failures are genuinely different.
 *
 * **Rivals** are the dangerous one: an installed skill at another scope under a
 * DIFFERENT name that ties with, or beats, one of this fleet's own skills on its
 * own declared trigger prompts. Nothing shadows it, so it competes forever.
 *
 * **Shadowed** copies share a name with a fleet skill or agent, so precedence
 * resolves them and they are harmless here — but they are stale copies that will
 * fire in every OTHER project, against a fleet that does not exist there.
 */
export function checkInstalled(spec, opts = {}) {
  const skills = installedSkills(opts);
  const agents = installedAgents(opts);
  const fleetSkillNames = new Set([...spec.skills.map((s) => s.name), spec.orchestrator.name]);
  const fleetAgentNames = new Set(spec.agents.map((a) => a.name));

  const shadowed = [
    ...skills.filter((s) => s.scope !== 'project' && fleetSkillNames.has(s.name)).map((s) => ({ ...s, kind: 'skill' })),
    ...agents.filter((a) => a.scope !== 'project' && fleetAgentNames.has(a.name)).map((a) => ({ ...a, kind: 'agent' })),
  ];

  // Score each fleet skill's own trigger corpus against the full installed set,
  // then keep only collisions with an OUTSIDER. A fleet skill colliding with
  // another skill of the same fleet is a spec defect that `fleetsmith eval`
  // already reports; surfacing it here as an install problem would send the
  // reader to delete a file that is supposed to be there.
  const corpus = [...skills];
  const byName = new Map(corpus.map((c) => [c.name, c]));
  const isOutsider = (name) => {
    const entry = byName.get(name);
    if (!entry) return false;
    // Belongs to this fleet AND resolves from the project — that is the copy
    // that is meant to be installed.
    return !(entry.scope === 'project' && (fleetSkillNames.has(name) || fleetAgentNames.has(name)));
  };

  const rivals = [];
  const seen = new Set();
  const addRival = (mine, rival, outcome, prompt = null) => {
    const key = `${mine}::${rival}::${outcome}`;
    if (seen.has(key)) return;
    seen.add(key);
    const where = byName.get(rival);
    rivals.push({ skill: mine, prompt, rival, scope: where.scope, file: where.file, outcome });
  };

  for (const skill of spec.skills) {
    if (!byName.has(skill.name)) continue;
    for (const prompt of skill.triggers.should) {
      if (/^TODO/i.test(prompt)) continue;
      const ranked = rankAgainst(prompt, corpus);
      if (!ranked.length) continue;
      const tie = ranked.length > 1 && Math.abs(ranked[0].score - ranked[1].score) < 1e-9;
      const loser = ranked[0].name !== skill.name;
      if (!tie && !loser) continue;
      const rival = loser ? ranked[0] : ranked[1];
      if (!rival || rival.name === skill.name || !isOutsider(rival.name)) continue;
      addRival(skill.name, rival.name, loser ? 'loses to' : 'ties with', prompt);
    }
  }

  // Corpus-free pass, and the one that catches the failure this check was built
  // for. The prompt pass above needs a declared `triggers.should`; the
  // orchestrator has none, and it is precisely the skill a fleet rename
  // duplicates, because its name follows the fleet's. So compare descriptions
  // directly: a near-duplicate of any fleet skill is a rival regardless of
  // whether a prompt exists to prove it.
  //
  // On the install that prompted this, the true duplicate scored 0.691 while the
  // next-nearest of nineteen installed skills scored 0.113. The threshold sits in
  // that gap rather than near either side of it.
  const orchestrator = byName.get(spec.orchestrator.name);
  const mineDescribed = [
    ...spec.skills.filter((s) => byName.has(s.name)).map((s) => ({ name: s.name, description: s.description })),
    ...(orchestrator ? [{ name: orchestrator.name, description: orchestrator.description }] : []),
  ];
  for (const mine of mineDescribed) {
    for (const other of corpus) {
      if (other.name === mine.name || !isOutsider(other.name)) continue;
      if (descriptionOverlap(mine.description, other.description) < NEAR_DUPLICATE) continue;
      addRival(mine.name, other.name, 'is a near-duplicate of');
    }
  }

  const evidence = [
    ...rivals.map(
      (r) =>
        r.prompt
          ? `${r.file}: "${r.prompt}" ${r.outcome} ${r.rival} (${r.scope} scope) instead of routing to ${r.skill}`
          : `${r.file}: ${r.scope}-scope "${r.rival}" ${r.outcome} the fleet's "${r.skill}" — two names, one skill, so neither shadows the other`
    ),
    ...shadowed.map((s) => `${s.file}: stale ${s.scope}-scope ${s.kind} "${s.name}" duplicates a fleet ${s.kind}`),
  ];

  return {
    name: 'ambient install',
    pass: evidence.length === 0,
    evidence,
    detail: evidence.length
      ? 'A competing copy of this fleet is installed at another scope. A differently-named orchestrator is never shadowed — ' +
        'it splits routing, and if it predates a rename its agents write to paths the handoff gate rejects, so every agent ' +
        'is blocked and retries. Remove the stale copies, or reinstall them from the current spec.'
      : '',
    rivals,
    shadowed,
  };
}
