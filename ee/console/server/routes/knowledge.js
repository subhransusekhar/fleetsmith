// SPDX-License-Identifier: AGPL-3.0-only
import { queryKnowledgeLive } from '../../../src/grid/knowledge.js';
import { recall } from '../../../src/memory/relatadb.js';
import { proposeOrgDocument, approveOrgDocument, publishOrgDocument } from '../../../src/grid/approval.js';

/**
 * G8.4's data source, split across two real, DIFFERENT engine mechanisms — documented here rather than
 * papered over, since "Knowledge + Procedures" reads as one screen but is not one underlying capability:
 *
 *  - **Knowledge** = `OrgDocument` rows (G6.1) — a real, first-class, fleetsmith-owned ontology type with real
 *    fields (`kind`, `title`, `valid_from`, and — G7.3 — a real `approval` lifecycle). `queryKnowledgeLive`
 *    (G6.5) is the same live-search path `fleetsmith grid knowledge` already uses.
 *  - **Procedures** = `lesson`-kind `MemoryItem`s (fleetsmith's ACE playbook bullets, recalled via the
 *    ordinary memory port). `ee/src/grid/approval.js`'s own doc comment already establishes, as a verified
 *    engine constraint and not a shortcut: **there is no distinct "ProcedureMemory" type** — a "procedural"
 *    memory is an ordinary `remember()`/`recall()` call whose only real engine field is an opaque `content`
 *    string, so it CANNOT carry the first-class `approval`/`approved_by` fields the state machine needs. This
 *    route therefore exposes procedures read-only, with no propose/approve/publish counterpart — building one
 *    would mean faking approval state inside that opaque string, contradicting the "real fields, not a JSON
 *    blob" requirement this whole approval mechanism exists to satisfy. `recall()` also has no "list
 *    everything" mode (server-enforced non-empty query, verified in `relatadb.js`'s own `consolidate()` doc
 *    comment) — so, like knowledge, this is a search, not a browse.
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

/** `role: 'admin'` in the route table already gates this on `CONSOLE_ADMINS`; `approveOrgDocument` itself ALSO checks `config.approvers` — kept as genuine defense in depth, not redundant duplication, since the two lists are configured independently (`CONSOLE_ADMINS` vs `grid.approvers`/`GRID_APPROVERS`) and a deployment may reasonably set them differently. */
export async function postApprove(ctx, consoleConfig) {
  requirePrincipal(ctx);
  const config = { url: consoleConfig.url, token: ctx.token, approvers: consoleConfig.admins };
  return { status: 200, body: await approveOrgDocument(config, ctx.params.contentHash, ctx.principal) };
}

export async function postPublish(ctx, consoleConfig) {
  requirePrincipal(ctx);
  const config = { url: consoleConfig.url, token: ctx.token };
  return { status: 200, body: await publishOrgDocument(config, ctx.params.contentHash, ctx.principal) };
}
