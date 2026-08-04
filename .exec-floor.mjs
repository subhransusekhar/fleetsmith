import fs from 'node:fs';
import YAML from 'yaml';
import { normalizeSpec } from './src/spec/schema.js';
import { runExecCases, execStability, formatExec } from './src/eval/exec.js';
const spec = normalizeSpec(YAML.parse(fs.readFileSync('fleet.yaml','utf8')));
const runs = [];
for (let i = 0; i < 2; i++) {
  runs.push(runExecCases(spec, { target: 'claude-code', timeout: 120000 }));
  console.log(`--- run ${i+1} ---\n` + formatExec(runs[i]));
  fs.writeFileSync('/tmp/floor.json', JSON.stringify(runs, null, 1));
}
console.log('STABILITY ' + JSON.stringify(execStability(runs)));
console.log('DONE');
