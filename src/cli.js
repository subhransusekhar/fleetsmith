#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { normalizeSpec } from './spec/schema.js';
import { validateSpec } from './spec/validate.js';
import { ADAPTERS, buildAll } from './adapters/index.js';
import { ARCHETYPES, archetype } from './patterns/index.js';

const USAGE = `fleetsmith — meta agent-fleet builder

Usage:
  fleetsmith init [name] --pattern <p> [--domain "..."] [--out fleet.yaml]
  fleetsmith validate <fleet.yaml>
  fleetsmith build <fleet.yaml> --target claude-code|opencode|goose|all [--out DIR] [--dry-run] [--force]
  fleetsmith patterns

Patterns: ${Object.keys(ARCHETYPES).join(', ')}
Targets:  ${Object.keys(ADAPTERS).join(', ')}, all
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
      case 'patterns':
        return cmdPatterns();
      default:
        process.stdout.write(USAGE);
        process.exitCode = cmd ? 1 : 0;
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
  const spec = loadSpec(positional[0]);
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

function cmdPatterns() {
  for (const [name, a] of Object.entries(ARCHETYPES)) {
    console.log(`${name.padEnd(16)} ${a.summary}`);
  }
}

function loadSpec(file) {
  if (!file) throw new Error('missing <fleet.yaml> argument');
  const raw = YAML.parse(fs.readFileSync(file, 'utf8'));
  return normalizeSpec(raw);
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
