// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Error taxonomy for the RelataDB adapter, shared by the write half (G1.2),
 * the read half (G1.3), and the degrade-to-file circuit breaker (G1.4).
 *
 * The breaker needs to tell three failure shapes apart, and a single generic
 * Error cannot: a network failure (DNS, connection refused, timeout) means
 * "unreachable, degrade"; an HTTP error carries a status the breaker can act
 * on (401/403 → auth/license problem, also degrade); a tool-level error
 * (HTTP 200, but RelataDB's own `isError:true`) usually means a caller bug
 * (bad payload shape) rather than an outage, and degrading the whole process
 * over one malformed call would hide a real defect instead of surfacing it.
 */

export class RelataError extends Error {}

/** `fetch` itself failed or the request timed out — RelataDB was never reached. */
export class RelataNetworkError extends RelataError {}

/** RelataDB responded with a non-2xx HTTP status. `status` is the numeric code. */
export class RelataHttpError extends RelataError {
  constructor(message, { status } = {}) {
    super(message);
    this.status = status;
  }
}

/** HTTP 200, but the wrapped tool response carries `isError: true`. */
export class RelataToolError extends RelataError {}

/**
 * A 2xx response whose body is non-empty but not valid JSON at all (G9.1) — a genuinely malformed response,
 * distinct from an intentionally empty body (which `request()` already treats as `null`, not an error) and
 * from a non-2xx response (whose raw text becomes the `RelataHttpError`'s own detail message, a real error
 * either way). Before this class existed, a 200-with-garbage-body silently became `null` all the way down to
 * whichever caller dereferenced its shape — `recall()`'s `result.rows` on a `null` result threw an
 * unclassified `TypeError` that `withDegradation`'s breaker (`degrade.js`) does not recognize as either an
 * immediate-trip or a counted failure, so it neither degraded to the file backend nor gave the caller a clear
 * error. Classified here so it degrades exactly like an unreachable cortex (this milestone's own "garbage
 * response -> treated as unreachable, never a crash" requirement), not silently, and not as a raw TypeError.
 */
export class RelataMalformedResponseError extends RelataError {}
