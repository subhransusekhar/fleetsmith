/**
 * The memory port — a backend-agnostic interface for everything a fleet
 * remembers.
 *
 * Today memory is real but implicit and scattered: run events in JSONL,
 * learned bullets in markdown playbooks, promotion verdicts in decisions.jsonl,
 * per-agent notes, the ledger. Nothing names the operations, so there is no
 * seam to put a different backend behind — and no way to offer richer memory to
 * deployments that need semantic recall, provenance, or multi-tenancy without
 * rewriting every call site.
 *
 * Five verbs, deliberately mirroring RelataDB's vocabulary because that
 * vocabulary is sensible independent of backend: an agent memory needs to
 * record, retrieve, consolidate, evict, and explain. The file backend
 * (`src/memory/file.js`) implements all five over the artifacts that already
 * exist, and remains the default and the only bundled implementation.
 *
 * ## Two rules that keep this honest
 *
 * **`purpose` is required on `recall`.** RelataDB rejects a query without a
 * registered purpose (HTTP 400). Making it mandatory here means the file
 * backend cannot quietly accept queries the real one refuses — which is the
 * usual way a "portable" interface stops being portable, one permissive
 * default at a time.
 *
 * **No capability may be backend-only.** Every operation must have a file
 * backend answer, even a degraded one. Open-core projects rot precisely when
 * the free path becomes a stub, and a fleet that cannot run without a database
 * is not the thing this project ships.
 */

/** Kinds of thing a fleet remembers. Each maps to a distinct file artifact. */
export const ITEM_KINDS = ['lesson', 'event', 'decision', 'note'];

/**
 * The interface every backend implements. Documented as a shape rather than a
 * base class: a backend is a plain object, which keeps the fake used in tests
 * honest — it cannot inherit behaviour it did not implement.
 *
 * @typedef {object} MemoryBackend
 * @property {(item: MemoryItem) => Promise<{id: string, merged?: string}>} remember
 * @property {(query: string, opts: RecallOptions) => Promise<MemoryItem[]>} recall
 * @property {(opts?: {kind?: string}) => Promise<{before: number, after: number}>} consolidate
 * @property {(selector: ForgetSelector) => Promise<{removed: string[]}>} forget
 * @property {(id: string) => Promise<Justification|null>} justify
 *
 * @typedef {object} MemoryItem
 * @property {string} [id]
 * @property {string} kind          one of ITEM_KINDS
 * @property {string} text          the content itself
 * @property {string} [subject]     what it is about (agent name, skill name)
 * @property {'human'|'evolved'} origin
 * @property {string[]} [evidence]  run ids, eval ids, file:line references
 * @property {number} [helpful]
 * @property {number} [harmful]
 *
 * @typedef {object} RecallOptions
 * @property {string} purpose       REQUIRED — why this is being read
 * @property {string} [kind]
 * @property {string} [subject]
 * @property {number} [limit]
 *
 * @typedef {object} ForgetSelector
 * @property {string} [id]
 * @property {string} [kind]
 * @property {string} [subject]
 * @property {number} [utilityBelow]  evict below this helpful-to-harmful ratio
 *
 * @typedef {object} Justification
 * @property {string} id
 * @property {string} text
 * @property {string[]} evidence
 * @property {string} origin
 * @property {object} [counters]
 */

export class MemoryError extends Error {}

/** Reject anything the strictest backend would reject, in every backend. */
export function assertValidItem(item) {
  if (!item || typeof item !== 'object') throw new MemoryError('a memory item must be an object');
  if (!ITEM_KINDS.includes(item.kind)) {
    throw new MemoryError(`unknown item kind "${item.kind}" (expected: ${ITEM_KINDS.join(', ')})`);
  }
  if (!item.text || !String(item.text).trim()) throw new MemoryError('a memory item needs text');
  if (item.origin && item.origin !== 'human' && item.origin !== 'evolved') {
    throw new MemoryError(`origin must be "human" or "evolved", got "${item.origin}"`);
  }
}

export function assertValidRecall(opts) {
  if (!opts || !opts.purpose || !String(opts.purpose).trim()) {
    throw new MemoryError(
      'recall requires a `purpose`. It is not bookkeeping: the RelataDB backend rejects ' +
        'purposeless queries outright, and allowing them here would let the file backend accept ' +
        'what the real one refuses.'
    );
  }
  if (opts.kind && !ITEM_KINDS.includes(opts.kind)) {
    throw new MemoryError(`unknown item kind "${opts.kind}"`);
  }
}

/**
 * The contract suite every backend must pass.
 *
 * Exported so the file backend, the RelataDB adapter, and any fake are held to
 * the same behaviour by the same assertions rather than by three
 * near-identical test files that drift apart.
 *
 * `assert` is injected so this module stays dependency-free.
 */
export async function runContract(makeBackend, assert) {
  const b = await makeBackend();

  // remember -> recall round trip
  const { id } = await b.remember({
    kind: 'lesson',
    text: 'Write the handoff file before finishing; the gate blocks otherwise.',
    subject: 'analyst',
    origin: 'evolved',
    evidence: ['gate_block: no handoff file'],
  });
  assert.ok(id, 'remember must return an id');

  const found = await b.recall('handoff file', { purpose: 'contract-test' });
  assert.ok(
    found.some((i) => i.id === id),
    'a remembered item must be recallable'
  );

  // purpose is mandatory
  await assert.rejects(() => b.recall('anything', {}), /purpose/i);

  // kind and subject filter
  const bySubject = await b.recall('handoff', { purpose: 'contract-test', subject: 'analyst' });
  assert.ok(bySubject.length > 0, 'subject filter must match');
  const wrongSubject = await b.recall('handoff', { purpose: 'contract-test', subject: 'nobody' });
  assert.equal(wrongSubject.length, 0, 'subject filter must exclude');

  // justify explains provenance
  const why = await b.justify(id);
  assert.ok(why, 'justify must find a remembered item');
  assert.equal(why.origin, 'evolved');
  assert.deepEqual(why.evidence, ['gate_block: no handoff file']);
  assert.equal(await b.justify('no-such-id'), null, 'justify must return null for an unknown id');

  // invalid items are refused
  await assert.rejects(() => b.remember({ kind: 'nonsense', text: 'x' }), /unknown item kind/);
  await assert.rejects(() => b.remember({ kind: 'lesson', text: '  ' }), /needs text/);

  // consolidate is idempotent on an already-clean store
  const first = await b.consolidate();
  assert.ok(typeof first.before === 'number' && typeof first.after === 'number');
  const second = await b.consolidate();
  assert.equal(second.before, second.after, 'consolidate must be idempotent once clean');

  // forget removes, and reports what it removed
  const { removed } = await b.forget({ id });
  assert.deepEqual(removed, [id]);
  assert.equal(await b.justify(id), null, 'a forgotten item must not be justifiable');
}
