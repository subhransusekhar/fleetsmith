// SPDX-License-Identifier: AGPL-3.0-only
import { queryAuditEntries, explainItem, renderAuditTable, renderExplanation } from '../../../src/grid/audit.js';

/**
 * G8.3's data source — shares `ee/src/grid/audit.js`'s `queryAuditEntries`/`explainItem` directly with the CLI
 * (`fleetsmith grid audit`, G7.4), not a second copy of the query-building logic, per the issue's own
 * instruction. Console requests are always live (no local checkout to degrade to, unlike the CLI's own
 * degraded mode) — every mutation this BFF performs elsewhere (approvals, equip-scope edits, token admin) is
 * forwarded under the CALLER's own token (the one documented exception being token admin — see
 * `routes/tokens.js`), so it lands as a real, attributable row here: this route is how G8.1's own acceptance
 * criterion ("every mutation visible in grid audit under the real caller's principal") is actually checked.
 *
 * --- Self-only for a member, server-forced, not a UI convention -------------------------------------------
 *
 * The issue's own access rule names three tiers — "auditor/admin roles" get full access, "members see their
 * OWN entries only." G8.1 only established two (`member`/`admin`, `CONSOLE_ADMINS`) — there is no separate
 * "auditor" concept anywhere else in this milestone, and inventing a third role tier for one screen is not
 * justified by anything else needing it. So this route treats "auditor" and "admin" as the same tier
 * `CONSOLE_ADMINS` already grants: an admin token sees any actor; a member token's `actor` filter is
 * OVERWRITTEN with their own discovered principal, regardless of what `?actor=` the request carries — the
 * acceptance criterion is explicit that a tampered query param must not escape this, so the override happens
 * after reading `ctx.query`, never as a default only applied when the param is absent. A member with no
 * discoverable principal is refused outright (403) rather than silently shown zero rows or every row — the
 * same fail-closed posture `auth.js`'s `resolveRole` already established for admin routes.
 */
function requireSelfOnlyActor(ctx, opts) {
  if (ctx.role === 'admin') return opts;
  if (!ctx.principal) {
    const err = new Error('cannot show audit entries without a discoverable principal for your token — this deployment\'s auth mode does not report one (the common bearer-mode case); self-only audit access requires an auth mode where GET /tokens/self resolves a real principal.');
    err.status = 403;
    throw err;
  }
  return { ...opts, actor: ctx.principal };
}

export async function getAudit(ctx, consoleConfig) {
  const config = { url: consoleConfig.url, token: ctx.token };
  const opts = requireSelfOnlyActor(ctx, {
    actor: ctx.query.actor,
    since: ctx.query.since,
    until: ctx.query.until,
    purpose: ctx.query.purpose,
    limit: ctx.query.limit ? Number.parseInt(ctx.query.limit, 10) : undefined,
  });
  const entries = await queryAuditEntries(config, opts);
  if (ctx.query.format === 'table') return { status: 200, body: { table: renderAuditTable(entries), selfOnly: ctx.role !== 'admin' } };
  return { status: 200, body: { entries, selfOnly: ctx.role !== 'admin' } };
}

export async function getAuditWhy(ctx, consoleConfig) {
  if (!ctx.query.id) {
    const err = new Error('missing required "id" query param');
    err.status = 400;
    throw err;
  }
  const config = { url: consoleConfig.url, token: ctx.token };
  const explanation = await explainItem(config, ctx.query.id);
  if (ctx.query.format === 'table') return { status: 200, body: { markdown: renderExplanation(explanation) } };
  return { status: 200, body: explanation };
}
