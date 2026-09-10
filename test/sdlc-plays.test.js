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
import { runQa, formatQa } from '../src/qa/index.js';
import { checksFor } from '../src/compile/agent-prompt.js';
import { protectedPathsFor, casePattern, literalPrefix, GUARD_PATH } from '../src/compile/guardrails.js';
import { CI_WORKFLOW_PATH } from '../src/compile/ci.js';
import { INTENT_FILE } from '../src/handover/protocol.js';

/**
 * The AI-native SDLC playbook (claude.com/blog/the-ai-native-sdlc-playbook,
 * 2026-08-21) applied to generated harnesses — see
 * docs/research/ai-native-sdlc-playbook-2026-09.md for the play-by-play
 * mapping. Four mechanisms are under test here:
 *
 *  1. intent artifact  — `00-intent.md` written before any agent runs, read
 *                        by every agent, checked by verifiers (Stage 1 + the
 *                        "committed artifact" thread)
 *  2. protected paths  — a PreToolUse hook / permission deny behind "do not
 *                        edit the tests or the gate" (Stage 3 + Stage 4)
 *  3. self-verification — agents accountable to a `check` run it and paste
 *                        the output, and the gate refuses a stop without it
 *                        (Stage 4 "give Claude a feedback loop")
 *  4. review passes + CI — severity-ranked review against the intent
 *                        (Stage 5 REVIEW.md) and an opt-in config-regression
 *                        workflow (Stage 4 "continuous evals in CI")
 */

function fixerSpec(extra = {}) {
  return normalizeSpec({
    fleet: { name: 'fixer', domain: 'fixes failing tests', pattern: 'generate-verify', ...extra },
    agents: [
      { name: 'patcher', role: 'Writes the fix.', capabilities: { read: true, edit: true, run: true }, handoff: { to: ['checker'], artifact: 'patch.md' } },
      { name: 'checker', role: 'Verifies the fix against the suite.', capabilities: { read: true, run: true } },
    ],
    orchestrator: {
      name: 'run-fixer',
      phases: [
        { name: 'Patch', agents: ['patcher'] },
        { name: 'Verify', agents: ['checker'], loop: { until: 'the suite passes', check: 'npm test', max: 3 } },
      ],
    },
  });
}

function plainSpec(extra = {}) {
  return normalizeSpec({
    fleet: { name: 'plain', domain: 'd', ...extra },
    agents: [
      { name: 'analyst', role: 'Analyzes.', handoff: { to: ['writer'], artifact: 'a.md' } },
      { name: 'writer', role: 'Writes.', capabilities: { read: true, edit: true } },
    ],
  });
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `fleetsmith-${prefix}-`));
}

