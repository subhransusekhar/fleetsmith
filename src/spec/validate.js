import {
  PATTERNS,
  EXECUTION_MODES,
  CAPABILITIES,
  MODEL_TIERS,
  HANDOFF_PROTOCOLS,
} from './schema.js';
import { slugify } from '../lib/md.js';

/**
 * Semantic validation of a normalized fleet spec.
 * Returns { errors: string[], warnings: string[] } — never throws,
 * so CLIs can print everything at once.
 */
export function validateSpec(spec) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  // fleet block
  if (!PATTERNS.includes(spec.fleet.pattern)) {
    err(`fleet.pattern "${spec.fleet.pattern}" is not one of: ${PATTERNS.join(', ')}`);
  }
  if (!EXECUTION_MODES.includes(spec.fleet.execution)) {
    err(`fleet.execution "${spec.fleet.execution}" is not one of: ${EXECUTION_MODES.join(', ')}`);
  }
  if (!spec.fleet.domain) warn('fleet.domain is empty — generated descriptions will be generic');

  // recurring loop (fleet.schedule)
  if (spec.fleet.schedule) {
    const sch = spec.fleet.schedule;
    if (sch.cron && !/^\s*(\S+\s+){4}\S+\s*$/.test(sch.cron)) {
      warn(`fleet.schedule.cron "${sch.cron}" is not a 5-field cron expression`);
    }
    if (sch.cron && sch.interval) {
      warn('fleet.schedule sets both cron and interval — cron wins; interval is ignored');
    }
  }

  // agents
  if (spec.agents.length === 0) err('Fleet has no agents');
  const agentNames = new Set();
  const skillNames = new Set(spec.skills.map((s) => s.name));

  for (const a of spec.agents) {
    if (agentNames.has(a.name)) err(`Duplicate agent name: ${a.name}`);
    agentNames.add(a.name);
    if (a.name !== slugify(a.name)) {
      err(`Agent name "${a.name}" must be kebab-case (got non-slug characters)`);
    }
    if (!a.role) warn(`Agent "${a.name}" has no role — its system prompt will be thin`);
    if (!MODEL_TIERS.includes(a.model)) {
      err(`Agent "${a.name}" model "${a.model}" is not one of: ${MODEL_TIERS.join(', ')}`);
    }
    for (const cap of Object.keys(a.capabilities)) {
      if (!CAPABILITIES.includes(cap)) {
        err(`Agent "${a.name}" declares unknown capability "${cap}"`);
      }
    }
    if (!HANDOFF_PROTOCOLS.includes(a.handoff.protocol)) {
      err(`Agent "${a.name}" handoff.protocol "${a.handoff.protocol}" invalid`);
    }
    for (const s of a.skills) {
      if (!skillNames.has(s)) err(`Agent "${a.name}" references unknown skill "${s}"`);
    }
  }

  // handoff graph
  for (const a of spec.agents) {
    for (const to of a.handoff.to) {
      if (!agentNames.has(to)) {
        err(`Agent "${a.name}" hands off to unknown agent "${to}"`);
      }
    }
    if (a.handoff.to.length > 0 && !a.handoff.artifact) {
      warn(`Agent "${a.name}" hands off without an artifact contract — receivers get no durable context`);
    }
  }
  const cycle = findCycle(spec.agents);
  // generate-verify's producer<->checker loop and the supervisor family's
  // delegate-and-return edges are intentional cycles
  if (cycle && !['supervisor', 'hierarchical', 'expert-pool', 'generate-verify'].includes(spec.fleet.pattern)) {
    warn(`Handoff cycle detected (${cycle.join(' -> ')}); fine for supervisor loops, suspicious for ${spec.fleet.pattern}`);
  }

  // orphans: agents nobody hands to and who hand to nobody, in multi-agent fleets
  if (spec.agents.length > 1) {
    const receiving = new Set(spec.agents.flatMap((a) => a.handoff.to));
    for (const a of spec.agents) {
      if (a.handoff.to.length === 0 && !receiving.has(a.name)) {
        warn(`Agent "${a.name}" is disconnected from the handoff graph`);
      }
    }
  }

  // skills
  const seen = new Set();
  for (const s of spec.skills) {
    if (seen.has(s.name)) err(`Duplicate skill name: ${s.name}`);
    seen.add(s.name);
    if (s.name !== slugify(s.name)) err(`Skill name "${s.name}" must be kebab-case`);
    // Agent Skills open spec (agentskills.io): name 1-64 chars, no consecutive
    // hyphens; description 1-1024 chars. Enforced here so emitted skills load
    // in every spec-compliant client, not just Claude Code.
    if (s.name.length > 64) err(`Skill name "${s.name}" exceeds 64 chars (Agent Skills spec limit)`);
    if (s.name.includes('--')) err(`Skill name "${s.name}" has consecutive hyphens (invalid per Agent Skills spec)`);
    if (!s.description) err(`Skill "${s.name}" needs a description — it is the only trigger mechanism`);
    if (s.description && s.description.length > 1024) {
      err(`Skill "${s.name}" description exceeds 1024 chars (Agent Skills spec limit)`);
    }
    if (s.description && s.description.length < 60) {
      warn(`Skill "${s.name}" description is short (<60 chars); pushy, trigger-rich descriptions fire more reliably`);
    }
    if (s.body && s.body.split('\n').length > 500) {
      warn(`Skill "${s.name}" body exceeds 500 lines — move detail into references/`);
    }
    const attached = spec.agents.some((a) => a.skills.includes(s.name));
    if (!attached) warn(`Skill "${s.name}" is not attached to any agent`);
  }

  // orchestrator phases reference real agents; iteration loops are bounded
  for (const p of spec.orchestrator.phases ?? []) {
    for (const n of p.agents ?? []) {
      if (!agentNames.has(n)) err(`Orchestrator phase "${p.name}" references unknown agent "${n}"`);
    }
    if (p.loop) {
      if (!Number.isInteger(p.loop.max) || p.loop.max < 1) {
        err(`Orchestrator phase "${p.name}" loop.max must be a positive integer`);
      } else if (p.loop.max > 10) {
        warn(`Orchestrator phase "${p.name}" loop.max is ${p.loop.max} — high bounds risk long runaway loops; keep refinement loops tight`);
      }
      if (!p.loop.until && !p.loop.check) {
        warn(`Orchestrator phase "${p.name}" loop has no exit condition (until/check) — it will always run to max iterations`);
      }
    }
  }

  return { errors, warnings, ok: errors.length === 0 };
}

/** DFS cycle detection over the handoff graph; returns one cycle path or null. */
function findCycle(agents) {
  const graph = new Map(agents.map((a) => [a.name, a.handoff.to]));
  const state = new Map(); // 0=unvisited 1=in-stack 2=done
  const stack = [];

  function dfs(node) {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === 1) {
        return [...stack.slice(stack.indexOf(next)), next];
      }
      if (!state.get(next)) {
        const found = dfs(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(node, 2);
    return null;
  }

  for (const a of agents) {
    if (!state.get(a.name)) {
      const found = dfs(a.name);
      if (found) return found;
    }
  }
  return null;
}
