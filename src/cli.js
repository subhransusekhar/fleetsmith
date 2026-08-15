#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import YAML from 'yaml';
import { normalizeSpec } from './spec/schema.js';
import { validateSpec } from './spec/validate.js';
import { runQa, formatQa } from './qa/index.js';
import { checkInstalled } from './qa/installed.js';
import { applyOps, canonicalize, OPS } from './evolve/patch.js';
import { protectedManifest, violations } from './evolve/protected.js';
import { evolve } from './evolve/loop.js';
import { rankProposals, readDecisions, recordDecision, canaryStatus, AUTO_APPLY } from './evolve/promote.js';
import { claudeProposer } from './evolve/proposer.js';
import { runEval, formatEval, calibrate, classifyDelta } from './eval/index.js';
import { judgeSkills, formatJudge, claudeJudge, agreement, CRITERIA } from './eval/judge.js';
import { runExecCases, formatExec, execStability } from './eval/exec.js';
import { computeHealth, formatHealth } from './health/index.js';
import { parsePlaybook, renderPlaybook, addBullet, bump, dedupe } from './playbook/index.js';
import { ADAPTERS, buildAll, DEFAULT_TARGETS } from './adapters/index.js';
import { ARCHETYPES, archetype } from './patterns/index.js';
import { planInstall, detectTools } from './install.js';
import * as registry from './lib/registry.js';
import { getCliCommand, listRegistered } from './lib/registry.js';
// Side-effect import: registers the file memory backend through the registry
// (src/lib/registry.js). Nothing else in the CLI calls a memory backend
// today, so without this the registry would sit empty on every OSS
// invocation and the plugin seam would go completely unexercised outside
// tests.
import './memory/file.js';

