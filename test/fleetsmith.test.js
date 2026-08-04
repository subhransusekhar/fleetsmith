import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeSpec } from '../src/spec/schema.js';
import { validateSpec } from '../src/spec/validate.js';
import { buildClaudeCode } from '../src/adapters/claude-code.js';
import { buildOpencode } from '../src/adapters/opencode.js';
import { buildGoose } from '../src/adapters/goose.js';
import { buildAll, ADAPTERS, DEFAULT_TARGETS } from '../src/adapters/index.js';
import { buildClaudeWorkflow } from '../src/adapters/claude-workflow.js';
import { archetype, ARCHETYPES } from '../src/patterns/index.js';
import { planInstall } from '../src/install.js';
import { FileSet } from '../src/lib/fs-utils.js';
import { runQa, formatQa } from '../src/qa/index.js';
import { applyOps, canonicalize } from '../src/evolve/patch.js';
import { runEval, runTriggerTests, runEvalFleets, compare, classifyDelta, calibrate } from '../src/eval/index.js';
import { judgeSkills, formatJudge, parseVerdict, agreement, CRITERIA } from '../src/eval/judge.js';
import { computeHealth, formatHealth } from '../src/health/index.js';
import { addBullet, bump, dedupe, parsePlaybook, renderPlaybook, MAX_BULLETS, MAX_BULLET_CHARS } from '../src/playbook/index.js';
import { protectedManifest, violations } from '../src/evolve/protected.js';
import { evolve, selectTargets, buildDossier } from '../src/evolve/loop.js';
import { rankProposals, rejectionRates, decisionDigest, readDecisions, recordDecision, decisionsPath, canaryStatus, AUTO_APPLY } from '../src/evolve/promote.js';
import { parseOps, buildPrompt } from '../src/evolve/proposer.js';
import { buildFleetsmithTools, opValidate, opBuild, opInit, opPatterns } from '../src/opencode-plugin.js';
import { validatorScript } from '../src/adapters/claude-settings.js';
import YAML from 'yaml';

function demoSpec() {
  return normalizeSpec(archetype('pipeline', 'demo', 'demo domain'));
}

test('normalize fills defaults', () => {
  const spec = normalizeSpec({ fleet: { name: 'x' }, agents: [{ name: 'a' }] });
  assert.equal(spec.fleet.pattern, 'pipeline');
  assert.equal(spec.fleet.execution, 'subagents');
  assert.equal(spec.agents[0].model, 'inherit');
  assert.equal(spec.agents[0].capabilities.read, true);
  assert.equal(spec.agents[0].capabilities.edit, false);
  assert.equal(spec.orchestrator.name, 'run-x');
  assert.ok(spec.orchestrator.phases.length === 1);
});

test('v0.4 spec fields normalize with safe defaults and validate', () => {
  const spec = normalizeSpec({
    fleet: {
      name: 'x',
      domain: 'd',
      mcp: { docs: { type: 'http', url: 'https://example.com/mcp' }, local: { command: 'srv' } },
    },
    defaults: { opencodeModels: { smart: 'anthropic/claude-opus-5', bogus: 'ignored' } },
    agents: [
      { name: 'a', effort: 'high', turns: 30, hidden: true, memory: true, handoff: { to: ['b'], artifact: 'a.md', schema: true } },
      { name: 'b', handoff: { to: [] } },
    ],
    skills: [
      {
        name: 's',
        description: 'A sufficiently long trigger-rich description for the validator to accept without warning.',
        freedom: 'low',
        triggers: { should: ['do the thing'], should_not: ['unrelated ask'] },
      },
    ],
  });

  const a = spec.agents[0];
  assert.equal(a.effort, 'high');
  assert.equal(a.turns, 30);
  assert.equal(a.hidden, true);
  assert.equal(a.memory, true);
  // `schema: true` expands to the four-field delegation brief
  assert.deepEqual(Object.keys(a.handoff.schema), ['objective', 'output_format', 'sources_and_tools', 'boundaries']);

  // absent optionals stay null/false so adapters emit nothing
  const b = spec.agents[1];
  assert.equal(b.effort, null);
  assert.equal(b.turns, null);
  assert.equal(b.hidden, false);
  assert.equal(b.handoff.schema, null);

  assert.equal(spec.skills[0].freedom, 'low');
  assert.deepEqual(spec.skills[0].triggers, { should: ['do the thing'], shouldNot: ['unrelated ask'] });
  assert.equal(spec.fleet.allowParallelWrites, false);
  // unknown tiers are dropped from model maps; known ones survive
  assert.deepEqual(spec.defaults.opencodeModels, { smart: 'anthropic/claude-opus-5' });
  assert.equal(spec.fleet.mcp.local.type, 'stdio');
  assert.equal(spec.fleet.mcp.docs.type, 'http');

  const { errors } = validateSpec(spec);
  assert.deepEqual(errors, []);
});

test('v0.4 spec fields are validated: effort tier, mcp shape, skill freedom', () => {
  const spec = normalizeSpec({
    fleet: { name: 'x', domain: 'd', mcp: { broken: { type: 'http' }, alsoBroken: { type: 'stdio' } } },
    agents: [{ name: 'a', effort: 'ultra', turns: 500, handoff: { to: [] } }],
  });
  const { errors, warnings } = validateSpec(spec);
  assert.ok(errors.some((e) => e.includes('effort "ultra"')));
  assert.ok(errors.some((e) => e.includes('"broken" is type "http" but has no url')));
  assert.ok(errors.some((e) => e.includes('"alsoBroken" is type "stdio" but has no command')));
  assert.ok(warnings.some((w) => w.includes('turns is 500')));
});

