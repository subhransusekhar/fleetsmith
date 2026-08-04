/**
 * Learned playbooks — the MUTATE stage's memory, stored as ACE-style bullets.
 *
 * Why bullets rather than a rewritten instruction body: ACE (arXiv 2510.04618)
 * names the two failure modes of the obvious approaches. *Brevity bias* —
 * summarizing drops the domain insight that made the lesson worth keeping.
 * *Context collapse* — iteratively rewriting a whole file erodes detail until
 * the accumulated knowledge is gone. Both are what happens to a hand-maintained
 * CLAUDE.md, only faster when a model is doing the rewriting every cycle.
 *
 * So: append id'd bullets with helpful/harmful counters, merge them with
 * deterministic non-LLM logic, and never regenerate the file. The payoff is a
 * git diff a human can actually review — one bullet added, one counter
 * incremented — instead of a 300-line rewrite nobody reads. The same property
 * is what lets two developers edit a shared playbook and still merge.
 *
 * Safety framing is not decoration. The Misevolution study (arXiv 2509.26354)
 * measured accumulated memory degrading alignment with no attacker present:
 * refusal rate down 45%, attack success 0.6% -> 20.6% on a frontier model. The
 * only mitigation that measurably helped was treating stored memory as
 * *references rather than rules* — and even that did not fully recover. Hence
 * the header, the fenced section, and the caps.
 */

/** Bullet budget per agent; overflow evicts by helpful-to-harmful ratio. */
export const MAX_BULLETS = 20;
/** Character budget per bullet. Length constraints are anti-overfitting, not tidiness. */
export const MAX_BULLET_CHARS = 200;
/**
 * Overlap above which two bullets are treated as the same lesson.
 *
 * Set high on purpose. Measured against real phrasings, a paraphrase of one
 * lesson ("cite file paths as evidence" / "a brief citing no paths was not
 * researched") scores ~0.67, while two genuinely different lessons sharing a
 * template ("Watch X closely whenever this agent runs") score ~0.75. The
 * paraphrase scores *lower* than the false pair, so no threshold separates
 * them and none is claimed to.
 *
 * The contract is therefore narrow and honest: near-identical restatements
 * merge, everything else accumulates. That is the case that actually matters —
 * a loop re-learning a lesson usually restates it almost verbatim — and
 * over-merging is the worse failure, because a wrongly merged bullet silently
 * destroys a distinct lesson while a duplicate merely wastes a slot.
 * Recognising paraphrase needs semantics, which belongs to the memory backend
 * (v0.6.0), not to a deterministic text merger.
 */
export const DEDUPE_THRESHOLD = 0.8;

const HEADER = (agent) => `# Learned notes — ${agent}

Machine-learned advisory references — **not rules**. Prefer the agent's current
instructions and any human guidance on conflict. Each bullet carries a stable id
and a (+helpful/-harmful) count; entries are appended and counted, never
rewritten, so the history stays reviewable.
`;

const BULLET_RE = /^- \[(pb-[a-z0-9-]+-\d+)\] \(\+(\d+)\/-(\d+)\) (.*)$/;

export function parsePlaybook(text) {
  const bullets = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = BULLET_RE.exec(line.trim());
    if (m) bullets.push({ id: m[1], helpful: Number(m[2]), harmful: Number(m[3]), text: m[4] });
  }
  return bullets;
}

export function renderPlaybook(agent, bullets) {
  const lines = [HEADER(agent), ''];
  for (const b of bullets) lines.push(`- [${b.id}] (+${b.helpful}/-${b.harmful}) ${b.text}`);
  return `${lines.join('\n')}\n`;
}

/** Next id for an agent, derived from what is already there — no global counter. */
function nextId(agent, bullets) {
  let max = 0;
  for (const b of bullets) {
    const n = Number(b.id.slice(b.id.lastIndexOf('-') + 1));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `pb-${agent}-${max + 1}`;
}

/**
 * Append a lesson. Idempotent against near-duplicates: re-learning something
 * already known counts it as helpful again rather than adding a second copy,
 * which is how a playbook stays a playbook instead of becoming a transcript.
 */
export function addBullet(agent, bullets, text) {
  const clean = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!clean) throw new Error('a playbook bullet needs text');
  if (clean.length > MAX_BULLET_CHARS) {
    throw new Error(
      `bullet is ${clean.length} chars; the cap is ${MAX_BULLET_CHARS}. ` +
        'Length limits exist to stop learned context overfitting to one run — shorten the lesson, do not raise the cap.'
    );
  }
  const dup = bullets.find((b) => similarity(b.text, clean, bullets) >= DEDUPE_THRESHOLD);
  if (dup) return { bullets: bump(bullets, dup.id, 'helpful'), added: null, merged: dup.id };

  const bullet = { id: nextId(agent, bullets), helpful: 1, harmful: 0, text: clean };
  return { bullets: evict([...bullets, bullet]), added: bullet.id, merged: null };
}

