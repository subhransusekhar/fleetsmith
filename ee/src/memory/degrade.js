// SPDX-License-Identifier: AGPL-3.0-only
import { RelataNetworkError, RelataHttpError, RelataMalformedResponseError } from './errors.js';

/**
 * The degrade-to-file circuit breaker (G1.4) — what actually gets registered
 * as the `'relatadb'` memory backend. Everything G1.1–G1.3 built talks to a
 * real RelataDB instance; this is what makes that safe to depend on, per the
 * standing BYOL rule (`docs/licensing.md`): connection failure or license
 * trouble must degrade to the file backend, never fail a fleet's run.
 *
 * One circuit for the whole backend (not per-verb): "delegate every verb to
 * the file backend for the rest of the process" is a single, process-wide
 * decision, made once, in whichever verb call happens to hit it first.
 *
 * Trip conditions, and why they are not all treated alike:
 *  - **Network error** (`RelataNetworkError` — unreachable, DNS failure, or
 *    our own `AbortSignal.timeout` firing), **401/403** (revoked or
 *    expired token), and **`RelataMalformedResponseError`** (G9.1 — a 2xx
 *    response whose body is not even valid JSON) trip on the FIRST
 *    occurrence. These are unambiguous: there is nothing a second attempt
 *    would learn that the first didn't — a garbled response is treated
 *    exactly like an unreachable cortex, not specially retried.
 *  - **A 4xx body that reads like license exhaustion** (mentions "license"
 *    alongside "expired"/"exhausted"/"exceeded"/"grace"/"revoked") also trips
 *    immediately, for the same reason. Unverified against a real exhausted
 *    license — doing that would have meant deliberately breaking a paid
 *    license to observe the error shape, which was not worth the cost of
 *    finding out; treat this pattern as a best-effort guess, not a confirmed
 *    contract, until it is validated against a real occurrence.
 *  - **5xx responses need THREE consecutive occurrences before tripping.**
 *    A single transient 500 is not evidence of an outage — degrading the
 *    whole process on one bad response would be jumpier than the failure it
 *    is supposedly protecting against. A success anywhere resets this
 *    counter to zero, since consecutive is exactly what it says.
 *  - **`RelataToolError`** (HTTP 200, but the tool call itself reported
 *    `isError: true`) is NEVER a trip condition, counted or otherwise — that
 *    is a caller-side bug (a malformed payload), not an outage, and
 *    degrading the whole process over one bad call would hide a real defect
 *    rather than surface it.
 *  - Anything else (a port-contract validation error, e.g. missing
 *    `purpose`, or `assertValidItem`'s refusal of a malformed item) is
 *    neither counted nor a trip condition — it propagates to the caller
 *    completely unchanged, exactly as the file backend alone would raise it.
 *
 * A call that fails for a reason THIS process has not yet given up on (a
 * single 500 short of the threshold) still falls back to the file backend
 * for that one call, rather than surfacing a "backend unavailable" error —
 * the wrapper's whole job is that no caller ever sees one. Whether that call
 * ALSO tripped the breaker only decides whether the NEXT call bothers trying
 * RelataDB again.
 *
 * State is entirely in-process and lost on exit by design ("optional
 * half-open probe on the next process start only" — there is no persisted
 * circuit file). A fresh process always gets a fresh attempt: this is a
 * circuit breaker for one run's worth of calls, not a standing verdict about
 * the instance.
 *
 * One real limitation worth stating plainly, not glossed over: RelataDB and
 * the file backend are two independent stores. Once degraded, a `recall`
 * only searches whatever the file backend already has — anything written to
 * RelataDB earlier in this same process (or by another process) is invisible
 * until RelataDB is reachable again. Degrading keeps a fleet's RUN alive; it
 * does not merge the two backends' data.
 */

const CONSECUTIVE_5XX_THRESHOLD = 3;
const LICENSE_MENTION = /license/i;
const EXHAUSTION_LANGUAGE = /expired|exhausted|exceeded|grace period|revoked/i;

function looksLikeLicenseExhaustion(e) {
  return e instanceof RelataHttpError && e.status >= 400 && e.status < 500 && LICENSE_MENTION.test(e.message) && EXHAUSTION_LANGUAGE.test(e.message);
}

/** Trips on the first occurrence — nothing a retry would learn that this call didn't already. */
function isImmediateTrip(e) {
  if (e instanceof RelataNetworkError) return true;
  // A 2xx response whose body isn't even valid JSON (G9.1) is treated exactly like "unreachable" — a
  // response this garbled is not a caller-side bug (unlike RelataToolError, below) and a retry has nothing
  // more to learn than the first attempt already showed.
  if (e instanceof RelataMalformedResponseError) return true;
  if (e instanceof RelataHttpError && (e.status === 401 || e.status === 403)) return true;
  return looksLikeLicenseExhaustion(e);
}

/** Needs a run of these before it means anything — a lone one is noise, not an outage. */
function isCountedFailure(e) {
  return e instanceof RelataHttpError && e.status >= 500;
}

const VERBS = ['remember', 'recall', 'consolidate', 'forget', 'justify'];

/** The default warning — one line, naming the reason, stated once. */
function defaultOnDegrade(reason) {
  console.error(`warn: RelataDB is unavailable (${reason}) — continuing on the file backend for the rest of this process.`);
}

/**
 * `withDegradation(relatadbBackend, fileBackend) -> backend`. Both arguments
 * are plain `MemoryBackend`-shaped objects (`src/memory/port.js`) — this
 * function does not construct either one, only decides which serves each
 * call. `onDegrade` is injectable so this is testable without capturing
 * `console.error`.
 */
export function withDegradation(relatadbBackend, fileBackend, { onDegrade = defaultOnDegrade } = {}) {
  let degraded = false;
  let warned = false;
  let consecutive5xx = 0;

  function trip(reason) {
    degraded = true;
    if (!warned) {
      warned = true;
      onDegrade(reason);
    }
  }

  const backend = {};
  for (const verb of VERBS) {
    backend[verb] = async (...args) => {
      if (degraded) return fileBackend[verb](...args);
      try {
        const result = await relatadbBackend[verb](...args);
        consecutive5xx = 0; // a success resets the counted-failure streak
        return result;
      } catch (e) {
        if (isImmediateTrip(e)) {
          trip(`${e.constructor.name}: ${e.message}`);
          return fileBackend[verb](...args);
        }
        if (isCountedFailure(e)) {
          consecutive5xx++;
          if (consecutive5xx >= CONSECUTIVE_5XX_THRESHOLD) {
            trip(`${consecutive5xx} consecutive 5xx responses (${e.message})`);
          }
          // Whether or not this call just tripped the breaker, its own
          // failure must not reach the caller as a "backend unavailable"
          // error — fall back to file for this one call regardless. Tripping
          // only decides whether the NEXT call bothers trying RelataDB again.
          return fileBackend[verb](...args);
        }
        // A port-contract error (missing purpose, a malformed item) or a
        // RelataToolError (a caller-side bug, not an outage) — never masked,
        // never counted, never degrades anything.
        throw e;
      }
    };
  }
  return backend;
}
