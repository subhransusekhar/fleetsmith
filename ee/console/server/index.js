// SPDX-License-Identifier: AGPL-3.0-only
import http from 'node:http';
import { resolveConsoleConfig } from './config.js';
import { buildApp } from './app.js';

/**
 * The single deployable (G8.1): `node ee/console/server/index.js`, config from the environment
 * (`RELATA_URL`, optionally `RELATA_ADMIN_TOKEN` and `CONSOLE_ADMINS`, `PORT`). No sessions, no user
 * database, no cache-of-record — `createServer` below holds nothing between requests except the router's own
 * static route table and `routes/tokens.js`'s explicitly-documented, explicitly-non-authoritative in-memory
 * "created this process" list. Restarting loses nothing but in-flight requests, per the acceptance criteria.
 *
 * Static web-UI serving (the `ee/console/web/` build, G8.2 onward) is deliberately not wired here yet — this
 * task's own file list is `ee/console/server/` only; a later task adds the static-file fallback once there is
 * a build to serve.
 */
export function createServer(env = process.env) {
  const consoleConfig = resolveConsoleConfig(env);
  const router = buildApp();
  const server = http.createServer((req, res) => {
    router.dispatch(req, res, consoleConfig).catch((e) => {
      // A handler or the dispatcher itself throwing OUTSIDE dispatch's own try/catch is a real server bug,
      // not a caller-input problem — the one place this file does not reuse router.js's error->status mapping.
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `unhandled server error: ${e.message}` }));
      }
    });
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
