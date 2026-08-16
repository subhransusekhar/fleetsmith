// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The overlap/merge-risk renderer (G5.3): turns G5.1's `findOverlaps()` output and G5.2's `mergeRisks()`
 * output into `_fleet/local/grid/OVERLAPS.md` — the one place these findings land where agents and humans
 * already look, refreshed after every reconcile (`ee/src/grid/daemon.js`'s `syncOnce`) and on demand
 * (`fleetsmith grid overlaps`).
 *
 * Pure and I/O-free, like `materialize.js`'s renderers (G3.4): `renderOverlaps(overlaps, risks, opts)` takes
 * already-computed arrays and a caller-supplied `syncedAt`, never `Date.now()` itself, so a snapshot test gets
 * byte-identical output across runs. The absence of `OVERLAPS.md` on disk means "never computed" — a
 * genuinely empty result (both arrays empty) still gets a real file, an explicit "no overlaps detected as of
 * <time>" statement, so a reader can tell "checked, found nothing" from "grid overlaps has never run here".
 */

const OVERLAP_RESPONSE = {
  artifact: 'coordinate on the shared artifact before either side finishes — whoever writes it second silently overwrites the first',
  'dependency-cycle': "break the cycle — restate one side's dependency; two tasks can't both wait on each other to finish",
  symbol: 'reuse the existing symbol instead of re-implementing it independently',
  file: 'coordinate before editing further — same file, different symbols is a likely merge collision',
};

const RISK_RESPONSE = {
  'delete-modify': "confirm with the deleting actor before merging — one side's work disappears silently otherwise",
  'same-file': 'resolve directly with the other actor before either branch merges — git will conflict here',
  adjacent: "review together before merging — close edits often hide a semantic conflict git can't detect",
  unverified: 'fetch the peer branch for a real verdict — this is only a declared-file guess, not a checked merge',
};

function overlapRow(o) {
  return `| ${o.kind} | ${o.severity} | ${o.actors.join(', ')} | ${o.tasks.join(', ')} | ${o.evidence.join(', ')} | ${OVERLAP_RESPONSE[o.kind] ?? '-'} |`;
}

function riskRow(r) {
  return `| ${r.kind} | ${r.actors.join(', ')} | ${r.branches.join(', ')} | ${r.files.join(', ')} | ${RISK_RESPONSE[r.kind] ?? '-'} |`;
}

/**
 * `overlaps`: G5.1's `findOverlaps()` output, already severity-ranked. `risks`: G5.2's `mergeRisks()` output's
 * `.risks` array, already severity-ranked. `opts.syncedAt`: an ISO timestamp supplied by the caller (defaults
 * to `new Date().toISOString()` only as a last resort — every real call site passes one explicitly).
 * `opts.warnings`: merge-risk warnings (e.g. an unresolvable branch, a too-old git) worth surfacing in the
 * file itself, not just the CLI's stderr.
 */
export function renderOverlaps(overlaps, risks, opts = {}) {
  const syncedAt = opts.syncedAt ?? new Date().toISOString();

  if (overlaps.length === 0 && risks.length === 0) {
    return `# Overlaps\n\nno overlaps detected as of ${syncedAt}\n`;
  }

  const lines = ['# Overlaps', '', `_Computed: ${syncedAt}_`, '', '## Declared overlaps', ''];

  if (overlaps.length === 0) {
    lines.push('(none)', '');
  } else {
    lines.push(
      '| Kind | Severity | Actors | Tasks | Evidence | Suggested response |',
      '|------|----------|--------|-------|----------|---------------------|',
      ...overlaps.map(overlapRow),
      ''
    );
  }

  lines.push('## Merge risks', '');
  if (risks.length === 0) {
    lines.push('(none)', '');
  } else {
    lines.push(
      '| Kind | Actors | Branches | Files | Suggested response |',
      '|------|--------|----------|-------|---------------------|',
      ...risks.map(riskRow),
      ''
    );
  }

  if (opts.warnings?.length) {
    lines.push('## Warnings', '', ...opts.warnings.map((w) => `- ${w}`), '');
  }

  return lines.join('\n');
}
