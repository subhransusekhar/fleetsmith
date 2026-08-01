import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeSpec } from '../src/spec/schema.js';
import { validateSpec } from '../src/spec/validate.js';
import { buildClaudeCode } from '../src/adapters/claude-code.js';
import { buildOpencode } from '../src/adapters/opencode.js';
import { buildGoose } from '../src/adapters/goose.js';
import { buildAll } from '../src/adapters/index.js';
import { archetype, ARCHETYPES } from '../src/patterns/index.js';
import { planInstall } from '../src/install.js';
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
  assert.ok(paths.includes('_fleet/handoffs/HANDOFF.template.md'));
  assert.ok(paths.includes('_fleet/LEDGER.md'));
  assert.ok(paths.includes('CLAUDE.md'));

  const builder = files.files.get('.claude/agents/builder.md');
  assert.match(builder, /^---\nname: builder\n/);
  assert.match(builder, /tools: Read, Grep, Glob, Write, Edit, Bash/);
  assert.match(builder, /Handover protocol/);
  assert.match(builder, /_fleet\/handoffs\/\{seq\}-builder-to-reviewer\.md/);
  assert.match(builder, /_fleet\/LEDGER\.md/);
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
  assert.match(status, /!`ls -1 _fleet\/handoffs/);
  assert.match(status, /@_fleet\/LEDGER\.md/);
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
  assert.ok(files.list().includes('_fleet/scripts/validate-handoff.sh'));

  // the workspace-trust caveat must reach the user: an inert gate looks identical to a passing one
  assert.match(files.files.get('CLAUDE.md'), /until this workspace is trusted/);
});

test('handover gate blocks incomplete handoffs and passes template-shaped ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetsmith-gate-'));
  buildClaudeCode(demoSpec(), {}).write(dir, { force: true });
  const script = path.join(dir, '_fleet/scripts/validate-handoff.sh');
  const run = (payload) =>
    spawnSync('sh', [script], { input: payload, cwd: dir, encoding: 'utf8' });

  // no handoff file yet -> exit 2 blocks the agent from stopping
  const missing = run('{"agent_type":"analyst"}');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no handoff file found/);

  // present but missing required sections -> still blocked, and says which
  const handoff = path.join(dir, '_fleet/handoffs/01-analyst-to-builder.md');
  fs.writeFileSync(handoff, '# Handoff\n\n## Objective\nDo it.\n');
  const partial = run('{"agent_type":"analyst"}');
  assert.equal(partial.status, 2);
  assert.match(partial.stderr, /missing required section\(s\).*Boundaries/s);

  // the bundled template satisfies the gate it ships with
  const template = fs.readFileSync(path.join(dir, '_fleet/handoffs/HANDOFF.template.md'), 'utf8');
  fs.writeFileSync(handoff, template.replace(/\{[^}]*\}/g, 'x'));
  fs.appendFileSync(path.join(dir, '_fleet/LEDGER.md'), '\n| 1 | x | analyst | - | done | h.md |\n');
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
  const template = files.files.get('_fleet/handoffs/HANDOFF.template.md');
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
  assert.match(buildClaudeCode(spec, {}).files.get('.claude/agents/a.md'), /_fleet\/notes\/a\.md/);
});

test('orchestrator skill injects live workspace state and guards autonomous runs', () => {
  const plain = buildClaudeCode(demoSpec(), {}).files.get('.claude/skills/run-demo/SKILL.md');
  assert.match(plain, /argument-hint:/);
  // shell injection block: state arrives inlined, not as an instruction to go read it
  assert.match(plain, /```!\n.*_fleet\/handoffs/s);
  assert.match(plain, /cat _fleet\/LEDGER\.md/);
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
  assert.equal(paths.filter((p) => p === '_fleet/LEDGER.md').length, 1);
  assert.equal(paths.filter((p) => p === 'AGENTS.md').length, 1);
  assert.ok(paths.some((p) => p.startsWith('.claude/')));
  assert.ok(paths.some((p) => p.startsWith('.opencode/')));
  assert.ok(paths.some((p) => p.startsWith('.goose/')));
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

  const readme = files.files.get('_fleet/evals/README.md');
  assert.match(readme, /fresh session is not optional/);
  assert.match(readme, /edit the `description`, not the prompt/);
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
  fs.mkdirSync(path.join(dir, '_fleet'), { recursive: true });
  fs.writeFileSync(path.join(dir, '_fleet/LEDGER.md'), '| 1 | scan | analyst | - | done | h.md |');
  const output = { context: ['existing'] };
  await hook({ sessionID: 's' }, output);
  assert.equal(output.context.length, 2);
  assert.match(output.context[1], /LEDGER\.md/);
  assert.match(output.context[1], /scan \| analyst/);
});
