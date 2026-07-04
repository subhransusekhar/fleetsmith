import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { FileSet } from './lib/fs-utils.js';

/**
 * Turn a generated FileSet into a concrete install plan.
 *
 * Two scopes:
 *  - `project`: verbatim layout, written into a target app repo (the tools
 *    discover project-level `.claude/`, `.opencode/`, `.goose/`). This is
 *    what `build` already does; `install` adds tool detection + friendlier
 *    reporting on top.
 *  - `user`: install the reusable definitions into each tool's user-global
 *    config directory so the fleet's agents/skills/recipes are available in
 *    every project. Only additive, per-name files are installed — shared
 *    singletons (CLAUDE.md, AGENTS.md) and project runtime artifacts
 *    (_fleet/) are skipped so we never clobber a user's global config.
 */

// Remap a tool's project-relative root onto its $HOME-relative user-config
// location. First matching rule wins; order matters (specific before broad).
const USER_REMAP = [
  { from: /^\.claude\//, to: '.claude/' },
  { from: /^\.opencode\/agents\//, to: '.config/opencode/agents/' },
  { from: /^\.opencode\/commands\//, to: '.config/opencode/commands/' },
  { from: /^\.opencode\/skills\//, to: '.config/opencode/skills/' },
  { from: /^\.goose\/recipes\//, to: '.config/goose/recipes/' },
  { from: /^\.goose\/skills\//, to: '.config/goose/skills/' },
];

const USER_SKIP = [
  {
    match: (p) => p === 'CLAUDE.md' || p === 'AGENTS.md',
    reason: 'shared pointer file — manage your global memory/instructions yourself',
  },
  {
    match: (p) => p.startsWith('_fleet/'),
    reason: 'project runtime workspace — belongs in the project where the fleet runs',
  },
];

/**
 * @returns {{ fileSet: FileSet, baseDir: string, skipped: {path,reason}[], scope: string }}
 *   baseDir is where the returned FileSet should be written. For `project`
 *   scope baseDir is the caller-supplied target dir; for `user` it is $HOME.
 */
export function planInstall(fileSet, { scope = 'project', home = os.homedir(), into = '.' } = {}) {
  if (scope === 'project') {
    return { fileSet, baseDir: into, skipped: [], scope };
  }
  if (scope !== 'user') {
    throw new Error(`Unknown install scope "${scope}" (use: project | user)`);
  }

  const out = new FileSet();
  const skipped = [];
  for (const [p, content] of fileSet.files) {
    const skip = USER_SKIP.find((s) => s.match(p));
    if (skip) {
      skipped.push({ path: p, reason: skip.reason });
      continue;
    }
    const rule = USER_REMAP.find((r) => r.from.test(p));
    if (!rule) {
      skipped.push({ path: p, reason: 'no user-scope location defined for this file' });
      continue;
    }
    out.add(p.replace(rule.from, rule.to), content);
  }
  return { fileSet: out, baseDir: home, skipped, scope };
}

/**
 * Best-effort detection of which target tools are present on this machine,
 * so `install` can tell the user where their fleet will actually be used.
 * Purely informational — never blocks an install.
 */
export function detectTools(home = os.homedir()) {
  const onPath = (bin) => {
    try {
      const probe = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
      execSync(probe, { stdio: 'ignore', shell: true });
      return true;
    } catch {
      return false;
    }
  };
  return {
    'claude-code': existsSync(path.join(home, '.claude')) || onPath('claude'),
    opencode: existsSync(path.join(home, '.config', 'opencode')) || onPath('opencode'),
    goose: existsSync(path.join(home, '.config', 'goose')) || onPath('goose'),
  };
}
