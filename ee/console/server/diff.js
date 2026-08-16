// SPDX-License-Identifier: AGPL-3.0-only

/**
 * G8.4's "diff-on-promotion": a small, dependency-free line-based diff (classic LCS backtrace) — no diff
 * library added for this, matching the rest of this project's "keep deps ≈ 0" discipline. Good enough for
 * what this screen needs (a readable old-vs-new comparison of a document chunk before approving it), not a
 * general-purpose diff engine — knowledge chunks are short (`DEFAULT_MAX_CHUNK_CHARS` in `grid/import.js` caps
 * them at 2000 chars), so the O(n*m) LCS table this uses is never a real cost here.
 */

function lcsTable(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

/**
 * `oldText`/`newText` -> `{type: 'same'|'removed'|'added', line}[]`, in display order (removed lines from
 * `oldText` before the added lines that replace them, matching how a reader expects a diff to read). `null`
 * for either input means "no prior version" — the caller (`routes/knowledge.js`) renders that as "first
 * version, nothing to diff against" rather than treating an absent old version as an empty string (which
 * would render as "every line added", which is technically true but a worse answer to "what changed").
 */
function toLines(text) {
  // `''.split('\n')` is `['']` (one empty line), not `[]` — genuinely absent text (null/undefined) must
  // produce zero lines, not a spurious single empty one that would show up as a phantom added/removed line.
  return text === null || text === undefined ? [] : String(text).split('\n');
}

export function diffLines(oldText, newText) {
  const a = toLines(oldText);
  const b = toLines(newText);
  const table = lcsTable(a, b);

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', line: a[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: 'removed', line: a[i] });
      i++;
    } else {
      ops.push({ type: 'added', line: b[j] });
      j++;
    }
  }
  while (i < a.length) ops.push({ type: 'removed', line: a[i++] });
  while (j < b.length) ops.push({ type: 'added', line: b[j++] });
  return ops;
}
