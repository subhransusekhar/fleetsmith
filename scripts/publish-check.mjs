// Pre-publish sanity gate (G10.3): tarball contents, license fields, and version-pin sanity —
// checked WITHOUT ever calling `npm publish` itself. Publishing is a separate, deliberate, human step
// (`npm publish` from each package directory, with real registry credentials) — this script only answers
// "is it safe to run that command", the same question `npm pack --dry-run` answers for one package at a
// time, extended to check the two packages against EACH OTHER (the license boundary, the peerDependency
// range) rather than in isolation.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function readJson(relPath) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relPath), 'utf8'));
}

// On Windows, `npm` on PATH is a `.cmd` shim — execFileSync needs either that exact extension or `shell:
// true` to resolve it; the bare name alone throws ENOENT there (caught by this project's own Windows
// release-binary CI run, not written defensively up front).
const NPM_CMD = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function packFileList(cwd) {
  const raw = execFileSync(NPM_CMD, ['pack', '--dry-run', '--json'], { cwd, encoding: 'utf8' });
  const [entry] = JSON.parse(raw);
  return entry.files.map((f) => f.path);
}

/** The only range shape this repo's own peerDependencies actually use — not a general semver engine. */
function satisfiesGte(range, version) {
  const m = /^>=\s*(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (!m) throw new Error(`publish-check only understands a ">=X.Y.Z" range shape, got "${range}"`);
  const [, rMaj, rMin, rPatch] = m.map(Number.isNaN ? String : Number);
  const vm = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!vm) throw new Error(`not a plain X.Y.Z version: "${version}"`);
  const [vMaj, vMin, vPatch] = [Number(vm[1]), Number(vm[2]), Number(vm[3])];
  const req = [Number(m[1]), Number(m[2]), Number(m[3])];
  const got = [vMaj, vMin, vPatch];
  for (let i = 0; i < 3; i++) {
    if (got[i] > req[i]) return true;
    if (got[i] < req[i]) return false;
  }
  return true; // exactly equal
}

const failures = [];

const coreJson = readJson('package.json');
const eeJson = readJson('ee/package.json');

if (coreJson.license !== 'MIT') failures.push(`core package.json license is "${coreJson.license}", expected "MIT"`);
if (eeJson.license !== 'AGPL-3.0-only') failures.push(`ee/package.json license is "${eeJson.license}", expected "AGPL-3.0-only"`);

const coreFiles = packFileList(REPO_ROOT);
const eeContentInCore = coreFiles.filter((f) => f === 'ee' || f.startsWith('ee/'));
if (eeContentInCore.length) failures.push(`core tarball contains ee/ content, which must never ship in the MIT package: ${eeContentInCore.join(', ')}`);
if (!coreFiles.includes('LICENSE')) failures.push('core tarball is missing LICENSE');

const eeFiles = packFileList(path.join(REPO_ROOT, 'ee'));
if (!eeFiles.includes('LICENSE')) failures.push('ee/ tarball is missing LICENSE');
const eeLicenseText = readFileSync(path.join(REPO_ROOT, 'ee', 'LICENSE'), 'utf8');
if (!/GNU AFFERO GENERAL PUBLIC LICENSE/.test(eeLicenseText)) failures.push('ee/LICENSE does not look like the AGPL text');

const peerRange = eeJson.peerDependencies?.fleetsmith;
if (!peerRange) {
  failures.push('ee/package.json has no peerDependencies.fleetsmith range at all');
} else if (!satisfiesGte(peerRange, coreJson.version)) {
  failures.push(`ee/package.json's peerDependencies.fleetsmith ("${peerRange}") does not admit the core version being published ("${coreJson.version}")`);
}

if (coreJson.version !== eeJson.version) {
  console.warn(`note: core is ${coreJson.version} and ee is ${eeJson.version} — versions need not match exactly, only the peerDependency range above, but a mismatch this large is worth a second look before publishing.`);
}

if (failures.length) {
  console.error('publish-check: FAIL');
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log(`publish-check: PASS — fleetsmith@${coreJson.version} (MIT, ${coreFiles.length} files, no ee/ content) and fleetsmith-ee@${eeJson.version} (AGPL-3.0-only, ${eeFiles.length} files) are ready for a human to run \`npm publish\` from each directory.`);
}
