import fs from 'node:fs';
import path from 'node:path';

/**
 * Harness health — aggregation of run telemetry into decision-grade signals.
 *
 * Raw events say what happened; these say what is *wrong*, and with which
 * artifact. The five metrics are SkillOps' (arXiv 2605.13716), which were
 * defined for exactly our artifact type — a markdown skill library — and are
 * reported there to work with **zero additional task-time LLM calls**. Nothing
 * in this module calls a model, and nothing here should ever start.
 *
 * The ΔH early exit matters as much as the metrics. A self-evolving system
 * that re-derives "nothing changed" on every run is a system that costs money
 * to stand still, so when aggregate health has not moved, the loop stops here.
 */

/** Below this aggregate change, maintenance is skipped entirely. */
export const DELTA_H_THRESHOLD = 0.05;

/** Utility at or under this, over enough runs, makes a skill an eviction candidate. */
export const EVICTION_UTILITY = 0.05;
export const EVICTION_MIN_RUNS = 10;

/**
 * Read every run log under <local>/runs and reduce it to per-agent and
 * per-skill health.
 *
 * `previous` is the last health.json, used only to compute ΔH.
 */
export function computeHealth(spec, { runsDir, previous = null } = {}) {
  const events = readEvents(runsDir);
  const runs = new Set(events.map((e) => e.run_id)).size;

  const agents = {};
  for (const agent of spec.agents) {
    const mine = events.filter((e) => e.agent === agent.name);
    const passes = mine.filter((e) => e.event === 'gate_pass').length;
    const blocks = mine.filter((e) => e.event === 'gate_block').length;
    const errors = mine.filter((e) => e.event === 'execute_tool_error').length;
    const feedback = mine.filter((e) => e.event === 'feedback').length;
    const attempts = passes + blocks;

    agents[agent.name] = {
      // Fraction of handovers accepted without the gate sending it back.
      utility: attempts > 0 ? round(passes / attempts) : null,
      // Gate blocks, tool errors, and human corrections all count: a human
      // having to correct an agent is the strongest failure signal available,
      // and the cheapest to collect.
      failureRisk: attempts + errors + feedback > 0 ? round((blocks + errors + feedback) / (attempts + errors + feedback)) : 0,
      // A handoff edge with no acceptance criteria cannot be checked by
      // anything, human or machine.
      validationGap: agent.handoff.to.length > 0 && (agent.handoff.criteria ?? []).length === 0,
      observed: { passes, blocks, errors, feedback },
      // Per-actor breakdown. "Fails for everyone" and "fails for one person's
      // setup" look identical in an aggregate and mean opposite things — only
      // the first is a harness defect, and the evolution loop must not
      // mistake one for the other.
      actors: byActor(mine),
    };
  }

  const skills = {};
  for (const skill of spec.skills) {
    const users = spec.agents.filter((a) => a.skills.includes(skill.name));
    const risks = users.map((a) => agents[a.name]?.failureRisk ?? 0);
    skills[skill.name] = {
      // A skill nothing references is dead weight regardless of its quality.
      utility: users.length === 0 ? 0 : round(1 - avg(risks)),
      redundancy: round(maxSimilarity(skill, spec.skills)),
      // No eval cases means no way to tell whether a change to it helped.
      validationGap: skill.triggers.should.length === 0 && skill.triggers.shouldNot.length === 0,
      usedBy: users.map((a) => a.name),
    };
  }

  // Handoff compatibility is a fleet-level property: an edge whose producer
  // and consumer disagree about the artifact is a break waiting for a run.
  const edges = [];
  for (const a of spec.agents) {
    for (const to of a.handoff.to) {
      const receiver = spec.agents.find((x) => x.name === to);
      edges.push({ from: a.name, to, compatible: !!receiver && !!a.handoff.artifact });
    }
  }
  const compatibility = edges.length ? round(edges.filter((e) => e.compatible).length / edges.length) : 1;

  const health = {
    fleet: spec.fleet.name,
    runs,
    events: events.length,
    compatibility,
    agents,
    skills,
    evictionCandidates: evictionCandidates(skills, runs),
  };
  health.aggregate = aggregate(health);
  health.deltaH = previous?.aggregate === undefined ? null : round(Math.abs(health.aggregate - previous.aggregate));
  health.maintenanceNeeded = health.deltaH === null ? health.runs > 0 : health.deltaH > DELTA_H_THRESHOLD;
  return health;
}

