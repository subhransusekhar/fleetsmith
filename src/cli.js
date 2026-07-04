#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { normalizeSpec } from './spec/schema.js';
import { validateSpec } from './spec/validate.js';
import { ADAPTERS, buildAll } from './adapters/index.js';
import { ARCHETYPES, archetype } from './patterns/index.js';
import { planInstall, detectTools } from './install.js';

const USAGE = `fleetsmith — meta agent-fleet builder

Usage:
  fleetsmith init [name] --pattern <p> [--domain "..."] [--out fleet.yaml]
  fleetsmith validate <fleet.yaml>
  fleetsmith build <fleet.yaml> [--target claude-code|opencode|goose|all] [--out DIR] [--dry-run] [--force]
  fleetsmith install <fleet.yaml> [--target ...] [--scope project|user] [--into DIR] [--dry-run] [--force]
  fleetsmith patterns
  fleetsmith version

Patterns: ${Object.keys(ARCHETYPES).join(', ')}
Targets:  ${Object.keys(ADAPTERS).join(', ')}, all

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

function cmdBuild(positional, flags) {
  const { fileSet, target } = buildFleet(positional[0], flags);
  const outDir = flags.out ?? '.';
  if (flags['dry-run']) {
    console.log(`dry run — would write ${fileSet.files.size} files under ${path.resolve(outDir)}:`);
    for (const p of fileSet.list()) console.log(`  ${p}`);
    return;
  }
  const written = fileSet.write(outDir, { force: !!flags.force });
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
    const written = planned.write(baseDir, { force: !!flags.force });
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
