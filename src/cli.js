#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { normalizeSpec } from './spec/schema.js';
import { validateSpec } from './spec/validate.js';
import { runQa, formatQa } from './qa/index.js';
import { ADAPTERS, buildAll, DEFAULT_TARGETS } from './adapters/index.js';
import { ARCHETYPES, archetype } from './patterns/index.js';
import { planInstall, detectTools } from './install.js';

const USAGE = `fleetsmith — meta agent-fleet builder

Usage:
  fleetsmith init [name] --pattern <p> [--domain "..."] [--out fleet.yaml]
  fleetsmith validate <fleet.yaml>
  fleetsmith qa <fleet.yaml> [--built DIR] [--target ...]
  fleetsmith migrate-workspace <fleet.yaml> [--dry-run]
  fleetsmith build <fleet.yaml> [--target claude-code|opencode|goose|all] [--out DIR] [--dry-run] [--force] [--force-preserved]
  fleetsmith install <fleet.yaml> [--target ...] [--scope project|user] [--into DIR] [--dry-run] [--force]
  fleetsmith patterns
  fleetsmith version

Patterns: ${Object.keys(ARCHETYPES).join(', ')}
Targets:  ${DEFAULT_TARGETS.join(', ')}, all
          claude-workflow (experimental; opt-in, not part of "all")

install scopes:
  project  install into a target app repo (default; layout the tools discover in a project)
  user     install reusable agents/skills/recipes into your user-global tool config
`;

main();

function main() {
  const [, , cmd, ...rest] = process.argv;
  const { positional, flags } = parseArgs(rest);
  try {
    switch (cmd) {
      case 'init':
        return cmdInit(positional, flags);
      case 'validate':
        return cmdValidate(positional, flags);
      case 'qa':
        return cmdQa(positional, flags);
      case 'migrate-workspace':
        return cmdMigrateWorkspace(positional, flags);
      case 'build':
        return cmdBuild(positional, flags);
      case 'install':
        return cmdInstall(positional, flags);
      case 'patterns':
        return cmdPatterns();
      case 'version':
      case '--version':
      case '-v':
        return cmdVersion();
      default:
        process.stdout.write(USAGE);
        process.exitCode = cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h' ? 1 : 0;
    }
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  }
}

function cmdInit(positional, flags) {
  const name = positional[0] ?? 'my-fleet';
  const pattern = flags.pattern ?? 'pipeline';
  const domain = flags.domain ?? '';
  const out = flags.out ?? 'fleet.yaml';
  const raw = archetype(pattern, name, domain);
  if (fs.existsSync(out) && !flags.force) {
    throw new Error(`${out} already exists (use --force to overwrite)`);
  }
  fs.writeFileSync(
    out,
    `# fleetsmith fleet spec — edit agents/skills, then: fleetsmith build ${out} --target all\n` +
      YAML.stringify(raw, { lineWidth: 0 })
  );
  console.log(`wrote ${out} (${pattern} archetype, ${raw.agents.length} agents)`);
  console.log(`next: edit ${out}, then run: fleetsmith build ${out} --target all`);
}

function cmdValidate(positional) {
  const spec = loadSpec(positional[0]);
  const { errors, warnings, ok } = validateSpec(spec);
  for (const w of warnings) console.log(`warn:  ${w}`);
  for (const e of errors) console.log(`error: ${e}`);
  console.log(ok ? `valid: ${spec.fleet.name} (${spec.agents.length} agents, ${spec.skills.length} skills)` : 'invalid spec');
  process.exitCode = ok ? 0 : 1;
}

/**
 * The deterministic verification battery. Exits non-zero on any FAIL so it can
 * gate CI and, later, the promotion of an evolved harness.
 */
function cmdQa(positional, flags) {
  const spec = loadSpec(positional[0]);
  const targets = flags.target && flags.target !== 'all' ? [flags.target] : undefined;
  const report = runQa(spec, { builtDir: flags.built ?? null, targets });
  console.log(formatQa(report));
  process.exitCode = report.pass ? 0 : 1;
}

/**
 * Move a pre-tier workspace into local/ and seed shared/.
 *
 * The workspace was never committed, so no history is at stake — the only
 * hazard is a developer with a run in flight, which is why this refuses to
 * touch a workspace holding a CURRENT-* marker. Idempotent: a second run finds
 * nothing to move and says so.
 */
