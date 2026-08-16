// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request } from '../memory/relatadb.js';

/**
 * The grid ontology (G2.1): the four typed rows that carry live cross-developer state through RelataDB's
 * `/ingest` (not the memory verbs — see the milestone architecture doc: `/memory/*` writes bypass
 * `governed_upsert` and never reach the `/graph/changes` SSE changefeed, only `/ingest` rows do). Every row is
 * single-writer, keyed by `actor` (or `actor`+`seq`), so two developers' concurrent pushes can never collide.
 *
 * `GRID_TYPES` (loaded from the sibling `types.json`, a reviewable data file, not string-built at runtime) is
 * the field-list contract `ee/src/grid/project.js` (G2.2) and the `fleetsmith grid` daemon (G3, not yet built)
 * both project into and read back out of. Extend it only additively.
 *
 * --- What `ontologyMigrate()` actually does, and why it is smaller than the milestone doc assumed -----------
 *
 * Verified directly against a real, isolated RelataDB v1.5.7 instance (2026-08-16, in-memory, no shared
 * state with the primary licensed dev instance):
 *
 *  1. **Types auto-register on first ingest, with no separate declaration step possible.** The very first
 *     `POST /ingest?object_type=<Name>` call for a given type infers its columns from that row's own shape.
 *     There is no verified way to declare a type's schema with zero real rows: even `{"rows": []}` still
 *     ingests one row (a JSON-encoded empty array), so "ingest a sentinel with no data" was tried and
 *     rejected — it leaves a phantom row behind, not a clean declaration.
 *  2. **`POST /ontology/migrate` is real, and is idempotent, but is the ENGINE's own reserved-pack schema
 *     versioning tool** (the extension packs `suggest_extensions` lists: telco, finint, fara, cyber, oci,
 *     maritime) — **not** a way to declare our four types. Confirmed directly: a spec-shaped `{"types": […]}`
 *     body, an empty `{}` body, and a garbage `{"bogus": 123}` body all produced the byte-identical
 *     `{from_version, to_version, requires_data_migration, steps: [], executed: false, applied: []}` response
 *     on a fresh instance with nothing pending. It also gates behind a **separate `RELATA_ADMIN_TOKEN`**
 *     (unprovisioned by default, non-persistent across restarts — set only via that env var on the server
 *     process, distinct from the regular per-developer data-plane bearer token every other verb in this
 *     package uses) — confirmed via a `403 admin token required for ontology migration` with no admin token
 *     configured, and a real `200` once one was.
 *
 * Given that reality, `ontologyMigrate()` calls the real endpoint when an admin token is available — harmless
 * and genuinely idempotent, and it is the mechanism by which any pending *engine* migration gets picked up —
 * but never requires one. Grid state is advisory (the milestone's own rule): a developer running on the
 * plain per-developer token must keep getting full functionality, since our own schema registers itself the
 * moment `ingestRows()` below writes the first real row of each type regardless of whether this ran at all.
 */

const TYPES_PATH = new URL('./types.json', import.meta.url);
export const GRID_TYPES = JSON.parse(readFileSync(TYPES_PATH, 'utf8'));

export class OntologyError extends Error {}

/**
 * `repo_id` = SHA-256 of the normalized git remote URL — one cortex serves many projects, and every row
 * across every developer's machine must hash to the same value for a shared repo, regardless of which URL
 * form (`git@host:org/repo.git`, `https://host/org/repo`, with or without a trailing `.git`/slash, differing
 * case) their local clone happens to use.
 */
export function normalizeRemoteUrl(raw) {
  let url = raw.trim().toLowerCase();
  const ssh = url.match(/^[a-z0-9._-]+@([^:]+):(.+?)(\.git)?\/?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  url = url.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // strip any scheme (https://, ssh://, git://, …)
  url = url.replace(/^[^@/]+@/, ''); // strip a leftover user@ (e.g. https://user@host/org/repo)
  url = url.replace(/\.git$/, '').replace(/\/+$/, '');
  return url;
}

/** Throws `OntologyError` when the repo has no configured remote — the grid needs one shared identity across every developer's clone, and only a shared remote provides that. */
export function resolveRepoId(cwd = process.cwd()) {
  let remote = '';
  try {
    remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    /* not a git repo, or no origin configured — fall through to the error below */
  }
  if (!remote) {
    throw new OntologyError(
      "no `remote.origin.url` configured for this repo — the grid needs a stable, shared repo identity (every " +
        'developer syncing through the same cortex must hash to the same repo_id), and only a shared git remote ' +
        'provides one across machines.'
    );
  }
  return createHash('sha256').update(normalizeRemoteUrl(remote)).digest('hex');
}

/** Every required key field for `typeName` must be present and non-empty on `row`; throws `OntologyError` naming the first one missing, or an unknown type name. */
export function validateRow(typeName, row) {
  const type = GRID_TYPES[typeName];
  if (!type) throw new OntologyError(`unknown grid type "${typeName}" — expected one of ${Object.keys(GRID_TYPES).join(', ')}`);
  for (const field of type.key) {
    if (row[field] === undefined || row[field] === null || row[field] === '') {
      throw new OntologyError(`grid row for "${typeName}" is missing required key field "${field}"`);
    }
  }
  if (typeName === 'FleetTask' && row.status !== undefined && !type.statuses.includes(row.status)) {
    throw new OntologyError(`FleetTask.status "${row.status}" is not one of ${type.statuses.join(', ')}`);
  }
  if (typeName === 'OrgDocument' && row.kind !== undefined && !type.kinds.includes(row.kind)) {
    throw new OntologyError(`OrgDocument.kind "${row.kind}" is not one of ${type.kinds.join(', ')}`);
  }
  if (typeName === 'EquipBinding' && row.scope_kind !== undefined && !type.scope_kinds.includes(row.scope_kind)) {
    throw new OntologyError(`EquipBinding.scope_kind "${row.scope_kind}" is not one of ${type.scope_kinds.join(', ')}`);
  }
  return row;
}

/**
 * `POST /ingest?object_type=<typeName>`, validating every row's key fields first so a caller never sends a
 * row that would land un-attributable (no `actor`, no `repo_id`) or, for `FleetTask`, an off-vocabulary
 * status. One real network call per invocation, not batched further — a caller with many rows to push (the
 * G3 daemon) issues one call per type per push cycle, which is already how `remember_batch` works elsewhere
 * in this package.
 */
export async function ingestRows(config, typeName, rows) {
  for (const row of rows) validateRow(typeName, row);
  return request(config, { method: 'POST', path: '/ingest', query: { object_type: typeName }, body: { rows } });
}

/** See the module doc comment above for exactly what this does and does not do, and why. Never throws for a missing admin token — that is the normal, fully-functional state. */
export async function ontologyMigrate(config) {
  const adminToken = config.adminToken ?? process.env.RELATA_ADMIN_TOKEN;
  if (!adminToken) {
    return {
      engineMigrationRan: false,
      reason: 'no admin token configured (config.adminToken / RELATA_ADMIN_TOKEN) — skipped; the four grid types register themselves on first ingestRows() call regardless',
    };
  }
  const result = await request(config, { method: 'POST', path: '/ontology/migrate', body: {}, token: adminToken });
  return { engineMigrationRan: true, ...result };
}
