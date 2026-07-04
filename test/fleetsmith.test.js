import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpec } from '../src/spec/schema.js';
import { validateSpec } from '../src/spec/validate.js';
import { buildClaudeCode } from '../src/adapters/claude-code.js';
import { buildOpencode } from '../src/adapters/opencode.js';
import { buildGoose } from '../src/adapters/goose.js';
import { buildAll } from '../src/adapters/index.js';
import { archetype, ARCHETYPES } from '../src/patterns/index.js';
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

test('team execution adds team protocol block on claude-code only', () => {
  const raw = archetype('supervisor', 'sup', 'supervision');
  const spec = normalizeSpec(raw);
  const cc = buildClaudeCode(spec, {});
  assert.match(cc.files.get('.claude/agents/lead.md'), /Team communication/);
  const oc = buildOpencode(spec, {});
  assert.doesNotMatch(oc.files.get('.opencode/agents/lead.md'), /Team communication/);
});
