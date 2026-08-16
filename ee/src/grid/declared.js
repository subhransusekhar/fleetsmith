// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Declared-work extraction (G2.3): best-effort "what is this developer's in-flight task touching," so a
 * peer's agent can notice overlap before either side commits. Advisory by construction — every failure mode
 * here (not a git repo, no such base ref, a binary or oversize file, a regex family this scanner does not
 * know) degrades to an empty result plus a warning, never a thrown error, because this runs unattended on
 * every grid push and must never be the thing that blocks one.
 *
 * Deliberately regex, not a real parser (tree-sitter or similar): this is a one-dependency project
 * (`yaml`, per the root package.json), and the milestone's own invariant is that overlap detection stays
 * advisory — a human always makes the actual call, G5's ranking never gates anything. A parser dependency
 * would buy precision this feature does not need in exchange for a real new dependency.
 */

const MAX_ENTRIES = 200;
const MAX_FILE_BYTES = 1024 * 1024; // 1 MB — skip larger files outright rather than regex-scan them

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * `git diff --name-only <baseRef>` (files changed versus the base) unioned with untracked files from
 * `git status --porcelain` (new files git diff against a ref would otherwise miss entirely) — capped at
 * `MAX_ENTRIES`, deduplicated, sorted for a deterministic result a caller can diff run-to-run.
 *
 * Any git failure (not a repo, no such `baseRef`, git not installed) yields `{ files: [], warnings: [...] }`,
 * never a throw — a developer with an unusual local state should still get a normal, if diminished, grid
 * push, not a blocked one.
 */
export function declaredFiles(repoDir, baseRef = 'origin/main') {
  const warnings = [];
  const files = new Set();

  try {
    const diffOutput = runGit(['diff', '--name-only', baseRef], repoDir);
    for (const line of diffOutput.split('\n')) {
      const file = line.trim();
      if (file) files.add(file);
    }
  } catch (e) {
    warnings.push(`git diff --name-only ${baseRef} failed: ${e.message.split('\n')[0]}`);
  }

  try {
    // `--untracked-files=all` (not the default `normal` mode): a wholly-new directory otherwise collapses to
    // one `?? dir/` line instead of listing the files inside it — exactly the common case (a new module
    // added under a new directory) this function exists to surface individually.
    const statusOutput = runGit(['status', '--porcelain', '--untracked-files=all'], repoDir);
    for (const line of statusOutput.split('\n')) {
      if (!line.startsWith('??')) continue;
      const file = line.slice(2).trim();
      if (file) files.add(file);
    }
  } catch (e) {
    warnings.push(`git status --porcelain failed: ${e.message.split('\n')[0]}`);
  }

  const sorted = [...files].sort();
  const truncated = sorted.slice(0, MAX_ENTRIES);
  if (sorted.length > MAX_ENTRIES) warnings.push(`declaredFiles: ${sorted.length} files found, truncated to ${MAX_ENTRIES}`);
  return { files: truncated, warnings };
}

/** One capture-group regex per definition site this scanner recognizes, grouped by the file extensions they apply to. */
const SYMBOL_PATTERNS = [
  { extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'], patterns: [
    /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g,
    /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /\bexport\s+(?:default\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
  ] },
  { extensions: ['.py'], patterns: [/\bdef\s+([A-Za-z_][A-Za-z0-9_]*)/g, /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/g] },
  { extensions: ['.go'], patterns: [/\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/g] },
  { extensions: ['.rs'], patterns: [/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g] },
];

function patternsFor(filePath) {
  const ext = path.extname(filePath);
  return SYMBOL_PATTERNS.find((p) => p.extensions.includes(ext))?.patterns;
}

/** A cheap, standard binary heuristic: a null byte anywhere in the first 8000 bytes — the same window `git diff`'s own binary detection samples. */
function looksBinary(buffer) {
  const window = buffer.subarray(0, 8000);
  return window.includes(0);
}

/**
 * Regex-scans `files` (paths relative to `repoDir`) for definition sites across four language families,
 * returning symbol names normalized for comparison (case-insensitive dedup) while preserving each symbol's
 * first-seen display casing. Skips any file over `MAX_FILE_BYTES`, any file that looks binary, any file that
 * no longer exists (deleted in the working tree since `declaredFiles` ran), and any extension none of the
 * four families claim — every skip is silent to the caller except via `warnings`, matching `declaredFiles`'s
 * "never throw" contract. Capped at `MAX_ENTRIES` across all files combined.
 */
export function declaredSymbols(files, repoDir) {
  const warnings = [];
  const seen = new Map(); // lowercase -> first-seen display casing, for a stable de-duplicated result

  for (const file of files) {
    if (seen.size >= MAX_ENTRIES) break;
    const patterns = patternsFor(file);
    if (!patterns) continue;

    const fullPath = path.join(repoDir, file);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue; // deleted or otherwise unreadable — not a failure worth a warning, just nothing to scan
    }
    if (stat.size > MAX_FILE_BYTES) {
      warnings.push(`declaredSymbols: skipped "${file}" — ${stat.size} bytes exceeds the ${MAX_FILE_BYTES}-byte cap`);
      continue;
    }

    let buffer;
    try {
      buffer = fs.readFileSync(fullPath);
    } catch (e) {
      warnings.push(`declaredSymbols: could not read "${file}": ${e.message}`);
      continue;
    }
    if (looksBinary(buffer)) {
      warnings.push(`declaredSymbols: skipped "${file}" — looks binary`);
      continue;
    }

    const content = buffer.toString('utf8');
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content))) {
        const name = match[1];
        const key = name.toLowerCase();
        if (!seen.has(key)) seen.set(key, name);
        if (seen.size >= MAX_ENTRIES) break;
      }
      if (seen.size >= MAX_ENTRIES) break;
    }
  }

  const symbols = [...seen.values()];
  if (symbols.length >= MAX_ENTRIES) warnings.push(`declaredSymbols: truncated to the ${MAX_ENTRIES}-symbol cap`);
  return { symbols, warnings };
}
