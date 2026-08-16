// SPDX-License-Identifier: AGPL-3.0-only

/**
 * G8.6's "nothing token-shaped ever in BFF logs" — the primary defense is structural, not a scrub applied
 * after the fact: this module logs exactly `method`, `pathname`, a (redacted) query string, `status`, and
 * `durationMs`. It NEVER has access to request headers (so `Authorization: Bearer <token>` is never even in
 * scope to leak) and NEVER logs a response body (so `POST /api/tokens`'/`POST /api/tokens/self/rotate`'s
 * one-time token value in the response is never captured either) — there is no header/body parameter this
 * function even accepts. The query-string redaction below is defense in depth for a route that does not
 * exist today (nothing in this console ever puts a token in a query string; every credential travels only in
 * the `Authorization` header) rather than the load-bearing protection.
 */
const SENSITIVE_QUERY_KEY = /token/i;

export function scrubbedRequestLine(req, status, durationMs) {
  const url = new URL(req.url, 'http://localhost');
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, '[redacted]');
  }
  const qs = url.searchParams.toString();
  return `${req.method} ${url.pathname}${qs ? `?${qs}` : ''} ${status} ${durationMs}ms`;
}

export function logRequest(req, status, durationMs, logger = console.log) {
  logger(scrubbedRequestLine(req, status, durationMs));
}
