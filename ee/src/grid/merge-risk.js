// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';

/**
 * Merge-risk detection (G5.2): a deeper, git-verified analysis on top of G5.1's declared-file intersection —
 * that engine only knows what a `FleetTask` row CLAIMS to touch; this one asks the merge machine itself what
 * would actually happen. Entirely read-only: `git merge-tree --write-tree` performs a real three-way merge
 * without touching the working tree or index (verified directly — `git status` stays clean across every call
 * this module makes), so this is safe to run against a developer's own live checkout at any time.
 *
 * `mergeRisks` never fetches — bringing a peer's branch ref up to date is the daemon's or CI's job (G3.5's
 * `pushOnce`/`pullOnce` already establish that fetch and this module are separate concerns; conflating them
 * here would make a pure analysis function depend on network access). A branch this module cannot resolve
 * LOCALLY degrades to G5.1-style file-set intersection, tagged so a reader knows the difference between "git
 * actually checked" and "these are just the paths both sides claim to be touching."
 *
 * --- Real merge-tree output, verified against git 2.50.1 (2026-08-16), not assumed from the man page alone ---
 *
 *  - `git merge-tree --write-tree --messages <branchA> <branchB>` exits 1 on conflict, 0 when clean.
 *  - Clean: stdout is just the resulting tree OID.
 *  - Conflicted: tree OID, then zero or more `<mode> <oid> <stage> <path>` conflicted-file-info lines
 *    (stage 1 = merge-base, 2 = branchA's side, 3 = branchB's side — a delete/modify conflict has only two
 *    such lines, since the deleting side contributes no stage), then a blank line, then human-readable
 *    messages: `CONFLICT (content): Merge conflict in <path>` for genuine same-line collisions, and
 *    `CONFLICT (modify/delete): <path> deleted in <sha> and modified in <sha>. …` for a delete-vs-modify pair
 *    — confirmed these are literally the two distinct message shapes this engine emits, not an inference.
 *  - `--merge-base <tree-ish>` overrides the auto-detected common ancestor — this is `stagingBase` below.
 *  - A file BOTH sides touched but which merges cleanly (no CONFLICT line at all) never appears in the
 *    conflicted-file-info section — proximity between two non-overlapping edits has to be measured
 *    separately, from each side's own diff against the merge base.
 *  - `git diff -U0 <base> <branch> -- <path>` reports hunk headers (`@@ -a[,b] +c[,d] @@`) with NO context
 *    padding, giving the exact changed-line range each side touched — the default 3-line context would
 *    otherwise make two edits several lines apart look like they overlap, which was confirmed directly
 *    (two edits 3 lines apart showed overlapping default-context hunk ranges but non-overlapping `-U0` ones).
 */

