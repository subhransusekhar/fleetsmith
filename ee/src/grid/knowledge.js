// SPDX-License-Identifier: AGPL-3.0-only
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { queryOrgDocuments } from '../memory/relatadb.js';

/**
 * Temporal knowledge queries (G6.5): `fleetsmith grid knowledge <query> [--as-of <date>]
 * [--as-recorded <date>] [--purpose <p>] [--limit n]` — "what did we know before the March decision," the
 * bi-temporal payoff wrapped in one command.
 *
 * --- Why this filters client-side, never with an engine `AS OF` clause ------------------------------------
 *
 * G3.3 already verified, the hard way, that `AS OF` fails EXACTLY like a `WHERE` clause for every ad-hoc
 * `/ingest`-registered type on this engine deployment: `SELECT * FROM T AS OF <ts>` returns zero rows, the
 * same failure mode `pull.js`'s own module doc comment documents for `WHERE` (even a trivially-true
 * `WHERE 1=1` empties the result). `OrgDocument` (G6.1) is exactly such an ad-hoc ingested type — there is no
 * reason to expect `AS OF` behaves differently for it, and no live credential was available this session to
 * re-confirm that pessimistic expectation either way. Rather than build a feature on a mechanism this
 * project's own prior work already found broken for this exact class of type, this module does the honest
 * thing: a bare `HYBRID_SEARCH` (via G6.3's `queryOrgDocuments`, reused directly rather than re-implemented),
 * then filters the RAW rows in JS against two plain data fields —
 *
 *  - `valid_from` (G6.1): the document's own business date. `--as-of <date>` keeps rows whose business
 *    validity is on or before `<date>` — "what did we know, going by the document's own date."
 *  - `imported_at` (G6.5, additive on `OrgDocument`): a client-stamped wall-clock timestamp set the moment
 *    `applyImport()` actually calls `/ingest` (`ee/src/grid/import.js`). This exists BECAUSE the engine's own
 *    system-time versioning is — per the SAME G3.3 finding — not reliably queryable either (`_system_from` is
 *    a recognized column name whose value is never populated for these types). `--as-recorded <date>` keeps
 *    rows actually pushed to the cortex on or before `<date>` — the audit question "what had been imported by
 *    then," regardless of what business date the document itself claims.
 *
 * These two dates can genuinely differ (a document backdated via `--date` at import time, or an old document
 * imported late) — that difference is the entire point of having both, not an edge case to collapse away.
 *
 * --- Degraded mode (rule 3: nothing is ee-only) -------------------------------------------------------------
 *
 * With no cortex configured at all, `queryKnowledgeDegraded` reads `_fleet/shared/knowledge/*.md` directly —
 * the same committed, PR-reviewed files `src/memory/file.js`'s own org-knowledge recall (G6.4, core) already
 * scans — and filters by frontmatter `date` client-side, labeling the result as degraded. Coarser than the
 * live path (one whole file per candidate, not per heading-chunk — a deliberate simplification, the same
 * "still useful, not identical" trade-off every other degraded grid answer makes, not a broken one).
 * `--as-recorded` has no local equivalent at all — there is no client-stamped import-time record for a
 * hand-authored or PR'd file — and is simply not applied in degraded mode, rather than pretending to filter
 * by data that does not exist locally.
 */

export const DEFAULT_PURPOSE = 'product_context';
export const AS_OF_DEFAULT_PURPOSE = 'decision_rationale';
const DEFAULT_LIMIT = 10;

function overfetchLimit(limit) {
  return Math.min(Math.max(limit * 5, 25), 100);
}

function firstLineExcerpt(text) {
  const line = String(text ?? '')
    .split('\n')
    .find((l) => l.trim());
  return (line ?? '').trim().slice(0, 100);
}

/** `"<source> (<kind>[, <client>], <date>)"` — identical shape to G6.3's/G6.4's own provenance strings, so a skill's citation instructions read the same regardless of which path (live, or either degraded mode) answered. */
function provenance(kind, client, date, sourceLabel) {
  const parts = [kind ?? 'unknown'];
  if (client) parts.push(client);
  parts.push(date ?? 'unknown-date');
  return `${sourceLabel} (${parts.join(', ')})`;
}

/** `true` when there is no cutoff at all, or `value` is present and on-or-before it — lexicographic comparison, valid for `YYYY-MM-DD` and full ISO timestamps alike. */
function onOrBefore(value, cutoff) {
  return !cutoff || (Boolean(value) && value <= cutoff);
}

// --- live (cortex-backed) path ---------------------------------------------------------

