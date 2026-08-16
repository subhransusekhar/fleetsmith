// SPDX-License-Identifier: AGPL-3.0-only
import { request } from '../../src/memory/relatadb.js';

/**
 * `EquipScope` (`routes/equip.js`) is deliberately NOT added to `ee/src/grid/types.json`/`GRID_TYPES` — doing
 * so would pull it into the CLI daemon's own push/pull/materialize cycle (`GRID_TYPE_NAMES` in `pull.js` is
 * derived from that same file) and expand G3's already-shipped, already-tested sync scope, which nothing in
 * this task asked for and which `ee/test/ontology.test.js` pins to exactly five types. `/ingest` types
 * register themselves on first write regardless of any central declaration (G2.1's own verified finding), so
 * this module talks to the SAME real, verified `/ingest` + bare-`SELECT *` mechanics `ontology.js`/`pull.js`
 * already established, just for a type namespace the console owns on its own.
 */

/** Mirrors `relatadb.js`'s own private `unpackQueryRows` / `pull.js`'s `unpackRecords` — every ad-hoc `/ingest`-registered type's `SELECT *` wraps one `/ingest` call's rows into a single JSON array under a pseudo-column literally named `rows` (verified, G2.1/G3.3). A record that fails to parse is skipped, not fatal. */
export function unpackQueryRows(queryResult) {
  const out = [];
  for (const record of queryResult?.data ?? []) {
    try {
      out.push(...JSON.parse(record.rows ?? '[]'));
    } catch {
      /* skip a malformed record, same tolerance every other reader of this shape in this package already has */
    }
  }
  return out;
}

/** A bare `SELECT * FROM <typeName>` — no `WHERE`, for the same verified reason every other ad-hoc-type reader in this package uses one (any `WHERE`, even a trivially-true one, empties the result — G3.3). Callers filter client-side. */
export async function queryAllRows(config, typeName, purpose) {
  const result = await request(config, { method: 'POST', path: '/query', body: { sql: `SELECT * FROM ${typeName}`, purpose } });
  return unpackQueryRows(result);
}

/** `POST /ingest?object_type=<typeName>` — no key-field validation beyond what the caller already did; `EquipScope`'s own shape is small enough that `routes/equip.js` validates it directly rather than needing `ontology.js`'s generic `validateRow`. */
export async function ingestRow(config, typeName, row) {
  return request(config, { method: 'POST', path: '/ingest', query: { object_type: typeName }, body: { rows: [row] } });
}
