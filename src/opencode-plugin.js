import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { normalizeSpec } from './spec/schema.js';
import { validateSpec } from './spec/validate.js';
import { ADAPTERS, buildAll } from './adapters/index.js';
import { ARCHETYPES, archetype } from './patterns/index.js';
import { planInstall, detectTools } from './install.js';

/**
 * opencode plugin core — dependency-free.
 *
 * This module wires the pure fleetsmith compiler into opencode custom tools
 * WITHOUT importing `@opencode-ai/plugin`, so it stays testable with a stub
 * `tool` helper. The real peer-dep import lives only in `src/opencode.js`,
 * the plugin entry point that `exports["./opencode"]` resolves to.
 *
 * Design note: this is the "builder as a plugin" surface (run/validate/build a
 * fleet in-session as tool calls) — distinct from the opencode ADAPTER, which
 * compiles a fleet into native .opencode/ files. Both exist; they solve
 * different problems.
 */

const TARGETS = [...Object.keys(ADAPTERS), 'all'];

// --- pure-ish operations (fs I/O reuses the shared FileSet.write path) -------

/** Parse + normalize a spec file into canonical shape. */
function loadSpec(specPath) {
  if (!specPath) throw new Error('missing spec path');
  return normalizeSpec(YAML.parse(fs.readFileSync(specPath, 'utf8')));
}

/** Compile a normalized spec to a FileSet for one target (or all). */
function compile(spec, target, today) {
  const options = { today };
  if (target === 'all') return buildAll(spec, options);
  if (ADAPTERS[target]) return ADAPTERS[target](spec, options);
  throw new Error(`Unknown target "${target}". Use: ${TARGETS.join(', ')}`);
}

function requireValid(spec) {
  const { errors, warnings, ok } = validateSpec(spec);
  if (!ok) throw new Error(`spec is invalid: ${errors.join('; ')}`);
  return warnings;
}

export function opValidate(specPath) {
  const spec = loadSpec(specPath);
  const { errors, warnings, ok } = validateSpec(spec);
  return { ok, errors, warnings, fleet: spec.fleet.name, agents: spec.agents.length, skills: spec.skills.length };
}

export function opBuild(specPath, { target = 'all', out = '.', force = true, today = defaultToday() } = {}) {
  const spec = loadSpec(specPath);
  const warnings = requireValid(spec);
  const written = compile(spec, target, today).write(out, { force });
  return { target, out: path.resolve(out), written, warnings };
}

export function opInit({ name = 'my-fleet', pattern = 'pipeline', domain = '', out = null, force = false } = {}) {
  const raw = archetype(pattern, name, domain);
  const yaml = `# fleetsmith fleet spec — edit agents/skills, then build with the fleet_build tool\n` + YAML.stringify(raw, { lineWidth: 0 });
  if (out) {
    if (fs.existsSync(out) && !force) throw new Error(`${out} already exists (set force=true to overwrite)`);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, yaml);
  }
  return { pattern, agents: raw.agents.length, out: out ? path.resolve(out) : null, yaml };
}

export function opInstall(specPath, { target = 'all', scope = 'project', into = '.', force = true, home, today = defaultToday() } = {}) {
  const spec = loadSpec(specPath);
  requireValid(spec);
  const fileSet = compile(spec, target, today);
  const { fileSet: planned, baseDir, skipped } = planInstall(fileSet, { scope, into, home });
  const written = planned.write(baseDir, { force });
  return { scope, target, baseDir: path.resolve(baseDir), written, skipped, detected: detectTools(home) };
}

export function opPatterns() {
  return Object.entries(ARCHETYPES).map(([name, a]) => ({ name, summary: a.summary }));
}

function defaultToday() {
  return new Date().toISOString().slice(0, 10);
}

// --- tool wiring (given opencode's `tool` helper) ----------------------------

/**
 * Build the object an opencode plugin returns: a `tool` map plus (optionally)
 * a file-edit hook. `tool` is opencode's helper from `@opencode-ai/plugin`;
 * passing it in keeps this module free of that peer dependency.
 *
 * @param {Function & {schema:{string:Function,boolean:Function}}} tool
 * @param {{directory?:string}} ctx  opencode plugin context
 */