function cmdMigrateWorkspace(positional, flags) {
  const spec = loadSpec(positional[0]);
  const ws = spec.fleet.workspace;
  if (!fs.existsSync(ws)) {
    console.log(`nothing to migrate: ${ws}/ does not exist`);
    return;
  }

  const runs = path.join(ws, 'runs');
  const inFlight = fs.existsSync(runs)
    ? fs.readdirSync(runs).filter((f) => f.startsWith('CURRENT'))
    : [];
  if (inFlight.length > 0) {
    throw new Error(
      `refusing to migrate: ${inFlight.length} run(s) in flight (${inFlight.join(', ')}). ` +
        'Let them finish, or delete the marker if the run is abandoned.'
    );
  }

  const LOCAL = ['handoffs', 'runs', 'scripts', 'evals', 'notes', 'LEDGER.md'];
  const SHARED = ['CHANGELOG.md', 'playbooks', 'decisions.jsonl'];
  const moves = [];
  for (const [names, tier] of [[LOCAL, 'local'], [SHARED, 'shared']]) {
    for (const name of names) {
      const from = path.join(ws, name);
      if (fs.existsSync(from)) moves.push([from, path.join(ws, tier, name)]);
    }
  }

  if (moves.length === 0) {
    console.log('workspace already uses the shared/ + local/ tiers — nothing to do');
    return;
  }
  for (const [from, to] of moves) console.log(`  ${from} -> ${to}`);
  if (flags['dry-run']) {
    console.log(`dry run — would move ${moves.length} path(s)`);
    return;
  }
  for (const [from, to] of moves) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  }
  console.log(`migrated ${moves.length} path(s); run \`fleetsmith build\` to seed anything missing`);
}

function cmdBuild(positional, flags) {
  const { fileSet, target } = buildFleet(positional[0], flags);
  const outDir = flags.out ?? '.';
  if (flags['dry-run']) {
    console.log(`dry run — would write ${fileSet.files.size} files under ${path.resolve(outDir)}:`);
    for (const p of fileSet.list()) console.log(`  ${p}`);
    return;
  }
  const written = fileSet.write(outDir, {
    force: !!flags.force,
    forcePreserved: !!flags['force-preserved'],
  });
  console.log(`wrote ${written.length} files under ${path.resolve(outDir)} (target: ${target})`);
  for (const p of written) console.log(`  ${p}`);
}

function cmdInstall(positional, flags) {
  const { fileSet, target } = buildFleet(positional[0], flags);
  const scope = flags.scope ?? 'project';
  const into = flags.into ?? '.';
  const { fileSet: planned, baseDir, skipped } = planInstall(fileSet, { scope, into });

  const detected = detectTools();
  const present = Object.entries(detected).filter(([, on]) => on).map(([t]) => t);
  console.log(`detected tools: ${present.length ? present.join(', ') : 'none on this machine (installing anyway)'}`);

  if (flags['dry-run']) {
    console.log(`dry run — would install ${planned.files.size} files (scope: ${scope}, target: ${target}) under ${path.resolve(baseDir)}:`);
    for (const p of planned.list()) console.log(`  ${p}`);
  } else {
    const written = planned.write(baseDir, {
      force: !!flags.force,
      forcePreserved: !!flags['force-preserved'],
    });
    console.log(`installed ${written.length} files under ${path.resolve(baseDir)} (scope: ${scope}, target: ${target})`);
    for (const p of written) console.log(`  ${p}`);
  }

  if (skipped.length) {
    console.log(`skipped ${skipped.length} file(s) for ${scope} scope:`);
    for (const s of skipped) console.log(`  ${s.path} — ${s.reason}`);
  }
}

function cmdPatterns() {
  for (const [name, a] of Object.entries(ARCHETYPES)) {
    console.log(`${name.padEnd(16)} ${a.summary}`);
  }
}

function cmdVersion() {
  // __FLEETSMITH_VERSION__ is injected by the bundler for standalone binaries;
  // when running from source it is undefined, so fall back to package.json.
  const injected = typeof __FLEETSMITH_VERSION__ !== 'undefined' ? __FLEETSMITH_VERSION__ : undefined;
  console.log(injected ?? readPkg().version ?? 'unknown');
}

/** Shared: load + validate a spec and compile it to a FileSet. */
function buildFleet(specFile, flags) {
  const spec = loadSpec(specFile);
  const { errors, warnings, ok } = validateSpec(spec);
  for (const w of warnings) console.log(`warn:  ${w}`);
  if (!ok) {
    for (const e of errors) console.log(`error: ${e}`);
    throw new Error('spec is invalid; fix errors before building');
  }

  const target = flags.target ?? 'all';
  const options = { today: new Date().toISOString().slice(0, 10) };
  let fileSet;
  if (target === 'all') {
    fileSet = buildAll(spec, options);
  } else if (ADAPTERS[target]) {
    fileSet = ADAPTERS[target](spec, options);
  } else {
    throw new Error(`Unknown target "${target}". Use: ${Object.keys(ADAPTERS).join(', ')}, all`);
  }
  return { spec, fileSet, target };
}

function loadSpec(file) {
  if (!file) throw new Error('missing <fleet.yaml> argument');
  const raw = YAML.parse(fs.readFileSync(file, 'utf8'));
  return normalizeSpec(raw);
}

function readPkg() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  } catch {
    return {};
  }
}

function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}