function normalizeLiveRow(row) {
  return {
    score: typeof row.score === 'number' ? row.score : 0,
    kind: row.kind,
    client: row.client || '',
    valid_from: row.valid_from,
    imported_at: row.imported_at,
    provenance: provenance(row.kind, row.client, row.valid_from, row.source_file),
    excerpt: firstLineExcerpt(row.chunk_text),
  };
}

/** Queries the live cortex — see the module doc comment for exactly why this is client-side filtering over a bare `HYBRID_SEARCH`, never an engine `AS OF` clause. */
export async function queryKnowledgeLive(config, query, opts = {}) {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const purpose = opts.purpose ?? (opts.asOf || opts.asRecorded ? AS_OF_DEFAULT_PURPOSE : DEFAULT_PURPOSE);
  const rawRows = await queryOrgDocuments(config, query, overfetchLimit(limit), purpose);

  const rows = rawRows
    .map(normalizeLiveRow)
    .filter((r) => onOrBefore(r.valid_from, opts.asOf))
    .filter((r) => onOrBefore(r.imported_at?.slice(0, 10), opts.asRecorded))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return { rows, purpose, degraded: false };
}

// --- degraded (file-backend) path -------------------------------------------------------

function tokens(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2)
  );
}

function overlapScore(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / a.size;
}

/** `---\n<yaml>\n---\n<body>` — a malformed or missing frontmatter block degrades to an empty frontmatter object and the whole file as body, never a throw, matching `src/memory/file.js`'s own G6.4 convention (independently reimplemented here, not imported — this is `ee/`, core's `file.js` internals are not part of its public API). */
function parseKnowledgeFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };
  let frontmatter;
  try {
    frontmatter = YAML.parse(m[1]);
  } catch {
    frontmatter = null;
  }
  return { frontmatter: frontmatter && typeof frontmatter === 'object' ? frontmatter : {}, body: m[2] };
}

/** No cortex configured at all: reads `_fleet/shared/knowledge/*.md` directly and scores/filters client-side. See the module doc comment for why `--as-recorded` has no effect here. */
export function queryKnowledgeDegraded(repoDir, query, opts = {}) {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const dir = path.join(repoDir, opts.sharedDir ?? '_fleet/shared', 'knowledge');
  const q = tokens(query);
  const rows = [];

  if (fs.existsSync(dir)) {
    for (const filename of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const raw = fs.readFileSync(path.join(dir, filename), 'utf8');
      const { frontmatter, body } = parseKnowledgeFrontmatter(raw);
      const score = overlapScore(q, tokens(body));
      if (score === 0 && q.size > 0) continue; // a zero-overlap file is not a weak match, it is not a match
      if (!onOrBefore(frontmatter.date, opts.asOf)) continue;

      rows.push({
        score,
        kind: frontmatter.kind ?? 'unknown',
        client: frontmatter.client || '',
        valid_from: frontmatter.date,
        provenance: provenance(frontmatter.kind, frontmatter.client, frontmatter.date, frontmatter.source || filename),
        excerpt: firstLineExcerpt(body),
      });
    }
  }

  rows.sort((a, b) => b.score - a.score);
  return { rows: rows.slice(0, limit), purpose: opts.purpose ?? DEFAULT_PURPOSE, degraded: true };
}

// --- rendering ---------------------------------------------------------------------------

function bannerFor(result) {
  return result.degraded ? 'degraded (file-backend) mode — filtered _fleet/shared/knowledge/ frontmatter directly, no cortex configured' : null;
}

/** Pure: `result` (from either query path above) plus the original `opts` -> a markdown table (score, kind, client, date, provenance, first-line excerpt), with a banner line for degraded mode and a metadata line naming the purpose and any active temporal filter. */
export function renderKnowledgeTable(result, opts = {}) {
  const banner = bannerFor(result);
  const lines = ['# Knowledge', ''];
  if (banner) lines.push(`> ${banner}`, '');

  const meta = [`purpose: ${result.purpose}`, opts.asOf ? `as-of: ${opts.asOf}` : null, opts.asRecorded ? `as-recorded: ${opts.asRecorded}` : null].filter(Boolean).join(' · ');
  lines.push(`_${meta}_`, '');

  if (result.rows.length === 0) {
    lines.push('no knowledge found matching this query.', '');
    return lines.join('\n');
  }

  lines.push(
    '| Score | Kind | Client | Date | Provenance | Excerpt |',
    '|-------|------|--------|------|------------|---------|',
    ...result.rows.map((r) => `| ${r.score.toFixed(2)} | ${r.kind} | ${r.client || '-'} | ${r.valid_from || '-'} | ${r.provenance} | ${r.excerpt} |`),
    ''
  );
  return lines.join('\n');
}
