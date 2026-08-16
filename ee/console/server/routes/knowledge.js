// SPDX-License-Identifier: AGPL-3.0-only
import { queryKnowledgeLive } from '../../../src/grid/knowledge.js';
import { recall, queryAllOrgDocuments } from '../../../src/memory/relatadb.js';
import { proposeOrgDocument, approveOrgDocument, publishOrgDocument, rejectOrgDocument } from '../../../src/grid/approval.js';
import { diffLines } from '../diff.js';

/**
 * G8.4's data source, split across two real, DIFFERENT engine mechanisms — documented here rather than
 * papered over, since "Knowledge + Procedures" reads as one screen but is not one underlying capability:
 *
 *  - **Knowledge** = `OrgDocument` rows (G6.1) — a real, first-class, fleetsmith-owned ontology type with real
 *    fields (`kind`, `title`, `valid_from`, and — G7.3 — a real `approval` lifecycle, extended G8.4 with a
 *    `reject` transition). `queryKnowledgeLive` (G6.5) is the same live-search path `fleetsmith grid
 *    knowledge` already uses; `getKnowledgeDocuments` (below) is a NEW browse-everything view this screen
 *    needs that neither the CLI nor G6.5 required — a bare `queryAllOrgDocuments()` (no `WHERE`, the same
 *    verified-necessary shape every ad-hoc-type reader in this package already uses), deduped to the latest
 *    version per `content_hash`.
 *  - **Procedures** = `lesson`-kind `MemoryItem`s (fleetsmith's ACE playbook bullets, recalled via the
 *    ordinary memory port). `ee/src/grid/approval.js`'s own doc comment already establishes, as a verified
 *    engine constraint and not a shortcut: **there is no distinct "ProcedureMemory" type** — a "procedural"
 *    memory is an ordinary `remember()`/`recall()` call whose only real engine field is an opaque `content`
 *    string, so it CANNOT carry the first-class `approval`/`approved_by` fields the state machine needs, nor
 *    a queryable `supersedes` chain (the milestone's own task text names one; it does not exist as a
 *    field on this type). RelataDB's real `consolidate` MCP tool is schema-documented to supersede one item by
 *    id (`{superseded, new_id}`, per `relatadb.js`'s own doc comment) — but that shape was read off `GET
 *    /mcp/tools`, never independently round-tripped against a live instance in this project, and this task has
 *    no live credentials to change that. Building a "deprecate" mutation on a call this project has never
 *    actually exercised is exactly the kind of guess this codebase's own standing rule forbids ("refusing to
 *    build on primitives that aren't real" — `identity.js`'s doc comment). So `/api/procedures` stays
 *    read-only, same as G8.1 shipped it; none of this task's own three acceptance criteria are about
 *    procedures at all — they are all about the knowledge approval round-trip.
 */

const PROCEDURE_PURPOSE = 'cross_dev_reuse';

export async function getKnowledge(ctx, consoleConfig) {
  const config = { url: consoleConfig.url, token: ctx.token, purposes: ctx.query.purpose ? [ctx.query.purpose] : undefined };
  const result = await queryKnowledgeLive(config, ctx.query.q ?? '', {
    limit: ctx.query.limit ? Number.parseInt(ctx.query.limit, 10) : undefined,
    asOf: ctx.query.asOf,
    asRecorded: ctx.query.asRecorded,
    purpose: ctx.query.purpose,
  });
  return { status: 200, body: result };
}

/** Last write wins by `content_hash` — the same resolution `approval.js`'s `fetchLatestOrgDocument` and every other ad-hoc-type reader in this package already applies, relying on `reconcile()`'s own verified stable insertion order. */
function latestVersionsByHash(rows) {
  const byHash = new Map();
  for (const row of rows) byHash.set(row.content_hash, row);
  return [...byHash.values()];
}

/**
 * The knowledge screen's browse view: every document's latest version, plus a metrics strip (total, and a
 * count per approval state) so "how much is still in draft/proposed" is a glance, not a manual count. Grouping
 * by source/kind/client is left to the web page (an array of plain rows sorts/groups client-side just fine) —
 * the BFF stays thin, same principle the audit screen's CSV export (G8.3) already established.
 */
export async function getKnowledgeDocuments(ctx, consoleConfig) {
  const config = { url: consoleConfig.url, token: ctx.token };
  const documents = latestVersionsByHash(await queryAllOrgDocuments(config));
  const byState = { draft: 0, proposed: 0, approved: 0, published: 0 };
  for (const d of documents) byState[d.approval || 'draft']++;
  return { status: 200, body: { documents, metrics: { total: documents.length, byState } } };
}