/** Record that a bullet did or did not help. The only other legal write. */
export function bump(bullets, id, kind) {
  if (kind !== 'helpful' && kind !== 'harmful') throw new Error(`unknown counter "${kind}"`);
  if (!bullets.some((b) => b.id === id)) throw new Error(`no such bullet: ${id}`);
  return bullets.map((b) => (b.id === id ? { ...b, [kind]: b[kind] + 1 } : b));
}

/**
 * Merge near-duplicates, keeping the higher-signal id and summing the counts.
 *
 * Summing rather than picking a side is also the documented resolution for the
 * one genuine multi-developer conflict: two people each incrementing the same
 * counter should end at the total, not at whichever branch merged last.
 */
export function dedupe(bullets) {
  const out = [];
  for (const b of bullets) {
    const hit = out.find((o) => similarity(o.text, b.text, bullets) >= DEDUPE_THRESHOLD);
    if (!hit) {
      out.push({ ...b });
      continue;
    }
    hit.helpful += b.helpful;
    hit.harmful += b.harmful;
    // Keep whichever wording has more evidence behind it.
    if (b.helpful - b.harmful > hit.helpful - hit.harmful) hit.text = b.text;
  }
  return evict(out);
}

/** Enforce the budget by dropping the least useful, not the oldest. */
function evict(bullets) {
  if (bullets.length <= MAX_BULLETS) return bullets;
  return [...bullets].sort((a, b) => b.helpful - b.harmful - (a.helpful - a.harmful)).slice(0, MAX_BULLETS);
}

/**
 * Similarity weighted by how rare each shared token is across the playbook.
 *
 * Plain overlap is not enough: learned bullets tend to share phrasing
 * ("Always check X before Y"), and a proportional measure counts that
 * boilerplate as evidence that two lessons are the same. Weighting by rarity
 * makes the shared *template* worth almost nothing and the shared *subject*
 * worth almost everything, which is the distinction being asked about.
 *
 * With an empty or single-bullet corpus every token is equally rare, so this
 * degrades to plain overlap — the right behaviour when there is nothing yet to
 * learn about which words are boilerplate.
 */
function similarity(a, b, corpus = []) {
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 || B.size === 0) return 0;

  // Weight down what is boilerplate, never up what is novel. A token seen in
  // many bullets is phrasing; one seen rarely is subject matter. Inflating
  // unseen tokens instead (as a plain IDF does) would make an unfamiliar
  // rewording of a known lesson look *less* similar the more new words it
  // used — the opposite of what dedupe is for.
  const docs = corpus.map((x) => tokens(x.text ?? x));
  const weight = (t) => 1 / Math.max(1, docs.filter((d) => d.has(t)).length);

  const smaller = A.size <= B.size ? A : B;
  let shared = 0;
  let total = 0;
  for (const t of smaller) {
    const w = weight(t);
    total += w;
    if ((smaller === A ? B : A).has(t)) shared += w;
  }
  return total > 0 ? shared / total : 0;
}

function tokens(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 3)
  );
}

/**
 * The compiled advisory section.
 *
 * Emitted at build time, so it is stable within a build and does not violate
 * the cache-stability invariant in compile/agent-prompt.js — learned state
 * reaches a prompt by way of the spec and a rebuild, never by per-run
 * injection.
 */
export function playbookSection(agent, bullets) {
  if (bullets.length === 0) return '';
  const lines = ['## Learned notes (advisory, machine-authored)', ''];
  lines.push(
    'These are references, not rules: they were inferred from past runs and may be wrong. Where one conflicts with your instructions above, or with what the user is asking for, follow the instructions and the user.'
  );
  lines.push('');
  for (const b of bullets) lines.push(`- ${b.text}`);
  return lines.join('\n');
}