const USAGE = `fleetsmith — meta agent-fleet builder

Usage:
  fleetsmith init [name] --pattern <p> [--domain "..."] [--out fleet.yaml]
  fleetsmith validate <fleet.yaml>
  fleetsmith qa <fleet.yaml> [--built DIR] [--target ...] [--installed]
  fleetsmith evolve <fleet.yaml> [--budget N] [--apply] [--model M] [--force]
  fleetsmith evolve <fleet.yaml> --review [--accept BRANCH | --reject BRANCH --reason R]
  fleetsmith protected <fleet.yaml> [--check-diff BASE] [--json FILE]
  fleetsmith health <fleet.yaml> [--json FILE]
  fleetsmith playbook <fleet.yaml> add|helpful|harmful|dedupe|show <agent> [text|id]
  fleetsmith eval <fleet.yaml> [--stage 1|2|3] [--fleets DIR] [--baseline FILE] [--calibrate] [--json FILE]
  fleetsmith eval <fleet.yaml> --judge [--ratings FILE] [--model M] [--concurrency N]   (advisory; gates nothing)
  fleetsmith eval <fleet.yaml> --exec [--target T] [--repeat N] [--fresh] [--concurrency N]  (live sessions; gates nothing)
  fleetsmith migrate-workspace <fleet.yaml> [--dry-run]
  fleetsmith patch <fleet.yaml> --ops ops.json [--dry-run] [--allow-contract-change]
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

/**
 * The fail-soft enterprise loader (G0.3, #29).
 *
 * `import('fleetsmith-ee')` is the ONLY reference to `ee/` core is allowed to
 * make (G0.4's CI guard whitelists exactly this specifier — a path-form
 * `../ee/...` import is always a violation, a bare package name is not). A
 * broken or absent enterprise install must never brick the OSS CLI:
 *  - Not installed: total silence. Absence is the normal, default state, and
 *    warning about it on every invocation would be noise nobody asked for.
 *  - Installed but its `register()` throws: exactly one warning line, then
 *    continue with core behavior. An enterprise package is optional by
 *    construction, and a bug in it must not out-rank the ability to run the
 *    OSS command the user actually typed.
 *
 * `FLEETSMITH_EE_PATH` (an absolute path to an ee checkout's `src/index.js`)
 * exists so ee/ can be developed and tested against a real core CLI without
 * `npm install`ing a package first — the loop this repo's own fleet depends on
 * for dogfooding itself.
 *
 * Version metadata (name/version/license, for `--version`) is read from the
 * loaded package's own `package.json` rather than duplicated into its
 * exports, so there is exactly one place that can drift out of date.
 *
 * Known gap: an installed `fleetsmith-ee` whose OWN internal import of some
 * other, unrelated module fails also throws `ERR_MODULE_NOT_FOUND`, which
 * this treats identically to "fleetsmith-ee itself is not installed" and so
 * stays silent rather than warning. Distinguishing the two reliably needs
 * inspecting the error's resolved specifier, which Node does not expose
 * uniformly across the supported engine range (`>=18`); not worth the
 * fragility for a rare packaging bug in a dependency that fails loudly the
 * moment someone actually runs an enterprise command.
 */
async function loadEnterprise() {
  const require = createRequire(import.meta.url);
  let mod;
  let meta = null;
  try {
    mod = await import('fleetsmith-ee');
    try {
      meta = require('fleetsmith-ee/package.json');
    } catch {
      /* metadata is best-effort; --version simply omits the ee line */
    }
  } catch (e) {
    if (e?.code !== 'ERR_MODULE_NOT_FOUND') {
      console.error(`warn: fleetsmith-ee failed to load: ${e.message}`);
      return null;
    }
    const eePath = process.env.FLEETSMITH_EE_PATH;
    if (!eePath) return null; // not installed and no dev override — the normal OSS state
    const resolved = path.resolve(eePath);
    try {
      mod = await import(pathToFileURL(resolved).href);
    } catch (e2) {
      console.error(`warn: FLEETSMITH_EE_PATH failed to load: ${e2.message}`);
      return null;
    }
    try {
      // FLEETSMITH_EE_PATH points at src/index.js; package.json is one level up.
      meta = JSON.parse(fs.readFileSync(path.join(path.dirname(resolved), '..', 'package.json'), 'utf8'));
    } catch {
      /* metadata is best-effort here too */
    }
  }
  try {
    await mod.register(registry);
  } catch (e) {
    console.error(`warn: fleetsmith-ee registration failed: ${e.message}`);
    return null;
  }
  return { meta };
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const ee = await loadEnterprise();
  const { positional, flags } = parseArgs(rest);
  try {
    switch (cmd) {
      case 'init':
        return cmdInit(positional, flags);
      case 'validate':
        return cmdValidate(positional, flags);
      case 'qa':
        return cmdQa(positional, flags);
      case 'eval':
        return await cmdEval(positional, flags);
      case 'health':
        return cmdHealth(positional, flags);
      case 'protected':
        return cmdProtected(positional, flags);
      case 'evolve':
        return await cmdEvolve(positional, flags);
      case 'playbook':
        return cmdPlaybook(positional, flags);
      case 'migrate-workspace':
        return cmdMigrateWorkspace(positional, flags);
      case 'patch':
        return cmdPatch(positional, flags);
      case 'build':
        return cmdBuild(positional, flags);
      case 'install':
        return cmdInstall(positional, flags);
      case 'patterns':
        return cmdPatterns();
      case 'version':
      case '--version':
      case '-v':
        return cmdVersion(ee);
      default: {
        // Enterprise commands (e.g. a future `fleetsmith grid`) register
        // through src/lib/registry.js via the fail-soft loader above. This
        // dispatcher only needs to consult it: an unrecognized verb the
        // registry also does not know is either a typo or an enterprise
        // command that is not installed, and the one-line hint below covers
        // both without guessing which.
        const handler = getCliCommand(cmd);
        if (handler) {
          process.exitCode = (await handler(rest)) ?? 0;
          return;
        }
        if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') {
          console.error(
            `error: unknown command "${cmd}". If this is an enterprise verb, install fleetsmith-ee ` +
              '(npm install -g fleetsmith-ee); otherwise run "fleetsmith --help".'
          );
          process.exitCode = 1;
          return;
        }
        process.stdout.write(USAGE);
      }
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
  const report = runQa(spec, { builtDir: flags.built ?? null, targets, playbooks: loadPlaybooks(spec) });
  console.log(formatQa(report));

  if (flags.installed) {
    // Opt-in and reported separately: this check reads $HOME and the live
    // filesystem, so its verdict is machine-dependent. Folding it into the gate
    // would make promotion depend on whose laptop ran it.
    const ambient = checkInstalled(spec);
    console.log('');
    console.log(`${ambient.pass ? 'PASS' : 'FAIL'}  ${ambient.name} (advisory — machine-specific, not part of the gate)`);
    for (const line of ambient.evidence) console.log(`        ${line}`);
    if (ambient.detail) console.log(`        ${ambient.detail}`);
  }

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

/**
 * Apply typed mutations to a fleet.yaml.
 *
 * --dry-run is the DEFAULT when stdin is not a TTY, so an automated caller
 * that forgets the flag prints a diff instead of writing. A tool that edits
 * its own configuration should be inert by default when nobody is watching.
 */
function cmdPatch(positional, flags) {
  const file = positional[0];
  if (!file) throw new Error('missing <fleet.yaml> argument');
  if (!flags.ops && !flags.normalize) throw new Error(`missing --ops <file.json> (ops: ${OPS.join(', ')})`);

  const source = fs.readFileSync(file, 'utf8');
  const ops = flags.ops ? JSON.parse(fs.readFileSync(flags.ops, 'utf8')) : [];
  if (flags.normalize) {
    const canonical = canonicalize(source);
    if (canonical === source) {
      console.log(`${file} is already canonical`);
      return;
    }
    fs.writeFileSync(file, canonical);
    console.log(`normalized ${file} — later patches will now produce minimal diffs`);
    return;
  }

  const { source: patched, applied, reformatted } = applyOps(source, Array.isArray(ops) ? ops : [ops], {
    allowContractChange: !!flags['allow-contract-change'],
  });
  if (reformatted) {
    console.warn(
      `warn:  ${file} is not in canonical YAML form, so this patch also reformats unrelated lines.\n` +
        '       Run `fleetsmith patch <spec> --normalize` once to separate that churn from real changes.'
    );
  }

  const dryRun = flags['no-dry-run'] ? false : (flags['dry-run'] ?? !process.stdin.isTTY);
  console.log(unifiedDiff(file, source, patched));
  if (dryRun) {
    console.log(`dry run — ${applied.length} op(s) would apply; pass --no-dry-run to write`);
    return;
  }
  if (patched === source) {
    console.log('no change');
    return;
  }
  fs.writeFileSync(file, patched);
  console.log(`applied ${applied.length} op(s) to ${file}`);
}

/** Minimal unified diff: enough to review a patch without a dependency. */
function unifiedDiff(name, a, b) {
  const A = a.split('\n');
  const B = b.split('\n');
  const out = [`--- a/${name}`, `+++ b/${name}`];
  let i = 0;
  let j = 0;
  while (i < A.length || j < B.length) {
    if (A[i] === B[j]) {
      i++;
      j++;
      continue;
    }
    const nextMatch = B.indexOf(A[i], j);
    if (A[i] !== undefined && nextMatch === -1) out.push(`-${A[i++]}`);
    else while (j < (nextMatch === -1 ? B.length : nextMatch)) out.push(`+${B[j++]}`);
  }
  return out.join('\n');
}

/**
 * Measure the harness rather than merely check it. Exits non-zero on a failing
 * case so it can gate a promotion, and writes JSON for the evolve loop to read.
 */
/**
 * Aggregate run telemetry into per-artifact health. No LLM calls, by design:
 * everything here is derived from work that already happened.
 */
/**
 * Learned-playbook maintenance. Every write here is deterministic and
 * non-LLM — that is what keeps the git diff reviewable (one bullet added, one
 * counter incremented) and what lets two developers merge a shared playbook.
 */
function cmdPlaybook(positional, flags) {
  const [file, action, agent, ...rest] = positional;
  const spec = loadSpec(file);
  if (!action || !agent) throw new Error('usage: fleetsmith playbook <fleet.yaml> add|helpful|harmful|dedupe|show <agent> [text|id]');
  if (!spec.agents.some((a) => a.name === agent)) throw new Error(`no such agent "${agent}"`);

  const dir = path.join(spec.fleet.shared, 'playbooks');
  const target = path.join(dir, `${agent}.md`);
  const before = fs.existsSync(target) ? parsePlaybook(fs.readFileSync(target, 'utf8')) : [];
  let after = before;
  let note = '';

  switch (action) {
    case 'show':
      console.log(before.length ? renderPlaybook(agent, before) : `(no learned notes for ${agent})`);
      return;
    case 'add': {
      const res = addBullet(agent, before, rest.join(' '));
      after = res.bullets;
      note = res.merged ? `merged into ${res.merged} (already known)` : `added ${res.added}`;
      break;
    }
    case 'helpful':
    case 'harmful':
      after = bump(before, rest[0], action);
      note = `${action} +1 on ${rest[0]}`;
      break;
    case 'dedupe':
      after = dedupe(before);
      note = `${before.length} -> ${after.length} bullet(s)`;
      break;
    default:
      throw new Error(`unknown playbook action "${action}"`);
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, renderPlaybook(agent, after));
  console.log(`${note} (${target})`);
  console.log('Rebuild to compile it into the agent: fleetsmith build <spec> --target all --force');
}

/** Learned bullets, keyed by agent, for the compiler to inline. */
function loadPlaybooks(spec) {
  const dir = path.join(spec.fleet.shared, 'playbooks');
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    out[f.replace(/\.md$/, '')] = parsePlaybook(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  return out;
}

/**
 * Write the protected-path manifest, and optionally refuse a branch that
 * touches one. `--check-diff main` is the out-of-process half of the guard;
 * the patch API is the in-process half.
 */
/**
 * Run one evolution cycle. Proposal-only by default: `--apply` still merges
 * nothing that is not on the auto-apply whitelist.
 */
async function cmdEvolve(positional, flags) {
  const specFile = positional[0];
  const spec = loadSpec(specFile);
  if (flags.review || flags.accept || flags.reject) return cmdReview(spec, flags);
  const noisePath = path.join(spec.fleet.shared, 'evals/noise.json');

  const result = await evolve(spec, {
    specFile,
    cwd: process.cwd(),
    budget: Number(flags.budget ?? 1),
    apply: !!flags.apply,
    force: !!flags.force,
    fleetsDir: flags.fleets ?? defaultFleetsDir(),
    noise: fs.existsSync(noisePath) ? JSON.parse(fs.readFileSync(noisePath, 'utf8')) : null,
    propose: claudeProposer({ model: flags.model ?? null }),
    // Regenerating and re-reading are the CLI's job; the loop stays free of
    // build and parse concerns so it can be tested without either.
    build: (file) => buildFleet(file, { target: 'all', force: true }).fileSet.write('.', { force: true }),
    reload: (file) => loadSpec(file),
  });

  for (const line of result.log) console.log(line);

  if (result.status === 'blocked') {
    console.error(`error: ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  if (result.status === 'skipped') return;

  console.log('');
  if (result.survivors.length === 0) {
    console.log('no candidate survived validation — nothing to review');
    return;
  }
  // Whitelist-only proposals never reach a human: their correctness is
  // mechanically decided, and a short review queue is what keeps review real.
  const ranked = rankProposals(result.survivors, readDecisions(spec));
  const auto = flags.apply ? ranked.filter((p) => p.ops.every((o) => AUTO_APPLY.has(o.op))) : [];
  for (const p of auto) {
    execFileSync('git', ['merge', '--no-ff', '-m', `evolve: auto-apply ${p.ops.map((o) => o.op).join(', ')}`, p.branch]);
    recordDecision(spec, {
      ts: new Date().toISOString(),
      branch: p.branch,
      target: p.target.name,
      ops: p.ops.map((o) => o.op),
      verdict: 'auto-apply',
      delta: p.delta?.delta ?? null,
    });
    console.log(`auto-applied ${p.branch} (all ops on the whitelist)`);
  }

  const queued = ranked.filter((p) => !auto.includes(p));
  if (queued.length === 0) return;

  console.log(`${queued.length} proposal(s) awaiting review, most promising first:`);
  for (const [i, p] of queued.entries()) {
    console.log(`  ${i + 1}. ${p.branch}`);
    console.log(`     score ${p.score.toFixed(3)} (delta ${(p.delta?.delta ?? 0).toFixed(3)} x confidence ${p.confidence.toFixed(2)})`);
    console.log(`     ${p.proposal}`);
  }
  console.log('');
  console.log('Nothing was merged. Review one at a time:');
  console.log(`  fleetsmith evolve ${specFile} --review`);
}

