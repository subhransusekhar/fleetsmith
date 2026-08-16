// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';

/**
 * Actor identity resolution — the same rule already documented and shipped
 * in the generated `log-event.sh` (`src/compile/telemetry.js`), reimplemented
 * here in JS because the RelataDB adapter runs in-process, not as a shell
 * script. Kept in exact lockstep with that rule so a fleetsmith run and its
 * grid-attributed memory rows agree on who did what: `FLEETSMITH_ACTOR` env
 * → the local part of `git config user.email` → `$USER` → `'unknown'`.
 *
 * Sanitized to `[A-Za-z0-9._-]` for the same reason the shell version is:
 * this becomes part of a stable derived id (see `deriveSessionId` in
 * `memory/relatadb.js`), and an unsanitized email or shell-supplied `$USER`
 * could otherwise carry characters that break that derivation or any path
 * built from it later.
 */
export function resolveActor() {
  let actor = process.env.FLEETSMITH_ACTOR;
  if (!actor) {
    try {
      const email = execFileSync('git', ['config', 'user.email'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      actor = email.split('@')[0] || undefined;
    } catch {
      /* not a git repo, or no user.email configured — fall through */
    }
  }
  if (!actor) actor = process.env.USER || 'unknown';
  return actor.replace(/[^A-Za-z0-9._-]/g, '-');
}
