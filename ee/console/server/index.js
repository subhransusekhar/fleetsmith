// SPDX-License-Identifier: AGPL-3.0-only
import http from 'node:http';
import { resolveConsoleConfig } from './config.js';
import { buildApp } from './app.js';
import { serveStatic } from './static.js';
import { logRequest } from './logging.js';

/**
 * The single deployable (G8.1): `node ee/console/server/index.js`, config from the environment
 * (`RELATA_URL`, optionally `RELATA_ADMIN_TOKEN` and `CONSOLE_ADMINS`, `PORT`). No sessions, no user
 * database, no cache-of-record — `createServer` below holds nothing between requests except the router's own
 * static route table and `routes/tokens.js`'s explicitly-documented, explicitly-non-authoritative in-memory
 * "created this process" list. Restarting loses nothing but in-flight requests, per the acceptance criteria.
 *
 * Static web-UI serving (`ee/console/web/`, wired G8.2): any request under `/api/` goes to the JSON router;
 * everything else falls through to `serveStatic` (the board page and its assets), so the whole console is one
 * deployable on one port, per the issue's own requirement.
 *
 * Every request is logged exactly once, on `res.on('finish')`, through `logging.js`'s `logRequest` — method,
 * path, (redacted) query, status, duration only; see that module's own doc comment for why headers and
 * response bodies are never even in scope to leak token material (G8.6). `logger` is injectable so a test can
 * capture output without polluting real stdout — defaults to `console.log`.
 */
export function createServer(env = process.env, { logger } = {}) {
  const consoleConfig = resolveConsoleConfig(env);
  const router = buildApp();
  const server = http.createServer((req, res) => {
    const start = Date.now();
    res.on('finish', () => logRequest(req, res.statusCode, Date.now() - start, logger));

    if (req.url.startsWith('/api/')) {
      router.dispatch(req, res, consoleConfig).catch((e) => {
        // A handler or the dispatcher itself throwing OUTSIDE dispatch's own try/catch is a real server bug,
        // not a caller-input problem — the one place this file does not reuse router.js's error->status mapping.
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `unhandled server error: ${e.message}` }));
        }
      });
      return;
    }
    if (!serveStatic(req, res)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });
  return { server, consoleConfig };
}

function isMain() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  const { server, consoleConfig } = createServer();
  server.listen(consoleConfig.port, () => {
    console.log(`fleetsmith-ee console listening on :${consoleConfig.port}`);
  });
}