/**
 * Present proposals one at a time and record the verdict.
 *
 * One at a time is the point, not a limitation: a reviewer handed a batch
 * approves the batch. Every decision is logged so the proposer can stop
 * suggesting categories this reviewer keeps declining.
 */
function cmdReview(spec, flags) {
  const history = readDecisions(spec);

  if (flags.accept) {
    execFileSync('git', ['merge', '--no-ff', '-m', `evolve: accept ${flags.accept}`, flags.accept]);
    const gen = history.filter((d) => d.verdict === 'accept').length + 1;
    execFileSync('git', ['tag', `fleet-gen/${gen}`]);
    recordDecision(spec, {
      ts: new Date().toISOString(),
      branch: flags.accept,
      ops: [],
      verdict: 'accept',
      generation: gen,
      reason: flags.reason ?? '',
    });
    // The tag is the durable reference; leaving the branch would make
    // --review keep offering a proposal that is already merged.
    try {
      execFileSync('git', ['branch', '-d', flags.accept]);
    } catch {
      /* leave it if git refuses; the tag is what matters */
    }
    console.log(`merged ${flags.accept} and tagged fleet-gen/${gen}`);
    console.log(`Provisional until later runs confirm no regression. Rollback: git revert fleet-gen/${gen}`);
    return;
  }

  if (flags.reject) {
    const ops = proposalOps(spec, flags.reject);
    try {
      execFileSync('git', ['branch', '-D', flags.reject]);
    } catch {
      /* already gone */
    }
    recordDecision(spec, {
      ts: new Date().toISOString(),
      branch: flags.reject,
      ops,
      verdict: 'reject',
      reason: flags.reason ?? '',
    });
    console.log(`rejected ${flags.reject}${flags.reason ? ` — ${flags.reason}` : ''}`);
    console.log('Recorded; this op category will be deprioritized in later proposals.');
    return;
  }

  // No verdict given: show the next thing to look at, and only that.
  const branches = execFileSync('git', ['branch', '--list', 'fleet-evolve/*'], { encoding: 'utf8' })
    .split('\n')
    .map((b) => b.replace('*', '').trim())
    .filter(Boolean);
  if (branches.length === 0) {
    console.log('no proposals awaiting review');
    return;
  }
  const next = branches[0];
  console.log(`Next proposal: ${next}\n`);
  console.log(execFileSync('git', ['diff', '--stat', `main...${next}`], { encoding: 'utf8' }));
  console.log('Accept:  fleetsmith evolve <spec> --accept ' + next);
  console.log('Reject:  fleetsmith evolve <spec> --reject ' + next + ' --reason "..."');
}

