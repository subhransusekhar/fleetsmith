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

/**
 * Abstract reasoning-effort tiers. Claude Code takes these near-verbatim
 * (`minimal` maps to its `low`); opencode expresses them as `variant` /
 * provider `reasoningEffort`; goose has no native equivalent and ignores them.
 */
export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'max'];

/** How much latitude a skill's methodology gives the agent (see docs/spec.md). */
export const FREEDOM_LEVELS = ['high', 'medium', 'low'];

/** Default iteration bound for a phase loop when the author omits `max`. */
export const DEFAULT_LOOP_MAX = 3;

/**
 * Default number of consecutive no-progress passes that ends a loop.
 * Anthropic's documented loop prompts pair a success check with a fixpoint
 * rule ("stop once two rounds in a row find nothing new") rather than relying
 * on the iteration cap alone — a pass that changes nothing will never start
 * changing something.
 */
export const DEFAULT_LOOP_NO_PROGRESS = 2;

/**
 * The four fields Anthropic's multi-agent research names as the fix for
 * duplicated/misaligned subagent work. Used as the default handoff artifact
 * schema when an agent declares no explicit one.
 */
export const DEFAULT_HANDOFF_SCHEMA = {
  objective: 'What the receiving agent must accomplish, in one sentence.',
  output_format: 'The exact shape/format the receiver should produce.',
  sources_and_tools: 'Which sources, files, and tools to use (and which to avoid).',
  boundaries: 'Explicit out-of-scope items and stopping conditions.',
};

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

  spec.fleet.mcp = normalizeMcp(spec.fleet.mcp);
  // Escape hatch for the single-writer rule: authors who genuinely coordinate
  // concurrent writers (disjoint paths, worktrees) opt out explicitly.
  spec.fleet.allowParallelWrites = spec.fleet.allowParallelWrites === true;

  spec.defaults ??= {};
  spec.defaults.model ??= 'inherit';
  spec.defaults.capabilities = { ...DEFAULT_CAPS, ...(spec.defaults.capabilities ?? {}) };
  // Concrete per-target model ids, keyed by abstract tier. Adapters emit model
  // selection only when the author supplies these; otherwise every agent
  // inherits the model of whoever invoked it.
  //
  // Inheriting is the right default even where a tier *could* be resolved to a
  // real name. A pinned model overrides the session: a fleet that hardcodes
  // Opus spawns Opus even when the user deliberately chose something cheaper,
  // and simply fails where that model is not available on their plan or
  // provider. Tier stays an intent in the spec; binding it to a name is a
  // deployment decision the author opts into.
  spec.defaults.claudeModels = normalizeModelMap(spec.defaults.claudeModels);
  spec.defaults.opencodeModels = normalizeModelMap(spec.defaults.opencodeModels);
  spec.defaults.gooseModels = normalizeModelMap(spec.defaults.gooseModels);

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
  // Reasoning budget. Absent (null) means "inherit the session default" on
  // every target — an explicit tier is only emitted when the author asked.
  agent.effort = a.effort ?? null;
  // Hard agentic-turn ceiling: Claude Code `maxTurns`, opencode `steps`,
  // goose `settings.max_turns`. The cheapest runaway-cost insurance there is.
  agent.turns = Number.isInteger(a.turns) && a.turns > 0 ? a.turns : null;
  // Hide from @-mention autocomplete (opencode only; no-op elsewhere).
  agent.hidden = a.hidden === true;
  // Durable cross-session notes (Claude Code `memory: project`; prose
  // instruction to keep notes in the fleet workspace on other targets).
  agent.memory = a.memory === true;
  return agent;
}

function normalizeHandoff(h) {
  if (!h) return { to: [], protocol: 'file', artifact: null, accepts: [], criteria: [], schema: null };
  return {
    to: toArray(h.to),
    protocol: h.protocol ?? 'file',
    artifact: h.artifact ?? null,
    accepts: toArray(h.accepts),
    criteria: toArray(h.criteria),
    // Optional machine-checkable contract for the handoff artifact. goose
    // compiles it to a native `response.json_schema`; the other targets get it
    // in the handoff template and the validator gate script.
    schema: normalizeHandoffSchema(h.schema),
  };
}