export async function getProcedures(ctx, consoleConfig) {
  const config = { url: consoleConfig.url, token: ctx.token };
  const items = await recall(config, ctx.query.q ?? '', {
    kind: 'lesson',
    purpose: ctx.query.purpose ?? PROCEDURE_PURPOSE,
    limit: ctx.query.limit ? Number.parseInt(ctx.query.limit, 10) : undefined,
  });
  return { status: 200, body: { items, note: 'read-only — no approval lifecycle exists for procedural memory on this engine (see the module doc comment)' } };
}

/** Shared by all three transition routes: refuses to attribute a mutation to nobody. Stricter than the CLI's advisory push-identity check, deliberately — see `auth.js`'s own doc comment for why an admin-console-adjacent mutation fails closed instead of proceeding unverified. */
function requirePrincipal(ctx) {
  if (!ctx.principal) {
    const err = new Error('cannot attribute this transition without a discoverable principal for your token — this deployment\'s auth mode does not report one (the common bearer-mode case); knowledge-approval mutations require an auth mode where GET /tokens/self resolves a real principal.');
    err.status = 403;
    throw err;
  }
}

export async function postPropose(ctx, consoleConfig) {
  requirePrincipal(ctx);
  const config = { url: consoleConfig.url, token: ctx.token };
  return { status: 200, body: await proposeOrgDocument(config, ctx.params.contentHash, ctx.principal) };
}

/**
 * `role: 'admin'` in the route table already gates this on `CONSOLE_ADMINS`; `approveOrgDocument` itself ALSO
 * checks `config.approvers` — kept as genuine defense in depth, not redundant duplication, since the two lists
 * are configured independently (`CONSOLE_ADMINS` vs `grid.approvers`/`GRID_APPROVERS`) and a deployment may
 * reasonably set them differently.
 *
 * G8.4's "diff-on-promotion": BEFORE approving, find the currently-*published* version sharing the same
 * `title` AND `chunk_index` (a title can span several chunks; comparing chunk N against chunk N, not the
 * whole document as one blob, is what makes the diff mean anything for a multi-chunk document) — approving
 * supersedes that CONTENT, so the diff answers "what will change once this goes live," not "what changed
 * since some arbitrary earlier draft." `diff: null` means either this is the first version ever (nothing
 * published to compare against) or its title+chunk_index has never been published before.
 */
export async function postApprove(ctx, consoleConfig) {
  requirePrincipal(ctx);
  const config = { url: consoleConfig.url, token: ctx.token, approvers: consoleConfig.admins };

  // Fetched BEFORE approving, once — the same query answers both "does this content_hash exist" (target) and
  // "what's currently published in this title+chunk_index slot," so approveOrgDocument's own re-ingest below
  // never needs a second round trip to compute the diff.
  const before = latestVersionsByHash(await queryAllOrgDocuments(config));
  const target = before.find((d) => d.content_hash === ctx.params.contentHash);
  const updated = await approveOrgDocument(config, ctx.params.contentHash, ctx.principal);

  let diff = null;
  if (target) {
    const publishedSameSlot = before.find((d) => d.title === target.title && d.chunk_index === target.chunk_index && d.approval === 'published' && d.content_hash !== target.content_hash);
    if (publishedSameSlot) diff = diffLines(publishedSameSlot.chunk_text, target.chunk_text);
  }
  return { status: 200, body: { ...updated, diff } };
}

export async function postPublish(ctx, consoleConfig) {
  requirePrincipal(ctx);
  const config = { url: consoleConfig.url, token: ctx.token };
  return { status: 200, body: await publishOrgDocument(config, ctx.params.contentHash, ctx.principal) };
}

/** `role: 'admin'` (`CONSOLE_ADMINS`) at the route table, `assertApprover` (`config.approvers`) again inside `rejectOrgDocument` — same defense-in-depth as `postApprove`. The note is read from `ctx.body.note`; `rejectOrgDocument` itself refuses an empty one before any network call. */
export async function postReject(ctx, consoleConfig) {
  requirePrincipal(ctx);
  const config = { url: consoleConfig.url, token: ctx.token, approvers: consoleConfig.admins };
  return { status: 200, body: await rejectOrgDocument(config, ctx.params.contentHash, ctx.principal, ctx.body?.note) };
}
