// SPDX-License-Identifier: AGPL-3.0-only
import { queryAuditEntries, explainItem, renderAuditTable, renderExplanation } from '../../../src/grid/audit.js';

/**
 * G8.3's data source. Console requests are always live (there is no local checkout to degrade to, unlike
 * `fleetsmith grid audit`'s own CLI degraded mode) — every mutation this BFF performs elsewhere (approvals,
 * equip-scope edits, token admin) is forwarded under the CALLER's own token (or, for token admin only, the
 * one documented exception — see `routes/tokens.js`), so it lands as a real, attributable row here: this
 * route is how G8.1's own acceptance criterion ("every mutation visible in grid audit under the real caller's
 * principal") is actually checked, not merely asserted.
 */
export async function getAudit(ctx, consoleConfig) {
  const config = { url: consoleConfig.url, token: ctx.token };
  const entries = await queryAuditEntries(config, {
    actor: ctx.query.actor,
    since: ctx.query.since,
    until: ctx.query.until,
    purpose: ctx.query.purpose,
    limit: ctx.query.limit ? Number.parseInt(ctx.query.limit, 10) : undefined,
  });
  if (ctx.query.format === 'table') return { status: 200, body: { table: renderAuditTable(entries) } };
  return { status: 200, body: { entries } };
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
