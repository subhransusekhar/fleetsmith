// SPDX-License-Identifier: AGPL-3.0-only
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static serving for the web UI (G8.1's own point 4, deferred until there was a build to serve — see
 * `index.js`'s earlier doc comment). No bundler, no framework: `ee/console/web/` is a handful of plain
 * HTML/CSS/JS files, matching this project's own "keep deps ≈ 0" discipline (nothing else in fleetsmith ships
 * a frontend build step either). Every `/api/*` path is handled by `router.js` before this is ever consulted
 * (see `index.js`'s request handler) — this module only ever serves what `router.js` did not match.
 */

const WEB_DIR = fileURLToPath(new URL('../web', import.meta.url));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

/** `true`/serves the response and returns `true` for a GET/HEAD whose resolved path stays inside `WEB_DIR`; `false` (serves nothing) for anything else, so the caller can fall through to a 404. Path-traversal-safe: resolves the joined path and refuses anything that escapes `WEB_DIR` after resolution, not just a string-prefix check on the URL. */
export function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const url = new URL(req.url, 'http://localhost');
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const resolved = path.normalize(path.join(WEB_DIR, requested));
  if (!resolved.startsWith(WEB_DIR + path.sep)) return false;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return false;

  const ext = path.extname(resolved);
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream' });
  if (req.method === 'HEAD') res.end();
  else res.end(fs.readFileSync(resolved));
  return true;
}
