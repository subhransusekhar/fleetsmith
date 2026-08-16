// SPDX-License-Identifier: AGPL-3.0-only
import { request } from '../../../src/memory/relatadb.js';
import { RelataNetworkError } from '../../../src/memory/errors.js';

/**
 * G8.7 — deployment health. `GET /health` is deliberately the ONE route this console leaves unauthenticated
 * (`role: 'public'` in `index.js`'s route table): it mirrors the underlying engine's own posture — `GET
 * /health` is unauthenticated regardless of the bearer header (G3.1's own verified finding: a wrong token
 * still gets HTTP 200 from it) — so gating fleetsmith's OWN health route behind a bearer token a monitoring
 * probe would rarely have would add friction the engine itself does not require, for a route that reveals no
 * more than "is the cortex reachable."
 */
export async function getDeploymentHealth(_ctx, consoleConfig) {
  const base = {
    consoleUrl: consoleConfig.url,
    tokenAdminConfigured: Boolean(consoleConfig.adminToken),
    admins: consoleConfig.admins.length,
  };
  try {
    // No token: this specific engine endpoint ignores the Authorization header regardless (see above), so
    // there is no caller token to forward here even in principle — this is the one call in the whole console
    // that is never made on a caller's behalf.
    const engine = await request({ url: consoleConfig.url, token: '' }, { method: 'GET', path: '/health' });
    return { status: 200, body: { ...base, reachable: true, engine } };
  } catch (e) {
    // Unlike the CLI daemon, this console has no local file backend to degrade to — an unreachable cortex is
    // reported plainly, not silently absorbed.
    return { status: 200, body: { ...base, reachable: false, error: e instanceof RelataNetworkError ? e.message : String(e.message ?? e) } };
  }
}
