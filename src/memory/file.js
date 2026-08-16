import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { assertValidItem, assertValidRecall, MemoryError } from './port.js';
import { parsePlaybook, renderPlaybook, addBullet, bump, dedupe } from '../playbook/index.js';
import { registerMemoryBackend } from '../lib/registry.js';

/**
 * The file backend — the default, and the only bundled, memory implementation.
 *
 * It is deliberately not a new store. Every verb maps onto an artifact the
 * fleet already produces, so adopting the port changes no on-disk format and
 * loses nothing:
 *
 * | kind       | lives in                              | tier |
 * |------------|---------------------------------------|------|
 * | `lesson`   | `shared/playbooks/<subject>.md`       | committed |
 * | `decision` | `shared/evolution/decisions.jsonl`    | committed |
 * | `event`    | `local/runs/<run>/events.jsonl`       | local |
 * | `note`     | `local/notes/<subject>.md`            | local |
 *
 * That mapping is the reason this backend must stay complete forever: it is
 * not a stub standing in for a database, it is where a fleet's memory actually
 * is. An enterprise backend adds semantic recall, provenance queries, and
 * multi-tenancy on top — it does not replace this.
 *
 * Recall is token-overlap ranking, with no embedding dependency, for the same
 * reason `fleetsmith health` uses it: this project ships one runtime
 * dependency, and lexical retrieval over a few hundred bullets is adequate.
 * Where it is not adequate is exactly the case the RelataDB adapter exists for.
 *
 * **Org knowledge (v0.7.0 G6.4) — the file-backend counterpart to the RelataDB adapter's `OrgDocument`
 * union (G6.3, `ee/src/memory/relatadb.js`).** Rule 3 of that milestone ("nothing is ee-only") applied to
 * org knowledge specifically: `shared/knowledge/<name>.md` — committed, PR-reviewed markdown with a small
 * YAML frontmatter block (`kind`, `client`, `date`, `source`) — is scanned, heading-chunked, and
 * token-overlap ranked for the SAME fixed allowlist of org purposes G6.3 uses, returning items in the exact
 * same provenance-string shape (`"<source> (<kind>[, <client>], <date>)"`) so a skill's recall instructions
 * stay backend-agnostic. `ORG_RECALL_PURPOSES`/the kind mapping are independently duplicated from
 * `relatadb.js`'s own copies, not imported — core (this file) must never import from `ee/`, and keeping two
 * small, hand-synced lists is the same trade-off `ee/src/grid/project.js` already makes for
 * `FleetTask.status`. **`remember` never writes here** — knowledge enters through `fleetsmith grid import`
 * (ee/) or a hand-authored PR, the same trust model as a playbook bullet added by hand vs. one written
 * through the port; there is no `'knowledge'` `ITEM_KIND` for an agent to even attempt it with.
 */

