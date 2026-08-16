import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * `scripts/publish-check.mjs` (G10.3) is the mechanism the release issue's own acceptance criterion names
 * ("tarball contains no ee/ — assert in the publish script"). This runs it for real against the actual
 * checkout's own package.json files and tarball contents — the same thing `npm run publish-check` /
 * `prepublishOnly` does — rather than mocking `npm pack`, since a mock could drift from what `npm pack`
 * actually reports and this check exists specifically to catch drift.
 */
test('publish-check passes against this checkout: MIT/AGPL license fields, no ee/ in the core tarball, peerDependency range satisfied', async () => {
  const { stdout } = await execFileAsync('node', [path.join(REPO_ROOT, 'scripts', 'publish-check.mjs')], { cwd: REPO_ROOT });
  assert.match(stdout, /publish-check: PASS/);
  assert.match(stdout, /no ee\/ content/);
});