const ADJACENT_LINE_THRESHOLD = 5;

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function branchResolves(repoDir, branch) {
  try {
    runGit(['rev-parse', '--verify', '--quiet', `${branch}^{commit}`], repoDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * The modern `--write-tree` form was introduced in git 2.38 (Oct 2022); this module targets it exclusively —
 * verified directly against git 2.50.1 in this session, not against an actual pre-2.38 binary (none was
 * available to test with), so a genuine fallback parser for the deprecated 3-arg form is not implemented
 * here: this project's own standard is verified behavior, not an assumed format for output nothing has
 * actually checked. `resolveMergeTreeSupport` detects which is available so `mergeRisks` can degrade the
 * WHOLE batch to the G5.1-style file-intersection fallback with a clear warning on a too-old git, rather
 * than risk a silently-wrong parse of a format never seen.
 *
 * Detection is real, not a version-string comparison (fragile across distro-patched git builds): running
 * `git merge-tree --write-tree` with no branch arguments always exits non-zero with a usage message, and
 * that usage text itself is a static string baked into the binary — mentioning `--write-tree` only on a git
 * that actually recognizes it. Confirmed directly: even a genuinely-unknown, made-up flag on THIS git
 * version prints the identical usage block (still mentioning `--write-tree`, since the flag IS real here),
 * so checking the output text is a valid, version-independent signal — not merely "did the command throw".
 */
export function resolveMergeTreeSupport(repoDir) {
  try {
    runGit(['merge-tree', '--write-tree'], repoDir);
    return true; // unreachable in practice — missing args always error — kept for completeness
  } catch (e) {
    const text = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    return /--write-tree/.test(text);
  }
}

function parseHunkRanges(diffOutput) {
  const ranges = [];
  for (const line of diffOutput.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] !== undefined ? Number(m[2]) : 1;
    ranges.push(count === 0 ? [start, start] : [start, start + count - 1]);
  }
  return ranges;
}

function hunkGap(rangeA, rangeB) {
  if (rangeA[1] < rangeB[0]) return rangeB[0] - rangeA[1];
  if (rangeB[1] < rangeA[0]) return rangeA[0] - rangeB[1];
  return 0; // overlapping — merge-tree would have already flagged this as a conflict, not "adjacent"
}

function changedFiles(repoDir, base, branch) {
  try {
    return new Set(
      runGit(['diff', '--name-only', base, branch], repoDir)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

function hunksForFile(repoDir, base, branch, file) {
  try {
    return parseHunkRanges(runGit(['diff', '-U0', base, branch, '--', file], repoDir));
  } catch {
    return [];
  }
}

/** Every file both branches touch relative to `base` that merge-tree merged cleanly (no CONFLICT for it) but whose closest hunk pair is within `ADJACENT_LINE_THRESHOLD` lines. */
function findAdjacentFiles(repoDir, base, branchA, branchB, conflictedFiles) {
  const commonFiles = [...changedFiles(repoDir, base, branchA)].filter((f) => changedFiles(repoDir, base, branchB).has(f) && !conflictedFiles.has(f));
  const adjacent = [];
  for (const file of commonFiles) {
    const hunksA = hunksForFile(repoDir, base, branchA, file);
    const hunksB = hunksForFile(repoDir, base, branchB, file);
    let closest = Infinity;
    for (const ra of hunksA) {
      for (const rb of hunksB) {
        closest = Math.min(closest, hunkGap(ra, rb));
      }
    }
    if (closest <= ADJACENT_LINE_THRESHOLD) adjacent.push(file);
  }
  return adjacent.sort();
}

const CONFLICT_MESSAGE_KIND = [
  { pattern: /^CONFLICT \(modify\/delete\)/, kind: 'delete-modify' },
  { pattern: /^CONFLICT \(delete\/modify\)/, kind: 'delete-modify' },
  { pattern: /^CONFLICT \(content\)/, kind: 'same-file' },
];

/** Classifies every `CONFLICT (...)` message line by the two kinds this module distinguishes; anything git reports beyond those (add/add, a rename conflict, etc.) is bucketed as `same-file` — still a real collision needing a human, just not one of the two specifically-named shapes. */
function classifyConflictMessage(line) {
  for (const { pattern, kind } of CONFLICT_MESSAGE_KIND) {
    if (pattern.test(line)) return kind;
  }
  return 'same-file';
}

/** Runs the real merge-tree analysis for one already-resolved branch pair. Never throws: a git failure mid-analysis degrades to no risks found for this pair, with a warning, since a false "no risk" is safer to surface loudly (via the warning) than to let one git hiccup crash the whole batch. */
function analyzeBranchPair(repoDir, branchA, branchB, stagingBase, warnings) {
  const args = ['merge-tree', '--write-tree', '--messages'];
  if (stagingBase) args.push('--merge-base', stagingBase);
  args.push(branchA, branchB);

  let output;
  try {
    output = runGit(args, repoDir);
  } catch (e) {
    // A non-zero exit here is the NORMAL "conflict found" case (exit 1) — execFileSync still throws for any
    // non-zero exit, so the real output lives on the error object, not just the success path.
    output = e.stdout ?? '';
    if (!output) {
      warnings.push(`merge-tree failed for ${branchA}...${branchB}: ${e.message.split('\n')[0]}`);
      return { conflictedFiles: new Map(), base: stagingBase ?? null };
    }
  }

  const lines = output.split('\n');
  const conflictedFiles = new Map(); // path -> kind
  let inMessages = false;
  for (const line of lines.slice(1)) {
    if (line === '') {
      inMessages = true;
      continue;
    }
    if (!inMessages) {
      const m = /^\d+ \S+ \d+\t(.+)$/.exec(line);
      if (m) conflictedFiles.set(m[1], conflictedFiles.get(m[1]) ?? null);
      continue;
    }
    if (line.startsWith('CONFLICT')) {
      const fileMatch = /(?:in|:)\s+([^\s.]+\.\S+|\S+)(?:\s+deleted)?/.exec(line);
      const kind = classifyConflictMessage(line);
      // Prefer the conflicted-file-info path list (authoritative) — this only fills in a kind for a path
      // we do not already know, or updates the still-null placeholder above.
      for (const path of conflictedFiles.keys()) {
        if (line.includes(path)) conflictedFiles.set(path, kind);
      }
      void fileMatch;
    }
  }

  let base = stagingBase ?? null;
  if (!base) {
    try {
      base = runGit(['merge-base', branchA, branchB], repoDir).trim();
    } catch {
      base = null;
    }
  }

  return { conflictedFiles, base };
}

/** Set intersection of two arrays, order of `a` preserved, deduped and later sorted by the caller. */
function intersect(a, b) {
  const setB = new Set(b);
  return [...new Set(a.filter((x) => setB.has(x)))];
}

function riskSortKey(risk) {
  return `${risk.kind}|${risk.actors.join(',')}|${risk.branches.join(',')}|${risk.files.join(',')}`;
}

const RISK_KIND_RANK = { 'delete-modify': 0, 'same-file': 1, adjacent: 2, unverified: 3 };

/**
 * `tasks`: active `FleetTask` rows (each carrying `actor`, `branch`, `files_declared`). `repoDir`: a local
 * checkout `git` commands run against. `stagingBase` (optional): a ref/tree-ish overriding the auto-detected
 * merge-base — omit to let git compute it per pair.
 *
 * One risk-detection pass per distinct (actor, branch) pair drawn from different actors; same-actor pairs are
 * excluded (a developer is never at merge risk with themselves). A branch either side names but this
 * checkout cannot resolve locally degrades that pair to a G5.1-style declared-file intersection, tagged
 * `unverified — peer branch not fetched` rather than silently skipped or falsely treated as risk-free.
 */
export function mergeRisks(tasks, repoDir, stagingBase = null) {
  const active = tasks.filter((t) => t.status === 'in-progress' && t.branch);
  const byActorBranch = new Map();
  for (const t of active) {
    byActorBranch.set(`${t.actor} ${t.branch}`, t);
  }
  const candidates = [...byActorBranch.values()];

  const risks = [];
  const warnings = [];

  const mergeTreeSupported = resolveMergeTreeSupport(repoDir);
  if (!mergeTreeSupported) {
    warnings.push('git is too old for `merge-tree --write-tree` (needs 2.38+) — every pair below degrades to declared-file intersection only, unverified against a real merge');
  }

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      if (a.actor === b.actor) continue;

      const actors = [a.actor, b.actor].sort();
      const branches = [a.branch, b.branch].sort();

      const aResolves = branchResolves(repoDir, a.branch);
      const bResolves = branchResolves(repoDir, b.branch);

      if (!mergeTreeSupported || !aResolves || !bResolves) {
        const files = intersect(a.files_declared ?? [], b.files_declared ?? []).sort();
        if (files.length > 0) {
          risks.push({
            kind: 'unverified',
            actors,
            branches,
            files,
            detail: !mergeTreeSupported
              ? 'unverified — git too old for merge-tree; falling back to declared-file intersection'
              : 'unverified — peer branch not fetched; falling back to declared-file intersection',
          });
        }
        continue;
      }

      const { conflictedFiles, base } = analyzeBranchPair(repoDir, a.branch, b.branch, stagingBase, warnings);

      const byKind = new Map();
      for (const [file, kind] of conflictedFiles) {
        const resolvedKind = kind ?? 'same-file';
        if (!byKind.has(resolvedKind)) byKind.set(resolvedKind, []);
        byKind.get(resolvedKind).push(file);
      }
      for (const [kind, files] of byKind) {
        risks.push({ kind, actors, branches, files: files.sort(), detail: `git merge-tree reports a ${kind} conflict` });
      }

      if (base) {
        const conflictedSet = new Set(conflictedFiles.keys());
        const adjacentFiles = findAdjacentFiles(repoDir, base, a.branch, b.branch, conflictedSet);
        if (adjacentFiles.length > 0) {
          risks.push({
            kind: 'adjacent',
            actors,
            branches,
            files: adjacentFiles,
            detail: `edits within ${ADJACENT_LINE_THRESHOLD} lines of each other but not conflicting`,
          });
        }
      }
    }
  }

  risks.sort((x, y) => {
    const rankDiff = (RISK_KIND_RANK[x.kind] ?? 99) - (RISK_KIND_RANK[y.kind] ?? 99);
    if (rankDiff !== 0) return rankDiff;
    if (x.files.length !== y.files.length) return y.files.length - x.files.length;
    return riskSortKey(x).localeCompare(riskSortKey(y));
  });

  return { risks, warnings };
}
