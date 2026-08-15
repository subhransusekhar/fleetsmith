// SPDX-License-Identifier: AGPL-3.0-only
/**
 * fleetsmith-ee entrypoint. Loaded fail-soft by the core CLI (which tries
 * `import('fleetsmith-ee')`, then FLEETSMITH_EE_PATH, and continues silently
 * if neither resolves). This module's only job is to register enterprise
 * backends and commands through core's plugin registry — core never imports
 * from ee/, and deleting ee/ must leave core at exact OSS behavior.
 *
 * Populated by milestone v0.7.0 (docs/milestones/v0.7.0-tasks.md):
 *   G1  registerMemoryBackend('relatadb', …)   — ./memory/relatadb.js
 *   G3  registerCliCommand('grid', …)          — ./grid/daemon.js
 */
export function register(/* registry */) {
  // Intentionally empty until G1/G3 land. The scaffold exists so the license
  // boundary (ee/LICENSE, SPDX headers, CI guards) predates any ee code.
}