export function buildFleetsmithTools(tool, ctx = {}, options = {}) {
  const s = tool.schema;
  const projectDir = ctx.directory ?? '.';
  const abs = (p) => path.resolve(projectDir, p);
  const today = defaultToday();

  const tools = {
    fleet_patterns: tool({
      description: 'List available fleetsmith fleet patterns (archetypes) with one-line summaries. Use before scaffolding a new fleet.',
      args: {},
      async execute() {
        return opPatterns().map((p) => `${p.name.padEnd(16)} ${p.summary}`).join('\n');
      },
    }),

    fleet_validate: tool({
      description: 'Validate a fleetsmith fleet.yaml spec. Returns blocking errors and design-smell warnings. Run before building.',
      args: { path: s.string().describe('Path to the fleet.yaml spec, relative to the project root (or absolute).') },
      async execute({ path: p }) {
        const r = opValidate(abs(p));
        return [
          r.ok ? `valid: ${r.fleet} (${r.agents} agents, ${r.skills} skills)` : `INVALID: ${r.fleet}`,
          ...r.errors.map((e) => `error: ${e}`),
          ...r.warnings.map((w) => `warn:  ${w}`),
        ].join('\n');
      },
    }),

    fleet_build: tool({
      description: 'Compile a fleet.yaml into native agent harnesses (Claude Code, opencode, goose) and write the files. Returns the written file list.',
      args: {
        path: s.string().describe('Path to the fleet.yaml spec.'),
        target: s.string().describe('claude-code | opencode | goose | all (default: all)').optional(),
        out: s.string().describe('Output directory (default: the project root).').optional(),
        force: s.boolean().describe('Overwrite existing files (default: true).').optional(),
      },
      async execute({ path: p, target, out, force }) {
        const r = opBuild(abs(p), {
          target: target || 'all',
          out: out ? abs(out) : projectDir,
          force: force !== false,
          today,
        });
        return [
          `built target=${r.target} → ${r.out} (${r.written.length} files)`,
          ...r.written.map((f) => `  ${f}`),
          ...r.warnings.map((w) => `warn: ${w}`),
        ].join('\n');
      },
    }),

    fleet_init: tool({
      description: 'Scaffold a new fleet.yaml from a pattern archetype. Writes the spec (or returns it when no output path is given).',
      args: {
        name: s.string().describe('kebab-case fleet name, e.g. review-bot'),
        pattern: s.string().describe('pipeline | fanout | generate-verify | supervisor | expert-pool (default: pipeline)').optional(),
        domain: s.string().describe('one-line domain statement').optional(),
        out: s.string().describe('where to write the spec, e.g. fleet.yaml (omit to return the YAML instead)').optional(),
      },
      async execute({ name, pattern, domain, out }) {
        const r = opInit({ name, pattern: pattern || 'pipeline', domain: domain || '', out: out ? abs(out) : null, force: true });
        return r.out ? `wrote ${r.out} (${r.pattern} archetype, ${r.agents} agents)` : r.yaml;
      },
    }),

    fleet_install: tool({
      description: 'Compile and install a fleet into a target repo (project scope) or the user-global tool config (user scope).',
      args: {
        path: s.string().describe('Path to the fleet.yaml spec.'),
        scope: s.string().describe('project | user (default: project)').optional(),
        target: s.string().describe('claude-code | opencode | goose | all (default: all)').optional(),
        into: s.string().describe('target directory for project scope (default: the project root)').optional(),
      },
      async execute({ path: p, scope, target, into }) {
        const r = opInstall(abs(p), {
          scope: scope || 'project',
          target: target || 'all',
          into: into ? abs(into) : projectDir,
          force: true,
          today,
        });
        return [
          `installed scope=${r.scope} target=${r.target} → ${r.baseDir} (${r.written.length} files)`,
          ...r.written.map((f) => `  ${f}`),
          ...r.skipped.map((sk) => `  skip ${sk.path} — ${sk.reason}`),
        ].join('\n');
      },
    }),
  };

  return { tool: tools, ...autobuildHook(ctx, options), ...compactionHook(ctx, options) };
}

/**
 * Optional hook: recompile the harness whenever fleet.yaml is edited in-session.
 * Off by default — enable with `{ "plugin": [["fleetsmith/opencode",
 * { "autobuild": true }]] }` or FLEETSMITH_OPENCODE_AUTOBUILD=1. Best-effort:
 * a hook must never throw. The file-event key/payload shape varies by opencode
 * version; extract the path defensively and verify against your install.
 */
function autobuildHook(ctx, options = {}) {
  const on = options.autobuild === true || process.env.FLEETSMITH_OPENCODE_AUTOBUILD === '1';
  if (!on) return {};
  const projectDir = ctx.directory ?? '.';
  const specName = options.spec ? path.basename(options.spec) : 'fleet.yaml';
  return {
    'file.edited': async (input) => {
      try {
        const file = input?.file?.path ?? input?.path ?? (typeof input?.file === 'string' ? input.file : '');
        if (typeof file !== 'string' || path.basename(file) !== specName) return;
        opBuild(file, { target: 'all', out: projectDir, force: true });
      } catch {
        /* best-effort: never propagate a hook error into the opencode session */
      }
    },
  };
}

/**
 * Carry fleet state through compaction.
 *
 * Compaction summarizes a long session and starts fresh, which is exactly when
 * a fleet run is most likely to lose track of which phase it is in and what
 * each agent already produced. That state is on disk in the ledger, so re-inject
 * it into the compaction context rather than hoping the summary preserved it.
 *
 * Off when there is no ledger to read. Best-effort like every hook — a failure
 * here must degrade to ordinary compaction, never break the session.
 */
function compactionHook(ctx, options = {}) {
  const projectDir = ctx.directory ?? '.';
  const workspace = options.workspace ?? '_fleet';
  return {
    'experimental.session.compacting': async (_input, output) => {
      try {
        const ledger = path.resolve(projectDir, workspace, 'LEDGER.md');
        if (!fs.existsSync(ledger)) return;
        const content = fs.readFileSync(ledger, 'utf8').slice(0, 8000);
        output.context = [
          ...(output.context ?? []),
          `Fleet state (${workspace}/LEDGER.md) — preserve this across compaction; it is the run's source of truth for what is done and what is outstanding:\n\n${content}`,
        ];
      } catch {
        /* best-effort: compaction proceeds without the ledger */
      }
    },
  };
}
