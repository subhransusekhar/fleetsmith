// SPDX-License-Identifier: AGPL-3.0-only
import fs from 'node:fs';
import path from 'node:path';

/**
 * G7.5's `registerHealthSource` provider (`src/lib/registry.js`). Reads `_fleet/local/grid/peers/<actor>/
 * health.json`, written by `materialize.js` from `RunEventSummary` rows the daemon already pulled — a file
 * read, never a network call, per the issue's own "materialized summaries" contract. Registered in
 * `ee/src/index.js` alongside the other registry seams; `spec` is accepted (and ignored) only to match the
 * `fn(spec, localDir)` shape `collectHealthSources` calls every registered source with.
 */
export function readGridHealthSummaries(spec, localDir) {
  const peersDir = path.join(localDir, 'grid', 'peers');
  if (!fs.existsSync(peersDir)) return [];

  const rows = [];
  for (const actor of fs.readdirSync(peersDir)) {
    const file = path.join(peersDir, actor, 'health.json');
    if (!fs.existsSync(file)) continue;
    try {
      rows.push(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      // A materialize() write mid-flight is atomic (rename, not in-place edit), so a parse failure here means
      // a genuinely corrupt file, not a torn read — skip it, the same tolerance readEvents() gives a run log.
    }
  }
  return rows;
}
