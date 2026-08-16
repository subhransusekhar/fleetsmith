import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import YAML from 'yaml';
import { normalizeSpec } from '../src/spec/schema.js';
import { validateSpec } from '../src/spec/validate.js';
import { buildAll } from '../src/adapters/index.js';
import { runTriggerTests } from '../src/eval/index.js';

/**
 * fleet.example.yaml is reference material (the "full-featured example" linked from the CLI's own build
 * comment) that nothing else in the test suite touches — without a check here, a future edit could silently
 * break its skill triggers or its compile-ability and nothing would notice. G4.2 added the `grid-awareness`
 * skill to it; this guards that (and the file generally) going forward.
 */
function loadExampleSpec() {
  return normalizeSpec(YAML.parse(fs.readFileSync('fleet.example.yaml', 'utf8')));
}

test('fleet.example.yaml validates cleanly', () => {
  const spec = loadExampleSpec();
  const { errors } = validateSpec(spec);
  assert.deepEqual(errors, []);
});

test('fleet.example.yaml compiles to all three targets without error', () => {
  const spec = loadExampleSpec();
  const fileSet = buildAll(spec);
  assert.ok(fileSet.files.size > 0);
  assert.ok([...fileSet.files.keys()].some((p) => p.includes('grid-awareness')), 'the grid-awareness skill should be compiled somewhere in the output');
});

test('every fleet.example.yaml skill trigger case passes, including grid-awareness', () => {
  const spec = loadExampleSpec();
  const { cases } = runTriggerTests(spec);
  const gridCases = cases.filter((c) => c.name.startsWith('grid-awareness'));
  assert.ok(gridCases.length >= 10, 'grid-awareness should declare at least 5 should + 5 shouldNot cases');
  const failed = cases.filter((c) => !c.pass);
  assert.deepEqual(failed.map((c) => `${c.name}: ${c.detail}`), []);
});
