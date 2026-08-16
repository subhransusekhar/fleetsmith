// SPDX-License-Identifier: AGPL-3.0-only
import http from 'node:http';

/**
 * A fake RelataDB HTTP server for console tests — same shape as `ee/test/daemon.test.js`'s own `fakeRelata()`
 * (not imported: that helper is `ee/test`-local and console tests live under `ee/console/test/` per G8.8's own
 * file list), extended with the console-specific routes G8.1's routes actually call: `/health`, `/tokens`
 * (admin-gated create/revoke, no list — matching the real, verified engine shape), `/audit/entries`,
 * `/memory/justify|recognize|recall`.
 *
 * `goodToken`/`adminToken` distinguish which bearer is treated as valid for which purpose — a test can pass a
 * `memberToken` value through `SELECT 1` (authenticates) but have it fail the `/tokens` admin gate, exactly
 * like the real engine's own `403 admin token required` behavior.
 */
export function fakeRelata({
  goodTokens = ['member-token', 'admin-token'],
  adminToken = 'admin-token',
  tokensSelf = () => ({ present: false }),
  queryRows = {},
  auditEntries = [],
  justifyResult = null,
  recognizeResult = null,
  recallRows = [],
  health = { status: 'ok', profile: 'free', license_tier: 'server' },
} = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      const url = new URL(req.url, 'http://localhost');
      const auth = req.headers.authorization ?? '';
      const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1] ?? null;
      requests.push({ method: req.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), body: parsed, token });

      const json = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (req.method === 'GET' && url.pathname === '/health') return json(200, health);

      if (req.method === 'POST' && url.pathname === '/query') {
        if (!goodTokens.includes(token)) return json(401, { title: 'Unauthorized', status: 401, detail: 'unauthorized' });
        if (parsed?.sql === 'SELECT 1') return json(200, { rows: 1, columns: ['?column?'], data: [{ '?column?': 1 }] });
        const match = /FROM (\w+)/.exec(parsed?.sql ?? '');
        const rows = queryRows[match?.[1]] ?? [];
        return json(200, rows.length ? { rows: rows.length, columns: ['rows'], data: [{ rows: JSON.stringify(rows) }] } : { rows: 0, columns: ['rows'], data: [] });
      }

      if (req.method === 'GET' && url.pathname === '/tokens/self') {
        if (!goodTokens.includes(token)) return json(401, { title: 'Unauthorized', status: 401 });
        return json(200, tokensSelf(token));
      }

      if (req.method === 'POST' && url.pathname === '/tokens') {
        if (token !== adminToken) return json(403, { title: 'Forbidden', status: 403, detail: 'admin token required' });
        if (!parsed?.id) return json(422, { title: 'Unprocessable Entity', status: 422, detail: 'missing field `id`' });
        return json(201, { id: parsed.id, token: `secret-${parsed.id}` });
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/tokens/')) {
        if (token !== adminToken) return json(403, { title: 'Forbidden', status: 403, detail: 'admin token required' });
        return json(200, { revoked: true });
      }

      if (req.method === 'POST' && url.pathname === '/ingest') {
        if (!goodTokens.includes(token)) return json(401, { title: 'Unauthorized', status: 401 });
        const rows = parsed?.rows ?? [];
        return json(200, { rows_ingested: rows.length, rows_queued: rows.length, rows_rejected: 0, connector: 'direct', errors: [] });
      }

      if (req.method === 'GET' && url.pathname === '/audit/entries') {
        if (!goodTokens.includes(token)) return json(401, { title: 'Unauthorized', status: 401 });
        // Real filtering (not a passthrough) — lets a test prove the console's own actor-forcing is REAL,
        // not merely forwarded-and-hoped-for: a request carrying ?actor=mallory while the console has
        // overwritten it server-side to the caller's real principal only ever sees THAT actor's rows here.
        const filtered = url.searchParams.get('actor') ? auditEntries.filter((e) => e.actor === url.searchParams.get('actor')) : auditEntries;
        return json(200, { entries: filtered });
      }

      if (req.method === 'GET' && url.pathname.startsWith('/memory/justify/')) {
        if (!goodTokens.includes(token)) return json(401, { title: 'Unauthorized', status: 401 });
        return json(200, justifyResult ?? { found: false });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/memory/recognize/')) {
        if (!goodTokens.includes(token)) return json(401, { title: 'Unauthorized', status: 401 });
        return json(200, { memory: { content: recognizeResult ?? '{}' } });
      }
      if (req.method === 'GET' && url.pathname === '/memory/recall') {
        if (!goodTokens.includes(token)) return json(401, { title: 'Unauthorized', status: 401 });
        return json(200, { rows: recallRows });
      }

      json(404, { title: 'Not Found', status: 404, detail: `no fake route for ${req.method} ${url.pathname}` });
    });
  });
  return { server, requests };
}

export async function withFakeRelata(opts, fn) {
  const { server, requests } = fakeRelata(opts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  try {
    await fn({ url, requests });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}
