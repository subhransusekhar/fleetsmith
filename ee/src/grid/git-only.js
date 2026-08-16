// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';

/**
 * Git-only degraded mode (G5.5): the OSS answer for overlap detection when there is no cortex at all — rule
 * 3 of this milestone ("nothing is ee-only") applied to G5.1's overlap engine specifically. `tasksFromGitOnly`
 * is an input ADAPTER, not a fork of the engine: it synthesizes minimal `FleetTask`-like rows straight from
 * local git state and hands them to the SAME `findOverlaps()` (G5.1) every grid-backed path already uses —
 * the engine cannot tell the difference between a row that came from RelataDB and one built here, and must
 * not need to.
 *
 * Lives in its own file, not `overlaps.js`: that module is deliberately dependency-free of `node:child_process`
 * (its own purity test asserts this — G5.1's doc comment calls out staying reusable outside the grid
 * entirely), so a git-shelling adapter belongs beside it, the same split `merge-risk.js` (G5.2) already
 * established for the same reason.
 *
 * Only `files_declared` is ever populated here — `artifact`, `symbols_declared`, and `depends_on` all stay
 * empty, since none of that is derivable from git alone. `findOverlaps()` therefore only ever produces
 * `file`-kind hits from this input; `artifact`, `symbol`, and `dependency-cycle` sections are correctly and
 * structurally absent, not merely empty by chance.
 *
 * Zero network access by construction: every git call below is a local `diff`/`for-each-ref` against refs
 * that must already exist in this checkout (a branch this module cannot resolve is simply skipped, with a
 * warning) — this module never fetches, pulls, or clones anything.
 */

const TRUNK_NAMES = new Set(['main', 'master', 'develop', 'trunk', 'staging', 'HEAD']);
const NON_ACTOR_TOKENS = new Set([
  'feat', 'feature', 'fix', 'bugfix', 'hotfix', 'chore', 'refactor', 'test', 'tests', 'docs', 'release', 'wip', 'build', 'ci', 'perf', 'style',
  ...TRUNK_NAMES,
]);

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * A best-effort branch-name heuristic, not an identity lookup: drops one leading conventional-prefix segment
 * (`feat/alice-x` -> `alice-x`), then takes the leading alphabetic run of what remains. Falls back to
 * `unknown:<branch>` (never a bare, shared `"unknown"`) when nothing usable survives — `findOverlaps()`
 * excludes same-actor pairs, so two different unresolved branches sharing one literal actor name would
 * silently suppress a real overlap between them instead of surfacing it; keeping the fallback unique per
 * branch avoids that.
 */
export function actorFromBranch(branch) {
  const segments = String(branch).split('/').filter(Boolean);
  const rest = segments.length > 1 && NON_ACTOR_TOKENS.has(segments[0].toLowerCase()) ? segments.slice(1) : segments;
  const candidate = rest[0] ?? '';
  const name = /^[A-Za-z][A-Za-z0-9]*/.exec(candidate)?.[0]?.toLowerCase();
  if (name && name.length >= 2 && !NON_ACTOR_TOKENS.has(name)) return name;
  return `unknown:${branch}`;
}

/**
 * `branches`: local refs (branch names or `remote/branch` remote-tracking refs) already known to this
 * checkout — this function never fetches them itself, so a caller wanting a peer's branch visible here must
 * have already fetched it by some other means. `baseRef`: the shared reference point every branch is diffed
 * against (defaults to `origin/main`, matching `declared.js`'s own convention). One synthetic
 * `FleetTask`-like row per branch that touches at least one file relative to `baseRef`; a branch this
 * checkout cannot resolve, or whose diff fails for any reason, is skipped with a warning, never thrown — the
 * same never-block-the-caller contract every other grid adapter in this package holds to.
 */
export function tasksFromGitOnly(repoDir, branches, baseRef = 'origin/main') {
  const warnings = [];
  const tasks = [];

  for (const branch of branches) {
    let files;
    try {
      files = runGit(['diff', '--name-only', baseRef, branch], repoDir)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .sort();
    } catch (e) {
      warnings.push(`git diff --name-only ${baseRef} ${branch} failed: ${e.message.split('\n')[0]}`);
      continue;
    }
    if (files.length === 0) continue; // nothing to report — not a warning, just an inactive branch

    tasks.push({
      actor: actorFromBranch(branch),
      task_seq: 1,
      task: `(git-only) ${branch}`,
      status: 'in-progress',
      depends_on: [],
      artifact: '',
      files_declared: files,
      symbols_declared: [],
      branch,
    });
  }

  return { tasks, warnings };
}

/**
 * Every local branch and remote-tracking branch this checkout already knows about, excluding `baseRef`, the
 * currently checked-out branch, common trunk names, and symbolic refs like `origin/HEAD` — the CLI's
 * zero-configuration default candidate list for `fleetsmith grid overlaps --git-only`. Never throws: a repo
 * with no refs at all (or `git` failing outright) just yields an empty candidate list.
 */
export function listCandidateBranches(repoDir, { currentBranch, baseRef = 'origin/main' } = {}) {
  let raw;
  try {
    raw = runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], repoDir);
  } catch {
    return [];
  }
  const exclude = new Set([currentBranch, baseRef].filter(Boolean));
  return [...new Set(raw.split('\n').map((l) => l.trim()).filter(Boolean))]
    .filter((ref) => !exclude.has(ref))
    .filter((ref) => !ref.endsWith('/HEAD'))
    .filter((ref) => !TRUNK_NAMES.has(ref.split('/').pop()))
    .sort();
}
