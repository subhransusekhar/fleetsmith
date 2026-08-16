// SPDX-License-Identifier: AGPL-3.0-only
import { buildApp } from './app.js';

/**
 * G8.8's route manifest — the live, authoritative list of every route this console actually serves, derived
 * directly from `buildApp()`'s own router rather than a second, hand-maintained list that could silently
 * drift from what `index.js` really dispatches to. `router.js`'s `routes()` is the one place this data comes
 * from; nothing here re-declares a route's method/pattern/role independently.
 */
export function routeManifest() {
  return buildApp().routes();
}

/** Every non-`GET` route — the mutation surface G8.8's authz-bypass suite must cover 100% of. */
export function mutationRoutes(manifest = routeManifest()) {
  return manifest.filter((r) => r.method !== 'GET');
}

/** `"METHOD pattern"` — a stable, human-readable key for a manifest entry, used both by the real suite (to track which routes it has covered) and by its own completeness-check unit test. */
export function routeKey(route) {
  return `${route.method} ${route.pattern}`;
}

/**
 * Throws, naming every uncovered route, unless `testedKeys` (a Set of `routeKey()` strings) covers every
 * mutation route in `manifest`. This is the actual completeness CHECK — kept as a small, pure, independently
 * testable function so G8.8's own "adding an unmanifested route breaks the build" acceptance criterion can be
 * proven with a synthetic manifest (a real drift scenario cannot be committed just to watch CI fail on it).
 */
export function assertMutationsFullyTested(manifest, testedKeys) {
  const missing = mutationRoutes(manifest).map(routeKey).filter((key) => !testedKeys.has(key));
  if (missing.length) {
    throw new Error(`${missing.length} mutation route(s) have no authz-bypass test coverage: ${missing.join(', ')}`);
  }
}
