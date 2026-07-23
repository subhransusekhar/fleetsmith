import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpec } from '../src/spec/schema.js';
import { validateSpec } from '../src/spec/validate.js';
import { buildClaudeCode } from '../src/adapters/claude-code.js';
import { buildOpencode } from '../src/adapters/opencode.js';
import { buildGoose } from '../src/adapters/goose.js';
import { buildAll } from '../src/adapters/index.js';
import { archetype, ARCHETYPES } from '../src/patterns/index.js';
import { planInstall } from '../src/install.js';
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
  const skillPaths = files.list().filter((p) => p.includes('shared-skill'));
  assert.deepEqual(skillPaths, ['.claude/skills/shared-skill/SKILL.md']);
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
});

test('planInstall rejects unknown scope', () => {
  assert.throws(() => planInstall(buildAll(demoSpec(), {}), { scope: 'global' }), /Unknown install scope/);
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
  assert.deepEqual(verify.loop, { until: 'checker reports no defects', max: 4, check: 'npm test' });
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