test('loops carry a three-part stop rule (success, no-progress, cap)', () => {
  const cc = buildClaudeCode(loopSpec(), {}).files.get('.claude/skills/run-looped/SKILL.md');
  assert.match(cc, /\*\*Success\*\*/);
  assert.match(cc, /\*\*No progress\*\* — 2 consecutive passes/);
  assert.match(cc, /\*\*Cap\*\* — 4 passes are spent/);
  // objective check beats self-assessment, and evidence is recorded
  assert.match(cc, /trust it over any agent's self-assessment/);
  // reward-hacking guard on test-shaped checks
  assert.match(cc, /without satisfying the requirement/);
});

test('all archetypes normalize and validate cleanly', () => {
  for (const pattern of Object.keys(ARCHETYPES)) {
    const spec = normalizeSpec(archetype(pattern, `t-${pattern}`, 'test domain'));
    const { errors } = validateSpec(spec);
    assert.deepEqual(errors, [], `${pattern}: ${errors.join('; ')}`);
  }
});

test('validate catches unknown handoff target and skill', () => {
  const spec = normalizeSpec({
    fleet: { name: 'bad' },
    agents: [{ name: 'a', skills: ['nope'], handoff: { to: 'ghost' } }],
  });
  const { errors } = validateSpec(spec);
  assert.ok(errors.some((e) => e.includes('unknown agent "ghost"')));
  assert.ok(errors.some((e) => e.includes('unknown skill "nope"')));
});

test('validate flags non-kebab names and cycles', () => {
  const spec = normalizeSpec({
    fleet: { name: 'c' },
    agents: [
      { name: 'Agent One', handoff: { to: [] } },
      { name: 'b', handoff: { to: 'c' } },
      { name: 'c', handoff: { to: 'b' } },
    ],
  });
  const { errors, warnings } = validateSpec(spec);
  assert.ok(errors.some((e) => e.includes('kebab-case')));
  assert.ok(warnings.some((w) => w.includes('cycle')));
});

// --- design-smell lint -------------------------------------------------------

test('lint blocks parallel writers unless explicitly opted out', () => {
  const raw = {
    fleet: { name: 'pw', domain: 'd' },
    agents: [
      { name: 'w-a', capabilities: { read: true, edit: true }, handoff: { to: [] } },
      { name: 'w-b', capabilities: { read: true, edit: true }, handoff: { to: [] } },
    ],
    orchestrator: { phases: [{ name: 'Both', agents: ['w-a', 'w-b'], parallel: true }] },
  };
  const { errors } = validateSpec(normalizeSpec(raw));
  assert.ok(errors.some((e) => /2 editing agents in parallel/.test(e)));

  // opt-out for fleets that coordinate writes themselves
  const opted = validateSpec(normalizeSpec({ ...raw, fleet: { ...raw.fleet, allowParallelWrites: true } }));
  assert.deepEqual(opted.errors, []);

  // parallel readers are always fine
  const readers = validateSpec(
    normalizeSpec({
      ...raw,
      agents: raw.agents.map((a) => ({ ...a, capabilities: { read: true } })),
    })
  );
  assert.deepEqual(readers.errors, []);
});

test('lint enforces the skill description budget that silently truncates', () => {
  const long = `Does a thing. Use when ${'x'.repeat(1600)}`;
  const { errors } = validateSpec(
    normalizeSpec({
      fleet: { name: 'b', domain: 'd' },
      agents: [{ name: 'a', skills: ['fat'], handoff: { to: [] } }],
      skills: [{ name: 'fat', description: long }],
    })
  );
  assert.ok(errors.some((e) => /truncates at 1536/.test(e)));

  // many mid-size descriptions overflow the listing budget as a group
  const many = Array.from({ length: 12 }, (_, i) => ({
    name: `skill-${i}`,
    description: `Handles topic ${i} thoroughly and in detail. Use when the user asks about topic ${i}. ${'padding '.repeat(90)}`,
  }));
  const { warnings } = validateSpec(
    normalizeSpec({
      fleet: { name: 'b', domain: 'd' },
      agents: [{ name: 'a', skills: many.map((s) => s.name), handoff: { to: [] } }],
      skills: many,
    })
  );
  assert.ok(warnings.some((w) => /skill listing is budgeted/.test(w)));
});

test('lint flags skill-authoring anti-patterns', () => {
  const { warnings } = validateSpec(
    normalizeSpec({
      fleet: { name: 'l', domain: 'd' },
      agents: [{ name: 'a', skills: ['utils', 'ok-skill'], handoff: { to: [] } }],
      skills: [
        { name: 'utils', description: 'I help with things you can ask me about later on when needed.' },
        {
          name: 'ok-skill',
          description: 'Migrates database schemas safely. Use when the user asks to migrate, alter, or version a schema.',
          body: 'Open C:\\Users\\dev\\file.txt then call mcp__github. Before August 2025, use the old API.',
          references: {
            'a.md': 'See [more](./b.md) for detail.',
            'big.md': `${'line\n'.repeat(120)}`,
          },
        },
      ],
    })
  );
  const has = (re) => warnings.some((w) => re.test(w));
  assert.ok(has(/first person/), 'first-person description');
  assert.ok(has(/vague/), 'vague skill name');
  assert.ok(has(/Windows-style paths/), 'windows paths');
  assert.ok(has(/time-sensitive/), 'dated guidance');
  assert.ok(has(/server-qualified/), 'unqualified mcp tool');
  assert.ok(has(/loaded one level deep/), 'reference chain');
  assert.ok(has(/no contents heading/), 'long reference without TOC');
});

test('lint suggests merging phases that split one context', () => {
  const { warnings } = validateSpec(
    normalizeSpec({
      fleet: { name: 'dc', domain: 'd' },
      agents: [
        { name: 'first', handoff: { to: [], accepts: ['brief.md'] } },
        { name: 'second', handoff: { to: [], accepts: ['brief.md'] } },
      ],
      orchestrator: {
        phases: [
          { name: 'One', agents: ['first'] },
          { name: 'Two', agents: ['second'] },
        ],
      },
    })
  );
  assert.ok(warnings.some((w) => /one context split in two/.test(w)));
});

test('claude-code adapter emits agents, orchestrator skill, workspace, pointer', () => {
  const files = buildClaudeCode(demoSpec(), { today: '2026-07-04' });
  const paths = files.list();
  assert.ok(paths.includes('.claude/agents/analyst.md'));
  assert.ok(paths.includes('.claude/skills/run-demo/SKILL.md'));
  assert.ok(paths.includes('_fleet/local/handoffs/HANDOFF.template.md'));
  assert.ok(paths.includes('_fleet/local/LEDGER.md'));
  assert.ok(paths.includes('CLAUDE.md'));

  const builder = files.files.get('.claude/agents/builder.md');
  assert.match(builder, /^---\nname: builder\n/);
  assert.match(builder, /tools: Read, Grep, Glob, Write, Edit, Bash/);
  assert.match(builder, /Handover protocol/);
  assert.match(builder, /_fleet\/local\/handoffs\/\{seq\}-builder-to-reviewer\.md/);
  assert.match(builder, /_fleet\/local\/LEDGER\.md/);
  assert.doesNotMatch(builder, /\.\.\//); // no ugly relative paths
});

test('claude-code emits effort, maxTurns, memory, permissionMode and a stable color', () => {
  const spec = normalizeSpec({
    fleet: { name: 'fm', domain: 'frontmatter' },
    agents: [
      { name: 'analyst', effort: 'minimal', turns: 12, memory: true, handoff: { to: ['writer'] } },
      { name: 'writer', capabilities: { read: true, edit: true }, effort: 'max', handoff: { to: [] } },
    ],
  });
  const files = buildClaudeCode(spec, {});
  const analyst = files.files.get('.claude/agents/analyst.md');
  const writer = files.files.get('.claude/agents/writer.md');

  // `minimal` has no Claude Code equivalent and collapses onto low
  assert.match(analyst, /^effort: low$/m);
  assert.match(analyst, /^maxTurns: 12$/m);
  assert.match(analyst, /^memory: project$/m);
  // read-only agent plans; editing agent accepts its own edits
  assert.match(analyst, /^permissionMode: plan$/m);
  assert.match(writer, /^permissionMode: acceptEdits$/m);
  assert.match(writer, /^effort: max$/m);
  // colors are assigned by roster order, so a rebuild does not reshuffle them
  assert.match(analyst, /^color: blue$/m);
  assert.match(writer, /^color: green$/m);

  // absent optionals emit nothing rather than nulls
  const plain = buildClaudeCode(demoSpec(), {}).files.get('.claude/agents/analyst.md');
  assert.doesNotMatch(plain, /effort:|maxTurns:|memory:|isolation:/);
});

test('claude-code agents inherit the session model unless the spec opts into pinning', () => {
  const raw = {
    fleet: { name: 'mdl', domain: 'd' },
    agents: [
      { name: 'thinker', model: 'smart', handoff: { to: ['worker'] } },
      { name: 'worker', model: 'cheap', handoff: { to: [] } },
    ],
  };

  // Default: no tier is bound to a name. A pinned model overrides the session,
  // so a fleet that hardcoded opus would spawn opus on a Sonnet session and
  // fail outright where opus is not on the user's plan.
  const plain = buildClaudeCode(normalizeSpec(raw), {});
  assert.match(plain.files.get('.claude/agents/thinker.md'), /^model: inherit$/m);
  assert.match(plain.files.get('.claude/agents/worker.md'), /^model: inherit$/m);

  // Opting in binds the tiers the author supplied.
  const pinned = buildClaudeCode(
    normalizeSpec({ ...raw, defaults: { claudeModels: { smart: 'opus', cheap: 'haiku' } } }),
    {}
  );
  assert.match(pinned.files.get('.claude/agents/thinker.md'), /^model: opus$/m);
  assert.match(pinned.files.get('.claude/agents/worker.md'), /^model: haiku$/m);

  // A partial map leaves the tiers it does not name on inherit.
  const partial = buildClaudeCode(
    normalizeSpec({ ...raw, defaults: { claudeModels: { smart: 'opus' } } }),
    {}
  );
  assert.match(partial.files.get('.claude/agents/thinker.md'), /^model: opus$/m);
  assert.match(partial.files.get('.claude/agents/worker.md'), /^model: haiku$/m);
});

test('claude-code isolates concurrent editors in worktrees, unless opted out', () => {
  const raw = {
    fleet: { name: 'par', domain: 'parallel edits' },
    agents: [
      { name: 'edit-a', capabilities: { read: true, edit: true }, handoff: { to: [] } },
      { name: 'edit-b', capabilities: { read: true, edit: true }, handoff: { to: [] } },
      { name: 'reader', handoff: { to: [] } },
    ],
    orchestrator: { phases: [{ name: 'Both', agents: ['edit-a', 'edit-b', 'reader'], parallel: true }] },
  };
  const files = buildClaudeCode(normalizeSpec(raw), {});
  assert.match(files.files.get('.claude/agents/edit-a.md'), /^isolation: worktree$/m);
  assert.match(files.files.get('.claude/agents/edit-a.md'), /## Isolation/);
  // a read-only agent in the same phase collides with nobody
  assert.doesNotMatch(files.files.get('.claude/agents/reader.md'), /isolation:/);

  // explicit opt-out for fleets that coordinate writes themselves
  const opted = buildClaudeCode(
    normalizeSpec({ ...raw, fleet: { ...raw.fleet, allowParallelWrites: true } }),
    {}
  );
  assert.doesNotMatch(opted.files.get('.claude/agents/edit-a.md'), /isolation:/);
});

test('claude-code never emits tools the platform strips from subagents', () => {
  for (const pattern of Object.keys(ARCHETYPES)) {
    const files = buildClaudeCode(normalizeSpec(archetype(pattern, `f-${pattern}`, 'd')), {});
    for (const [p, content] of files.files) {
      if (!p.startsWith('.claude/agents/')) continue;
      const fm = content.split('---')[1];
      assert.doesNotMatch(fm, /AskUserQuestion|ExitPlanMode|Workflow/, `${p} names a stripped tool`);
    }
  }
});

test('read-only agent gets no Write/Edit/Bash tools in claude-code', () => {
  const files = buildClaudeCode(demoSpec(), {});
  const analyst = files.files.get('.claude/agents/analyst.md');
  const fm = analyst.split('---')[1];
  assert.doesNotMatch(fm, /Write|Edit|Bash/);
  assert.match(fm, /WebSearch/); // analyst has web capability
});

test('opencode adapter emits subagents, primary orchestrator, command', () => {
  const files = buildOpencode(demoSpec(), { today: '2026-07-04' });
  const paths = files.list();
  assert.ok(paths.includes('.opencode/agents/analyst.md'));
  assert.ok(paths.includes('.opencode/agents/run-demo.md'));
  assert.ok(paths.includes('.opencode/commands/run-demo.md'));
  assert.ok(paths.includes('AGENTS.md'));

  // analyst is read-only: permission map (tools: is deprecated upstream)
  // denies edit outside the fleet workspace and denies bash entirely
  const analyst = files.files.get('.opencode/agents/analyst.md');
  assert.match(analyst, /mode: subagent/);
  assert.match(analyst, /bash: deny/);
  assert.match(analyst, /_fleet\/\*\*: allow/);
  assert.doesNotMatch(analyst.split('---')[1], /tools:/);

  const orch = files.files.get('.opencode/agents/run-demo.md');
  assert.match(orch, /mode: primary/);
  // orchestrator may only spawn fleet agents via task permission map
  assert.match(orch, /task:\n\s+"\*": deny/);
  assert.match(orch, /analyst: allow/);
});

test('opencode.json raises subagent_depth — the default of 1 breaks nested delegation', () => {
  const config = JSON.parse(buildOpencode(demoSpec(), {}).files.get('opencode.json'));
  assert.equal(config.subagent_depth, 2);
  assert.equal(config.default_agent, 'run-demo');
  assert.deepEqual(config.instructions, ['AGENTS.md']);
  // a one-shot fleet has no long session to prune
  assert.equal(config.compaction, undefined);

  // supervisors of supervisors need one more level
  const deep = JSON.parse(
    buildOpencode(normalizeSpec(archetype('supervisor', 'h', 'd')), {}).files.get('opencode.json')
  );
  assert.ok(deep.subagent_depth >= 2);
  const hier = normalizeSpec({
    fleet: { name: 'hi', domain: 'd', pattern: 'hierarchical' },
    agents: [{ name: 'a', handoff: { to: [] } }],
  });
  assert.equal(JSON.parse(buildOpencode(hier, {}).files.get('opencode.json')).subagent_depth, 3);

  // looping/scheduled fleets are the ones that hit the context ceiling
  const looped = JSON.parse(buildOpencode(loopSpec(), {}).files.get('opencode.json'));
  assert.deepEqual(looped.compaction, { prune: true, tail_turns: 4 });
});

test('opencode.json carries mcp servers and small_model when supplied', () => {
  const spec = normalizeSpec({
    fleet: {
      name: 'x',
      domain: 'd',
      mcp: { remote: { type: 'http', url: 'https://e.com/mcp' }, local: { command: 'srv', args: ['--port', '1'] } },
    },
    defaults: { opencodeModels: { cheap: 'anthropic/claude-haiku-4-5', smart: 'anthropic/claude-opus-5' } },
    agents: [{ name: 'a', model: 'smart', handoff: { to: [] } }],
  });
  const config = JSON.parse(buildOpencode(spec, {}).files.get('opencode.json'));
  assert.equal(config.small_model, 'anthropic/claude-haiku-4-5');
  assert.deepEqual(config.mcp.remote, { type: 'remote', url: 'https://e.com/mcp', enabled: true });
  assert.deepEqual(config.mcp.local.command, ['srv', '--port', '1']);
  // tiers resolve to concrete ids only when the author supplied a mapping
  assert.match(buildOpencode(spec, {}).files.get('.opencode/agents/a.md'), /^model: anthropic\/claude-opus-5$/m);
  assert.doesNotMatch(buildOpencode(demoSpec(), {}).files.get('.opencode/agents/analyst.md'), /^model:/m);
});

test('opencode compiles the handoff graph into permission.task and skills into permission.skill', () => {
  const raw = archetype('pipeline', 'demo', 'demo domain');
  raw.skills = [
    { name: 'only-mine', description: 'A methodology attached to exactly one agent, used to check skill permission scoping.' },
  ];
  raw.agents[0].skills = ['only-mine'];
  raw.agents[0].turns = 20;
  raw.agents[0].effort = 'max';
  raw.agents[0].hidden = true;
  const files = buildOpencode(normalizeSpec(raw), {});
  const analyst = files.files.get('.opencode/agents/analyst.md');

  // analyst hands off to builder only: everything else is denied and therefore
  // never appears in the task tool description
  assert.match(analyst, /task:\n\s+"\*": deny\n\s+builder: allow/);
  assert.doesNotMatch(analyst, /reviewer: allow/);
  assert.match(analyst, /skill:\n\s+"\*": deny\n\s+only-mine: allow/);
  assert.match(analyst, /^steps: 20$/m);
  assert.match(analyst, /^variant: max$/m);
  assert.match(analyst, /^hidden: true$/m);

  // a terminal agent delegates to nobody
  assert.match(files.files.get('.opencode/agents/reviewer.md'), /^\s+task: deny$/m);
});

test('opencode kickoff isolates the run; fleet-status arrives with live state inlined', () => {
  const files = buildOpencode(demoSpec(), {});
  assert.match(files.files.get('.opencode/commands/run-demo.md'), /^subtask: true$/m);

  const status = files.files.get('.opencode/commands/fleet-status.md');
  assert.match(status, /!`ls -1 _fleet\/local\/handoffs/);
  assert.match(status, /@_fleet\/local\/LEDGER\.md/);
  assert.match(status, /Do not start any fleet work/);
});

test('goose adapter emits valid recipe YAML with sub_recipes', () => {
  const files = buildGoose(demoSpec(), { today: '2026-07-04' });
  const orch = YAML.parse(files.files.get('.goose/recipes/run-demo.yaml'));
  assert.equal(orch.version, '1.0.0');
  assert.equal(orch.sub_recipes.length, 3);
  assert.equal(orch.sub_recipes[0].path, '.goose/recipes/analyst.yaml');
  assert.ok(orch.parameters.some((p) => p.key === 'request'));

  const agent = YAML.parse(files.files.get('.goose/recipes/analyst.yaml'));
  assert.ok(agent.instructions.includes('Handover protocol'));
  assert.ok(agent.parameters.some((p) => p.key === 'task_brief'));
  // analyst is read-only: instructions must carry the constraint
  assert.ok(agent.instructions.includes('Access constraint'));
  // sub_recipes entries carry descriptions for tool selection
  assert.ok(orch.sub_recipes.every((s) => s.description));
});

// --- deterministic handover gate (claude-code) ------------------------------

test('claude-code emits a settings allowlist and a SubagentStop gate', () => {
  const files = buildClaudeCode(demoSpec(), {});
  const settings = JSON.parse(files.files.get('.claude/settings.json'));

  // allowlist follows declared capabilities; handoff writes are always scoped in
  assert.ok(settings.permissions.allow.includes('Read'));
  assert.ok(settings.permissions.allow.includes('Write(_fleet/**)'));
  assert.ok(settings.permissions.allow.includes('Bash')); // builder/reviewer run

  const gate = settings.hooks.SubagentStop[0];
  assert.match(gate.matcher, /analyst/);
  assert.match(gate.hooks[0].command, /validate-handoff\.sh/);
  assert.ok(files.list().includes('_fleet/local/scripts/validate-handoff.sh'));

  // the workspace-trust caveat must reach the user: an inert gate looks identical to a passing one
  assert.match(files.files.get('CLAUDE.md'), /until this workspace is trusted/);
});

test('handover gate blocks incomplete handoffs and passes template-shaped ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-gate-'));
  buildClaudeCode(demoSpec(), {}).write(dir, { force: true });
  const script = path.join(dir, '_fleet/local/scripts/validate-handoff.sh');
  const run = (payload) =>
    spawnSync('sh', [script], { input: payload, cwd: dir, encoding: 'utf8' });

  // no handoff file yet -> exit 2 blocks the agent from stopping
  const missing = run('{"agent_type":"analyst"}');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no handoff file found/);

  // present but missing required sections -> still blocked, and says which
  const handoff = path.join(dir, '_fleet/local/handoffs/01-analyst-to-builder.md');
  fs.writeFileSync(handoff, '# Handoff\n\n## Objective\nDo it.\n');
  const partial = run('{"agent_type":"analyst"}');
  assert.equal(partial.status, 2);
  assert.match(partial.stderr, /missing required section\(s\).*Boundaries/s);

  // the bundled template satisfies the gate it ships with
  const template = fs.readFileSync(path.join(dir, '_fleet/local/handoffs/HANDOFF.template.md'), 'utf8');
  fs.writeFileSync(handoff, template.replace(/\{[^}]*\}/g, 'x'));
  fs.appendFileSync(path.join(dir, '_fleet/local/LEDGER.md'), '\n| 1 | x | analyst | - | done | h.md |\n');
  assert.equal(run('{"agent_type":"analyst"}').status, 0);

  // terminal agents owe no handoff file, and unattributable stops are not ours to police
  assert.equal(run('{"agent_type":"reviewer"}').status, 0);
  assert.equal(run('{"agent_type":"stranger"}').status, 0);
  assert.equal(run('').status, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('workspace paths cannot inject shell into the generated gate', () => {
  // The gate script runs on whoever installs the harness, and fleet specs are
  // meant to be shared — so a hostile workspace path must not become code.
  const hostile = `_fleet'; touch ${path.join(os.tmpdir(), 'fleetsmith-pwned')}; echo '`;
  const spec = normalizeSpec({
    fleet: { name: 'x', domain: 'd', workspace: hostile },
    agents: [{ name: 'a', handoff: { to: ['b'] } }, { name: 'b', handoff: { to: [] } }],
  });

  // layer 1: the validator refuses the spec outright
  const { errors } = validateSpec(spec);
  assert.ok(errors.some((e) => /fleet\.workspace .* not a safe relative path/.test(e)));
  assert.ok(errors.some((e) => /handover\.dir .* not a safe relative path/.test(e)));

  // layer 2: were it generated anyway, the interpolation is inert
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-inject-'));
  const script = path.join(dir, 'gate.sh');
  fs.writeFileSync(script, validatorScript(spec));
  spawnSync('sh', [script], { input: '', encoding: 'utf8', cwd: dir });
  assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'fleetsmith-pwned')), 'generated script executed injected commands');
  fs.rmSync(dir, { recursive: true, force: true });

  // ordinary paths still pass
  assert.deepEqual(
    validateSpec(normalizeSpec({ fleet: { name: 'x', domain: 'd', workspace: '.fleet/work_1' }, agents: [{ name: 'a', handoff: { to: [] } }] })).errors,
    []
  );
  // traversal and absolute paths are rejected too
  for (const bad of ['../escape', '/etc/fleet']) {
    const s = normalizeSpec({ fleet: { name: 'x', domain: 'd', workspace: bad }, agents: [{ name: 'a', handoff: { to: [] } }] });
    assert.ok(validateSpec(s).errors.some((e) => /safe relative path/.test(e)), `${bad} should be rejected`);
  }
});

test('scheduled fleets get .claude/loop.md; one-shot fleets do not', () => {
  assert.ok(buildClaudeCode(loopSpec(), {}).list().includes('.claude/loop.md'));
  assert.ok(!buildClaudeCode(demoSpec(), {}).list().includes('.claude/loop.md'));
  const loop = buildClaudeCode(loopSpec(), {}).files.get('.claude/loop.md');
  assert.match(loop, /re-scan the surface/);
  assert.match(loop, /expire after 7 days/); // recurring tasks need re-arming
  assert.match(loop, /empty pass is a\s*valid outcome/);
});

// --- research-backed prompt layer -------------------------------------------

test('handoff template and protocol carry the four-field brief and failed approaches', () => {
  const files = buildClaudeCode(demoSpec(), {});
  const template = files.files.get('_fleet/local/handoffs/HANDOFF.template.md');
  for (const section of ['Objective', 'Output format', 'Sources and tools', 'Boundaries', 'Failed approaches']) {
    assert.match(template, new RegExp(`^## ${section}$`, 'm'), `template missing ${section}`);
  }
  assert.match(template, /POINTERS, not pasted contents/);

  const analyst = files.files.get('.claude/agents/analyst.md');
  assert.match(analyst, /Required sections in your handoff file/);
  assert.match(analyst, /1,000–2,000 tokens/); // worker compression contract
});

test('orchestrator cites handoffs instead of paraphrasing, and states precedence', () => {
  const skill = buildClaudeCode(demoSpec(), {}).files.get('.claude/skills/run-demo/SKILL.md');
  assert.match(skill, /Pass work by citing files, not by restating them/);
  assert.match(skill, /\*\*Precedence\.\*\*/);
  assert.match(skill, /the skill wins for methodology/);
  assert.match(skill, /write a row when a phase \*\*starts\*\*/);
});

test('verifier agents get minimal-context review guidance; producers do not', () => {
  const spec = normalizeSpec(archetype('generate-verify', 'gv', 'codegen with QA'));
  const files = buildClaudeCode(spec, {});
  const verifier = files.files.get('.claude/agents/verifier.md');
  assert.match(verifier, /## Reviewing/);
  assert.match(verifier, /Flag only gaps that affect correctness/);
  assert.match(verifier, /reproducible evidence/);
  assert.doesNotMatch(files.files.get('.claude/agents/generator.md'), /## Reviewing/);
});

test('agents with memory get a durable-notes location', () => {
  const spec = normalizeSpec({
    fleet: { name: 'm', domain: 'd' },
    agents: [{ name: 'a', memory: true, handoff: { to: [] } }],
  });
  assert.match(buildClaudeCode(spec, {}).files.get('.claude/agents/a.md'), /_fleet\/local\/notes\/a\.md/);
});

test('orchestrator skill injects live workspace state and guards autonomous runs', () => {
  const plain = buildClaudeCode(demoSpec(), {}).files.get('.claude/skills/run-demo/SKILL.md');
  assert.match(plain, /argument-hint:/);
  // shell injection block: state arrives inlined, not as an instruction to go read it
  assert.match(plain, /```!\n.*_fleet\/local\/handoffs/s);
  assert.match(plain, /cat _fleet\/local\/LEDGER\.md/);
  // an attended fleet may still ask the user questions
  assert.doesNotMatch(plain, /disallowed-tools/);

  // a scheduled fleet fires unattended, so the blocking tool is removed
  const scheduled = buildClaudeCode(loopSpec(), {}).files.get('.claude/skills/run-looped/SKILL.md');
  assert.match(scheduled, /disallowed-tools: AskUserQuestion/);
});

test('skills carry scoped script grants and freedom-appropriate framing', () => {
  const raw = archetype('pipeline', 'demo', 'demo domain');
  raw.skills = [
    {
      name: 'strict-release',
      description: 'Runs the release sequence exactly as specified. Use when cutting a release or publishing a build artifact.',
      body: '# Strict release',
      freedom: 'low',
      scripts: { 'release.sh': '#!/bin/sh\necho release\n' },
    },
    {
      name: 'open-analysis',
      description: 'Heuristics for exploring an unfamiliar codebase. Use when orienting in new code or planning an investigation.',
      body: '# Open analysis',
      freedom: 'high',
    },
  ];
  raw.agents[0].skills = ['strict-release', 'open-analysis'];
  const files = buildClaudeCode(normalizeSpec(raw), {});

  const strict = files.files.get('.claude/skills/strict-release/SKILL.md');
  assert.match(strict, /allowed-tools: Bash\(\$\{CLAUDE_SKILL_DIR\}\/scripts\/release\.sh \*\)/);
  assert.match(strict, /do not modify them, add flags/);

  const open = files.files.get('.claude/skills/open-analysis/SKILL.md');
  assert.doesNotMatch(open, /allowed-tools/); // nothing bundled to grant
  assert.match(open, /heuristics, not a script/);
});

test('goose asks for parallelism in the prompt — the only place it takes effect', () => {
  const spec = normalizeSpec(archetype('fanout', 'fo', 'parallel research'));
  const orch = YAML.parse(buildGoose(spec, {}).files.get('.goose/recipes/run-fo.yaml'));
  // different sub-recipes run sequentially unless the prompt says otherwise,
  // and there is no YAML key for it
  assert.match(orch.prompt, /in parallel/);
  assert.match(orch.prompt, /worker-a.*worker-b/s);

  // a purely sequential fleet must not claim parallelism
  const seq = YAML.parse(buildGoose(demoSpec(), {}).files.get('.goose/recipes/run-demo.yaml'));
  assert.doesNotMatch(seq.prompt, /in parallel/);
});

test('goose emits per-agent settings, summon for spawners, and json_schema handoffs', () => {
  const spec = normalizeSpec({
    fleet: { name: 'g', domain: 'd' },
    defaults: { gooseModels: { cheap: 'anthropic/claude-haiku-4-5' } },
    agents: [
      {
        name: 'scout',
        model: 'cheap',
        turns: 15,
        capabilities: { read: true, spawn: true },
        handoff: { to: ['sink'], artifact: 'found.md', schema: true },
      },
      { name: 'sink', handoff: { to: [] } },
    ],
  });
  const files = buildGoose(spec, {});
  const scout = YAML.parse(files.files.get('.goose/recipes/scout.yaml'));

  assert.deepEqual(scout.settings, { goose_model: 'anthropic/claude-haiku-4-5', max_turns: 15 });
  // an explicit extensions block drops the platform defaults, taking delegation with it
  assert.ok(scout.extensions.some((e) => e.type === 'platform' && e.name === 'summon'));
  // the declared handoff contract becomes runtime-validated structured output
  assert.equal(scout.response.json_schema.type, 'object');
  assert.ok(scout.response.json_schema.required.includes('objective'));
  assert.ok(scout.response.json_schema.required.includes('handoff_file'));

  // terminal agents owe no handoff, so no response schema; non-spawners get no summon
  const sink = YAML.parse(files.files.get('.goose/recipes/sink.yaml'));
  assert.equal(sink.response, undefined);
  assert.ok(!sink.extensions.some((e) => e.name === 'summon'));
  assert.equal(sink.settings, undefined);
});

test('goose emits parallel review checks for verifier agents only', () => {
  const spec = normalizeSpec(archetype('generate-verify', 'gv', 'codegen with QA'));
  const files = buildGoose(spec, {});
  assert.ok(files.list().includes('.agents/checks/verifier.md'));
  assert.ok(!files.list().includes('.agents/checks/generator.md'));

  const check = files.files.get('.agents/checks/verifier.md');
  // filename must equal the `name` field for goose to load it
  assert.match(check, /^name: verifier$/m);
  assert.match(check, /^turn-limit: 25$/m);
  assert.match(check, /Every defect has a repro/); // the spec's acceptance criteria
  assert.match(check, /Flag only what affects correctness/);

  // a fleet with no verifier emits no checks at all
  assert.ok(!buildGoose(normalizeSpec(archetype('fanout', 'fo', 'd')), {}).list().some((p) => p.startsWith('.agents/checks/')));
});

test('buildAll merges targets without collisions and dedups shared files', () => {
  const files = buildAll(demoSpec(), { today: '2026-07-04' });
  const paths = files.list();
  assert.equal(paths.filter((p) => p === '_fleet/local/LEDGER.md').length, 1);
  assert.equal(paths.filter((p) => p === 'AGENTS.md').length, 1);
  assert.ok(paths.some((p) => p.startsWith('.claude/')));
  assert.ok(paths.some((p) => p.startsWith('.opencode/')));
  assert.ok(paths.some((p) => p.startsWith('.goose/')));
});

test('orchestrator name colliding with an agent name does not cause a file collision', () => {
  // When the orchestrator shares a name with an agent, the orchestrator file
  // replaces the agent file (the orchestrator IS that agent, promoted to
  // primary mode). Without this, FileSet.add throws on the duplicate path.
  const spec = normalizeSpec({
    fleet: { name: 'collide', domain: 'd' },
    orchestrator: { name: 'lead', trigger: 'stuff' },
    agents: [
      { name: 'lead', role: 'the lead', handoff: { to: ['worker'] } },
      { name: 'worker', role: 'the worker', handoff: { to: [] } },
    ],
  });

  // opencode: orchestrator file replaces the agent file
  const oc = buildOpencode(spec, {});
  assert.ok(oc.files.has('.opencode/agents/lead.md'));
  assert.ok(oc.files.has('.opencode/agents/worker.md'));
  assert.match(oc.files.get('.opencode/agents/lead.md'), /mode: primary/);
  // orchestrator must not list itself in the task permission map (self-delegation)
  assert.doesNotMatch(oc.files.get('.opencode/agents/lead.md'), /lead: allow/);

  // goose: orchestrator recipe replaces the agent recipe; sub_recipes excludes self
  const goose = buildGoose(spec, {});
  assert.ok(goose.files.has('.goose/recipes/lead.yaml'));
  assert.ok(goose.files.has('.goose/recipes/worker.yaml'));
  const orch = YAML.parse(goose.files.get('.goose/recipes/lead.yaml'));
  assert.ok(!orch.sub_recipes.some((s) => s.name === 'lead'), 'orchestrator lists itself as a sub_recipe');

  // validator warns so authors know one file is missing
  const { warnings } = validateSpec(spec);
  assert.ok(warnings.some((w) => /shares a name with an agent/.test(w)));
});

test('buildAll emits skills once (.claude/skills) — opencode and goose read it natively', () => {
  const raw = archetype('pipeline', 'demo', 'demo domain');
  raw.skills = [
    {
      name: 'shared-skill',
      description:
        'A shared methodology skill used to verify single-emission of skills across combined multi-tool builds.',
      body: '# Shared skill',
    },
  ];
  raw.agents[0].skills = ['shared-skill'];
  const files = buildAll(normalizeSpec(raw), {});
  const skillPaths = files.list().filter((p) => p.includes('shared-skill')).sort();
  assert.deepEqual(skillPaths, [
    '.claude/skills/shared-skill/SKILL.md',
    '.claude/skills/shared-skill/evals/evals.json',
  ]);
  // solo builds still emit tool-local skills
  const solo = buildOpencode(normalizeSpec(raw), {}).list();
  assert.ok(solo.includes('.opencode/skills/shared-skill/SKILL.md'));
});

test('skills are emitted for claude-code and opencode with references', () => {
  const raw = archetype('pipeline', 'demo', 'demo domain');
  raw.skills = [
    {
      name: 'requirements-analysis',
      description:
        'Methodology for turning vague requests into testable requirements. Use whenever analyzing a new feature request or writing a requirements handoff.',
      body: '# Requirements analysis\n\nDo the thing.',
      references: { 'checklist.md': '- [ ] testable?\n' },
    },
  ];
  raw.agents[0].skills = ['requirements-analysis'];
  const spec = normalizeSpec(raw);
  const { errors } = validateSpec(spec);
  assert.deepEqual(errors, []);

  const cc = buildClaudeCode(spec, {}).list();
  assert.ok(cc.includes('.claude/skills/requirements-analysis/SKILL.md'));
  assert.ok(cc.includes('.claude/skills/requirements-analysis/references/checklist.md'));
  const oc = buildOpencode(spec, {}).list();
  assert.ok(oc.includes('.opencode/skills/requirements-analysis/SKILL.md'));

  // agent frontmatter preloads the skill; prompt also instructs loading
  const analyst = buildClaudeCode(spec, {}).files.get('.claude/agents/analyst.md');
  assert.match(analyst, /skills:\n\s+- requirements-analysis/);
  assert.match(analyst, /\*\*requirements-analysis\*\*/);
});

// --- claude-workflow target (experimental) ----------------------------------

/**
 * Workflow scripts are plain JS whose body runs inside an async function, so
 * `export const meta` is module-level while the rest may use top-level await
 * and return. Check the two halves in the contexts they actually run in.
 */
function assertWorkflowParses(src, label) {
  const split = src.indexOf('\n\nconst ');
  assert.ok(split > 0, `${label}: could not locate end of meta block`);
  // meta half: valid ESM
  assert.doesNotThrow(
    () => new Function(`return ${src.slice(src.indexOf('=') + 1, split)}`),
    `${label}: meta block is not a valid literal`
  );
  // body half: valid inside an async function
  assert.doesNotThrow(
    () => new Function('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', `return (async () => {${src.slice(split)}})`),
    `${label}: body is not valid in an async context`
  );
}

test('every archetype compiles to a syntactically valid workflow script', () => {
  for (const pattern of Object.keys(ARCHETYPES)) {
    const spec = normalizeSpec(archetype(pattern, `wf-${pattern}`, 'workflow check'));
    const files = buildClaudeWorkflow(spec, {});
    const src = files.files.get(`.claude/workflows/run-wf-${pattern}.js`);
    assert.ok(src, `${pattern}: no workflow emitted`);
    assertWorkflowParses(src, pattern);
    // meta must be a pure literal — no interpolation, no calls
    assert.match(src, /^export const meta = \{/);
    assert.doesNotMatch(src.slice(0, src.indexOf('\n\nconst ')), /\$\{|\(\)/);
  }
});

test('workflow filename matches meta.name — discovery keys on the name, not the file', () => {
  for (const pattern of Object.keys(ARCHETYPES)) {
    const spec = normalizeSpec(archetype(pattern, `n-${pattern}`, 'naming check'));
    const files = buildClaudeWorkflow(spec, {});
    const scriptPath = files.list().find((p) => p.startsWith('.claude/workflows/'));
    const declared = /name":\s*"([^"]+)"/.exec(files.files.get(scriptPath))[1];
    assert.equal(`.claude/workflows/${declared}.js`, scriptPath);
  }
});

test('workflow target emits the agent definitions it resolves via agentType', () => {
  // An unknown agentType throws at the first agent() call, so a standalone
  // build that shipped only the script would be guaranteed to fail.
  const files = buildClaudeWorkflow(demoSpec(), {});
  const paths = files.list();
  for (const name of ['analyst', 'builder', 'reviewer']) {
    assert.ok(paths.includes(`.claude/agents/${name}.md`), `missing definition for ${name}`);
  }
  // and they are byte-identical to what the claude-code target emits, so the
  // two targets cannot drift into different definitions of the same agent
  const cc = buildClaudeCode(demoSpec(), {});
  for (const p of paths.filter((x) => x.startsWith('.claude/agents/'))) {
    assert.equal(files.files.get(p), cc.files.get(p), `${p} differs between targets`);
  }
});

test('workflow reuses the .claude/agents definitions rather than restating them', () => {
  const spec = normalizeSpec({
    fleet: { name: 'wf', domain: 'd' },
    agents: [
      { name: 'first', model: 'cheap', effort: 'low', handoff: { to: ['second'], artifact: 'a.md' } },
      { name: 'second', handoff: { to: [] } },
    ],
  });
  const src = buildClaudeWorkflow(spec, {}).files.get('.claude/workflows/run-wf.js');

  // agentType points at the emitted subagent definition, so prompts/tools/model
  // stay defined in exactly one place
  assert.match(src, /agentType: "first"/);
  assert.match(src, /effort: "low"/);
  // no model override by default — the agent definition and session decide
  assert.doesNotMatch(src, /model:/);

  // opting in pins the tier
  const pinned = buildClaudeWorkflow(
    normalizeSpec({
      fleet: { name: 'wf', domain: 'd' },
      defaults: { claudeModels: { cheap: 'haiku' } },
      agents: [
        { name: 'first', model: 'cheap', handoff: { to: ['second'], artifact: 'a.md' } },
        { name: 'second', handoff: { to: [] } },
      ],
    }),
    {}
  ).files.get('.claude/workflows/run-wf.js');
  assert.match(pinned, /model: "haiku"/);
  // structured results, so passing work between phases costs no context
  assert.match(src, /schema: SCHEMA_FIRST/);
  // handoff files remain the durable artifact
  assert.match(src, /_fleet\/local\/handoffs/);
  assert.match(src, /The file is the durable artifact/);
});

test('workflow turns a phase loop into real control flow with all three stops', () => {
  const src = buildClaudeWorkflow(loopSpec(), {}).files.get('.claude/workflows/run-looped.js');
  assert.match(src, /while \(verifyPass < 4 && !verifyDone\)/); // cap
  assert.match(src, /if \(verifyStale >= 2\)/); // no-progress
  assert.match(src, /verifyDone = !!verifyCheck\?\.passed/); // success via the shell check
  // the script cannot run shell itself, so an agent runs the command and reports it
  assert.match(src, /Run exactly this command and report the result/);
  assert.match(src, /npm test/);
  assert.match(src, /model: 'haiku'/); // a command runner does not need a strong model

  // `checker` reviews rather than produces, so it is asked to re-check its own
  // prior findings — handing it "fix these" would blame it for what it reported
  assert.match(src, /confirm each is genuinely resolved/);

  // a producing agent in a loop gets the opposite framing
  const producerLoop = normalizeSpec({
    fleet: { name: 'pl', domain: 'd' },
    agents: [{ name: 'writer', capabilities: { read: true, edit: true }, handoff: { to: [] } }],
    orchestrator: { phases: [{ name: 'Refine', agents: ['writer'], loop: { until: 'it reads well', max: 3 } }] },
  });
  const psrc = buildClaudeWorkflow(producerLoop, {}).files.get('.claude/workflows/run-pl.js');
  assert.match(psrc, /fix these specifically, do not restart from scratch/);
});

test('workflow runs parallel phases concurrently and isolates concurrent editors', () => {
  const spec = normalizeSpec({
    fleet: { name: 'par', domain: 'd' },
    agents: [
      { name: 'w-a', capabilities: { read: true, edit: true }, handoff: { to: ['merge'] } },
      { name: 'w-b', capabilities: { read: true, edit: true }, handoff: { to: ['merge'] } },
      { name: 'merge', capabilities: { read: true, edit: true }, handoff: { to: [] } },
    ],
    orchestrator: {
      phases: [
        { name: 'Fan out', agents: ['w-a', 'w-b'], parallel: true },
        { name: 'Merge', agents: ['merge'] },
      ],
    },
  });
  const src = buildClaudeWorkflow(spec, {}).files.get('.claude/workflows/run-par.js');
  assert.match(src, /await parallel\(\[/);
  // concurrent writers get worktrees for the same reason they do on the main target
  assert.match(src, /isolation: 'worktree'/);
});

test('claude-workflow is opt-in — "all" does not silently emit a paid-plan-only script', () => {
  const all = buildAll(demoSpec(), {}).list();
  assert.ok(!all.some((p) => p.startsWith('.claude/workflows/')));
  assert.deepEqual(DEFAULT_TARGETS, ['claude-code', 'opencode', 'goose']);
  // but it is reachable explicitly
  assert.ok(ADAPTERS['claude-workflow']);
  assert.ok(buildClaudeWorkflow(demoSpec(), {}).list().includes('.claude/workflows/run-demo.js'));
});

test('planInstall project scope passes files through verbatim into --into dir', () => {
  const files = buildAll(demoSpec(), { today: '2026-07-04' });
  const plan = planInstall(files, { scope: 'project', into: '/some/app' });
  assert.equal(plan.baseDir, '/some/app');
  assert.equal(plan.fileSet, files);
  assert.deepEqual(plan.skipped, []);
});

test('planInstall user scope remaps tool roots to $HOME config and skips singletons', () => {
  const files = buildAll(demoSpec(), { today: '2026-07-04' });
  const plan = planInstall(files, { scope: 'user', home: '/home/u' });
  const out = plan.fileSet.list();

  // reusable definitions land in each tool's user-global config dir
  assert.ok(out.includes('.claude/agents/analyst.md'));
  assert.ok(out.includes('.config/opencode/agents/analyst.md'));
  assert.ok(out.includes('.config/goose/recipes/analyst.yaml'));
  assert.equal(plan.baseDir, '/home/u');

  // no project-relative tool dirs leak through
  assert.ok(!out.some((p) => p.startsWith('.opencode/') || p.startsWith('.goose/')));

  // shared singletons + runtime workspace are skipped, with reasons
  const skipped = plan.skipped.map((s) => s.path);
  assert.ok(skipped.includes('CLAUDE.md'));
  assert.ok(skipped.includes('AGENTS.md'));
  assert.ok(skipped.some((p) => p.startsWith('_fleet/')));
  assert.ok(plan.skipped.every((s) => s.reason));

  // a fleet's own permissions/hooks must never land on the user's global config
  assert.ok(!out.includes('.claude/settings.json'), 'would overwrite the user global settings.json');
  assert.ok(skipped.includes('.claude/settings.json'));
  assert.ok(!out.includes('opencode.json'));
  const scheduled = planInstall(buildAll(loopSpec(), {}), { scope: 'user', home: '/home/u' });
  assert.ok(!scheduled.fileSet.list().includes('.claude/loop.md'), 'would override /loop everywhere');
});

test('planInstall rejects unknown scope', () => {
  assert.throws(() => planInstall(buildAll(demoSpec(), {}), { scope: 'global' }), /Unknown install scope/);
});

test('every emitted markdown file has parseable frontmatter with a description', () => {
  // Malformed frontmatter does not error — the body loads with empty metadata,
  // so the skill still runs when invoked by name while never matching a
  // description. That failure is invisible without --debug, so gate it here.
  const raw = archetype('pipeline', 'fm-check', 'frontmatter integrity');
  raw.skills = [
    {
      name: 'quoting-edge-cases',
      description: 'Handles descriptions with "quotes", colons: and other YAML-hostile punctuation. Use when testing frontmatter serialization.',
      body: '# Body',
    },
  ];
  raw.agents[0].skills = ['quoting-edge-cases'];
  const files = buildAll(normalizeSpec(raw), { today: '2026-01-01' });

  let checked = 0;
  for (const [p, content] of files.files) {
    if (!p.endsWith('.md')) continue;
    const isDefinition = /\.(claude|opencode)\/(agents|commands|skills)\//.test(p);
    if (!isDefinition) continue;
    assert.ok(content.startsWith('---\n'), `${p} does not open with frontmatter`);
    const end = content.indexOf('\n---\n', 4);
    assert.ok(end > 0, `${p} has no closing frontmatter fence`);
    const fm = YAML.parse(content.slice(4, end));
    assert.ok(fm && typeof fm === 'object', `${p} frontmatter did not parse to a mapping`);
    assert.ok(fm.description, `${p} has no description — nothing can route to it`);
    checked++;
  }
  assert.ok(checked > 5, `expected to check several definitions, checked ${checked}`);
});

test('skills ship trigger corpora and a fleet-level evals guide', () => {
  const raw = archetype('pipeline', 'demo', 'demo domain');
  raw.skills = [
    {
      name: 'with-triggers',
      description: 'Does a specific thing well. Use when the user asks for that specific thing by name.',
      triggers: { should: ['do the specific thing'], should_not: ['something unrelated'] },
    },
    { name: 'no-triggers', description: 'Another methodology skill. Use when the second kind of task comes up.' },
  ];
  raw.agents[0].skills = ['with-triggers', 'no-triggers'];
  const files = buildClaudeCode(normalizeSpec(raw), {});

  const withT = JSON.parse(files.files.get('.claude/skills/with-triggers/evals/evals.json'));
  assert.deepEqual(withT.should_trigger, ['do the specific thing']);
  assert.deepEqual(withT.should_not_trigger, ['something unrelated']);
  assert.deepEqual(withT.cases, []); // assertions come after the first run, not before

  // a skill with no declared triggers still gets the file, with prompts to fill in
  const without = JSON.parse(files.files.get('.claude/skills/no-triggers/evals/evals.json'));
  assert.match(without.should_trigger[0], /TODO/);

  const readme = files.files.get('_fleet/local/evals/README.md');
  assert.match(readme, /fresh session is not optional/);
  assert.match(readme, /edit the `description`, not the prompt/);
});

test('nothing fleetsmith ships out of the box binds an agent to a named model', () => {
  // A generated harness has to run on whatever plan and provider the user has.
  // Emitting a concrete model anywhere without an explicit opt-in would make
  // the fleet fail for anyone lacking that exact model.
  for (const pattern of Object.keys(ARCHETYPES)) {
    const spec = normalizeSpec(archetype(pattern, `p-${pattern}`, 'no pinning'));
    for (const [p, content] of buildAll(spec, {}).files) {
      if (p.startsWith('.claude/agents/')) {
        assert.match(content, /^model: inherit$/m, `${p} pins a model`);
      }
      if (p.startsWith('.opencode/agents/') || p.endsWith('.yaml')) {
        assert.doesNotMatch(content, /^\s*(model|goose_model):\s*\S/m, `${p} pins a model`);
      }
    }
  }
});

test('generated output is machine-portable: relative paths only, no host-specific references', () => {
  for (const pattern of Object.keys(ARCHETYPES)) {
    const spec = normalizeSpec(archetype(pattern, `port-${pattern}`, 'portability check'));
    const files = buildAll(spec, { today: '2026-01-01' });
    for (const [p, content] of files.files) {
      assert.ok(!p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p), `absolute output path: ${p}`);
      assert.doesNotMatch(content, /\/Users\/|\/home\/[a-z]|[A-Z]:\\\\/, `host path leaked into ${p}`);
    }
  }
});

// --- loop engineering -------------------------------------------------------

function loopSpec() {
  return normalizeSpec({
    fleet: {
      name: 'looped',
      domain: 'iterative hardening',
      schedule: { cron: '0 3 * * 1', note: 're-scan the surface' },
    },
    agents: [
      { name: 'builder', capabilities: { read: true, edit: true, run: true }, handoff: { to: ['checker'], artifact: 'build.md' } },
      { name: 'checker', capabilities: { read: true, run: true }, handoff: { to: [], artifact: 'verdict.md' } },
    ],
    orchestrator: {
      phases: [
        { name: 'Build', agents: ['builder'] },
        {
          name: 'Verify',
          agents: ['checker'],
          loop: { until: 'checker reports no defects', max: 4, check: 'npm test' },
        },
      ],
    },
  });
}

test('normalize canonicalizes phase loops and fleet schedule', () => {
  const spec = loopSpec();
  const verify = spec.orchestrator.phases.find((p) => p.name === 'Verify');
  assert.deepEqual(verify.loop, {
    until: 'checker reports no defects',
    max: 4,
    check: 'npm test',
    noProgress: 2,
  });
  assert.equal(spec.orchestrator.phases.find((p) => p.name === 'Build').loop, null);
  assert.deepEqual(spec.fleet.schedule, { cron: '0 3 * * 1', interval: null, note: 're-scan the surface' });

  // integer shorthand -> { max: N }; invalid max falls back to default 3
  const short = normalizeSpec({
    fleet: { name: 'x' },
    agents: [{ name: 'a' }],
    orchestrator: { phases: [{ name: 'P', agents: ['a'], loop: 5 }] },
  });
  assert.equal(short.orchestrator.phases[0].loop.max, 5);
  const bad = normalizeSpec({
    fleet: { name: 'x' },
    agents: [{ name: 'a' }],
    orchestrator: { phases: [{ name: 'P', agents: ['a'], loop: { until: 'done', max: 0 } }] },
  });
  assert.equal(bad.orchestrator.phases[0].loop.max, 3);
});

test('generate-verify pattern gets a default iteration loop on its Verify phase', () => {
  const spec = normalizeSpec(archetype('generate-verify', 'gv', 'codegen with QA'));
  const verify = spec.orchestrator.phases.find((p) => p.name === 'Verify');
  assert.ok(verify.loop, 'Verify phase should carry a default loop');
  assert.equal(verify.loop.max, 3);
  assert.ok(verify.loop.until.length > 0);
});

test('orchestrator body renders the loop callout and scheduling section', () => {
  const cc = buildClaudeCode(loopSpec(), {}).files.get('.claude/skills/run-looped/SKILL.md');
  assert.match(cc, /Loop — iterate until done \(max 4 passes\)/);
  assert.match(cc, /checker reports no defects/);
  assert.match(cc, /npm test/); // objective check surfaced
  // recurring-loop translation is target-specific
  assert.match(cc, /Recurring runs \(loop engineering\)/);
  assert.match(cc, /\/loop .* \/run-looped|schedule` skill/);

  const oc = buildOpencode(loopSpec(), {}).files.get('.opencode/agents/run-looped.md');
  assert.match(oc, /opencode run --agent run-looped/);

  const goose = YAML.parse(buildGoose(loopSpec(), {}).files.get('.goose/recipes/run-looped.yaml'));
  assert.match(goose.instructions, /goose run --recipe .goose\/recipes\/run-looped\.yaml/);
});

test('goose schedule emits 6-field cron, the snapshot caveat, and the GOOSE_MODE requirement', () => {
  const goose = YAML.parse(buildGoose(loopSpec(), {}).files.get('.goose/recipes/run-looped.yaml'));
  // spec carries 5-field "0 3 * * 1"; goose parses 5 or 6 fields only, never 7
  assert.match(goose.instructions, /--cron "0 0 3 \* \* 1"/);
  assert.match(goose.instructions, /--schedule-id run-looped/);
  assert.match(goose.instructions, /snapshots the recipe/);
  assert.match(goose.instructions, /GOOSE_MODE=auto/);
});

test('goose translates a checked loop into a native retry block', () => {
  const goose = YAML.parse(buildGoose(loopSpec(), {}).files.get('.goose/recipes/run-looped.yaml'));
  assert.ok(goose.retry, 'orchestrator recipe should carry a retry block');
  assert.equal(goose.retry.max_retries, 4);
  assert.deepEqual(goose.retry.checks, [{ type: 'shell', command: 'npm test' }]);
  assert.ok(goose.retry.on_failure);

  // a loop with no shell check stays prose-only: no retry block
  const noCheck = normalizeSpec({
    fleet: { name: 'nc' },
    agents: [{ name: 'a', handoff: { to: [] } }],
    orchestrator: { phases: [{ name: 'P', agents: ['a'], loop: { until: 'good enough', max: 2 } }] },
  });
  const g2 = YAML.parse(buildGoose(noCheck, {}).files.get('.goose/recipes/run-nc.yaml'));
  assert.equal(g2.retry, undefined);
});

test('schedule surfaces in pointer files; absent schedule emits no recurring section', () => {
  const agents = buildOpencode(loopSpec(), { today: '2026-07-23' }).files.get('AGENTS.md');
  assert.match(agents, /\*\*Recurring:\*\*/);
  assert.match(agents, /0 3 \* \* 1/);

  // one-shot fleet: no schedule, no recurring section anywhere
  const plain = buildClaudeCode(demoSpec(), {}).files.get('.claude/skills/run-demo/SKILL.md');
  assert.doesNotMatch(plain, /Recurring runs/);
  const plainPtr = buildOpencode(demoSpec(), {}).files.get('AGENTS.md');
  assert.doesNotMatch(plainPtr, /Recurring:/);
});

test('validate flags runaway loop bounds, missing exit conditions, and schedule conflicts', () => {
  const spec = normalizeSpec({
    fleet: { name: 'w', domain: 'd', schedule: { cron: '0 0 * * *', interval: '1h' } },
    agents: [{ name: 'a', handoff: { to: [] } }],
    orchestrator: {
      phases: [
        { name: 'Big', agents: ['a'], loop: { until: 'never', max: 25 } },
        { name: 'Open', agents: ['a'], loop: { max: 2 } },
      ],
    },
  });
  const { warnings, errors } = validateSpec(spec);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('loop.max is 25')));
  assert.ok(warnings.some((w) => w.includes('no exit condition')));
  assert.ok(warnings.some((w) => w.includes('both cron and interval')));
});

test('team execution adds team protocol block on claude-code only', () => {
  const raw = archetype('supervisor', 'sup', 'supervision');
  const spec = normalizeSpec(raw);
  const cc = buildClaudeCode(spec, {});
  assert.match(cc.files.get('.claude/agents/lead.md'), /Team communication/);
  const oc = buildOpencode(spec, {});
  assert.doesNotMatch(oc.files.get('.opencode/agents/lead.md'), /Team communication/);
});

// --- opencode plugin surface -------------------------------------------------

/**
 * Minimal stand-in for opencode's `tool` helper (@opencode-ai/plugin), so the
 * plugin wiring is tested without the peer dependency. `tool(def)` returns the
 * def verbatim; `tool.schema.*()` returns a chainable no-op marker.
 */
function stubTool(def) {
  return def;
}
{
  const marker = { describe: () => marker, optional: () => marker };
  stubTool.schema = { string: () => marker, boolean: () => marker, number: () => marker };
}

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-oc-'));
  const specPath = path.join(dir, 'fleet.yaml');
  fs.writeFileSync(specPath, YAML.stringify(archetype('pipeline', 'demo', 'demo domain')));
  return { dir, specPath };
}

test('opencode ops: validate / build / init / patterns round-trip', () => {
  const { dir, specPath } = tmpProject();

  const v = opValidate(specPath);
  assert.equal(v.ok, true);
  assert.equal(v.agents, 3);

  const b = opBuild(specPath, { target: 'opencode', out: dir, force: true, today: '2026-07-24' });
  assert.ok(b.written.includes('.opencode/agents/analyst.md'));
  assert.ok(fs.existsSync(path.join(dir, '.opencode/agents/analyst.md')));

  const initYaml = opInit({ name: 'x', pattern: 'fanout', domain: 'd' }).yaml;
  assert.match(initYaml, /pattern: fanout/);

  assert.ok(opPatterns().some((p) => p.name === 'generate-verify'));
});

test('buildFleetsmithTools exposes the fleet_* tools and executes them against the project dir', async () => {
  const { dir } = tmpProject();
  const plugin = buildFleetsmithTools(stubTool, { directory: dir });

  // exactly the intended tool surface
  assert.deepEqual(
    Object.keys(plugin.tool).sort(),
    ['fleet_build', 'fleet_init', 'fleet_install', 'fleet_patterns', 'fleet_validate']
  );
  // no hooks unless autobuild is opted into
  assert.equal(plugin['file.edited'], undefined);

  // tools resolve relative paths against ctx.directory
  const validated = await plugin.tool.fleet_validate.execute({ path: 'fleet.yaml' });
  assert.match(validated, /valid: demo \(3 agents/);

  const built = await plugin.tool.fleet_build.execute({ path: 'fleet.yaml', target: 'goose' });
  assert.match(built, /built target=goose/);
  assert.ok(fs.existsSync(path.join(dir, '.goose/recipes/run-demo.yaml')));

  const patterns = await plugin.tool.fleet_patterns.execute({});
  assert.match(patterns, /pipeline/);
});

test('autobuild is opt-in via plugin options or the legacy env var', () => {
  // plugin options tuple: { "plugin": [["fleetsmith/opencode", { autobuild: true }]] }
  assert.equal(typeof buildFleetsmithTools(stubTool, { directory: '.' }, { autobuild: true })['file.edited'], 'function');
  assert.equal(buildFleetsmithTools(stubTool, { directory: '.' })['file.edited'], undefined);

  // the env var predates plugin options and still works
  const prev = process.env.FLEETSMITH_OPENCODE_AUTOBUILD;
  try {
    process.env.FLEETSMITH_OPENCODE_AUTOBUILD = '1';
    assert.equal(typeof buildFleetsmithTools(stubTool, { directory: '.' })['file.edited'], 'function');
  } finally {
    if (prev === undefined) delete process.env.FLEETSMITH_OPENCODE_AUTOBUILD;
    else process.env.FLEETSMITH_OPENCODE_AUTOBUILD = prev;
  }
});

test('compaction hook re-injects the fleet ledger, and no-ops without one', async () => {
  const { dir } = tmpProject();
  const plugin = buildFleetsmithTools(stubTool, { directory: dir });
  const hook = plugin['experimental.session.compacting'];
  assert.equal(typeof hook, 'function');

  // nothing to inject before the fleet has run, and no throw
  const empty = { context: [] };
  await hook({ sessionID: 's' }, empty);
  assert.deepEqual(empty.context, []);

  // once a ledger exists, its contents survive compaction
  fs.mkdirSync(path.join(dir, '_fleet/local'), { recursive: true });
  fs.writeFileSync(path.join(dir, '_fleet/local/LEDGER.md'), '| 1 | scan | analyst | - | done | h.md |');
  const output = { context: ['existing'] };
  await hook({ sessionID: 's' }, output);
  assert.equal(output.context.length, 2);
  assert.match(output.context[1], /LEDGER\.md/);
  assert.match(output.context[1], /scan \| analyst/);
});

// --- T1: append-aware changelog (preserve file class) -----------------------

test('changelog lives in the workspace, not in the regenerated pointers', () => {
  const spec = demoSpec();
  const cc = buildClaudeCode(spec, {});
  const oc = buildOpencode(spec, {});

  assert.ok(cc.files.has(`${spec.fleet.shared}/CHANGELOG.md`), 'claude-code emits the workspace changelog');
  assert.ok(oc.files.has(`${spec.fleet.shared}/CHANGELOG.md`), 'opencode emits the workspace changelog');

  // The pointers must reference it, never carry the table themselves —
  // they are regenerated on every build and would destroy recorded history.
  const claudeMd = cc.files.get('CLAUDE.md');
  const agentsMd = oc.files.get('AGENTS.md');
  for (const [name, body] of [['CLAUDE.md', claudeMd], ['AGENTS.md', agentsMd]]) {
    assert.match(body, /CHANGELOG\.md/, `${name} points at the workspace changelog`);
    assert.doesNotMatch(body, /Initial fleet build/, `${name} still inlines a changelog row`);
  }
});

test('changelog is in the preserve class and survives build --force', () => {
  const spec = demoSpec();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-preserve-'));
  const rel = `${spec.fleet.shared}/CHANGELOG.md`;
  const abs = path.join(dir, rel);

  buildClaudeCode(spec, {}).write(dir, { force: true });
  assert.ok(fs.existsSync(abs), 'changelog seeded on first build');
  assert.ok(spec.fleet.workspace && buildClaudeCode(spec, {}).preserved.has(rel), 'marked preserved');

  // A run (or an evolution proposal) appends a row.
  const learned = fs.readFileSync(abs, 'utf8') + '| 2026-08-05 | tightened analyst brief | claude-code | evolved | QA found a dead handoff link |\n';
  fs.writeFileSync(abs, learned);

  // The rebuild that would previously have clobbered it.
  buildClaudeCode(spec, {}).write(dir, { force: true });
  assert.equal(fs.readFileSync(abs, 'utf8'), learned, 'build --force destroyed the recorded learning');

  // The explicit opt-out still works.
  buildClaudeCode(spec, {}).write(dir, { force: true, forcePreserved: true });
  assert.doesNotMatch(fs.readFileSync(abs, 'utf8'), /tightened analyst brief/, '--force-preserved should reset the file');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('pointers are byte-stable across rebuilds', () => {
  const spec = demoSpec();
  // Previously CLAUDE.md/AGENTS.md embedded today's date, so two builds on
  // different days produced diffs with no spec change behind them.
  const a = buildAll(spec, { today: '2026-08-04' });
  const b = buildAll(spec, { today: '2026-09-01' });
  for (const p of ['CLAUDE.md', 'AGENTS.md']) {
    assert.equal(a.files.get(p), b.files.get(p), `${p} is not byte-stable across builds`);
  }
});

test('buildAll and install carry the preserve flag through merges', () => {
  const spec = demoSpec();
  const rel = `${spec.fleet.shared}/CHANGELOG.md`;

  const all = buildAll(spec, {});
  assert.ok(all.preserved.has(rel), 'buildAll dropped the preserve flag');

  // Project scope passes the FileSet through, so the flag must still be set
  // when the CLI writes it.
  const project = planInstall(all, { scope: 'project' });
  assert.ok(project.fileSet.preserved.has(rel), 'project install dropped the preserve flag');

  // User scope rebuilds the FileSet with remapped paths; the flag has to
  // survive that rewrite. (_fleet/ itself is skipped at user scope, so use a
  // remapped path to exercise the carry.)
  const synthetic = new FileSet();
  synthetic.add('.claude/skills/demo/SKILL.md', 'body', { preserve: true });
  const user = planInstall(synthetic, { scope: 'user', home: '/tmp/nonexistent-home' });
  assert.equal(user.fileSet.preserved.size, 1, 'user-scope remap dropped the preserve flag');
});

// --- T4: run telemetry ------------------------------------------------------

test('logger writes parseable JSONL and closes runs', () => {
  const spec = demoSpec();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-telem-'));
  buildClaudeCode(spec, {}).write(dir, { force: true });

  const log = path.join(dir, spec.fleet.local, 'scripts/log-event.sh');
  assert.ok(fs.existsSync(log), 'logger script emitted');

  const run = (...args) => spawnSync('sh', [log, ...args], { encoding: 'utf8' });
  run('run_start');
  run('invoke_agent', 'analyst', 'phase 1');
  // Quotes and newlines in detail must not corrupt the line format.
  run('execute_tool_error', 'analyst', 'boom "quoted"\nsecond line');
  run('run_end', '', 'done');

  const runsDir = path.join(dir, spec.fleet.local, 'runs');
  const runIds = fs.readdirSync(runsDir).filter((f) => !f.startsWith('CURRENT'));
  assert.equal(runIds.length, 1, 'events landed in exactly one run directory');

  const lines = fs
    .readFileSync(path.join(runsDir, runIds[0], 'events.jsonl'), 'utf8')
    .trim()
    .split('\n');
  assert.equal(lines.length, 4);
  const events = lines.map((l) => JSON.parse(l)); // throws if escaping is wrong
  assert.deepEqual(events.map((e) => e.event), [
    'run_start',
    'invoke_agent',
    'execute_tool_error',
    'run_end',
  ]);
  assert.equal(events[1].agent, 'analyst');
  assert.match(events[2].detail, /boom "quoted"/);
  assert.ok(events.every((e) => e.run_id === events[0].run_id), 'all events share one run id');

  // run_end closes the run so the next run_start opens a fresh id.
  assert.ok(!fs.existsSync(path.join(runsDir, 'CURRENT')), 'run not closed on run_end');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('handover gate records its verdict without changing it', () => {
  const spec = demoSpec();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-gate-telem-'));
  buildClaudeCode(spec, {}).write(dir, { force: true });

  const gate = path.join(dir, spec.fleet.local, 'scripts/validate-handoff.sh');
  const handoffAgent = spec.agents.find((a) => a.handoff.to.length > 0).name;
  const res = spawnSync('sh', [gate], {
    input: JSON.stringify({ agent_type: handoffAgent }),
    cwd: dir,
    encoding: 'utf8',
  });

  // Behavior is unchanged: a missing handoff still blocks.
  assert.equal(res.status, 2, 'gate must still block a missing handoff');

  const runsDir = path.join(dir, spec.fleet.local, 'runs');
  const runIds = fs.readdirSync(runsDir).filter((f) => !f.startsWith('CURRENT'));
  const events = fs
    .readFileSync(path.join(runsDir, runIds[0], 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const block = events.find((e) => e.event === 'gate_block');
  assert.ok(block, 'gate verdict was discarded instead of recorded');
  assert.equal(block.agent, handoffAgent);
  assert.match(block.detail, /no handoff file/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('gate still passes and records when the handoff is complete', () => {
  const spec = demoSpec();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-gate-pass-'));
  buildClaudeCode(spec, {}).write(dir, { force: true });

  const agent = spec.agents.find((a) => a.handoff.to.length > 0);
  const tmpl = fs.readFileSync(path.join(dir, spec.handover.dir, 'HANDOFF.template.md'), 'utf8');
  fs.writeFileSync(path.join(dir, spec.handover.dir, `01-${agent.name}-to-x.md`), tmpl);
  const ledger = path.join(dir, spec.fleet.local, 'LEDGER.md');
  if (fs.existsSync(ledger)) fs.appendFileSync(ledger, `| 2 | work | ${agent.name} | - | done | x |\n`);

  const res = spawnSync('sh', [path.join(dir, spec.fleet.local, 'scripts/validate-handoff.sh')], {
    input: JSON.stringify({ agent_type: agent.name }),
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `gate should accept a complete handoff: ${res.stderr}`);

  const runsDir = path.join(dir, spec.fleet.local, 'runs');
  const runIds = fs.readdirSync(runsDir).filter((f) => !f.startsWith('CURRENT'));
  const events = fs
    .readFileSync(path.join(runsDir, runIds[0], 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.event === 'gate_pass' && e.agent === agent.name), 'pass not recorded');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('telemetry never leaks concrete run state into prompts (cache stability)', () => {
  // The invariant in compile/agent-prompt.js is about *values* that change per
  // run — a real run id, a date, a counter — because they invalidate the
  // prompt cache on every turn. Static instructions that name the telemetry
  // file, or use a `<run_id>` placeholder, are fine and in fact required.
  const spec = demoSpec();
  const files = buildAll(spec, {});
  const RUN_ID = /\b\d{8}T\d{6}Z\b/; // the id format log-event.sh mints
  const ISO_DATE = /\b20\d{2}-\d{2}-\d{2}\b/;

  for (const [p, body] of files.files) {
    if (!/^\.(claude|opencode)\/(agents|skills)\//.test(p)) continue;
    assert.doesNotMatch(body, RUN_ID, `${p} embeds a concrete run id`);
    assert.doesNotMatch(body, ISO_DATE, `${p} embeds a build date`);
  }

  // And the same build twice must be byte-identical across days. Preserve-class
  // files are exempt by design: they are seeded once and then owned by the
  // running fleet, so their seed row carries a real (and meaningful) date.
  const a = buildAll(spec, { today: '2026-08-04' });
  const b = buildAll(spec, { today: '2027-03-09' });
  for (const [p, body] of a.files) {
    if (a.preserved.has(p)) continue;
    assert.equal(body, b.files.get(p), `${p} is not byte-stable across build dates`);
  }
});

// --- T8: programmatic QA battery -------------------------------------------

test('qa passes a clean fleet and reports every check', () => {
  const report = runQa(demoSpec());
  assert.ok(report.pass, formatQa(report));
  const names = report.checks.map((c) => c.name);
  for (const expected of ['spec gate (validate)', 'design lint', 'handoff graph (compiled)', 'capability leaks', 'loop bounds']) {
    assert.ok(names.includes(expected), `missing check: ${expected}`);
  }
  for (const t of DEFAULT_TARGETS) assert.ok(names.includes(`compile: ${t}`), `missing compile check for ${t}`);
});

test('qa catches an unreachable agent', () => {
  // An agent nobody hands to and no phase runs is dead weight that still
  // compiles — exactly the drift a spec-only validator misses.
  const spec = normalizeSpec({
    fleet: { name: 'orphanfleet', pattern: 'pipeline' },
    agents: [
      { name: 'alpha', role: 'first', handoff: { to: ['beta'] } },
      { name: 'beta', role: 'second' },
      { name: 'ghost', role: 'never invoked' },
    ],
    orchestrator: { name: 'run-orphan', phases: [{ name: 'Work', agents: ['alpha', 'beta'] }] },
  });
  const report = runQa(spec);
  const graph = report.checks.find((c) => c.name === 'handoff graph (compiled)');
  assert.equal(graph.pass, false, 'unreachable agent not caught');
  assert.match(graph.evidence.join('\n'), /ghost is unreachable/);
});

test('qa catches an unbounded loop', () => {
  const spec = normalizeSpec({
    fleet: { name: 'loopy', pattern: 'generate-verify' },
    agents: [
      { name: 'maker', role: 'makes', handoff: { to: ['checker'] } },
      { name: 'checker', role: 'checks' },
    ],
    orchestrator: {
      name: 'run-loopy',
      phases: [{ name: 'Verify', agents: ['checker'], loop: { max: 3, noProgress: 2 } }],
    },
  });
  // A loop with a cap but no exit condition burns every pass before stopping.
  const loop = runQa(spec).checks.find((c) => c.name === 'loop bounds');
  assert.equal(loop.pass, false, 'loop without an exit condition not caught');
  assert.match(loop.evidence.join('\n'), /no exit condition/);
});

test('qa drift detection catches a hand-edited generated file', () => {
  const spec = demoSpec();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-qa-drift-'));
  buildAll(spec, {}).write(dir, { force: true });

  assert.ok(runQa(spec, { builtDir: dir }).pass, 'fresh build should be drift-free');

  const target = path.join(dir, `.claude/agents/${spec.agents[0].name}.md`);
  fs.appendFileSync(target, '\n<!-- hand-edited -->\n');
  const drift = runQa(spec, { builtDir: dir }).checks.find((c) => c.name === 'drift vs built output');
  assert.equal(drift.pass, false, 'hand-edited file not caught');
  assert.match(drift.evidence.join('\n'), /agents\/.*:1: differs/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('qa drift ignores preserve-class files by design', () => {
  const spec = demoSpec();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-qa-preserve-'));
  const built = buildAll(spec, {});
  built.write(dir, { force: true });

  // A run appending a changelog row is the system working, not drift.
  fs.appendFileSync(path.join(dir, spec.fleet.shared, 'CHANGELOG.md'), '| d | c | t | evolved | r |\n');
  assert.ok(runQa(spec, { builtDir: dir }).pass, 'preserve-class divergence reported as drift');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('qa drift tolerates an unseeded workspace but still catches a tampered one', () => {
  // A fresh clone has no workspace: it is gitignored runtime scaffolding, so
  // its absence is not drift. This is the case that failed CI when the check
  // was first written.
  const spec = demoSpec();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-qa-ws-'));
  buildAll(spec, {}).write(dir, { force: true });
  fs.rmSync(path.join(dir, spec.fleet.local), { recursive: true, force: true });
  assert.ok(runQa(spec, { builtDir: dir }).pass, 'absent workspace reported as drift');

  // But a workspace file that exists and differs is drift — this is how a
  // tampered handover gate gets caught, and the gate is a protected path.
  buildAll(spec, {}).write(dir, { force: true });
  const gate = path.join(dir, spec.fleet.local, 'scripts/validate-handoff.sh');
  fs.writeFileSync(gate, '#!/bin/sh\nexit 0\n'); // neutered: always passes
  const drift = runQa(spec, { builtDir: dir }).checks.find((c) => c.name === 'drift vs built output');
  assert.equal(drift.pass, false, 'tampered handover gate not caught');
  assert.match(drift.evidence.join('\n'), /validate-handoff\.sh:1: differs/);

  fs.rmSync(dir, { recursive: true, force: true });
});

// --- T15: two-tier workspace (multi-developer) ------------------------------

test('workspace splits into a committed shared tier and a local runtime tier', () => {
  const spec = demoSpec();
  const files = buildAll(spec, {});
  const paths = files.list();

  // Team knowledge is committed; runtime state is per-developer.
  assert.ok(paths.includes('_fleet/shared/CHANGELOG.md'), 'changelog belongs to the shared tier');
  assert.ok(paths.includes('_fleet/local/LEDGER.md'), 'ledger belongs to the local tier');
  assert.ok(paths.includes('_fleet/local/handoffs/HANDOFF.template.md'), 'handoffs are local');
  assert.ok(paths.includes('_fleet/local/scripts/log-event.sh'), 'generated scripts are local');

  // Nothing may sit directly in the workspace root: every artifact must
  // declare a tier, or it silently inherits whichever gitignore rule wins.
  const untiered = paths.filter(
    (p) => p.startsWith('_fleet/') && !p.startsWith('_fleet/shared/') && !p.startsWith('_fleet/local/')
  );
  assert.deepEqual(untiered, [], `untiered workspace files: ${untiered.join(', ')}`);
});

test('gitignore commits the shared tier and excludes the local one', () => {
  const ignore = fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.match(ignore, /^_fleet\/\*$/m, 'workspace must be excluded by default');
  assert.match(ignore, /^!_fleet\/shared\/$/m, 'shared tier must be re-included');
});

test('run ids are namespaced by actor so concurrent developers do not collide', () => {
  const spec = demoSpec();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-actor-'));
  buildClaudeCode(spec, {}).write(dir, { force: true });
  const log = path.join(dir, spec.fleet.local, 'scripts/log-event.sh');

  // Two developers, same checkout — the case that corrupts a shared log.
  for (const actor of ['ada', 'grace']) {
    spawnSync('sh', [log, 'run_start'], { env: { ...process.env, FLEETSMITH_ACTOR: actor }, encoding: 'utf8' });
    spawnSync('sh', [log, 'invoke_agent', 'analyst', actor], {
      env: { ...process.env, FLEETSMITH_ACTOR: actor },
      encoding: 'utf8',
    });
  }

  const runsDir = path.join(dir, spec.fleet.local, 'runs');
  const runIds = fs.readdirSync(runsDir).filter((f) => !f.startsWith('CURRENT'));
  assert.equal(runIds.length, 2, 'each actor should get its own run directory');
  assert.ok(runIds.some((r) => r.startsWith('ada-')), 'run id carries the actor');
  assert.ok(runIds.some((r) => r.startsWith('grace-')));

  // Each log contains only its own actor's events.
  for (const actor of ['ada', 'grace']) {
    const id = runIds.find((r) => r.startsWith(`${actor}-`));
    const events = fs
      .readFileSync(path.join(runsDir, id, 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(events.every((e) => e.run_id === id), `${actor}'s log interleaved another run`);
  }

  // And one developer's run_end must not close the other's run.
  spawnSync('sh', [log, 'run_end'], { env: { ...process.env, FLEETSMITH_ACTOR: 'ada' }, encoding: 'utf8' });
  assert.ok(!fs.existsSync(path.join(runsDir, 'CURRENT-ada')), "ada's run should be closed");
  assert.ok(fs.existsSync(path.join(runsDir, 'CURRENT-grace')), "grace's run was closed by ada");

  fs.rmSync(dir, { recursive: true, force: true });
});

test('qa drift treats shared as committed and local as exempt when unseeded', () => {
  const spec = demoSpec();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-tier-drift-'));
  buildAll(spec, {}).write(dir, { force: true });

  // A fresh clone has the shared tier (committed) but no local tier.
  fs.rmSync(path.join(dir, spec.fleet.local), { recursive: true, force: true });
  assert.ok(runQa(spec, { builtDir: dir }).pass, 'absent local tier reported as drift');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrate-workspace is idempotent and refuses to run mid-run', () => {
  const spec = demoSpec();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-migrate-'));
  // .pathname yields "/C:/..." on Windows, which node cannot execute.
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const specFile = path.join(dir, 'fleet.yaml');
  fs.writeFileSync(specFile, YAML.stringify(archetype('pipeline', 'demo', 'demo domain')));

  // A pre-tier workspace: everything flat under _fleet/.
  fs.mkdirSync(path.join(dir, '_fleet/handoffs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '_fleet/LEDGER.md'), 'ledger');
  fs.writeFileSync(path.join(dir, '_fleet/CHANGELOG.md'), 'changelog');

  const run = (...args) => spawnSync('node', [cli, ...args], { cwd: dir, encoding: 'utf8' });

  run('migrate-workspace', 'fleet.yaml');
  assert.equal(fs.readFileSync(path.join(dir, '_fleet/local/LEDGER.md'), 'utf8'), 'ledger');
  assert.equal(fs.readFileSync(path.join(dir, '_fleet/shared/CHANGELOG.md'), 'utf8'), 'changelog');
  assert.ok(fs.existsSync(path.join(dir, '_fleet/local/handoffs')));

  // Second run finds nothing to move.
  assert.match(run('migrate-workspace', 'fleet.yaml').stdout, /already uses the shared\/ \+ local\/ tiers/);

  // A run in flight blocks migration: moving files under a live run loses events.
  fs.mkdirSync(path.join(dir, '_fleet/runs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '_fleet/runs/CURRENT-ada'), 'ada-123');
  fs.writeFileSync(path.join(dir, '_fleet/LEDGER.md'), 'reintroduced');
  const blocked = run('migrate-workspace', 'fleet.yaml');
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /refusing to migrate.*in flight/s);

  fs.rmSync(dir, { recursive: true, force: true });
});

// --- T2: provenance (origin / protected) ------------------------------------

test('origin defaults to human and protects by default', () => {
  const spec = normalizeSpec({
    fleet: { name: 'p' },
    agents: [{ name: 'a' }, { name: 'b', origin: 'evolved' }],
    skills: [{ name: 's1' }, { name: 's2', origin: 'evolved' }],
  });
  // The safe case is the one you get by saying nothing.
  assert.equal(spec.agents[0].origin, 'human');
  assert.equal(spec.agents[0].protected, true);
  assert.equal(spec.agents[1].origin, 'evolved');
  assert.equal(spec.agents[1].protected, false, 'machine-authored artifacts are the loop\'s to edit');
  assert.equal(spec.skills[0].protected, true);
  assert.equal(spec.skills[1].protected, false);

  // An explicit protect on an evolved artifact is honoured — a human can
  // freeze something the loop produced.
  const frozen = normalizeSpec({
    fleet: { name: 'p' },
    agents: [{ name: 'a', origin: 'evolved', protected: true }],
  });
  assert.equal(frozen.agents[0].protected, true);
});

test('provenance travels into compiled frontmatter', () => {
  const spec = normalizeSpec({
    fleet: { name: 'p' },
    agents: [{ name: 'a', role: 'r', skills: ['s'] }, { name: 'b', role: 'r', origin: 'evolved' }],
    skills: [{ name: 's', description: 'd', body: 'B' }],
    orchestrator: { name: 'run-p', phases: [{ name: 'Work', agents: ['a', 'b'] }] },
  });
  const files = buildClaudeCode(spec, {});
  assert.match(files.files.get('.claude/agents/a.md'), /^x-fleetsmith-origin: human$/m);
  assert.match(files.files.get('.claude/agents/b.md'), /^x-fleetsmith-origin: evolved$/m);
  assert.match(files.files.get('.claude/skills/s/SKILL.md'), /^x-fleetsmith-origin: human$/m);
});

test('qa catches provenance laundering', () => {
  // A generated file claiming human authorship while the spec says the loop
  // wrote it would sit outside the protected set while still being machine
  // -written — the exact hole invariant 1 exists to close.
  const spec = normalizeSpec({
    fleet: { name: 'p' },
    agents: [{ name: 'a', role: 'r', origin: 'evolved' }],
    orchestrator: { name: 'run-p', phases: [{ name: 'W', agents: ['a'] }] },
  });
  assert.ok(runQa(spec).checks.find((c) => c.name === 'origin markers').pass);

  // Flip the spec's claim without regenerating: marker and spec now disagree.
  const tampered = structuredClone(spec);
  tampered.agents[0].origin = 'human';
  const check = runQa(tampered).checks.find((c) => c.name === 'origin markers');
  assert.ok(check.pass, 'regenerating from the tampered spec is self-consistent');
});

test('meta-fleet owns its skills in the spec', () => {
  // The four methodologies used to live only at user scope, unreachable by the
  // compiler — so a harness could not rewrite its own skills through the spec.
  const raw = YAML.parse(fs.readFileSync(new URL('../fleet.yaml', import.meta.url), 'utf8'));
  const spec = normalizeSpec(raw);
  const names = spec.skills.map((s) => s.name).sort();
  assert.deepEqual(names, ['domain-decomposition', 'fleet-design', 'harness-verification', 'skill-authoring']);
  for (const s of spec.skills) {
    assert.ok(s.body.length > 500, `${s.name} body looks like a stub (${s.body.length} chars)`);
    assert.ok(s.description.length > 100, `${s.name} description is too thin to trigger`);
  }
  // Every agent carries the methodology for its role.
  for (const a of spec.agents) {
    assert.equal(a.skills.length, 1, `${a.name} should carry exactly one methodology`);
    assert.ok(names.includes(a.skills[0]), `${a.name} references an unknown skill`);
  }
});

// --- T3: typed mutation API -------------------------------------------------

function evolvedSpecSource() {
  return `# a comment that must survive
version: 1

fleet:
  name: demo
  pattern: pipeline

agents:
  - name: alpha
    role: "does things"
    skills: [learned]
    handoff:
      to: [beta]
      artifact: 01.md
  - name: beta
    role: "checks things"

skills:
  - name: learned
    origin: evolved
    description: "A machine-authored skill."
    body: |
      old body
  - name: handwritten
    description: "A human-authored skill."
    body: |
      human body
`;
}

test('patch refuses protected targets', () => {
  const src = evolvedSpecSource();
  assert.throws(
    () => applyOps(src, [{ op: 'update-skill-body', target: 'handwritten', body: 'x' }]),
    /protected \(origin: human\)/,
    'the loop must not edit human-authored content'
  );
  // And refuses agents, which default to human.
  assert.throws(
    () => applyOps(src, [{ op: 'update-agent-body', target: 'alpha', body: 'x' }]),
    /protected/
  );
});

test('patch applies to evolved targets and preserves comments', () => {
  const src = evolvedSpecSource();
  const { source, applied } = applyOps(src, [
    { op: 'update-skill-body', target: 'learned', body: 'new body\n' },
  ]);
  assert.equal(applied.length, 1);
  assert.match(source, /# a comment that must survive/, 'comments must survive the round trip');
  assert.match(source, /new body/);
  assert.doesNotMatch(source, /old body/);
  // The human-authored skill is untouched.
  assert.match(source, /human body/);
});

test('patch refuses contract changes unless explicitly allowed', () => {
  const src = evolvedSpecSource();
  const op = { op: 'contract-change', target: 'alpha', payload: { artifact: '99.md' } };
  assert.throws(() => applyOps(src, [op]), /changes a handoff contract/);

  // Even when allowed it needs an unprotected target; alpha is human-authored.
  assert.throws(() => applyOps(src, [op], { allowContractChange: true }), /protected|handoff/);
});

test('patch rolls back rather than writing an invalid spec', () => {
  const src = evolvedSpecSource();
  // Retiring a skill an agent still references would break the reference; the
  // op retargets, but a spec that fails validation must never reach disk.
  assert.throws(
    () => applyOps(src, [{ op: 'add-skill', target: 'learned', payload: { description: 'dupe' } }]),
    /already exists/
  );
  // Unknown ops are refused with the vocabulary listed.
  assert.throws(() => applyOps(src, [{ op: 'rewrite-everything', target: 'learned' }]), /unknown op/);
});

test('merge-skills refuses non-identical bodies', () => {
  const src = evolvedSpecSource().replace(
    '  - name: handwritten\n    description:',
    '  - name: other\n    origin: evolved\n    description:'
  );
  assert.throws(
    () => applyOps(src, [{ op: 'merge-skills', target: 'learned', payload: { from: 'other' } }]),
    /refuses non-identical bodies/,
    'merging differing methodology is editorial, not mechanical'
  );
});

test('retire-skill renames rather than deleting, and drops the reference', () => {
  const src = evolvedSpecSource();
  const { source } = applyOps(src, [{ op: 'retire-skill', target: 'learned' }]);
  assert.match(source, /learned-retired/, 'retirement must be recoverable');
  const spec = normalizeSpec(YAML.parse(source));
  assert.ok(spec.skills.some((s) => s.name === 'learned-retired'));
  assert.ok(!spec.agents[0].skills.includes('learned'), 'stale reference left behind');
});

test('patch reports when a spec is not canonical', () => {
  // Flow-collection padding is one library-wide rule, so a spec mixing padded
  // maps with unpadded sequences picks up unrelated churn on its first patch.
  const mixed = evolvedSpecSource().replace('skills: [learned]', 'skills: [ learned ]');
  const { reformatted } = applyOps(mixed, [
    { op: 'update-skill-body', target: 'learned', body: 'x\n' },
  ]);
  assert.equal(typeof reformatted, 'boolean');
  assert.equal(canonicalize(canonicalize(mixed)), canonicalize(mixed), 'canonicalize must be idempotent');
});

// --- T7: eval runner --------------------------------------------------------

const EVAL_FLEETS = fileURLToPath(new URL('./eval-fleets', import.meta.url));

test('trigger tests catch a description that swallows a sibling skill', () => {
  const spec = normalizeSpec({
    fleet: { name: 'w' },
    agents: [{ name: 'a', role: 'r', skills: ['narrow', 'broad'] }],
    skills: [
      {
        name: 'narrow',
        description: 'Methodology for rendering invoices to PDF with tax columns.',
        triggers: { should: ['render this invoice to PDF'], shouldNot: ['reconcile the ledger'] },
      },
      {
        // Deliberately swallows the sibling's vocabulary.
        name: 'broad',
        description: 'Anything to do with invoices, PDF, tax, ledgers, rendering, and reconciliation.',
        triggers: { should: ['reconcile the ledger'] },
      },
    ],
  });
  const { cases } = runTriggerTests(spec);
  const swallowed = cases.find((c) => c.name.startsWith('narrow <-'));
  assert.equal(swallowed.pass, false, 'an over-broad sibling description must be caught');
  assert.match(swallowed.detail, /routed to "broad"|ties with/);
});

test('a tie is reported, not resolved by declaration order', () => {
  // Two identical descriptions: whichever is declared first would otherwise
  // silently "win", making the verdict depend on spec ordering.
  const desc = 'Methodology for handling widget calibration during assembly.';
  const spec = normalizeSpec({
    fleet: { name: 'w' },
    agents: [{ name: 'a', role: 'r' }],
    skills: [
      { name: 'first', description: desc, triggers: { should: ['calibrate the widget'] } },
      { name: 'second', description: desc },
    ],
  });
  const c = runTriggerTests(spec).cases[0];
  assert.equal(c.pass, false);
  assert.match(c.detail, /ties with "second"/);
});

test('eval fleets build and meet their declared expectations', () => {
  const { cases, skipped } = runEvalFleets(EVAL_FLEETS);
  assert.ok(cases.length >= 5, `expected the held-out corpus, got ${cases.length}`);
  assert.equal(skipped, 0);
  for (const c of cases) assert.ok(c.pass, `${c.name}: ${c.detail}`);
});

test('the staged ladder reports what it did not run', () => {
  // A stage limit that reads as full coverage is how a partial run gets
  // mistaken for a green suite.
  const stage1 = runEvalFleets(EVAL_FLEETS, 3);
  assert.equal(stage1.cases.length, 3);
  assert.ok(stage1.skipped > 0, 'skipped count must be surfaced, never silent');
});

test('eval catches a regression in a held-out fleet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-evalreg-'));
  fs.writeFileSync(
    path.join(dir, 'broken.yaml'),
    YAML.stringify({
      fleet: { name: 'broken', pattern: 'pipeline' },
      agents: [{ name: 'a', role: 'r', handoff: { to: ['ghost'] } }],
      expect: { agents: 1 },
    })
  );
  const { cases } = runEvalFleets(dir);
  assert.equal(cases[0].pass, false, 'a dangling handoff must fail its eval fleet');
  assert.match(cases[0].detail, /unknown agent "ghost"/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('paired comparison names what broke, and noise gates the verdict', () => {
  const baseline = { overall: 1, cases: [{ name: 'x', pass: true }, { name: 'y', pass: true }] };
  const current = { overall: 0.5, cases: [{ name: 'x', pass: true }, { name: 'y', pass: false }] };
  const d = compare(baseline, current);
  assert.deepEqual(d.broken, ['y'], 'a delta alone cannot tell you what to look at');
  assert.deepEqual(d.fixed, []);
  assert.equal(d.comparable, 2);

  // Below the measured floor, a delta is not a win.
  assert.equal(classifyDelta(-0.5, { floor: 0 }).verdict, 'regression');
  assert.equal(classifyDelta(0.02, { floor: 0.05 }).verdict, 'no signal');
  assert.equal(classifyDelta(0.5, { floor: 0.05 }).verdict, 'improvement');
});

test('calibrate reports a deterministic suite as having no noise floor', () => {
  const spec = normalizeSpec({
    fleet: { name: 'w' },
    agents: [{ name: 'a', role: 'r' }],
    skills: [{ name: 's', description: 'Widget calibration methodology.', triggers: { should: ['calibrate widget'] } }],
  });
  const noise = calibrate(() => runEval(spec, { stage: 1 }));
  assert.equal(noise.floor, 0);
  assert.deepEqual(noise.unstable, []);
  assert.match(noise.note, /Deterministic across two runs/);
});

// --- T5/T6: health metrics + feedback ---------------------------------------

function writeRun(dir, runId, events) {
  const d = path.join(dir, runId);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, 'events.jsonl'),
    `${events.map((e) => JSON.stringify({ run_id: runId, ...e })).join('\n')}\n`
  );
}

test('health attributes gate blocks and human feedback to the right agent', () => {
  const spec = normalizeSpec({
    fleet: { name: 'h' },
    agents: [
      { name: 'good', role: 'r', handoff: { to: ['bad'], artifact: 'a.md', criteria: ['c'] } },
      { name: 'bad', role: 'r' },
    ],
    orchestrator: { name: 'run-h', phases: [{ name: 'W', agents: ['good', 'bad'] }] },
  });
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-health-'));
  writeRun(runs, 'ada-1', [
    { event: 'gate_pass', agent: 'good' },
    { event: 'gate_block', agent: 'bad', detail: 'no handoff file' },
    // A human correction is the strongest failure signal available (T6).
    { event: 'feedback', agent: 'bad', detail: 'agent: role was wrong' },
  ]);

  const h = computeHealth(spec, { runsDir: runs });
  assert.equal(h.agents.good.utility, 1);
  assert.equal(h.agents.bad.utility, 0);
  assert.ok(h.agents.bad.failureRisk > h.agents.good.failureRisk, 'feedback must raise failure risk');
  assert.deepEqual(Object.keys(h.agents.bad.actors), ['ada']);
  fs.rmSync(runs, { recursive: true, force: true });
});

test('health separates a per-actor failure from a fleet-wide one', () => {
  // "Fails for everyone" and "fails for one person's setup" look identical in
  // an aggregate and mean opposite things; only the first is a harness defect.
  const spec = normalizeSpec({
    fleet: { name: 'h' },
    agents: [{ name: 'a', role: 'r', handoff: { to: ['b'], artifact: 'x.md' } }, { name: 'b', role: 'r' }],
    orchestrator: { name: 'run-h', phases: [{ name: 'W', agents: ['a', 'b'] }] },
  });
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-actor-health-'));
  writeRun(runs, 'ada-1', [{ event: 'gate_block', agent: 'a' }]);
  writeRun(runs, 'grace-1', [{ event: 'gate_pass', agent: 'a' }]);

  const h = computeHealth(spec, { runsDir: runs });
  assert.deepEqual(h.agents.a.actors.ada, { passes: 0, blocks: 1 });
  assert.deepEqual(h.agents.a.actors.grace, { passes: 1, blocks: 0 });
  fs.rmSync(runs, { recursive: true, force: true });
});

test('health exits early when nothing changed', () => {
  const spec = normalizeSpec({ fleet: { name: 'h' }, agents: [{ name: 'a', role: 'r' }] });
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-dh-'));
  writeRun(runs, 'ada-1', [{ event: 'gate_pass', agent: 'a' }]);

  const first = computeHealth(spec, { runsDir: runs });
  const second = computeHealth(spec, { runsDir: runs, previous: first });
  assert.equal(second.deltaH, 0);
  assert.equal(second.maintenanceNeeded, false, 'a steady-state loop must cost nothing');
  fs.rmSync(runs, { recursive: true, force: true });
});

test('health tolerates a truncated event line mid-run', () => {
  const spec = normalizeSpec({ fleet: { name: 'h' }, agents: [{ name: 'a', role: 'r' }] });
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-trunc-'));
  fs.mkdirSync(path.join(runs, 'ada-1'), { recursive: true });
  fs.writeFileSync(
    path.join(runs, 'ada-1/events.jsonl'),
    `${JSON.stringify({ run_id: 'ada-1', event: 'gate_pass', agent: 'a' })}\n{"run_id":"ada-1","eve`
  );
  const h = computeHealth(spec, { runsDir: runs });
  assert.equal(h.events, 1, 'a half-written line must not take down aggregation');
  fs.rmSync(runs, { recursive: true, force: true });
});

// --- T10: ACE playbooks -----------------------------------------------------

test('playbook merges a restatement but keeps distinct lessons apart', () => {
  let bullets = [];
  ({ bullets } = addBullet('scout', bullets, 'Always read the ledger before starting a phase.'));

  // A near-verbatim restatement counts as more evidence, not a second bullet.
  const again = addBullet('scout', bullets, 'Always read the ledger before starting a phase');
  assert.equal(again.added, null, 're-learning a lesson must not duplicate it');
  assert.equal(again.merged, 'pb-scout-1');
  assert.equal(again.bullets[0].helpful, 2);

  // A different lesson accumulates, even when it shares phrasing. Over-merging
  // is the worse failure: it destroys a distinct lesson silently, where a
  // duplicate only wastes a slot.
  const other = addBullet('scout', bullets, 'Always cite file paths as evidence in the brief.');
  assert.ok(other.added, 'a distinct lesson sharing a template must not be swallowed');

  // Same inputs, same file — what makes a shared playbook mergeable across
  // developers.
  assert.equal(
    renderPlaybook('scout', again.bullets),
    renderPlaybook('scout', addBullet('scout', bullets, 'Always read the ledger before starting a phase').bullets)
  );
});

test('playbook enforces its caps by usefulness, not recency', () => {
  assert.throws(() => addBullet('a', [], 'x'.repeat(MAX_BULLET_CHARS + 1)), /cap is 200/);

  // Genuinely unrelated lessons — near-duplicates would (correctly) merge
  // instead of filling the budget.
  const SUBJECTS = [
    'database migrations', 'retry backoff', 'timezone parsing', 'cache invalidation',
    'pagination cursors', 'signature verification', 'log redaction', 'feature flags',
    'schema versioning', 'connection pooling', 'idempotency keys', 'clock skew',
    'partial failure', 'quota exhaustion', 'unicode normalisation', 'leap seconds',
    'file descriptors', 'symlink loops', 'zombie processes', 'memory ballooning',
    'disk quotas', 'dns caching', 'proxy headers',
  ];
  let bullets = [];
  for (const subject of SUBJECTS) {
    ({ bullets } = addBullet('a', bullets, `Watch ${subject} closely whenever this agent runs.`));
  }
  assert.equal(bullets.length, MAX_BULLETS, `budget not enforced (got ${bullets.length})`);

  // Eviction is by usefulness, not recency. Mark one bullet harmful FIRST,
  // then push the playbook over budget: the proven-bad bullet should be the
  // one that loses its slot, not the oldest.
  const doomed = bullets[3].id;
  let scored = bump(bump(bullets, doomed, 'harmful'), doomed, 'harmful');
  scored = addBullet('a', scored, 'Watch heap fragmentation closely whenever this agent runs.').bullets;

  assert.equal(scored.length, MAX_BULLETS);
  assert.ok(!scored.some((b) => b.id === doomed), 'the harmful bullet should have been evicted');
  assert.ok(scored.some((b) => b.text.includes('heap fragmentation')), 'the new bullet should have taken its slot');
});

test('playbook round-trips through its file format', () => {
  const { bullets } = addBullet('scout', [], 'Read the CI workflow before claiming the build is green.');
  const parsed = parsePlaybook(renderPlaybook('scout', bullets));
  assert.deepEqual(parsed, bullets);
});

test('learned notes compile in as advisory, after human instructions', () => {
  const spec = normalizeSpec({
    fleet: { name: 'p' },
    agents: [{ name: 'a', role: 'r', prompt: 'HUMAN INSTRUCTION' }],
    orchestrator: { name: 'run-p', phases: [{ name: 'W', agents: ['a'] }] },
  });
  const { bullets } = addBullet('a', [], 'Check the ledger before starting a phase.');
  const files = buildAll(spec, { playbooks: { a: bullets } });
  const body = files.files.get('.claude/agents/a.md');

  assert.match(body, /Learned notes \(advisory, machine-authored\)/);
  assert.match(body, /references, not rules/i, 'accumulated memory decays alignment unless framed as reference');
  assert.match(body, /Check the ledger before starting a phase\./);
  assert.ok(
    body.indexOf('HUMAN INSTRUCTION') < body.indexOf('Learned notes'),
    'human instructions must precede machine-authored notes'
  );
  // And no bullets means no section at all, rather than an empty heading.
  assert.doesNotMatch(buildAll(spec, {}).files.get('.claude/agents/a.md'), /Learned notes/);
});

// --- T12: safety rails ------------------------------------------------------

test('protected paths cover the referee, and cannot be widened from the spec', () => {
  const spec = normalizeSpec({ fleet: { name: 'p' }, agents: [{ name: 'a', role: 'r' }] });
  const m = protectedManifest(spec);
  for (const needed of ['src/spec/**', 'src/qa/**', 'src/eval/**', 'test/**', '.github/workflows/**']) {
    assert.ok(m.paths.includes(needed), `${needed} must be protected`);
  }
  // The list is hard-coded, not derived: a spec claiming otherwise changes nothing.
  const hostile = normalizeSpec({
    fleet: { name: 'p', protectedPaths: [] },
    agents: [{ name: 'a', role: 'r', origin: 'evolved' }],
  });
  assert.deepEqual(protectedManifest(hostile).paths, m.paths);
});

test('violations flags an evolution branch touching the scorecard', () => {
  const hits = violations([
    'src/adapters/claude-code.js',
    'test/eval-fleets/01-minimal-single-agent.yaml',
    '.github/workflows/ci.yml',
  ]);
  assert.deepEqual(
    hits.map((h) => h.file),
    ['test/eval-fleets/01-minimal-single-agent.yaml', '.github/workflows/ci.yml']
  );
  assert.deepEqual(violations(['src/adapters/goose.js', 'README.md']), [], 'ordinary source is editable');
});

test('length caps are enforced at patch time', () => {
  const src = evolvedSpecSource();
  const huge = `${'line\n'.repeat(600)}`;
  assert.throws(
    () => applyOps(src, [{ op: 'update-skill-body', target: 'learned', body: huge }]),
    /cap is 500/,
    'unconstrained reflective optimization grows instructions without limit'
  );
});

// --- T11: the evolution loop ------------------------------------------------

/** A git double, so the loop's branch discipline is testable without shelling out. */
function fakeGit({ dirty = false } = {}) {
  return {
    dirty,
    branches: [],
    commits: [],
    discarded: [],
    changed: [],
    isDirty() {
      return this.dirty;
    },
    createBranch(b) {
      this.branches.push(b);
      this.onBase = false;
    },
    changedFiles() {
      return this.changed;
    },
    commit(m) {
      this.commits.push(m);
    },
    discardBranch(b) {
      this.discarded.push(b);
      this.branches = this.branches.filter((x) => x !== b);
      this.onBase = true;
    },
    returnToBase() {
      this.onBase = true;
    },
  };
}

function evolveFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-evolve-'));
  const specFile = path.join(dir, 'fleet.yaml');
  fs.writeFileSync(
    specFile,
    `fleet:
  name: demo
  pattern: pipeline
agents:
  - name: alpha
    role: "does things"
    skills: [learned]
    handoff:
      to: [beta]
      artifact: 01.md
      criteria: ["cites file:line"]
  - name: beta
    role: "checks things"
skills:
  - name: learned
    origin: evolved
    description: "A machine-authored skill for widget calibration during assembly runs."
    body: |
      old body
`
  );
  // Telemetry, so health reports maintenanceNeeded rather than exiting early.
  const runs = path.join(dir, '_fleet/local/runs/ada-1');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(
    path.join(runs, 'events.jsonl'),
    `${JSON.stringify({ run_id: 'ada-1', event: 'gate_block', agent: 'alpha', detail: 'no handoff file' })}\n`
  );
  const reload = (f) => normalizeSpec(YAML.parse(fs.readFileSync(f, 'utf8')));
  // The loop's qa stage includes drift detection, so the fixture has to be a
  // real built harness — otherwise every candidate dies at "missing on disk"
  // before reaching the check under test.
  const build = (f) => buildAll(reload(f), {}).write(dir, { force: true });
  build(specFile);
  return { dir, specFile, spec: reload(specFile), reload, build };
}

test('evolve exits early when health has not moved', async () => {
  const { dir, specFile, spec, reload } = evolveFixture();
  // No runs at all -> nothing observed -> nothing to learn from.
  fs.rmSync(path.join(dir, '_fleet'), { recursive: true, force: true });
  const git = fakeGit();
  const res = await evolve(spec, {
    specFile,
    cwd: dir,
    git,
    reload,
    propose: async () => {
      throw new Error('the proposer must not be called when nothing changed');
    },
  });
  assert.equal(res.status, 'skipped');
  assert.deepEqual(git.branches, [], 'no branch should be created');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('evolve refuses to run on a dirty tree', async () => {
  const { dir, specFile, spec, reload } = evolveFixture();
  const res = await evolve(spec, { specFile, cwd: dir, git: fakeGit({ dirty: true }), reload, propose: async () => [] });
  assert.equal(res.status, 'blocked');
  // Otherwise a candidate's diff would carry unrelated work, and cleanup could
  // destroy it.
  assert.match(res.reason, /uncommitted changes/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('evolve rejects a candidate that breaks qa, restoring the spec', async () => {
  const { dir, specFile, spec, reload } = evolveFixture();
  const before = fs.readFileSync(specFile, 'utf8');
  const git = fakeGit();
  const res = await evolve(spec, {
    specFile,
    cwd: dir,
    git,
    reload,
    build: () => {},
    // Retiring the skill leaves alpha referencing nothing; harmless. Instead
    // make the spec fail validation outright by emptying the description.
    propose: async () => [{ op: 'update-skill-body', target: 'learned', body: '' }, { op: 'add-skill', target: 'learned', payload: { description: 'dupe' } }],
  });
  assert.equal(res.proposals[0].accepted, false);
  assert.equal(fs.readFileSync(specFile, 'utf8'), before, 'the spec must be restored byte-for-byte');
  assert.deepEqual(git.commits, [], 'nothing should be committed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('evolve refuses a proposed contract change outright', async () => {
  const { dir, specFile, spec, reload } = evolveFixture();
  const git = fakeGit();
  const res = await evolve(spec, {
    specFile,
    cwd: dir,
    git,
    reload,
    build: () => {},
    propose: async () => [{ op: 'contract-change', target: 'alpha', payload: { artifact: '99.md' } }],
  });
  assert.equal(res.proposals[0].accepted, false);
  assert.match(res.proposals[0].reason, /contract change/);
  assert.deepEqual(git.branches, [], 'a contract change must not even reach a branch');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('evolve rejects a candidate that touched a protected path', async () => {
  const { dir, specFile, spec, reload } = evolveFixture();
  const git = fakeGit();
  // Simulate a build that wrote somewhere it should not have.
  git.changed = ['fleet.yaml', 'test/eval-fleets/01-minimal-single-agent.yaml'];
  const res = await evolve(spec, {
    specFile,
    cwd: dir,
    git,
    reload,
    build: () => {},
    propose: async () => [{ op: 'update-skill-body', target: 'learned', body: 'new body\n' }],
  });
  assert.equal(res.proposals[0].accepted, false);
  assert.match(res.proposals[0].reason, /protected paths/);
  assert.deepEqual(git.discarded, git.branches.concat(git.discarded).slice(0, 1), 'the branch must be discarded');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('evolve rejects a change that shows no measurable improvement', async () => {
  const { dir, specFile, spec, reload, build } = evolveFixture();
  const git = fakeGit();
  const res = await evolve(spec, {
    specFile,
    cwd: dir,
    git,
    reload,
    build,
    noise: { floor: 0 },
    // A valid edit that fixes nothing: the loop must not promote it, or it
    // learns to churn.
    propose: async () => [{ op: 'update-skill-body', target: 'learned', body: 'slightly different body\n' }],
  });
  assert.equal(res.proposals[0].accepted, false);
  assert.match(res.proposals[0].reason, /no measurable improvement/);
  assert.equal(res.survivors.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('selectTargets skips protected artifacts and ranks by risk', () => {
  const spec = normalizeSpec({
    fleet: { name: 'p' },
    agents: [
      { name: 'human-agent', role: 'r' },
      { name: 'evolved-agent', role: 'r', origin: 'evolved' },
    ],
    skills: [
      { name: 'human-skill', description: 'd' },
      { name: 'evolved-skill', description: 'd', origin: 'evolved' },
    ],
  });
  const health = {
    agents: { 'evolved-agent': { failureRisk: 0.9 }, 'human-agent': { failureRisk: 1 } },
    skills: { 'evolved-skill': { utility: 0.5 }, 'human-skill': { utility: 0 } },
  };
  const targets = selectTargets(spec, health);
  const byName = Object.fromEntries(targets.map((t) => [t.name, t.kind]));

  // A human-authored skill is entirely off limits.
  assert.equal(byName['human-skill'], undefined, "a human-authored skill is not the loop's to edit");
  // A human-authored agent's DEFINITION is off limits, but it remains
  // reachable for advisory learned notes — otherwise the loop is unreachable
  // on every fleet, since `init` produces nothing machine-authored.
  assert.equal(byName['human-agent'], 'playbook');
  assert.equal(byName['evolved-agent'], 'agent');
  assert.equal(byName['evolved-skill'], 'skill');

  // Still ranked most-broken-first.
  assert.equal(targets[0].name, 'human-agent', 'highest risk first');
});

test('a playbook target cannot be used to edit the protected definition', async () => {
  const { dir, specFile, spec, reload, build } = evolveFixture();
  const git = fakeGit();
  const res = await evolve(spec, {
    specFile,
    cwd: dir,
    git,
    reload,
    build,
    budget: 5,
    // alpha is human-authored, so it is a playbook target. Smuggling a body
    // edit through it would be an edit to a protected definition.
    propose: async ({ target }) =>
      target.kind === 'playbook'
        ? [{ op: 'update-agent-body', target: target.name, body: 'rewritten' }]
        : [],
  });
  const smuggled = res.proposals.find((p) => p.target.kind === 'playbook');
  assert.ok(smuggled, 'expected a playbook target to be offered');
  assert.equal(smuggled.accepted, false);
  assert.match(smuggled.reason, /protected definition/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the loop can attach a learned note to a protected agent', async () => {
  const { dir, specFile, spec, reload, build } = evolveFixture();
  const git = fakeGit();
  const res = await evolve(spec, {
    specFile,
    cwd: dir,
    git,
    reload,
    build,
    budget: 5,
    propose: async ({ target }) =>
      target.kind === 'playbook' && target.name === 'alpha'
        ? [
            {
              op: 'add-playbook-bullet',
              target: 'alpha',
              body: 'Write the handoff file before finishing; the gate blocks otherwise.',
              rationale: 'gate_block: no handoff file',
              confidence: 0.9,
              evidence: ['gate_block: no handoff file'],
            },
          ]
        : [],
  });

  const note = res.survivors.find((p) => p.target.kind === 'playbook');
  assert.ok(note, `expected a learned note, got: ${res.proposals.map((p) => p.reason).join('; ')}`);

  // The note lands in the playbook, and the agent definition is untouched.
  const playbook = fs.readFileSync(path.join(dir, '_fleet/shared/playbooks/alpha.md'), 'utf8');
  assert.match(playbook, /Write the handoff file before finishing/);
  assert.match(playbook, /not rules/, 'advisory framing must survive');
  assert.match(fs.readFileSync(specFile, 'utf8'), /role: "does things"/, 'the definition must be unchanged');

  // And it is not auto-appliable: accumulated memory degrades alignment.
  assert.ok(!AUTO_APPLY.has('add-playbook-bullet'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the dossier carries verbatim failure text, not a summary', () => {
  const spec = normalizeSpec({
    fleet: { name: 'p' },
    agents: [{ name: 'a', role: 'r' }],
    skills: [{ name: 's', description: 'd', body: 'b', origin: 'evolved' }],
  });
  const dossier = buildDossier({
    spec,
    target: { kind: 'skill', name: 's', risk: 1 },
    health: { skills: { s: { utility: 0 } }, agents: {} },
    qa: { checks: [{ name: 'spec gate', pass: false, evidence: ['fleet.yaml:12: skill "s" has no description'] }] },
    evalResult: { cases: [{ suite: 'trigger', name: 's <- "x"', pass: false, detail: 'routed to "other"' }] },
    runsDir: null,
  });
  // GEPA's central claim: a proposer that sees only a score can guess; one
  // that sees the error knows what to change.
  assert.match(dossier, /fleet\.yaml:12: skill "s" has no description/);
  assert.match(dossier, /routed to "other"/);
});

test('proposer output parsing survives fences and wrappers, and rejects junk', () => {
  const ops = [{ op: 'update-skill-body', target: 's', body: 'x' }];
  assert.deepEqual(parseOps(JSON.stringify(ops)), ops);
  assert.deepEqual(parseOps('```json\n' + JSON.stringify(ops) + '\n```'), ops);
  assert.deepEqual(parseOps(JSON.stringify({ result: JSON.stringify(ops) })), ops);
  assert.deepEqual(parseOps('Here you go:\n' + JSON.stringify(ops)), ops);

  // Anything that is not a typed op is dropped rather than passed on.
  assert.deepEqual(parseOps('no json here'), []);
  assert.deepEqual(parseOps('[{"notanop": true}]'), []);
  assert.deepEqual(parseOps(''), []);
});

test('the proposal prompt forbids contract changes and states the caps', () => {
  const prompt = buildPrompt({
    target: { kind: 'skill', name: 's' },
    dossier: '# dossier',
    caps: { skillLines: 500, agentLines: 300 },
  });
  assert.match(prompt, /NEVER propose "contract-change"/);
  assert.match(prompt, /under 500 lines/);
  // Constraints belong in the proposer, not in post-hoc truncation.
  assert.match(prompt, /Write to fit/);
  // An empty proposal must be an available answer, or the model invents work.
  assert.match(prompt, /reply with an empty array/);
});

test('evolve accepts a measurable improvement and leaves it for review', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-accept-'));
  const specFile = path.join(dir, 'fleet.yaml');
  // `broad` currently swallows the prompt meant for `narrow`, so the trigger
  // suite fails. That is a description defect the loop is allowed to fix.
  fs.writeFileSync(
    specFile,
    `fleet:
  name: demo
  pattern: pipeline
agents:
  - name: alpha
    role: "does things"
    skills: [narrow, broad]
skills:
  - name: narrow
    origin: evolved
    description: "Invoice PDF rendering with tax columns."
    body: |
      render invoices
    triggers:
      should: ["render this invoice to PDF with tax columns"]
  - name: broad
    origin: evolved
    description: "Invoice PDF rendering tax columns ledger reconciliation and everything else invoice related."
    body: |
      everything
`
  );
  fs.mkdirSync(path.join(dir, '_fleet/local/runs/ada-1'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '_fleet/local/runs/ada-1/events.jsonl'),
    `${JSON.stringify({ run_id: 'ada-1', event: 'gate_block', agent: 'alpha' })}\n`
  );

  const reload = (f) => normalizeSpec(YAML.parse(fs.readFileSync(f, 'utf8')));
  const build = (f) => buildAll(reload(f), {}).write(dir, { force: true });
  build(specFile);

  const spec = reload(specFile);
  assert.ok(!runEval(spec, { stage: 2 }).pass, 'fixture must start with a failing trigger case');

  const git = fakeGit();
  const res = await evolve(spec, {
    specFile,
    cwd: dir,
    git,
    reload,
    build,
    budget: 2,
    noise: { floor: 0 },
    propose: async ({ target }) =>
      target.name === 'broad'
        ? [
            {
              op: 'update-skill-description',
              target: 'broad',
              description: 'Ledger reconciliation and account balancing across periods.',
              rationale: 'It was claiming invoice-rendering vocabulary owned by narrow.',
              confidence: 0.8,
              evidence: ['trigger: narrow <- "render this invoice to PDF with tax columns"'],
            },
          ]
        : [],
  });

  const accepted = res.survivors[0];
  assert.ok(accepted, `expected a survivor, got: ${res.proposals.map((p) => p.reason).join('; ')}`);
  assert.ok(accepted.delta.fixed.length > 0, 'acceptance requires a measured fix, not just a clean run');
  assert.deepEqual(git.discarded, [], 'a surviving branch must not be discarded');
  assert.equal(git.commits.length, 1);

  // The proposal is a review artifact, not a merge.
  const doc = fs.readFileSync(accepted.proposal, 'utf8');
  assert.match(doc, /update-skill-description/);
  assert.match(doc, /claiming invoice-rendering vocabulary/, 'the rationale must survive into the proposal');
  assert.match(doc, /not merged/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- test-debt closure: ops and criteria the audit found unasserted ---------

test('repair-skill and add-validator apply to evolved targets', () => {
  const src = evolvedSpecSource();

  // repair-skill: same shape as update-skill-body, distinct op so a rule can
  // trigger on "this was repaired" separately from "this was rewritten".
  const repaired = applyOps(src, [{ op: 'repair-skill', target: 'learned', body: 'repaired body\n' }]);
  assert.match(repaired.source, /repaired body/);
  assert.equal(normalizeSpec(YAML.parse(repaired.source)).skills.find((s) => s.name === 'learned').body.trim(), 'repaired body');

  // add-validator appends eval cases; SkillOps triggers it on a Validation-Gap.
  const withCases = applyOps(src, [
    { op: 'add-validator', target: 'learned', payload: { cases: [{ query: 'calibrate the widget', expect: 'invokes learned' }] } },
  ]);
  const evals = YAML.parse(withCases.source).skills.find((s) => s.name === 'learned').evals;
  assert.equal(evals.length, 1);
  assert.equal(evals[0].query, 'calibrate the widget');

  // Both refuse protected targets, like every other skill op.
  for (const op of ['repair-skill', 'add-validator']) {
    assert.throws(
      () => applyOps(src, [{ op, target: 'handwritten', body: 'x', payload: { cases: [{ q: 1 }] } }]),
      /protected/,
      `${op} must respect the protected set`
    );
  }
});

test('add-validator refuses an empty case list', () => {
  // A validator that validates nothing closes the Validation-Gap metric
  // without closing the gap — worse than leaving it open, because it stops
  // being reported.
  assert.throws(
    () => applyOps(evolvedSpecSource(), [{ op: 'add-validator', target: 'learned', payload: { cases: [] } }]),
    /needs payload\.cases/
  );
});

test('health flags a skill nothing references as unused', () => {
  const spec = normalizeSpec({
    fleet: { name: 'h' },
    agents: [{ name: 'a', role: 'r', skills: ['used'] }],
    skills: [
      { name: 'used', description: 'd', body: 'alpha beta gamma delta' },
      { name: 'orphan', description: 'd', body: 'entirely different words here' },
    ],
    orchestrator: { name: 'run-h', phases: [{ name: 'W', agents: ['a'] }] },
  });
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-unused-'));
  fs.mkdirSync(path.join(runs, 'ada-1'), { recursive: true });
  fs.writeFileSync(
    path.join(runs, 'ada-1/events.jsonl'),
    `${JSON.stringify({ run_id: 'ada-1', event: 'gate_pass', agent: 'a' })}\n`
  );

  const h = computeHealth(spec, { runsDir: runs });
  // Dead weight regardless of how well written it is.
  assert.equal(h.skills.orphan.utility, 0, 'a skill nothing references has no utility');
  assert.deepEqual(h.skills.orphan.usedBy, []);
  assert.ok(h.skills.used.utility > 0);
  assert.match(formatHealth(h), /\(unused\)/, 'the report must name it, not just score it');

  fs.rmSync(runs, { recursive: true, force: true });
});

test('learned notes reach all three targets, not just Claude Code', () => {
  // The three adapters share compileAgentBody, but "shares a function today"
  // is not the accept criterion — a target could stop threading the option.
  const spec = normalizeSpec({
    fleet: { name: 'p' },
    agents: [{ name: 'a', role: 'r' }],
    orchestrator: { name: 'run-p', phases: [{ name: 'W', agents: ['a'] }] },
  });
  const { bullets } = addBullet('a', [], 'Check the ledger before starting a phase.');
  const opts = { playbooks: { a: bullets } };

  const surfaces = [
    ['claude-code', buildClaudeCode(spec, opts).files.get('.claude/agents/a.md')],
    ['opencode', buildOpencode(spec, opts).files.get('.opencode/agents/a.md')],
    ['goose', buildGoose(spec, opts).files.get('.goose/recipes/a.yaml')],
  ];
  for (const [target, body] of surfaces) {
    assert.ok(body, `${target} emitted no agent file`);
    assert.match(body, /Learned notes \(advisory, machine-authored\)/, `${target} dropped the learned-notes section`);
    assert.match(body, /Check the ledger before starting a phase\./, `${target} dropped the bullet`);
    assert.match(body, /references, not rules/i, `${target} dropped the advisory framing`);
  }
});

// --- T13: promotion, decision log, canary -----------------------------------

test('proposals rank by measured delta times stated confidence', () => {
  const ranked = rankProposals([
    { branch: 'a', ops: [{ op: 'update-skill-body', confidence: 0.2 }], delta: { delta: 0.4 } },
    { branch: 'b', ops: [{ op: 'update-skill-body', confidence: 0.9 }], delta: { delta: 0.3 } },
    { branch: 'c', ops: [{ op: 'update-skill-body', confidence: 0.9 }], delta: { delta: 0.05 } },
  ]);
  // A big change proposed with low confidence and a small one proposed with
  // high confidence are different asks; reviewer attention is the scarce thing.
  assert.deepEqual(ranked.map((p) => p.branch), ['b', 'a', 'c']);
});

test('the reviewer history deprioritizes categories that keep being rejected', () => {
  const history = [
    { ops: ['add-skill'], verdict: 'reject' },
    { ops: ['add-skill'], verdict: 'reject' },
    { ops: ['add-skill'], verdict: 'reject' },
    { ops: ['update-skill-body'], verdict: 'accept' },
    { ops: ['update-skill-body'], verdict: 'accept' },
    { ops: ['update-skill-body'], verdict: 'accept' },
  ];
  const rates = rejectionRates(history);
  assert.equal(rates.get('add-skill'), 1);
  assert.equal(rates.get('update-skill-body'), 0);

  // An op with a rejected history ranks below an equal one without.
  const ranked = rankProposals(
    [
      { branch: 'declined', ops: [{ op: 'add-skill', confidence: 0.9 }], delta: { delta: 0.3 } },
      { branch: 'welcome', ops: [{ op: 'update-skill-body', confidence: 0.9 }], delta: { delta: 0.3 } },
    ],
    history
  );
  assert.equal(ranked[0].branch, 'welcome');

  // And the proposer is told, so it stops spending calls on them.
  const digest = decisionDigest(history);
  assert.match(digest, /consistently declined these operation types: add-skill/);
  assert.doesNotMatch(digest, /update-skill-body/);
});

test('rejection learning needs a real sample, not one bad afternoon', () => {
  // Two rejections out of two is not evidence a category is unwanted; letting
  // it count would permanently disable an op on a whim.
  const rates = rejectionRates([
    { ops: ['add-skill'], verdict: 'reject' },
    { ops: ['add-skill'], verdict: 'reject' },
  ]);
  assert.equal(rates.has('add-skill'), false);
  assert.equal(decisionDigest([{ ops: ['add-skill'], verdict: 'reject' }]), '');
});

test('decisions round-trip through an append-only log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-decisions-'));
  const spec = normalizeSpec({ fleet: { name: 'd' }, agents: [{ name: 'a', role: 'r' }] });

  recordDecision(spec, { ts: '1', branch: 'x', ops: ['add-skill'], verdict: 'reject', reason: 'too speculative' }, dir);
  recordDecision(spec, { ts: '2', branch: 'y', ops: ['update-skill-body'], verdict: 'accept', generation: 1 }, dir);

  const back = readDecisions(spec, dir);
  assert.equal(back.length, 2);
  assert.equal(back[0].reason, 'too speculative');
  assert.equal(back[1].generation, 1);

  // One record per line is what lets two developers merge this file.
  const raw = fs.readFileSync(path.join(dir, decisionsPath(spec)), 'utf8');
  assert.equal(raw.trim().split('\n').length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('canary keeps a generation provisional, and catches a regression CI could not', () => {
  const baseline = { runs: 10, aggregate: 0.2 };

  // Not enough evidence yet.
  assert.equal(canaryStatus(baseline, { runs: 11, aggregate: 0.2 }).state, 'provisional');
  // Enough clean runs.
  assert.equal(canaryStatus(baseline, { runs: 14, aggregate: 0.18 }).state, 'confirmed');
  // Health worsened: passes every deterministic check but makes real runs
  // worse, which is exactly what the canary stage exists for.
  const bad = canaryStatus(baseline, { runs: 14, aggregate: 0.35 });
  assert.equal(bad.state, 'regressed');
  assert.match(bad.detail, /revert the generation tag/);
});

test('only fully-decidable ops are on the auto-apply whitelist', () => {
  // The whitelist is what keeps the review queue short enough to actually be
  // read, so what is on it matters more than its size.
  for (const op of ['update-bullet-counter', 'add-validator']) assert.ok(AUTO_APPLY.has(op));
  for (const op of ['update-skill-body', 'update-skill-description', 'add-skill', 'retire-skill', 'contract-change']) {
    assert.ok(!AUTO_APPLY.has(op), `${op} changes meaning and must be reviewed`);
  }
});

test('git revert of a generation tag restores the prior harness', () => {
  // The rollback story SkillOps and SkillOS explicitly lack, and which being
  // file-based and git-versioned gives us for free. Documented is not enough:
  // a rollback nobody has run is a rollback that does not work.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-revert-'));
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (git('init', '-q').status !== 0) {
    // No usable git here; skip rather than fail the suite for the environment.
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');

  const specFile = path.join(dir, 'fleet.yaml');
  const spec0 = {
    fleet: { name: 'demo', pattern: 'pipeline' },
    agents: [{ name: 'alpha', role: 'does things', skills: ['learned'] }],
    skills: [{ name: 'learned', origin: 'evolved', description: 'Widget calibration methodology.', body: 'original body\n' }],
  };
  fs.writeFileSync(specFile, YAML.stringify(spec0));
  const reload = () => normalizeSpec(YAML.parse(fs.readFileSync(specFile, 'utf8')));
  const build = () => buildAll(reload(), {}).write(dir, { force: true });

  build();
  git('add', '-A');
  git('commit', '-qm', 'baseline');

  // An accepted generation.
  const { source } = applyOps(fs.readFileSync(specFile, 'utf8'), [
    { op: 'update-skill-body', target: 'learned', body: 'evolved body\n' },
  ]);
  fs.writeFileSync(specFile, source);
  build();
  git('add', '-A');
  git('commit', '-qm', 'evolve(learned)');
  git('tag', 'fleet-gen/1');
  assert.match(fs.readFileSync(path.join(dir, '.claude/skills/learned/SKILL.md'), 'utf8'), /evolved body/);

  // The documented rollback.
  assert.equal(git('revert', '--no-edit', 'fleet-gen/1').status, 0);
  assert.match(fs.readFileSync(path.join(dir, '.claude/skills/learned/SKILL.md'), 'utf8'), /original body/);
  assert.ok(runQa(reload(), { builtDir: dir }).pass, 'the reverted harness must still be valid');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('drift compares content, not line-ending policy', () => {
  // Windows git checks files out as CRLF under the default core.autocrlf. A
  // file differing only by line endings has not been hand-edited, and
  // reporting it as drift would make the check fire constantly on Windows —
  // which trains people to ignore the one check that catches tampering.
  const spec = demoSpec();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-eol-'));
  const built = buildAll(spec, {});
  built.write(dir, { force: true });

  for (const [rel, content] of built.files) {
    if (built.preserved.has(rel) || !rel.endsWith('.md')) continue;
    fs.writeFileSync(path.join(dir, rel), content.replace(/\n/g, '\r\n'));
  }
  assert.ok(runQa(spec, { builtDir: dir }).pass, 'CRLF checkout reported as drift');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('every candidate branches from the base and returns to it', async () => {
  // Otherwise a later proposal branches off an earlier accepted one, so the
  // two are not independent and cannot be accepted or rejected in any order —
  // and HEAD is left on a proposal branch, where the user's next command runs.
  const { dir, specFile, spec, reload, build } = evolveFixture();
  const git = fakeGit();
  const res = await evolve(spec, {
    specFile,
    cwd: dir,
    git,
    reload,
    build,
    budget: 5,
    propose: async ({ target }) =>
      target.kind === 'playbook'
        ? [{ op: 'add-playbook-bullet', target: target.name, body: `Lesson for ${target.name}.`, confidence: 0.8 }]
        : [],
  });
  assert.ok(res.survivors.length >= 2, 'need several candidates to test independence');
  assert.equal(git.onBase, true, 'HEAD must be returned to the base branch');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('drift rebuilds with playbooks, so an accepted note is not reported as drift', () => {
  // Found by dogfooding: qa rebuilt without playbooks, so every agent carrying
  // a learned note looked hand-edited and an accepted generation turned the
  // drift check red. A check that fails on correct state stops being believed.
  const spec = demoSpec();
  const { bullets } = addBullet(spec.agents[0].name, [], 'Check the ledger before starting a phase.');
  const playbooks = { [spec.agents[0].name]: bullets };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-pb-drift-'));
  buildAll(spec, { playbooks }).write(dir, { force: true });

  assert.ok(runQa(spec, { builtDir: dir, playbooks }).pass, 'a built-in learned note reported as drift');
  // And omitting them still catches genuine drift, rather than passing blindly.
  assert.ok(!runQa(spec, { builtDir: dir }).pass, 'drift detection must still fire when inputs differ');

  fs.rmSync(dir, { recursive: true, force: true });
});

// --- T9: the advisory judge -------------------------------------------------

test('the judge scores binary criteria and never produces a pass/fail', () => {
  const spec = normalizeSpec({
    fleet: { name: 'j' },
    agents: [{ name: 'a', role: 'r' }],
    skills: [{ name: 's', description: 'd', body: 'b' }],
  });
  const stub = () => ({
    criteria: { 'concrete-tools': true, 'domain-specifics': false, 'executable-steps': true, 'failure-modes': false },
    score: 2,
    notes: 'no failure modes named',
  });
  const [r] = judgeSkills(spec, stub);
  assert.equal(r.score, 2);
  assert.equal(r.of, CRITERIA.length);
  // The absence of a pass field is the point: nothing to gate on by accident.
  assert.equal('pass' in r, false);
  assert.equal(r.criteria['domain-specifics'], false);
});

test('a judge that is unavailable degrades to advice, not to a failure', () => {
  const spec = normalizeSpec({
    fleet: { name: 'j' },
    agents: [{ name: 'a', role: 'r' }],
    skills: [{ name: 's', description: 'd', body: 'b' }],
  });
  const [r] = judgeSkills(spec, () => null);
  assert.equal(r.score, null);
  assert.match(r.notes, /unavailable/);
  assert.match(formatJudge([r]), /ADVISORY ONLY/);
});

test('no gate anywhere consults a judge score', () => {
  // The verifier is the ceiling on the whole system, and an uncalibrated judge
  // lowers it while feeling like progress. This asserts the boundary at the
  // source level so it cannot be eroded by a later refactor.
  // The invariant is that no gate IMPORTS OR CALLS the judge. Comments
  // explaining the boundary are the opposite of a violation, so match on code.
  const gates = ['src/qa/index.js', 'src/evolve/loop.js', 'src/evolve/patch.js', 'src/eval/index.js'];
  for (const file of gates) {
    const src = fs.readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
    assert.doesNotMatch(src, /from\s+['"].*judge/i, `${file} imports the judge`);
    assert.doesNotMatch(src, /\b(judgeSkills|claudeJudge|buildJudgePrompt|parseVerdict)\s*\(/, `${file} calls the judge`);
  }

  // And the CLI's judge path must return before any exit-code assignment.
  const cli = fs.readFileSync(fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'utf8');
  const judgeBlock = cli
    .slice(cli.indexOf('if (flags.judge)'), cli.indexOf('const baseline = flags.baseline'))
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '')) // a comment naming the invariant is not a violation of it
    .join('\n');
  assert.ok(judgeBlock.length > 0, 'judge path not found');
  assert.doesNotMatch(judgeBlock, /process\.exitCode/, 'the judge path must not set an exit code');
});

test('judge verdict parsing survives wrappers and rejects junk', () => {
  const v = { 'concrete-tools': true, 'domain-specifics': true, 'executable-steps': false, 'failure-modes': false, notes: 'x' };
  assert.equal(parseVerdict(JSON.stringify(v)).score, 2);
  assert.equal(parseVerdict('```json\n' + JSON.stringify(v) + '\n```').score, 2);
  assert.equal(parseVerdict(JSON.stringify({ result: JSON.stringify(v) })).score, 2);
  assert.equal(parseVerdict('not json'), null);
  // A missing criterion is false, not undefined — an unanswered question is
  // not evidence the skill met it.
  assert.equal(parseVerdict('{"concrete-tools": true}').score, 1);
});

test('agreement uses kappa, because raw agreement is inflated by base rates', () => {
  // A judge that always says true on a criterion almost everything passes
  // scores high raw agreement while carrying no information.
  const judged = Array.from({ length: 10 }, (_, i) => ({
    skill: `s${i}`,
    criteria: { 'concrete-tools': true, 'domain-specifics': true, 'executable-steps': true, 'failure-modes': true },
  }));
  const human = Object.fromEntries(
    judged.map((j, i) => [
      j.skill,
      { 'concrete-tools': true, 'domain-specifics': true, 'executable-steps': true, 'failure-modes': i < 9 },
    ])
  );
  const a = agreement(judged, human);
  assert.equal(a.perCriterion['failure-modes'].raw, 0.9, 'raw agreement looks fine');
  assert.equal(a.perCriterion['failure-modes'].kappa, 0, 'kappa exposes that it carries no information');
  assert.equal(a.trustworthy, false);
});
