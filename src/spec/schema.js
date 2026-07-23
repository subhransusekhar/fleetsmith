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
 *  - Loops are declared, not hand-coded. A phase can carry an iteration
 *    `loop` (repeat-until-condition) and a fleet can carry a `schedule`
 *    (recurring/interval/self-paced run); adapters translate each onto the
 *    target's native loop primitive (goose `retry`, Claude Code `/loop`,
 *    cron wrappers) with a portable prose fallback everywhere.
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

/** Default iteration bound for a phase loop when the author omits `max`. */
export const DEFAULT_LOOP_MAX = 3;

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
  spec.fleet.schedule = normalizeSchedule(spec.fleet.schedule);

  spec.defaults ??= {};
  spec.defaults.model ??= 'inherit';
  spec.defaults.capabilities = { ...DEFAULT_CAPS, ...(spec.defaults.capabilities ?? {}) };

  spec.agents = (spec.agents ?? []).map((a) => normalizeAgent(a, spec));
  spec.skills = (spec.skills ?? []).map(normalizeSkill);

  spec.orchestrator ??= {};
  spec.orchestrator.name ??= `run-${spec.fleet.name}`;
  spec.orchestrator.trigger ??= `${spec.fleet.domain || spec.fleet.name} tasks`;
  spec.orchestrator.phases = (spec.orchestrator.phases ?? defaultPhases(spec)).map(normalizePhase);

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

/**
 * Normalize an orchestrator phase, canonicalizing its optional iteration loop.
 * A phase `loop` turns a one-shot phase into a repeat-until-condition loop.
 */
function normalizePhase(p) {
  return { ...p, loop: normalizeLoop(p.loop) };
}

/**
 * Iteration loop: `{ until, max, check }`.
 *  - `until`  human-readable exit condition (the loop's acceptance test)
 *  - `max`    hard iteration bound (safety valve against runaway loops)
 *  - `check`  optional shell command; exit 0 = condition satisfied. When
 *             present it becomes goose's native `retry.checks` entry and the
 *             objective signal the prose loop defers to on every target.
 * Accepts a bare integer as shorthand for `{ max: N }`.
 */
function normalizeLoop(l) {
  if (l === undefined || l === null || l === false) return null;
  if (typeof l === 'number') l = { max: l };
  const max = Number.isInteger(l.max) && l.max > 0 ? l.max : DEFAULT_LOOP_MAX;
  return { until: l.until ?? '', max, check: l.check ?? null };
}

/**
 * Recurring loop: `{ cron, interval, note }` or null.
 *  - `cron`     5-field cron expression for scheduled runs
 *  - `interval` human interval ("1h", "15m") for `/loop`-style polling
 *  - `note`     what the recurring run should accomplish each firing
 * Neither cron nor interval → self-paced (the agent decides its own cadence).
 */
function normalizeSchedule(s) {
  if (!s) return null;
  return { cron: s.cron ?? null, interval: s.interval ?? null, note: s.note ?? '' };
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
        {
          name: 'Verify',
          mode: spec.fleet.execution,
          agents: names.slice(mid),
          parallel: true,
          // The generate-verify pattern IS a refinement loop: verifiers send
          // defects back to producers until the artifact holds. Make that
          // first-class instead of leaving it to prose.
          loop: {
            until: 'the verifier(s) report no outstanding defects — every prior finding is fixed or explicitly accepted',
            max: DEFAULT_LOOP_MAX,
          },
        },
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
