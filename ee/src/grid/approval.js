// SPDX-License-Identifier: AGPL-3.0-only
import { queryAllOrgDocuments } from '../memory/relatadb.js';
import { ingestRows } from './ontology.js';

/**
 * The org-approved channel (G7.3): the cortex's downstream influence, kept honest. Approved/published
 * `OrgDocument` rows (G6.1) rank higher in recall and render distinctly in `GRID.md` — but stay advisory,
 * and the PR ladder remains the only path into `_fleet/shared/`. This module never writes to
 * `_fleet/local` or `_fleet/shared` at all — it is pure network + row logic, nothing else (see the invariant
 * test in `ee/test/approval.test.js`, which greps this file's own source for exactly that guarantee).
 *
 * --- Scoped to `OrgDocument`, not "ProcedureMemory" — a real engine constraint, not a shortcut -------------
 *
 * The milestone's own spec for this task names approval state on "`ProcedureMemory` and `OrgDocument` rows."
 * `ProcedureMemory` is not a real, distinct RelataDB type — G1.3's own already-verified finding
 * (`ee/src/memory/relatadb.js`'s module doc comment) is that no `remember_procedure`/`recall_procedure` tool
 * exists at all; a "procedural" memory is just an ordinary `remember()` call with `memory_class:
 * 'procedural'`, whose only real engine-level field is an opaque `content` string — fleetsmith's own JSON
 * envelope lives entirely inside that one field. There is no way to add genuine FIRST-CLASS fields (as this
 * task's own acceptance criteria explicitly demand, not a metadata blob) to that shape; only `OrgDocument` —
 * an ad-hoc `/ingest`-registered type whose schema fleetsmith itself defines — actually supports it, the same
 * way `valid_from` (G6.1) and `imported_at` (G6.5) were added as real fields, not envelope contents. This
 * module's approval lifecycle therefore covers `OrgDocument` rows only; a "procedural" memory item has no
 * approval mechanism today, and this is documented here rather than faked with a JSON-blob workaround that
 * would contradict the "real fields" requirement anyway.
 *
 * --- Why `assertApprover` is a fleet-configured list, not an engine-enforced role --------------------------
 *
 * G7.1's own ACL policy template (`ee/src/grid/fixtures/acl-policy.json`) already documents this exact gap:
 * "no role/scope concept has been verified on this engine surface at all." There is no `/tokens/self` field,
 * no `/roles` endpoint, nothing to check an "approver role" against on the engine side — unlike G7.1's
 * principal-mismatch check, which at least has A discoverable principal in some auth modes to compare
 * against. The only real, honest control available is `config.approvers` — a fleet-configured allowlist
 * (`grid.approvers` in `fleet.yaml`, or `GRID_APPROVERS`, G7.3's addition to `ee/src/config.js`) checked
 * against the locally-resolved actor. This is CLIENT-SIDE ONLY, exactly like G7.1's identity check — it is
 * the operative control today, not a stand-in for a server-side one that does not exist.
 */

export class ApprovalError extends Error {}

/** Forward-only, one step at a time: `draft` -> `proposed` -> `approved` -> `published`. A row with no `approval` field at all is treated as `draft` (the default state every G6.1-imported row starts in). */
export const APPROVAL_STATES = ['draft', 'proposed', 'approved', 'published'];

/** A fixed, deterministic multiplier on an approved/published `OrgDocument` hit's merge score in `recall()` (`ee/src/memory/relatadb.js`) — no model judgment, no per-item variation. */
export const RANKING_BOOST = 1.5;

const FORWARD_TRANSITIONS = { draft: 'proposed', proposed: 'approved', approved: 'published', published: null };

/** `true` for `approved` or `published` — the two states `recall()`'s ranking boost applies to. Zero dependencies (no network, no other module) so `ee/src/memory/relatadb.js` can import just this without pulling in this module's own network calls. */
export function isApprovedOrPublished(row) {
  return row?.approval === 'approved' || row?.approval === 'published';
}

