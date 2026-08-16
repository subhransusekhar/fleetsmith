// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Push-side secret redaction (G9.2) — the real implementation behind the `redactRow` hook `push.js` (G3.2)
 * already stubbed as a pass-through default (`opts.redactRow ?? ((row) => row)`).
 *
 * --- Block, never scrub — a standing decision, not a simplification ------------------------------------------
 *
 * `redactRow` either returns `row` completely UNCHANGED or throws `RedactionError` naming the offending field
 * (never the value). It never returns a row with the secret masked out — a scrubbed row is a lie about what
 * the task actually declared (the row's `task`/`chunk_text`/etc. field would silently read differently than
 * what the developer actually wrote), and this project's own grid rows are already pointers/digests only
 * (G2.1's design) — this module is defense-in-depth for the remaining FREE-TEXT fields (task titles, notes,
 * imported chunk text), not the primary confidentiality boundary.
 *
 * --- Per-row, not per-batch — `push.js`'s own wiring changed alongside this file to make that true -----------
 *
 * A blocked row must not take its siblings down with it ("Seeded secret in a task title: row blocked ...
 * sibling rows push" — this task's own acceptance criterion). `push.js` catches `redactRow`'s throw PER ROW
 * now, not once per whole type-batch as the original G3.2 stub's call site did.
 */

export class RedactionError extends Error {}

/**
 * Ordered, reviewable data table — not a single sprawling regex — so each pattern gets its own name (for the
 * warning message) and its own test. Deliberately over-inclusive (a false positive blocks one row and logs a
 * warning; a false negative pushes a real secret) — see `ee/test/redact.test.js` for the tricky-negative
 * cases each pattern was checked against before being added here.
 */
const PATTERNS = [
  { name: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/ },
  { name: 'pem-private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9_\-.=]{16,}/ },
  { name: 'key-value-assignment', re: /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"]?\S{6,}/i },
];

/** Field names that plausibly hold a raw credential value with no inline prefix to catch it by pattern alone — see `isHighEntropyNearKeyLikeField` below for why this check ALSO requires the name, not entropy alone. */
const KEY_LIKE_FIELD_NAME = /token|secret|password|passwd|api[_-]?key|credential/i;
const MIN_HIGH_ENTROPY_LENGTH = 32;
const HIGH_ENTROPY_BITS_PER_CHAR = 4.0;

/** Shannon entropy, bits/char — a real hex/base64-ish random string sits well above ordinary English prose's ~1.5-2.5 bits/char. */
function shannonEntropyBitsPerChar(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * `true` only when a string is BOTH long enough AND entropy-dense enough to look randomly generated. This
 * intentionally does NOT fire on its own — a `content_hash` field is exactly this shape (64 hex chars,
 * ~4 bits/char) and must never block a push. It only matters combined with `KEY_LIKE_FIELD_NAME`: field
 * CONTEXT, not the string's own shape, is what tells a hash apart from a secret (this task's own named
 * "tricky negative" — content hashes are high-entropy but fine because of field context).
 */
function looksRandomlyGenerated(value) {
  return value.length >= MIN_HIGH_ENTROPY_LENGTH && shannonEntropyBitsPerChar(value) >= HIGH_ENTROPY_BITS_PER_CHAR;
}

/** `null`, or the name of the first matching pattern — exported so tests can check pattern selection directly, not just the throw/pass-through boundary. */
export function matchCredentialPattern(value) {
  for (const p of PATTERNS) {
    if (p.re.test(value)) return p.name;
  }
  return null;
}

/**
 * Scans every STRING field of `row`. Throws `RedactionError` naming the field (never echoing the value) on
 * the first match; returns `row` completely unchanged otherwise. Field iteration order is `Object.keys(row)`'s
 * own order — deterministic for a given row shape, not alphabetized, since nothing here needs a canonical
 * scan order beyond "always finds the same first hit for the same input."
 */
export function redactRow(row) {
  for (const [field, value] of Object.entries(row)) {
    if (typeof value !== 'string') continue;

    const pattern = matchCredentialPattern(value);
    if (pattern) {
      throw new RedactionError(`field "${field}" matches a credential pattern (${pattern}) — value withheld, row not pushed this cycle`);
    }
    if (KEY_LIKE_FIELD_NAME.test(field) && looksRandomlyGenerated(value)) {
      throw new RedactionError(`field "${field}" looks like a high-entropy secret (key-shaped field name + randomly-generated-looking value) — value withheld, row not pushed this cycle`);
    }
  }
  return row;
}