/** Recover the op list from a proposal doc, so a rejection records what was declined. */
function proposalOps(spec, branch) {
  const dir = path.join(spec.fleet.shared, 'evolution/proposals');
  if (!fs.existsSync(dir)) return [];
  for (const f of fs.readdirSync(dir)) {
    const body = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!body.includes(branch)) continue;
    return [...body.matchAll(/- \*\*([a-z-]+)\*\*/g)].map((m) => m[1]);
  }
  return [];
}

function cmdProtected(positional, flags) {
  const spec = loadSpec(positional[0]);
  const manifest = protectedManifest(spec);

  if (flags['check-diff']) {
    const base = flags['check-diff'];
    const changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    const hits = violations(changed);
    if (hits.length > 0) {
      console.error('Protected paths modified on an evolution branch:');
      for (const h of hits) console.error(`  ${h.file}  (matches ${h.pattern})`);
      console.error('');
      console.error(manifest.why);
      process.exitCode = 1;
      return;
    }
    console.log(`protected: PASS (${changed.length} changed file(s), none protected)`);
    return;
  }

  const out = flags.json ?? path.join(spec.fleet.shared, 'evolution/protected.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${manifest.paths.length} protected path pattern(s), ${manifest.artifacts.length} protected artifact(s)`);
  console.log(`wrote ${out}`);
}

function cmdHealth(positional, flags) {
  const spec = loadSpec(positional[0]);
  const out = flags.json ?? path.join(spec.fleet.local, 'health.json');
  const previous = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;

  const health = computeHealth(spec, { runsDir: path.join(spec.fleet.local, 'runs'), previous });
  console.log(formatHealth(health));

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(health, null, 2)}\n`);
  // Exit 0 either way: health is a report, not a gate. `evolve` reads
  // maintenanceNeeded to decide whether to spend anything at all.
}

async function cmdEval(positional, flags) {
  const spec = loadSpec(positional[0]);
  const fleetsDir = flags.fleets ?? defaultFleetsDir();
  const stage = Number(flags.stage ?? 1);
  const once = () => runEval(spec, { stage, fleetsDir });

  if (flags.calibrate) {
    // Establish the noise floor BEFORE believing any delta. On a corpus this
    // small, run-to-run variation is otherwise indistinguishable from a real
    // regression — which is how a loop learns to promote luck.
    const noise = calibrate(once);
    const out = flags.json ?? path.join(spec.fleet.shared, 'evals/noise.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(noise, null, 2)}\n`);
    console.log(`noise floor: ${noise.floor.toFixed(3)} over ${noise.cases} case(s)`);
    console.log(noise.note);
    console.log(`wrote ${out}`);
    return;
  }

  if (flags.exec) {
    // A separate path that returns before any exit-code logic, for the same
    // reason as --judge: a promotion gate must be reproducible in CI with no
    // model available, and live execution is none of those things.
    const target = flags.target ?? 'claude-code';
    const repeat = Number(flags.repeat ?? 1);
    const runs = [];
    for (let i = 0; i < repeat; i++) {
      runs.push(
        await runExecCases(spec, {
          target,
          fresh: !!flags.fresh,
          concurrency: flags.concurrency ?? null,
          // Progress to stderr, so piping stdout to a file still yields a clean
          // report while an operator watching the terminal can tell a slow run
          // from a hung one. Each case is a whole session; silence for minutes
          // is what makes someone kill a suite that was working.
          onProgress: ({ skill, done, total }) =>
            process.stderr.write(`  [${done}/${total}${repeat > 1 ? ` run ${i + 1}/${repeat}` : ''}] ${skill}\n`),
        })
      );
    }
    console.log(formatExec(runs[0]));
    if (repeat > 1) {
      const st = execStability(runs);
      console.log('');
      console.log(`stability over ${st.runs} runs: ${st.flipped}/${st.cases} case(s) flipped (floor ${st.floor.toFixed(3)})`);
      if (st.unstable.length) console.log(`  unstable: ${st.unstable.join(', ')}`);
      console.log('  A delta smaller than this floor is not a result.');
    }
    if (flags.json) fs.writeFileSync(flags.json, `${JSON.stringify(runs, null, 2)}\n`);
    return; // no process.exitCode is set on this path, by design
  }

  if (flags.judge) {
    // Deliberately a separate path that returns before any exit-code logic:
    // there is no branch in which a judge score can influence the result.
    const results = await judgeSkills(spec, claudeJudge({ model: flags.model ?? null }), {
      concurrency: Number(flags.concurrency) || 4,
      onProgress: ({ skill, done, total }) => process.stderr.write(`  [${done}/${total}] judged ${skill}\n`),
    });
    console.log(formatJudge(results));
    if (flags.json) fs.writeFileSync(flags.json, `${JSON.stringify(results, null, 2)}\n`);

    if (flags.ratings && fs.existsSync(flags.ratings)) {
      const human = JSON.parse(fs.readFileSync(flags.ratings, 'utf8'));
      const agree = agreement(results, human);
      console.log('');
      console.log(`calibration over ${agree.sample} rated skill(s):`);
      for (const [id, v] of Object.entries(agree.perCriterion)) {
        console.log(`  ${id.padEnd(18)} n=${String(v.n).padEnd(4)} raw=${v.raw ?? '-'}  kappa=${v.kappa ?? '-'}`);
      }
      console.log(`  mean kappa: ${agree.meanKappa ?? '-'}`);
      console.log(
        agree.trustworthy
          ? '  Agreement is at the level where aggregate judge metrics are usable.'
          : '  Below the 0.8 threshold — treat individual verdicts as prompts to look, not as evidence.'
      );
    }
    return; // no process.exitCode is set on this path, by design
  }

  const baseline = flags.baseline ? JSON.parse(fs.readFileSync(flags.baseline, 'utf8')) : null;
  const result = runEval(spec, { stage, fleetsDir, baseline });

  if (result.delta) {
    const noisePath = path.join(spec.fleet.shared, 'evals/noise.json');
    const noise = fs.existsSync(noisePath) ? JSON.parse(fs.readFileSync(noisePath, 'utf8')) : null;
    Object.assign(result.delta, classifyDelta(result.delta.delta, noise));
  }

  console.log(formatEval(result));
  if (flags.json) fs.writeFileSync(flags.json, `${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.pass ? 0 : 1;
}

/** The bundled eval fleets, when running inside a fleetsmith checkout. */
function defaultFleetsDir() {
  const bundled = fileURLToPath(new URL('../test/eval-fleets', import.meta.url));
  return fs.existsSync(bundled) ? bundled : null;
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

function cmdVersion(ee) {
  // __FLEETSMITH_VERSION__ is injected by the bundler for standalone binaries;
  // when running from source it is undefined, so fall back to package.json.
  const injected = typeof __FLEETSMITH_VERSION__ !== 'undefined' ? __FLEETSMITH_VERSION__ : undefined;
  console.log(injected ?? readPkg().version ?? 'unknown');
  // Output is byte-identical to core-only whenever ee did not load: this
  // block only ever adds lines, never changes the line above.
  if (ee?.meta) {
    console.log(`${ee.meta.name} ${ee.meta.version} (${ee.meta.license})`);
    const { commands } = listRegistered();
    if (commands.length) console.log(`registered commands: ${commands.join(', ')}`);
  }
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
  // Learned bullets are read here, not inside the adapters: adapters stay
  // pure spec -> FileSet, and all I/O lives in the CLI.
  const options = { today: new Date().toISOString().slice(0, 10), playbooks: loadPlaybooks(spec) };
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