function readEvents(dir, spec) {
  const runsDir = path.join(dir, spec.fleet.local, 'runs');
  if (!fs.existsSync(runsDir)) return [];
  return fs
    .readdirSync(runsDir)
    .filter((f) => !f.startsWith('CURRENT'))
    .flatMap((id) => fs.readFileSync(path.join(runsDir, id, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
}

// --- spec surface ------------------------------------------------------------

test('fleet.guardrails normalizes: object, bare-array shorthand, dedupe; fleet.ci defaults to null', () => {
  assert.deepEqual(plainSpec().fleet.guardrails, { protectedPaths: [] });
  assert.equal(plainSpec().fleet.ci, null);
  assert.deepEqual(plainSpec({ guardrails: ['test/**', 'test/**', ' src/gen/** '] }).fleet.guardrails, {
    protectedPaths: ['test/**', 'src/gen/**'],
  });
  assert.deepEqual(plainSpec({ guardrails: { protectedPaths: 'test/**' } }).fleet.guardrails, { protectedPaths: ['test/**'] });
});

test('validator refuses unsafe guardrail globs and unknown CI providers, and warns when a checked loop has no protected paths', () => {
  // The glob lands unquoted in a `case` pattern inside a generated hook, so
  // anything beyond path + wildcard characters is a shell injection vector.
  for (const bad of ['test/$(rm -rf /)', '../secret/**', '/etc/**', 'a;b', 'a b']) {
    const { errors } = validateSpec(plainSpec({ guardrails: [bad] }));
    assert.ok(errors.some((e) => e.includes('protectedPaths') && e.includes(bad)), `${bad} should be rejected: ${errors}`);
  }
  assert.deepEqual(validateSpec(plainSpec({ guardrails: ['test/**', 'src/gen/*.js', '**/*.snap', 'a?b/c'] })).errors, []);

  assert.ok(validateSpec(plainSpec({ ci: 'gitlab' })).errors.some((e) => /fleet\.ci "gitlab"/.test(e)));
  assert.deepEqual(validateSpec(plainSpec({ ci: 'github' })).errors, []);

  const unprotected = validateSpec(fixerSpec()).warnings;
  assert.ok(unprotected.some((w) => /declares a shell `check`.*protectedPaths is empty/.test(w)), unprotected.join('\n'));
  const protectedWarnings = validateSpec(fixerSpec({ guardrails: ['test/**'] })).warnings;
  assert.ok(!protectedWarnings.some((w) => /protectedPaths is empty/.test(w)));
});

// --- protected paths ----------------------------------------------------------

test('the fleet\'s own gate scripts are always protected, before anything the author declares', () => {
  assert.deepEqual(protectedPathsFor(plainSpec()), ['_fleet/local/scripts/**']);
  assert.deepEqual(protectedPathsFor(plainSpec({ guardrails: ['test/**'] })), ['_fleet/local/scripts/**', 'test/**']);
  // an author re-declaring the auto path does not duplicate it
  assert.deepEqual(protectedPathsFor(plainSpec({ guardrails: ['_fleet/local/scripts/**'] })), ['_fleet/local/scripts/**']);
  assert.equal(casePattern('test/**'), 'test/*');
  assert.equal(casePattern('**/*.snap'), '*.snap');
  assert.equal(literalPrefix('test/**'), 'test/');
  assert.equal(literalPrefix('src/gen/*.js'), 'src/gen/');
  assert.equal(literalPrefix('*.snap'), '');
});

test('claude-code registers a PreToolUse guard on the editing tools and Bash, and the CLAUDE.md pointer names the protected set', () => {
  const spec = plainSpec({ guardrails: ['test/**'] });
  const files = buildClaudeCode(spec, {});
  const settings = JSON.parse(files.files.get('.claude/settings.json'));
  const pre = settings.hooks.PreToolUse;
  assert.equal(pre.length, 1);
  assert.match(pre[0].matcher, /Edit\|Write\|MultiEdit\|NotebookEdit\|Bash/);
  assert.match(pre[0].hooks[0].command, new RegExp(GUARD_PATH.replace('.', '\\.')));
  // the SubagentStop handover gate is untouched by the new hook
  assert.ok(settings.hooks.SubagentStop?.length === 1);

  const script = files.files.get(`_fleet/local/${GUARD_PATH}`);
  assert.ok(script, 'guard script must be emitted');
  assert.match(script, /^# Protected: _fleet\/local\/scripts\/\*\*, test\/\*\*$/m);
  assert.match(files.files.get('CLAUDE.md'), /\*\*Protected paths:\*\*.*`test\/\*\*`/);
  assert.match(files.files.get('CLAUDE.md'), /\*\*Intent:\*\* every run starts by writing/);
});

test('guard hook: blocks edits under protected paths with an explanation, lets everything else through, and records the block', () => {
  const spec = plainSpec({ guardrails: ['test/**', 'src/gen/*.js', '**/*.snap'] });
  const dir = tmp('guard');
  buildClaudeCode(spec, {}).write(dir, { force: true });
  const script = path.join(dir, spec.fleet.local, GUARD_PATH);
  const run = (payload, projectDir = dir) =>
    spawnSync('sh', [script], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir } });

  const edit = (file_path, tool = 'Edit', agent_type = 'writer') => ({ tool_name: tool, tool_input: { file_path }, agent_type });

  // Windows sends OS-native paths and JSON escapes every separator, so the hook
  // reads `D:\\repo\\test\\x.js` while these patterns are POSIX globs. It matched
  // nothing there and allowed every protected edit — caught by the Windows
  // release runner, asserted here on every platform. `JSON.stringify` produces
  // exactly the escaping a real payload carries, so this is the true shape.
  const winRoot = 'D:\\repo';
  assert.equal(
    run(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: `${winRoot}\\test\\unit\\a.test.js` }, agent_type: 'writer' }), winRoot).status,
    2,
    'a backslash-separated path under a protected glob must still be blocked'
  );
  assert.equal(
    run(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: `${winRoot}\\src\\index.js` }, agent_type: 'writer' }), winRoot).status,
    0,
    'an unprotected backslash path is still allowed'
  );

  // absolute and relative forms of a protected path are both caught
  let r = run(edit(path.join(dir, 'test/unit/a.test.js')));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Guardrail: 'test\/unit\/a\.test\.js' is a protected path/);
  assert.match(r.stderr, /do not work around the block/);
  assert.equal(run(edit('test/x.js', 'Write')).status, 2);
  assert.equal(run(edit('./src/gen/out.js', 'MultiEdit')).status, 2);
  assert.equal(run(edit('deep/er/file.snap')).status, 2);
  assert.equal(run({ tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(dir, 'test/nb.ipynb') } }).status, 2);

  // the fleet's own gate is protected even though nobody declared it
  r = run(edit(path.join(dir, '_fleet/local/scripts/validate-handoff.sh')));
  assert.equal(r.status, 2);

  // ordinary files, the handoff dir, reads, and unknown tools pass
  assert.equal(run(edit(path.join(dir, 'src/index.js'))).status, 0);
  assert.equal(run(edit(path.join(dir, '_fleet/local/handoffs/01-analyst-to-writer.md'))).status, 0);
  assert.equal(run({ tool_name: 'Read', tool_input: { file_path: path.join(dir, 'test/x.js') } }).status, 0);
  assert.equal(run('').status, 0);
  assert.equal(run('{"tool_name":"Edit","tool_input":{}}').status, 0);

  // Bash: reads of a protected prefix pass — including reads that redirect
  // ELSEWHERE and prose that merely mentions the path next to a '>' — while
  // write-shaped commands INTO the prefix are blocked.
  const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
  for (const cmd of [
    'grep -rn foo test/ | head',
    'cat test/x.js 2>/dev/null',
    'cat test/x.js > /tmp/out.txt',
    'npm test > out.log',
    'diff <(sort test/a.txt) <(sort test/b.txt)',
    "git commit -m 'protect test/** (see <local>/scripts)'",
    'node -e "console.log(1 > 0)" -- test/x.js',
  ]) {
    r = run(bash(cmd));
    assert.equal(r.status, 0, `should allow: ${cmd}\n${r.stderr}`);
  }
  for (const cmd of [
    'cat > test/x.js <<EOF\nx\nEOF',
    'echo hi >> test/log.txt',
    'sed -i.bak s/a/b/ test/x.js',
    "sed -i '' 's/a/b/' test/x.js",
    'rm -rf test/fixtures',
    'mv test/a test/b',
    'cp /tmp/x src/gen/y.js',
    'git checkout -- test/',
    'git restore test/a.js',
    'echo x | tee src/gen/a.js',
    'echo x | tee -a "test/a.txt"',
    'truncate -s 0 test/big.log',
  ]) {
    r = run(bash(cmd));
    assert.equal(r.status, 2, `should block: ${cmd}`);
    assert.match(r.stderr, /Bash writes into a protected prefix/);
  }

  // The payload arrives as ONE line — a heredoc's newlines are escaped — so an
  // unbounded gap between the write token and the path matched any write-ish
  // word anywhere against any protected path anywhere. This blocked a long
  // heredoc whose prose merely mentioned a protected path; the gap is bounded.
  const longProse = [
    "python3 - <<'PY'",
    "s = s.replace('run rm -rf build first', 'x')",
    ...Array.from({ length: 40 }, (_, i) => `# line ${i} of ordinary documentation prose about fleets`),
    "s += 'Your fleet\\'s own test/ directory is protected for you'",
    'PY',
  ].join('\n');
  r = run(bash(longProse));
  assert.equal(r.status, 0, `a distant mention is not an argument of the write token:\n${r.stderr}`);
  // but the same token with the path as its actual argument still blocks
  assert.equal(run(bash('rm -rf --preserve-root test/fixtures/old')).status, 2);

  // every block was recorded through the fleet's telemetry, attributed to the agent
  const blocks = readEvents(dir, spec).filter((e) => e.event === 'guard_block');
  assert.ok(blocks.length >= 8, `expected guard_block events, got ${blocks.length}`);
  assert.ok(blocks.some((e) => e.agent === 'writer' && /Edit test\/unit\/a\.test\.js/.test(e.detail)));
  // a main-session block (no agent_type) is attributed to '-'
  run({ tool_name: 'Edit', tool_input: { file_path: 'test/main.js' } });
  assert.ok(readEvents(dir, spec).some((e) => e.event === 'guard_block' && e.agent === '-'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('guardrail globs cannot inject shell into the generated guard even if validation were bypassed', () => {
  // Layer 2 for the same reason the handover gate has one: a spec is meant to
  // be shared. The validator rejects this glob; if it were emitted anyway, a
  // `case` pattern never executes its text.
  const marker = path.join(os.tmpdir(), 'fleetsmith-guard-pwned');
  const spec = normalizeSpec({
    fleet: { name: 'x', domain: 'd', guardrails: [`test/*) touch ${marker}; (x`] },
    agents: [{ name: 'a' }],
  });
  assert.ok(validateSpec(spec).errors.some((e) => /protectedPaths/.test(e)));
  const dir = tmp('guard-inject');
  buildClaudeCode(spec, {}).write(dir, { force: true });
  spawnSync('sh', [path.join(dir, spec.fleet.local, GUARD_PATH)], { input: '{"tool_name":"Edit","tool_input":{"file_path":"test/a"}}', cwd: dir, encoding: 'utf8' });
  assert.ok(!fs.existsSync(marker), 'generated guard executed injected text');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('opencode denies protected paths in every agent\'s edit map, including editors and the orchestrator', () => {
  const spec = plainSpec({ guardrails: ['test/**'] });
  const files = buildOpencode(spec, {});
  const writer = files.files.get('.opencode/agents/writer.md');
  assert.match(writer, /edit:\n\s+"\*": allow\n\s+_fleet\/local\/scripts\/\*\*: deny\n\s+test\/\*\*: deny/);
  const analyst = files.files.get('.opencode/agents/analyst.md');
  // read-only agents keep their workspace-only grant but lose the gate scripts inside it
  assert.match(analyst, /edit:\n\s+"\*": deny\n\s+_fleet\/\*\*: allow\n\s+_fleet\/local\/scripts\/\*\*: deny\n\s+test\/\*\*: deny/);
  const orch = files.files.get(`.opencode/agents/${spec.orchestrator.name}.md`);
  assert.match(orch, /edit:\n\s+"\*": allow\n\s+_fleet\/local\/scripts\/\*\*: deny\n\s+test\/\*\*: deny/);
});

test('goose states the guardrail as advisory, since it has no path-level permission', () => {
  const spec = plainSpec({ guardrails: ['test/**'] });
  const files = buildGoose(spec, {});
  const recipe = files.files.get('.goose/recipes/writer.yaml');
  assert.match(recipe, /## Guardrails/);
  assert.match(recipe, /`test\/\*\*`/);
  assert.match(recipe, /Nothing enforces this on this target/);
  // and the claude-code body says the opposite, truthfully
  assert.match(buildClaudeCode(spec, {}).files.get('.claude/agents/writer.md'), /A hook blocks such edits/);
});

test('qa: the guardrails check verifies the compiled wiring on all three targets', () => {
  const report = runQa(plainSpec({ guardrails: ['test/**'] }));
  const check = report.checks.find((c) => c.name === 'guardrails (compiled)');
  assert.ok(check, 'guardrails check missing');
  assert.ok(check.pass, formatQa(report));
  assert.equal(check.detail, '2 protected path(s)');
  assert.ok(report.pass, formatQa(report));
});

// --- intent artifact ----------------------------------------------------------

test('every target ships the intent template, every agent reads the intent first, and the orchestrator captures it in Phase 0', () => {
  const spec = plainSpec();
  const all = buildAll(spec, {}); // no adapter conflict on the shared template
  const tmpl = all.files.get(`${spec.handover.dir}/INTENT.template.md`);
  assert.ok(tmpl, 'INTENT.template.md missing');
  for (const h of ['## Problem', '## Proposed outcome', '## Affected users and systems', '## Constraints', '## Out of scope', '## Open questions', '## Revisions']) {
    assert.ok(tmpl.includes(h), `intent template lacks ${h}`);
  }
  for (const target of [buildClaudeCode, buildOpencode, buildGoose]) {
    assert.equal(target(spec, {}).files.get(`${spec.handover.dir}/INTENT.template.md`), tmpl);
  }

  for (const [p, body] of all.files) {
    if (!/^\.claude\/agents\//.test(p)) continue;
    assert.match(body, new RegExp(`\\*\\*On start:\\*\\*\\n1\\. Read \`${spec.handover.dir}/${INTENT_FILE}\``), `${p} does not read the intent first`);
  }
  const orch = all.files.get(`.claude/skills/${spec.orchestrator.name}/SKILL.md`);
  assert.match(orch, /### Capture the intent before any agent runs/);
  assert.match(orch, /Interactive run:.*take corrections before Phase 1/);
  assert.match(orch, /Non-interactive or scheduled run:.*Accepted by: trigger/);
  assert.match(orch, /Partial re-run:.*Revisions table/);
  // completion checks the deliverable against the intent, and applies the twice rule
  assert.match(orch, /3\. Check the deliverable against `_fleet\/local\/handoffs\/00-intent\.md`/);
  assert.match(orch, /5\. Apply the twice rule/);

  // the handoff template points at the intent and carries a Verification section
  const handoff = all.files.get(`${spec.handover.dir}/HANDOFF.template.md`);
  assert.match(handoff, /\*\*Intent:\*\* 00-intent\.md/);
  assert.match(handoff, /## Verification/);
});

test('a scheduled fleet\'s loop.md turns found work into an intent file before any agent runs', () => {
  const files = buildClaudeCode(plainSpec({ schedule: { interval: '1h' } }), {});
  assert.match(files.files.get('.claude/loop.md'), /write it down first as `_fleet\/local\/handoffs\/00-intent\.md`/);
});

// --- self-verification -------------------------------------------------------

test('checksFor: agents in a checked phase and the producers handing into it are accountable to the check', () => {
  const spec = fixerSpec();
  const [patcher, checker] = spec.agents;
  assert.deepEqual(checksFor(checker, spec), ['npm test']);
  assert.deepEqual(checksFor(patcher, spec), ['npm test'], 'the producer runs the verifier\'s check before handing off');
  const plain = plainSpec();
  for (const a of plain.agents) assert.deepEqual(checksFor(a, plain), []);
});

test('checked agents get a "Verifying your work" section; unchecked fleets do not', () => {
  const fixer = buildClaudeCode(fixerSpec(), {});
  const patcher = fixer.files.get('.claude/agents/patcher.md');
  assert.match(patcher, /## Verifying your work/);
  assert.match(patcher, /run `npm test` yourself and paste the literal output under `## Verification`/);
  assert.match(patcher, /fix the work, not the check/);
  const plain = buildClaudeCode(plainSpec(), {});
  for (const p of ['.claude/agents/analyst.md', '.claude/agents/writer.md']) {
    assert.doesNotMatch(plain.files.get(p), /## Verifying your work/);
  }
});

test('handover gate requires the Verification section only from agents accountable to a check', () => {
  // checked producer: blocked without Verification, accepted with it
  const spec = fixerSpec();
  const dir = tmp('gate-verify');
  buildClaudeCode(spec, {}).write(dir, { force: true });
  const gate = path.join(dir, spec.fleet.local, 'scripts/validate-handoff.sh');
  const run = (agent) => spawnSync('sh', [gate], { input: JSON.stringify({ agent_type: agent }), cwd: dir, encoding: 'utf8' });

  const handoff = path.join(dir, spec.handover.dir, '01-patcher-to-checker.md');
  fs.writeFileSync(handoff, '# Handoff\n\n## Objective\nx\n## Output format\nx\n## Sources and tools\nx\n## Boundaries\nx\n');
  fs.appendFileSync(path.join(dir, spec.fleet.local, 'LEDGER.md'), '| 2 | fix | patcher | - | done | h.md |\n');
  let r = run('patcher');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /missing required section\(s\): Verification/);
  fs.appendFileSync(handoff, '## Verification\n```\n$ npm test\n... 12 passing\n```\n');
  r = run('patcher');
  assert.equal(r.status, 0, r.stderr);
  fs.rmSync(dir, { recursive: true, force: true });

  // unchecked producer: the four-field brief is still the whole contract
  const plain = plainSpec();
  const dir2 = tmp('gate-plain');
  buildClaudeCode(plain, {}).write(dir2, { force: true });
  fs.writeFileSync(path.join(dir2, plain.handover.dir, '01-analyst-to-writer.md'), '# Handoff\n\n## Objective\nx\n## Output format\nx\n## Sources and tools\nx\n## Boundaries\nx\n');
  fs.appendFileSync(path.join(dir2, plain.fleet.local, 'LEDGER.md'), '| 2 | a | analyst | - | done | h.md |\n');
  const r2 = spawnSync('sh', [path.join(dir2, plain.fleet.local, 'scripts/validate-handoff.sh')], { input: '{"agent_type":"analyst"}', cwd: dir2, encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr);
  fs.rmSync(dir2, { recursive: true, force: true });
});

// --- review passes ------------------------------------------------------------

test('verifiers review in three ranked passes against the intent, cap nits, and flag repeat findings as harness defects', () => {
  const files = buildClaudeCode(fixerSpec(), {});
  const checker = files.files.get('.claude/agents/checker.md');
  assert.match(checker, /## Reviewing/);
  assert.match(checker, /\*\*Defects\*\*/);
  assert.match(checker, /\*\*Compliance\*\* — the artifact does what `_fleet\/local\/handoffs\/00-intent\.md` asked/);
  assert.match(checker, /\*\*Policy\*\*/);
  assert.match(checker, /Reserve \*\*Important\*\* for/);
  assert.match(checker, /at most five nits/);
  assert.match(checker, /second time.*harness defect/);
  // producers are not reviewers
  assert.doesNotMatch(files.files.get('.claude/agents/patcher.md'), /## Reviewing/);
});

// --- config-regression CI -----------------------------------------------------

test('fleet.ci: github emits one workflow, identical from every adapter; absent by default', () => {
  assert.ok(!buildAll(plainSpec(), {}).files.has(CI_WORKFLOW_PATH));
  const spec = plainSpec({ ci: 'github' });
  const all = buildAll(spec, {});
  const wf = all.files.get(CI_WORKFLOW_PATH);
  assert.ok(wf, 'workflow missing');
  for (const target of [buildClaudeCode, buildOpencode, buildGoose]) {
    assert.equal(target(spec, {}).files.get(CI_WORKFLOW_PATH), wf);
  }
  assert.match(wf, /npx --yes fleetsmith qa fleet\.yaml --built \./);
  assert.match(wf, /npx --yes fleetsmith eval fleet\.yaml --stage 2/);
  for (const p of ['fleet.yaml', '.claude/**', '.opencode/**', '.goose/**', '_fleet/shared/**', 'CLAUDE.md', 'AGENTS.md']) {
    assert.ok(wf.includes(`- '${p}'`), `workflow does not watch ${p}`);
  }
  assert.doesNotMatch(wf, /ANTHROPIC_API_KEY/, 'both commands are deterministic; no model key belongs in this workflow');
  assert.ok(runQa(spec).pass, 'a fleet with ci: github must still pass qa');
});

// --- invariants the plays must not break ---------------------------------------

test('the new sections stay cache-stable and deterministic across builds', () => {
  const spec = fixerSpec({ guardrails: ['test/**'], ci: 'github' });
  const a = buildAll(spec, { today: '2026-09-10' });
  const b = buildAll(spec, { today: '2027-01-01' });
  for (const [p, body] of a.files) {
    if (a.preserved.has(p)) continue;
    assert.equal(body, b.files.get(p), `${p} differs between builds`);
  }
  // no untiered workspace files were introduced
  const untiered = a.list().filter((p) => p.startsWith('_fleet/') && !p.startsWith('_fleet/shared/') && !p.startsWith('_fleet/local/'));
  assert.deepEqual(untiered, []);
});
