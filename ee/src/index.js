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
 *   G3  registerCliCommand('grid', …)          — ./grid/daemon.js, not yet built
 */
import { resolveGridConfig } from './config.js';
import { relatadbBackend } from './memory/relatadb.js';
import { withDegradation } from './memory/degrade.js';
import { fileBackend } from 'fleetsmith/memory/file';

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
}