/**
 * A handoff schema is a plain `field -> description` map (the shape the
 * handoff template and goose's json_schema both need). `true` is shorthand
 * for the default four-field delegation brief.
 */
function normalizeHandoffSchema(s) {
  if (s === true) return { ...DEFAULT_HANDOFF_SCHEMA };
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const out = {};
  for (const [k, v] of Object.entries(s)) out[k] = typeof v === 'string' ? v : String(v ?? '');
  return Object.keys(out).length > 0 ? out : null;
}

/** Concrete model ids per abstract tier, e.g. `{smart: "anthropic/claude-opus-5"}`. */
function normalizeModelMap(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const out = {};
  for (const tier of MODEL_TIERS) {
    if (typeof m[tier] === 'string' && m[tier].trim()) out[tier] = m[tier].trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * MCP servers the fleet depends on: `name -> {type, url|command, args, env}`.
 * Adapters map this onto `.mcp.json` (Claude Code), `opencode.json` `mcp`
 * (local/remote), and goose recipe `extensions` (stdio/streamable_http).
 */
function normalizeMcp(mcp) {
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) return null;
  const out = {};
  for (const [name, raw] of Object.entries(mcp)) {
    if (!raw || typeof raw !== 'object') continue;
    const type = raw.type ?? (raw.url ? 'http' : 'stdio');
    out[name] = {
      type,
      url: raw.url ?? null,
      command: raw.command ?? null,
      args: toArray(raw.args),
      env: raw.env && typeof raw.env === 'object' ? raw.env : null,
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Normalize an orchestrator phase, canonicalizing its optional iteration loop.
 * A phase `loop` turns a one-shot phase into a repeat-until-condition loop.
 */
function normalizePhase(p) {
  return { ...p, loop: normalizeLoop(p.loop) };
}

/**
 * Iteration loop: `{ until, max, check, noProgress }`.
 *  - `until`      human-readable exit condition (the loop's acceptance test)
 *  - `max`        hard iteration bound (safety valve against runaway loops)
 *  - `check`      optional shell command; exit 0 = condition satisfied. When
 *                 present it becomes goose's native `retry.checks` entry and the
 *                 objective signal the prose loop defers to on every target.
 *  - `noProgress` consecutive no-change passes that end the loop early.
 *
 * The three together are the research-backed stop rule: a success condition,
 * a fixpoint rule, and a hard cap. A cap alone burns the full budget on a loop
 * that stopped improving after pass one.
 *
 * Accepts a bare integer as shorthand for `{ max: N }`.
 */
function normalizeLoop(l) {
  if (l === undefined || l === null || l === false) return null;
  if (typeof l === 'number') l = { max: l };
  const max = Number.isInteger(l.max) && l.max > 0 ? l.max : DEFAULT_LOOP_MAX;
  const noProgress =
    Number.isInteger(l.noProgress) && l.noProgress > 0 ? l.noProgress : DEFAULT_LOOP_NO_PROGRESS;
  return { until: l.until ?? '', max, check: l.check ?? null, noProgress };
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
    // How much latitude the methodology gives: `low` emits exact-command
    // framing (fragile, consistency-critical work), `high` emits heuristics.
    freedom: FREEDOM_LEVELS.includes(s.freedom) ? s.freedom : 'medium',
    // Trigger-test corpus. Whether a skill fires is a separate property from
    // whether its output is good, and only prompts can measure the former.
    triggers: normalizeTriggers(s.triggers),
  };
}

function normalizeTriggers(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return { should: [], shouldNot: [] };
  return {
    should: toArray(t.should).map(String),
    shouldNot: toArray(t.shouldNot ?? t.should_not).map(String),
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
