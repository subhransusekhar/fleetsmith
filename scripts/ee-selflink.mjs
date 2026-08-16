#!/usr/bin/env node
/**
 * Self-link fleetsmith into its own node_modules, so `ee/` can import core
 * as `fleetsmith/...` (the same way a real customer install resolves it —
 * `fleetsmith-ee` declares `fleetsmith` as a peerDependency) rather than a
 * relative path across the license boundary that only happens to work
 * because both trees sit in one checkout during development.
 *
 * A relative import (`../../../src/memory/port.js`) would silently break the
 * moment `fleetsmith-ee` is actually published: its npm tarball contains only
 * `ee/`'s own files, no copy of core's `src/`. Importing by package name and
 * making that name resolve locally is what keeps dev and production on the
 * same code path.
 *
 * Runs as `pretest` (before `npm test` / `node --test`, including in CI —
 * `node --test` auto-discovers `ee/test/**` too) so this never needs a
 * manual setup step. Idempotent and fail-soft: an existing correct link is
 * left alone, and any failure warns rather than blocking the test run — a
 * real resolution failure surfaces as its own clear import error anyway.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nodeModules = path.join(root, 'node_modules');
const link = path.join(nodeModules, 'fleetsmith');

try {
  if (fs.existsSync(link)) {
    const real = fs.realpathSync(link);
    if (real === fs.realpathSync(root)) process.exit(0); // already correct
    fs.rmSync(link, { recursive: true, force: true }); // stale — replace it
  }
  fs.mkdirSync(nodeModules, { recursive: true });
  // 'junction' works on Windows without admin/Developer Mode (regular
  // symlinks do not); POSIX ignores the type argument and creates a normal
  // symlink either way.
  fs.symlinkSync(root, link, 'junction');
} catch (e) {
  console.error(`warn: could not self-link fleetsmith for ee/ local dev: ${e.message}`);
}