/**
 * Skills the loop may retire without asking. Deliberately conservative: low
 * utility over a handful of runs is noise, so the rule needs both a floor and
 * a sample size (SkillMentor evicts below 0.05).
 */
function evictionCandidates(skills, runs) {
  if (runs < EVICTION_MIN_RUNS) return [];
  return Object.entries(skills)
    .filter(([, s]) => s.utility <= EVICTION_UTILITY)
    .map(([name]) => name);
}

/** One number, so ΔH has something to compare. Lower is healthier. */
function aggregate(health) {
  const risks = Object.values(health.agents).map((a) => a.failureRisk);
  const gaps = [
    ...Object.values(health.agents).map((a) => (a.validationGap ? 1 : 0)),
    ...Object.values(health.skills).map((s) => (s.validationGap ? 1 : 0)),
  ];
  const redundancy = Object.values(health.skills).map((s) => s.redundancy);
  return round(avg([avg(risks), avg(gaps), avg(redundancy), 1 - health.compatibility]));
}

/**
 * Token-overlap similarity against the most similar sibling. No embedding
 * dependency: this project ships one runtime dependency, and a duplicate-body
 * check does not justify a second.
 */
function maxSimilarity(skill, all) {
  const mine = tokenSet(skill.body);
  if (mine.size === 0) return 0;
  let max = 0;
  for (const other of all) {
    if (other.name === skill.name) continue;
    const theirs = tokenSet(other.body);
    if (theirs.size === 0) continue;
    let shared = 0;
    for (const t of mine) if (theirs.has(t)) shared++;
    max = Math.max(max, shared / Math.min(mine.size, theirs.size));
  }
  return max;
}

function tokenSet(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 3)
  );
}

function byActor(events) {
  const out = {};
  for (const e of events) {
    const actor = String(e.run_id ?? '').split('-')[0] || 'unknown';
    out[actor] ??= { passes: 0, blocks: 0 };
    if (e.event === 'gate_pass') out[actor].passes++;
    if (e.event === 'gate_block') out[actor].blocks++;
  }
  return out;
}

export function readEvents(runsDir) {
  if (!runsDir || !fs.existsSync(runsDir)) return [];
  const events = [];
  for (const entry of fs.readdirSync(runsDir)) {
    const file = path.join(runsDir, entry, 'events.jsonl');
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // A truncated final line is normal while a run is in flight; a
        // malformed record must never take down the aggregation.
      }
    }
  }
  return events;
}

export function formatHealth(health) {
  const lines = [`fleet: ${health.fleet} — ${health.runs} run(s), ${health.events} event(s)`, ''];
  lines.push('agent                  utility  risk   gap   actors');
  for (const [name, a] of Object.entries(health.agents)) {
    lines.push(
      `${name.padEnd(22)} ${fmt(a.utility).padEnd(8)} ${fmt(a.failureRisk).padEnd(6)} ${(a.validationGap ? 'yes' : '-').padEnd(5)} ${
        Object.keys(a.actors).join(',') || '-'
      }`
    );
  }
  if (Object.keys(health.skills).length) {
    lines.push('');
    lines.push('skill                  utility  redund gap   used by');
    for (const [name, s] of Object.entries(health.skills)) {
      lines.push(
        `${name.padEnd(22)} ${fmt(s.utility).padEnd(8)} ${fmt(s.redundancy).padEnd(6)} ${(s.validationGap ? 'yes' : '-').padEnd(5)} ${
          s.usedBy.join(',') || '(unused)'
        }`
      );
    }
  }
  lines.push('');
  lines.push(`compatibility: ${fmt(health.compatibility)}   aggregate: ${fmt(health.aggregate)}`);
  if (health.evictionCandidates.length) {
    lines.push(`eviction candidates: ${health.evictionCandidates.join(', ')}`);
  }
  lines.push(
    health.maintenanceNeeded
      ? `maintenance needed (ΔH ${health.deltaH ?? 'n/a'})`
      : `no maintenance needed (ΔH ${health.deltaH ?? 0} <= ${DELTA_H_THRESHOLD})`
  );
  return lines.join('\n');
}

const round = (n) => Math.round(n * 1000) / 1000;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmt = (n) => (n === null ? '-' : String(n));