/** Throws `ApprovalError` naming the only valid next state, unless `to` is exactly the one allowed forward step from `from`. Skipping a state (draft -> approved) or moving backward is always refused — this task's own acceptance criterion ("enforced in order") is checked here, client-side, before any network call. */
export function assertValidTransition(from, to) {
  const expected = FORWARD_TRANSITIONS[from] ?? null;
  if (expected !== to) {
    throw new ApprovalError(
      `cannot transition from "${from}" to "${to}" — the only forward transition from "${from}" is ${expected ? `"${expected}"` : 'none (this is the final state)'}`
    );
  }
}

/** Throws `ApprovalError` unless `actor` is listed in `config.approvers`. See the module doc comment for why this is a client-side, fleet-configured list rather than an engine-enforced role. */
export function assertApprover(config, actor) {
  const approvers = config.approvers ?? [];
  if (!approvers.includes(actor)) {
    throw new ApprovalError(
      `"${actor}" is not listed in grid.approvers — approving requires being on that list (fleet.yaml's grid: block, or GRID_APPROVERS). ` +
        (approvers.length ? `Currently configured approvers: ${approvers.join(', ')}.` : 'No approvers are configured at all yet.')
    );
  }
}

/** Every version of the `OrgDocument` row keyed by `contentHash`, last-write-wins — mirrors the same resolution `materialize.js` (G3.4) already applies everywhere else in this package, since RelataDB has no server-side dedup on `/ingest` (two writes to one key produce two bi-temporal versions, not one overwritten row). Throws `ApprovalError` if no row with that hash exists at all. */
async function fetchLatestOrgDocument(config, contentHash) {
  const rows = (await queryAllOrgDocuments(config)).filter((r) => r.content_hash === contentHash);
  if (rows.length === 0) {
    throw new ApprovalError(`no OrgDocument row found with content_hash "${contentHash}"`);
  }
  return rows[rows.length - 1]; // last-write-wins — reconcile()'s own verified stable insertion order
}

/**
 * The shared transition machinery `proposeOrgDocument`/`approveOrgDocument`/`publishOrgDocument` (below) all
 * call: fetch the row's current state, validate the forward transition, optionally require an approver
 * (`approve` only — this task's own acceptance criterion, not applied to `propose`/`publish`), and re-ingest
 * the SAME row (same `content_hash` key) with `approval`/`approved_by`/`approved_at` updated. Re-ingesting an
 * unchanged key is exactly how every other bi-temporal update in this package already works (G3.5's
 * `ended_at` supersession on `ActorPresence` is the precedent) — there is no "update in place" on this
 * engine, only a new version at the same key.
 */
async function transitionOrgDocument(config, contentHash, toState, actor, { requireApprover = false } = {}) {
  const current = await fetchLatestOrgDocument(config, contentHash);
  const fromState = current.approval ?? 'draft';
  assertValidTransition(fromState, toState);
  if (requireApprover) assertApprover(config, actor);

  const updated = {
    ...current,
    approval: toState,
    approved_by: toState === 'approved' ? actor : current.approved_by ?? '',
    approved_at: toState === 'approved' ? new Date().toISOString() : current.approved_at ?? '',
  };
  await ingestRows(config, 'OrgDocument', [updated]);
  return updated;
}

export async function proposeOrgDocument(config, contentHash, actor) {
  return transitionOrgDocument(config, contentHash, 'proposed', actor);
}

/** The only transition requiring an approver — see the module doc comment for why that check is a fleet-configured list, not an engine-enforced role. */
export async function approveOrgDocument(config, contentHash, actor) {
  return transitionOrgDocument(config, contentHash, 'approved', actor, { requireApprover: true });
}

export async function publishOrgDocument(config, contentHash, actor) {
  return transitionOrgDocument(config, contentHash, 'published', actor);
}
