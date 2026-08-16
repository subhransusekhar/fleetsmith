// SPDX-License-Identifier: AGPL-3.0-only
import { extractBearerToken, authenticateToken, resolveRole, AuthError } from './auth.js';

/**
 * A tiny, dependency-free route table over `node:http` — matches the rest of this project's "keep deps ≈ 0"
 * discipline (core ships exactly one runtime dependency; this console adds none). Every route declares a
 * `role` (`'public'`, `'member'`, or `'admin'`); `dispatch` performs BOTH real checks — `authenticateToken`
 * (is this token valid at all) then `resolveRole` (member vs admin) — BEFORE calling the handler, exactly as
 * the issue requires ("authz check ... BEFORE any fan-out"). A route can therefore never reach its own
 * fan-out logic un-authorized: there is no handler code path that runs before this gate.
 */

const ROLES = ['public', 'member', 'admin'];

export function createRouter() {
  const registered = [];

  /** `pattern` uses `:name` segments, e.g. `/api/equip/:fleet/:agent`. `role` is checked in `dispatch`, never left to the handler to remember. */
  function route(method, pattern, role, handler) {
    if (!ROLES.includes(role)) throw new Error(`route ${method} ${pattern}: unknown role "${role}" (expected one of ${ROLES.join(', ')})`);
    const segments = pattern.split('/').filter(Boolean);
    registered.push({ method, segments, role, handler, pattern });
  }

  function match(method, pathname) {
    const pathSegments = pathname.split('/').filter(Boolean);
    for (const r of registered) {
      if (r.method !== method || r.segments.length !== pathSegments.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < r.segments.length; i++) {
        const seg = r.segments[i];
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(pathSegments[i]);
        else if (seg !== pathSegments[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { route: r, params };
    }
    return null;
  }

  async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      const err = new Error('request body is not valid JSON');
      err.status = 400;
      throw err;
    }
  }

  function statusFor(err) {
    if (err instanceof AuthError) return err.status;
    if (typeof err.status === 'number') return err.status;
    // Every domain error class in this package (OntologyError, ApprovalError, PurposeError, AuditError, …) is
    // a caller-input/state problem, not a server fault — 400 is the honest default for "thrown, not a bug."
    return 400;
  }

  async function dispatch(req, res, consoleConfig) {
    const url = new URL(req.url, 'http://localhost');
    const matched = match(req.method, url.pathname);
    if (!matched) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `no route for ${req.method} ${url.pathname}` }));
      return;
    }
    const { route: r, params } = matched;

    try {
      let token = null;
      let auth = { role: 'public', principal: null };
      if (r.role !== 'public') {
        token = extractBearerToken(req);
        await authenticateToken(consoleConfig, token);
        auth = await resolveRole(consoleConfig, token);
        if (r.role === 'admin' && auth.role !== 'admin') {
          throw new AuthError(
            auth.principal
              ? `"${auth.principal}" is not listed in CONSOLE_ADMINS — this route requires the admin role.`
              : 'this route requires the admin role, and no principal is discoverable for this token — an admin console fails closed when identity cannot be verified, unlike the CLI grid daemon\'s advisory check.',
            403
          );
        }
      }

      const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await readJsonBody(req);
      const ctx = { params, query: Object.fromEntries(url.searchParams), body, token, ...auth };
      const result = await r.handler(ctx, consoleConfig);
      res.writeHead(result?.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result?.body ?? result ?? {}));
    } catch (e) {
      res.writeHead(statusFor(e), { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  }

  /** `[{method, pattern, role}]` — never handlers. The one authoritative source `manifest.js` (G8.8) reads from, so the authz-bypass suite can never drift from what is actually registered (there is no separate, hand-maintained list to fall out of sync with this one). */
  function routes() {
    return registered.map((r) => ({ method: r.method, pattern: r.pattern, role: r.role }));
  }

  return { route, dispatch, routes };
}
