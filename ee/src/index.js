// SPDX-License-Identifier: AGPL-3.0-only
/**
 * fleetsmith-ee entrypoint. Loaded fail-soft by the core CLI (which tries
 * `import('fleetsmith-ee')`, then FLEETSMITH_EE_PATH, and continues silently
 * if neither resolves). This module's only job is to register enterprise
 * backends and commands through core's plugin registry — core never imports
 * from ee/, and deleting ee/ must leave core at exact OSS behavior.
 *
 * Populated by milestone v0.7.0 (docs/milestones/v0.7.0-tasks.md):
 *   G1  registerMemoryBackend('relatadb', …)   — done (G1.1–G1.4)
 *   G3  registerCliCommand('grid', …)          — done (G3.1–G3.5), ./grid/daemon.js
 *   G7.5 registerHealthSource(…)                — done, ./grid/health-source.js
 */
import { resolveGridConfig } from './config.js';
import { relatadbBackend } from './memory/relatadb.js';
import { withDegradation } from './memory/degrade.js';
import { fileBackend } from 'fleetsmith/memory/file';
import { gridCliHandler, onRunStart, onRunEnd } from './grid/daemon.js';
import { readGridHealthSummaries } from './grid/health-source.js';

export function register(registry) {
  // Same factory shape as core's own 'file' registration: `({spec, cwd}) ->
  // backend`. Absence is the default state even though the name is always
  // registered — a spec with no `grid:` block and no RELATA_* env behaves
  // exactly like the file backend, never surprising a caller who didn't ask
  // for the enterprise tier.
  registry.registerMemoryBackend('relatadb', ({ spec, cwd } = {}) => {
    const file = fileBackend({ spec, cwd });
    const grid = resolveGridConfig(spec);
    if (!grid) return file;
    const relata = relatadbBackend({ ...grid, fleetName: spec?.fleet?.name });
    return withDegradation(relata, file);
  });

  registry.registerCliCommand('grid', gridCliHandler);

  // Provisioned, not load-bearing today — see the doc comment on onRunStart/onRunEnd in grid/daemon.js:
  // nothing in core calls runDaemonHooks('run_start'|'run_end', …) yet, so these never fire in practice.
  // `fleetsmith grid sync --watch` detects a real run's lifecycle itself, by watching the CURRENT-<actor>
  // marker file directly — it does not depend on this registration either.
  registry.registerDaemonHook('run_start', onRunStart);
  registry.registerDaemonHook('run_end', onRunEnd);

  // G7.5: `src/health/index.js` calls this with (spec, localDir) for every `fleetsmith health`/`evolve` run.
  // Reads a materialized file, never the network — see the doc comment on readGridHealthSummaries.
  registry.registerHealthSource(readGridHealthSummaries);
}