export function fileBackend({ spec, cwd = process.cwd() } = {}) {
  if (!spec) throw new MemoryError('the file backend needs a spec to locate the workspace');
  const shared = path.join(cwd, spec.fleet.shared);
  const local = path.join(cwd, spec.fleet.local);

  const paths = {
    playbook: (subject) => path.join(shared, 'playbooks', `${subject}.md`),
    decisions: path.join(shared, 'evolution/decisions.jsonl'),
    notes: (subject) => path.join(local, 'notes', `${subject}.md`),
    runs: path.join(local, 'runs'),
    knowledge: path.join(shared, 'knowledge'),
  };

  return {
    async remember(item) {
      assertValidItem(item);
      const subject = item.subject ?? 'fleet';
      switch (item.kind) {
        case 'lesson': {
          // Reuses the ACE bullet machinery rather than a parallel format, so
          // a lesson written through the port and one written by
          // `fleetsmith playbook add` are the same thing.
          const file = paths.playbook(subject);
          const before = fs.existsSync(file) ? parsePlaybook(fs.readFileSync(file, 'utf8')) : [];
          const res = addBullet(subject, before, item.text);
          write(file, renderPlaybook(subject, res.bullets));
          if (res.merged) return { id: res.merged, merged: res.merged };
          rememberEvidence(shared, res.added, item.evidence ?? []);
          return { id: res.added };
        }
        case 'decision': {
          const id = `dec-${hash(item.text)}`;
          appendLine(paths.decisions, { id, ...item, ts: item.ts ?? null });
          return { id };
        }
        case 'note': {
          const file = paths.notes(subject);
          const id = `note-${hash(item.text)}`;
          appendText(file, `\n- [${id}] ${item.text}\n`);
          return { id };
        }
        case 'event': {
          // Events are written by the run logger, not by callers. Accepting
          // them here would create a second writer for an append-only log that
          // a shell script owns, and two writers is how a log gets corrupted.
          throw new MemoryError(
            'events are recorded by the run logger (scripts/log-event.sh), not through the memory port'
          );
        }
        default:
          throw new MemoryError(`unhandled kind "${item.kind}"`);
      }
    },

    async recall(query, opts = {}) {
      assertValidRecall(opts);
      const items = readAll(paths, spec);
      if (ORG_RECALL_PURPOSES.includes(opts.purpose)) items.push(...readKnowledge(paths));
      const q = tokens(query);
      return items
        .filter((i) => (opts.kind ? i.kind === opts.kind : true))
        .filter((i) => (opts.subject ? i.subject === opts.subject : true))
        .map((i) => ({ item: i, score: overlap(q, tokens(i.text)) }))
        // A zero-overlap item is not a weak match, it is not a match.
        .filter((r) => r.score > 0 || q.size === 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, opts.limit ?? 10)
        .map((r) => r.item);
    },

    async consolidate({ kind = 'lesson' } = {}) {
      if (kind !== 'lesson') return { before: 0, after: 0 };
      const dir = path.join(shared, 'playbooks');
      if (!fs.existsSync(dir)) return { before: 0, after: 0 };
      let before = 0;
      let after = 0;
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
        const subject = f.replace(/\.md$/, '');
        const bullets = parsePlaybook(fs.readFileSync(path.join(dir, f), 'utf8'));
        const merged = dedupe(bullets);
        before += bullets.length;
        after += merged.length;
        if (merged.length !== bullets.length) write(path.join(dir, f), renderPlaybook(subject, merged));
      }
      return { before, after };
    },

    async forget(selector = {}) {
      const removed = [];
      const dir = path.join(shared, 'playbooks');
      if (!fs.existsSync(dir)) return { removed };
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
        const subject = f.replace(/\.md$/, '');
        if (selector.subject && selector.subject !== subject) continue;
        const bullets = parsePlaybook(fs.readFileSync(path.join(dir, f), 'utf8'));
        const keep = bullets.filter((b) => {
          if (selector.id) return b.id !== selector.id;
          if (typeof selector.utilityBelow === 'number') {
            const total = b.helpful + b.harmful;
            return total === 0 || b.helpful / total >= selector.utilityBelow;
          }
          return true;
        });
        for (const b of bullets) if (!keep.includes(b)) removed.push(b.id);
        if (keep.length !== bullets.length) write(path.join(dir, f), renderPlaybook(subject, keep));
      }
      return { removed };
    },

    async justify(id) {
      for (const item of readAll(paths, spec)) {
        if (item.id !== id) continue;
        return {
          id,
          text: item.text,
          evidence: item.evidence ?? readEvidence(shared, id),
          origin: item.origin ?? 'evolved',
          counters: item.helpful === undefined ? undefined : { helpful: item.helpful, harmful: item.harmful },
        };
      }
      return null;
    },

    /** Record that a lesson did or did not help. */
    async count(subject, id, kind = 'helpful') {
      const file = paths.playbook(subject);
      if (!fs.existsSync(file)) throw new MemoryError(`no playbook for "${subject}"`);
      const bullets = bump(parsePlaybook(fs.readFileSync(file, 'utf8')), id, kind);
      write(file, renderPlaybook(subject, bullets));
      return { id, kind };
    },
  };
}

/**
 * Evidence sidecar.
 *
 * A playbook bullet's line format carries an id, counters, and text — adding
 * evidence to it would break `parsePlaybook` and make the file less readable,
 * which is most of why the format was chosen. So evidence lives beside it,
 * keyed by bullet id, and `justify` joins the two.
 */
function evidencePath(shared) {
  return path.join(shared, 'evolution/evidence.json');
}

function rememberEvidence(shared, id, evidence) {
  if (!id || evidence.length === 0) return;
  const file = evidencePath(shared);
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  all[id] = evidence;
  write(file, `${JSON.stringify(all, null, 2)}\n`);
}

function readEvidence(shared, id) {
  const file = evidencePath(shared);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))[id] ?? [];
  } catch {
    return [];
  }
}

/**
 * Purposes that pull `shared/knowledge/` into `recall()` — an independent, hand-synced duplicate of
 * `ee/src/memory/relatadb.js`'s own `ORG_RECALL_PURPOSES` (G6.3). Core must never import from `ee/`, so this
 * small list is kept identical by hand rather than shared; a caller-facing skill instruction is written once
 * against this fixed vocabulary and works unchanged on either backend.
 */
const ORG_RECALL_PURPOSES = ['product_context', 'client_commitment', 'decision_rationale'];

