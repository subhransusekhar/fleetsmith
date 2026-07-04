/**
 * The Fleet Spec is the single tool-agnostic source of truth.
 * Adapters compile it into Claude Code, opencode, and goose artifacts.
 *
 * Design principles:
 *  - Capabilities, not tool names. An agent declares WHAT it may do
 *    (read/edit/run/web/spawn); each adapter maps that onto the target
 *    tool's permission model.
 *  - Handovers are first-class. Every edge between agents carries an
 *    artifact contract so context transfer is explicit and auditable.
 *  - Skills carry the "how", agents carry the "who". The same skill can
 *    be attached to many agents and is emitted once per target.
 */

export const PATTERNS = [
  'pipeline', // sequential dependency chain
  'fanout', // parallel independent workers -> merge
  'expert-pool', // router picks specialists on demand
  'generate-verify', // producers paired with adversarial checkers
  'supervisor', // central coordinator owns state, delegates dynamically
  'hierarchical', // supervisors of supervisors
];

export const EXECUTION_MODES = ['team', 'subagents', 'hybrid'];

/** Abstract capability flags mapped per-tool by adapters. */
export const CAPABILITIES = ['read', 'edit', 'run', 'web', 'spawn'];

/** Abstract model tiers; adapters resolve to concrete model ids. */
export const MODEL_TIERS = ['smart', 'fast', 'cheap', 'inherit'];

export const HANDOFF_PROTOCOLS = ['file', 'task', 'message'];

const DEFAULT_CAPS = { read: true, edit: false, run: false, web: false, spawn: false };

/**
 * Normalize a raw parsed fleet spec into its canonical shape,
 * filling defaults. Throws on structural errors it cannot default.
 * Semantic validation lives in validate.js.
 */
export function normalizeSpec(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Fleet spec must be a YAML mapping');
  const spec = structuredClone(raw);

  spec.version ??= 1;
  spec.fleet ??= {};
  spec.fleet.name ??= 'unnamed-fleet';
  spec.fleet.pattern ??= 'pipeline';
  spec.fleet.execution ??= 'subagents';
  spec.fleet.workspace ??= '_fleet';
  spec.fleet.domain ??= spec.fleet.description ?? '';

  spec.defaults ??= {};
  spec.defaults.model ??= 'inherit';
  spec.defaults.capabilities = { ...DEFAULT_CAPS, ...(spec.defaults.capabilities ?? {}) };

  spec.agents = (spec.agents ?? []).map((a) => normalizeAgent(a, spec));
  spec.skills = (spec.skills ?? []).map(normalizeSkill);

  spec.orchestrator ??= {};
  spec.orchestrator.name ??= `run-${spec.fleet.name}`;
  spec.orchestrator.trigger ??= `${spec.fleet.domain || spec.fleet.name} tasks`;
  spec.orchestrator.phases ??= defaultPhases(spec);

  spec.handover ??= {};
  spec.handover.strategy ??= 'file';
  spec.handover.ledger ??= true;
  spec.handover.dir ??= `${spec.fleet.workspace}/handoffs`;

  return spec;
}

function normalizeAgent(a, spec) {
  if (!a.name) throw new Error('Every agent needs a name');
  const agent = { ...a };
  agent.role ??= '';
  agent.goal ??= '';
  agent.model ??= spec.defaults.model;
  agent.capabilities = { ...spec.defaults.capabilities, ...(a.capabilities ?? {}) };
  agent.skills ??= [];
  agent.handoff = normalizeHandoff(a.handoff);
  agent.principles ??= [];
  agent.prompt ??= '';
  return agent;
}

function normalizeHandoff(h) {
  if (!h) return { to: [], protocol: 'file', artifact: null, accepts: [] };
  return {
    to: toArray(h.to),
    protocol: h.protocol ?? 'file',
    artifact: h.artifact ?? null,
    accepts: toArray(h.accepts),
    criteria: toArray(h.criteria),
  };
}

function normalizeSkill(s) {
  if (!s.name) throw new Error('Every skill needs a name');
  return {
    name: s.name,
    description: s.description ?? '',
    body: s.body ?? '',
    references: s.references ?? {},
    scripts: s.scripts ?? {},
    assets: s.assets ?? {},
  };
}

/** Derive phases from the pattern when the author didn't write any. */
function defaultPhases(spec) {
  const names = spec.agents.map((a) => a.name);
  if (names.length === 0) return [];
  switch (spec.fleet.pattern) {
    case 'fanout': {
      const last = names[names.length - 1];
      const workers = names.slice(0, -1);
      return [
        { name: 'Fan out', mode: spec.fleet.execution, agents: workers.length ? workers : names, parallel: true },
        ...(workers.length ? [{ name: 'Merge', mode: spec.fleet.execution, agents: [last] }] : []),
      ];
    }
    case 'generate-verify': {
      const mid = Math.ceil(names.length / 2);
      return [
        { name: 'Generate', mode: spec.fleet.execution, agents: names.slice(0, mid), parallel: true },
        { name: 'Verify', mode: spec.fleet.execution, agents: names.slice(mid), parallel: true },
      ];
    }
    case 'supervisor':
    case 'hierarchical':
    case 'expert-pool':
      return [{ name: 'Coordinate', mode: 'team', agents: names, parallel: false }];
    case 'pipeline':
    default:
      return names.map((n, i) => ({
        name: `Stage ${i + 1}: ${n}`,
        mode: spec.fleet.execution,
        agents: [n],
      }));
  }
}

function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}
