// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The purpose registry (G7.2): purpose is the unit of governance on reads — six standard purposes, each with
 * a one-line meaning that shows up directly in the engine's own audit output (`GET /audit/entries`, see
 * `docs/milestones/v0.7.0-intelligence-grid.md`'s architecture section; G7.4's `grid audit` is the future
 * wrapper around it, not built yet — this task only needs the purposes themselves to exist and reach the
 * engine, not the audit-reading CLI).
 *
 * --- No purpose-registration endpoint exists — this was already verified in G3.1, not re-discovered here ----
 *
 * `/purposes`, `/purpose`, `/purposes/register` all 404 against a real, licensed instance (verified 2026-08-16,
 * `bearer` auth mode — see `init.js`'s own doc comment). `purpose_mode = "open"` is this engine's only
 * observed configuration: every purpose string works, unregistered, regardless. `seedPurposes()` is therefore
 * a pure, local, zero-network computation — the list this checkout will use for every future grid call, not a
 * write to the engine — moved here from `init.js` (where it was originally written during G3.1) so the
 * vocabulary and its human-facing meanings live in one place a caller can import without pulling in the rest
 * of `gridInit()`'s machinery.
 *
 * --- Why `assertPurpose` is NOT wired into the generic memory-port verbs ------------------------------------
 *
 * `src/memory/port.js`'s own contract deliberately treats `purpose` as an open string, not a fixed vocabulary
 * — `runContract()` itself calls `recall(..., {purpose: 'contract-test'})`, and every existing test in this
 * project (core and `ee/`) freely uses ad-hoc purpose strings (`'p'`, `'test_purpose'`, per-task live-test
 * purposes like `'fleetsmith_g2_1_live'`). Restricting the low-level `remember`/`recall`/`justify`/`forget`
 * calls to only these six values would break that genericity for no real benefit — those are FLEETSMITH's
 * own internal machinery calls, not a place a human ever types a purpose by hand. `assertPurpose` exists for
 * the ONE place that actually happens on this milestone's CLI surface: `fleetsmith grid knowledge --purpose
 * <p>` (G6.5) — typo-proofing a human-typed flag value with a friendlier, local error than waiting for
 * whatever the engine itself would eventually do with an unrecognized purpose string.
 */

export class PurposeError extends Error {}

/** `purpose -> one-line meaning`. Order here is the order every summary/help text renders them in. */
export const STANDARD_PURPOSES = {
  cross_dev_reuse: 'checking whether a peer already built it',
  regression_check: 'past failures touching these files',
  product_context: 'product/roadmap background for a decision',
  client_commitment: 'what we promised a client',
  decision_rationale: 'why a past decision was made',
  grid_sync: "the daemon's own machinery",
};

const STANDARD_PURPOSE_NAMES = Object.keys(STANDARD_PURPOSES);

/**
 * `config.purposes` (G1.1's `resolveGridConfig` — a fleet's own declared extras, or an empty array) merged
 * with the six standard names, deduplicated. This is the FULL vocabulary this checkout treats as "known" —
 * both what `gridInit`'s summary reports as seeded and what `assertPurpose` (below) accepts beyond the
 * standard six.
 */
export function seedPurposes(config) {
  const purposes = [...new Set([...STANDARD_PURPOSE_NAMES, ...(config?.purposes ?? [])])];
  return {
    purposes,
    registered: false,
    note: 'no purpose-registration endpoint exists on this engine surface (verified: /purposes, /purpose, /purposes/register all 404) — purpose_mode=open accepts every one of these strings unregistered',
  };
}

/**
 * Throws `PurposeError` — listing every known purpose — when `purpose` is neither one of the six standard
 * ones nor one of `extraPurposes` (a fleet's own `grid.purposes` declarations, from `resolveGridConfig`).
 * Intended for a CLI flag a human typed by hand (`grid knowledge --purpose`), not for internal machinery
 * calls — see the module doc comment for why the generic memory-port verbs deliberately do not call this.
 */
export function assertPurpose(purpose, extraPurposes = []) {
  const known = [...new Set([...STANDARD_PURPOSE_NAMES, ...extraPurposes])];
  if (!known.includes(purpose)) {
    throw new PurposeError(`unknown purpose "${purpose}" — expected one of: ${known.join(', ')}`);
  }
}