/** `OrgDocument.kind` (meeting/discussion/decision/spec — the same vocabulary `ee/src/grid/ontology.js` declares) has no 1:1 mapping onto `ITEM_KINDS` (`port.js`) — `decision` lines up directly, everything else is closest to `note`: an imported reference, not a learned `lesson` or a run `event`. */
const KNOWLEDGE_KIND_TO_ITEM_KIND = { decision: 'decision', meeting: 'note', discussion: 'note', spec: 'note' };

/** `---\n<yaml>\n---\n<body>` — a malformed or missing frontmatter block degrades to an empty frontmatter object and the whole file as body, never a throw: one badly-authored knowledge file must not break recall for every other one. */
function parseKnowledgeFile(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };
  let frontmatter;
  try {
    frontmatter = YAML.parse(m[1]);
  } catch {
    frontmatter = null;
  }
  return { frontmatter: frontmatter && typeof frontmatter === 'object' ? frontmatter : {}, body: m[2] };
}

/** One chunk per heading section (heading path + everything until the next heading of any level) — simpler than `ee/src/grid/import.js`'s own char-budget packer (independently written, not shared code; this file backend's own stated philosophy is that lexical retrieval over a modest corpus does not need that precision), but the same underlying idea: a citable, section-sized unit rather than "the whole file" or "one line." */
function chunkKnowledgeBody(body) {
  const chunks = [];
  let headingPath = [];
  let lines = [];
  const flush = () => {
    const text = lines.join('\n').trim();
    if (text) chunks.push({ headingPath: [...headingPath], text });
    lines = [];
  };
  for (const line of body.split('\n')) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      headingPath = headingPath.slice(0, level - 1);
      headingPath[level - 1] = m[2].trim();
      continue;
    }
    lines.push(line);
  }
  flush();
  return chunks;
}

/** `"<source> (<kind>[, <client>], <date>)"` — identical shape to G6.3's `orgDocumentProvenance`, so a skill's recall instructions read the same citation format regardless of which backend answered. `client` is omitted (not a bare double comma) when the frontmatter carries none. */
function knowledgeProvenance(frontmatter, filename) {
  const parts = [frontmatter.kind ?? 'unknown'];
  if (frontmatter.client) parts.push(frontmatter.client);
  parts.push(frontmatter.date ?? 'unknown-date');
  return `${frontmatter.source || filename} (${parts.join(', ')})`;
}

/** Every `shared/knowledge/*.md` file, heading-chunked, one `MemoryItem` per chunk — never called by `readAll()` itself, only from `recall()` and only for `ORG_RECALL_PURPOSES`, so a non-org recall never pays the cost of scanning this directory at all. */
function readKnowledge(paths) {
  const dir = paths.knowledge;
  if (!fs.existsSync(dir)) return [];
  const items = [];
  for (const filename of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const raw = fs.readFileSync(path.join(dir, filename), 'utf8');
    const { frontmatter, body } = parseKnowledgeFile(raw);
    chunkKnowledgeBody(body).forEach((chunk, i) => {
      const text = chunk.headingPath.length ? `${chunk.headingPath.join(' > ')}\n\n${chunk.text}` : chunk.text;
      items.push({
        id: `knowledge:${filename}:${i}`,
        kind: KNOWLEDGE_KIND_TO_ITEM_KIND[frontmatter.kind] ?? 'note',
        text,
        subject: frontmatter.client,
        origin: 'human',
        evidence: [knowledgeProvenance(frontmatter, filename)],
      });
    });
  }
  return items;
}

function readAll(paths, spec) {
  const items = [];
  const dir = path.dirname(paths.playbook('x'));
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      const subject = f.replace(/\.md$/, '');
      for (const b of parsePlaybook(fs.readFileSync(path.join(dir, f), 'utf8'))) {
        items.push({ ...b, kind: 'lesson', subject, origin: 'evolved' });
      }
    }
  }
  if (fs.existsSync(paths.decisions)) {
    for (const line of fs.readFileSync(paths.decisions, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        items.push({ ...d, kind: 'decision', text: d.text ?? d.reason ?? d.branch ?? '', origin: 'evolved' });
      } catch {
        /* a partial final line is normal while a run is in flight */
      }
    }
  }
  return items;
}

const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const appendLine = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
};
const appendText = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text);
};

function tokens(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2)
  );
}

function overlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / a.size;
}

/** Stable short id from content — no clock, so the same lesson keeps its id. */
function hash(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h).toString(36).slice(0, 8);
}

// Self-register through the plugin seam (src/lib/registry.js) so an OSS run
// exercises the exact path an ee memory backend would use, rather than that
// seam only ever being touched by an enterprise install. Runs once per
// process: ESM caches this module, so importing file.js from many call sites
// re-registers nothing.
registerMemoryBackend('file', (config) => fileBackend(config));
