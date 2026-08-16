// SPDX-License-Identifier: AGPL-3.0-only
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ingestRows } from './ontology.js';

/**
 * Org-knowledge import (G6.1): `fleetsmith grid import <path|dir> --kind meeting|discussion|decision|spec
 * [--client <name>] [--date <YYYY-MM-DD>] [--apply]` turns meeting notes, discussion write-ups, decision
 * records, and specs into provenance-tracked `OrgDocument` rows (G2.1's ontology) — one row per chunk, keyed
 * by content hash.
 *
 * Two-phase by design, mirroring this package's other "never surprise a user" conventions:
 *  - `planImport()` is pure I/O-in, no-network: reads files, chunks them, computes hashes. This is what
 *    `--dry-run` (the default — `--apply` is required to actually ingest anything) reports.
 *  - `applyImport()` is the only function that touches the network, and only ever ingests rows whose
 *    `content_hash` is not already recorded in `_fleet/local/grid/imported.json` — the same client-side
 *    digest-skip shape `push.js`'s `pushed.json` already established, for the same reason: RelataDB has no
 *    server-side dedup on `/ingest` (verified in G2.1 — two writes to the same key produce two bi-temporal
 *    versions, not one row overwritten), so "idempotent re-import" is a client-side bookkeeping concern, not
 *    an engine guarantee.
 *
 * `valid_from` (the document's own business date — the meeting date, not the import date) is a PLAIN DATA
 * FIELD on the row, not an engine-level bi-temporal parameter — the engine's own system-time versioning is
 * separate, verified not to be client-settable (G3.3's `_system_from` findings), and this module never tries
 * to set it. Per-file: `--date` if given, else the file's own mtime (with a warning — an approximation, not a
 * real business date).
 *
 * Chunking is markdown-heading-aware for `.md`/`.markdown` (split on headings, then paragraphs, packed to
 * `DEFAULT_MAX_CHUNK_CHARS`, each chunk carrying its heading path as a prefix so an isolated chunk recalled
 * later still shows what section it came from) and speaker-turn-aware for anything else (plain-text
 * transcripts: split on blank lines or a "Name: ..." turn boundary). Deliberately regex/heuristic, not a real
 * parser — the same trade-off `declared.js` (G2.3) already made for this one-runtime-dependency project.
 */

export const DEFAULT_MAX_CHUNK_CHARS = 2000;
const IMPORTABLE_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const DEFAULT_PURPOSE = 'product_context';
const PURPOSE_BY_KIND = { decision: 'decision_rationale' };
const SKIP_DIRS = new Set(['node_modules', '.git']);

export class ImportError extends Error {}

function hashChunk(text) {
  return createHash('sha256').update(text).digest('hex');
}

// --- chunking ------------------------------------------------------------------------

/** One heading-delimited section of a markdown file: its heading path (e.g. ["Meeting notes", "Decisions"]) and the raw body lines under it, up to (not including) the next heading of any level. */
function parseHeadingSections(markdown) {
  const sections = [];
  let stack = [];
  let currentBody = [];

  function flush() {
    if (currentBody.some((l) => l.trim())) sections.push({ headingPath: [...stack], bodyLines: currentBody });
    currentBody = [];
  }

  for (const line of markdown.split('\n')) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      stack = stack.slice(0, level - 1);
      stack[level - 1] = m[2].trim();
      continue;
    }
    currentBody.push(line);
  }
  flush();
  return sections;
}

/** Blank-line-separated blocks, trimmed, empties dropped. */
function paragraphsFrom(lines) {
  const paragraphs = [];
  let current = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (current.length) paragraphs.push(current.join('\n').trim());
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) paragraphs.push(current.join('\n').trim());
  return paragraphs.filter(Boolean);
}

/** Packs `blocks` into chunks of up to `maxChars`, never splitting a block itself — a single block longer than `maxChars` still becomes its own (oversized) chunk rather than being cut mid-thought. */
function packBlocks(blocks, maxChars) {
  const chunks = [];
  let buf = '';
  for (const block of blocks) {
    const candidate = buf ? `${buf}\n\n${block}` : block;
    if (candidate.length > maxChars && buf) {
      chunks.push(buf);
      buf = block;
    } else {
      buf = candidate;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/** `[{headingPath: string[], text: string}]` — heading-path-aware chunking for markdown. Each section's paragraphs are packed independently, so a chunk never straddles a heading boundary. */
export function chunkMarkdown(content, { maxChars = DEFAULT_MAX_CHUNK_CHARS } = {}) {
  const chunks = [];
  for (const section of parseHeadingSections(content)) {
    const paragraphs = paragraphsFrom(section.bodyLines);
    if (paragraphs.length === 0) continue;
    for (const text of packBlocks(paragraphs, maxChars)) chunks.push({ headingPath: section.headingPath, text });
  }
  return chunks;
}

/** A plain-text "turn" is a blank-line-separated block, OR a new block started by a "Name: ..." speaker-turn line — the common shape of a dumped call transcript. */
function turnsFromPlainText(content) {
  const speakerLine = /^[A-Za-z][A-Za-z0-9 ._'-]{0,40}:\s*/;
  const turns = [];
  let current = [];
  for (const line of content.split('\n')) {
    if (line.trim() === '') {
      if (current.length) turns.push(current.join('\n').trim());
      current = [];
      continue;
    }
    if (speakerLine.test(line) && current.length) {
      turns.push(current.join('\n').trim());
      current = [line];
      continue;
    }
    current.push(line);
  }
  if (current.length) turns.push(current.join('\n').trim());
  return turns.filter(Boolean);
}

/** `[{headingPath: [], text: string}]` — no heading structure in plain text, so every chunk's `headingPath` is empty. */
export function chunkPlainText(content, { maxChars = DEFAULT_MAX_CHUNK_CHARS } = {}) {
  return packBlocks(turnsFromPlainText(content), maxChars).map((text) => ({ headingPath: [], text }));
}

/** Dispatches on extension: `.md`/`.markdown` gets heading-aware chunking, everything else gets speaker-turn chunking. */
export function chunkFile(filePath, content, opts = {}) {
  const ext = path.extname(filePath).toLowerCase();
  return MARKDOWN_EXTENSIONS.has(ext) ? chunkMarkdown(content, opts) : chunkPlainText(content, opts);
}

/** Renders one chunk's stored `chunk_text`: the heading path prefixed as nested markdown headings (so a reader — or a future re-chunker — sees the same structure the source document had), then the chunk's own text. A chunk with no heading path (plain text, or a markdown file's preamble before any heading) is stored as-is. */
function renderChunkText(chunk) {
  if (chunk.headingPath.length === 0) return chunk.text;
  const prefix = chunk.headingPath.map((title, i) => `${'#'.repeat(i + 1)} ${title}`).join(' > ');
  return `${prefix}\n\n${chunk.text}`;
}

// --- file discovery, title/date derivation --------------------------------------------

/** `pathOrDir` -> every importable file under it (or itself, if a file) — `.md`/`.markdown`/`.txt` only, skipping `node_modules`/`.git`. Sorted for a deterministic plan across runs. */
function resolveFiles(pathOrDir, warnings) {
  let stat;
  try {
    stat = fs.statSync(pathOrDir);
  } catch (e) {
    warnings.push(`could not stat "${pathOrDir}": ${e.message}`);
    return [];
  }
  if (stat.isFile()) return [pathOrDir];

  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (IMPORTABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full);
    }
  };
  walk(pathOrDir);
  return files.sort();
}

/** The file's own H1 heading, else its first non-blank line (if short enough to plausibly be a title), else the filename without extension. */
function deriveTitle(filePath, content) {
  const h1 = /^#\s+(.+)$/m.exec(content);
  if (h1) return h1[1].trim();
  const firstLine = content.split('\n').find((l) => l.trim());
  if (firstLine && firstLine.trim().length <= 120) return firstLine.trim();
  return path.basename(filePath, path.extname(filePath));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `--date` if given and well-formed; else the file's own mtime, with a warning — an approximation of the real business date, not a substitute for passing `--date` explicitly. */
function resolveValidFrom(filePath, explicitDate, warnings) {
  if (explicitDate) {
    if (!DATE_RE.test(explicitDate)) throw new ImportError(`--date "${explicitDate}" is not a YYYY-MM-DD date`);
    return explicitDate;
  }
  const mtimeDate = fs.statSync(filePath).mtime.toISOString().slice(0, 10);
  warnings.push(`no --date given for "${filePath}" — using its file mtime (${mtimeDate}) as valid_from; pass --date for the real business date`);
  return mtimeDate;
}

// --- planning (dry-run) ---------------------------------------------------------------

/**
 * Reads and chunks every importable file under `pathOrDir`, producing the exact `OrgDocument` rows an
 * `applyImport()` call would ingest — but touches no network. This is what `--dry-run` (the default) shows: a
 * caller can inspect `plan[].rows` for file/chunk counts and content hashes before ever calling `applyImport`.
 * Never throws for a single bad file (unreadable, empty) — skipped with a warning; only a malformed `--date`
 * is a hard `ImportError`, since that is a caller mistake affecting every file in this batch.
 */
export function planImport(pathOrDir, { kind, client = '', date = null, actor, repoDir = process.cwd() } = {}) {
  if (!kind) throw new ImportError('planImport requires a `kind` (one of meeting, discussion, decision, spec)');
  const warnings = [];
  const files = resolveFiles(pathOrDir, warnings);
  const plan = [];

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (e) {
      warnings.push(`could not read "${file}": ${e.message}`);
      continue;
    }
    const chunks = chunkFile(file, content);
    if (chunks.length === 0) {
      warnings.push(`"${file}" produced no chunks (empty or whitespace-only) — skipped`);
      continue;
    }

    const validFrom = resolveValidFrom(file, date, warnings);
    const title = deriveTitle(file, content);
    const sourceFile = path.relative(repoDir, file);

    const rows = chunks.map((chunk, chunk_index) => {
      const chunk_text = renderChunkText(chunk);
      return {
        content_hash: hashChunk(chunk_text),
        kind,
        title,
        client,
        chunk_index,
        chunk_text,
        source_file: sourceFile,
        imported_by: actor,
        valid_from: validFrom,
        purpose: PURPOSE_BY_KIND[kind] ?? DEFAULT_PURPOSE,
        origin: 'human',
      };
    });

    plan.push({ file, sourceFile, title, validFrom, rows });
  }

  return { plan, warnings };
}

// --- apply (the only network-touching step) --------------------------------------------

function importedHashesPath(localDir) {
  return path.join(localDir, 'grid', 'imported.json');
}

function readImportedHashes(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // missing or corrupt — self-heals via a full re-check of every chunk's hash, same as pushed.json
  }
}

function writeImportedHashes(filePath, hashes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(hashes, Object.keys(hashes).sort(), 2)}\n`);
}

/**
 * Ingests every row in `plan` whose `content_hash` is not already recorded in
 * `_fleet/local/grid/imported.json` — the client-side idempotency mechanism this module relies on instead of
 * server-side dedup (RelataDB has none). Re-running `applyImport` with an unchanged `plan` therefore ingests
 * zero rows the second time; a changed file produces new hashes only for its changed chunks, not the whole
 * file. Never throws for one file's ingest failure — collected into `warnings`, retried on the next apply.
 */
export async function applyImport(config, plan, { localDir, repoId }) {
  const hashesPath = importedHashesPath(localDir);
  const known = readImportedHashes(hashesPath);
  const warnings = [];
  let ingested = 0;
  let skipped = 0;

  for (const fileEntry of plan) {
    const newRows = fileEntry.rows.filter((r) => !known[r.content_hash]).map((r) => ({ ...r, repo_id: repoId }));
    skipped += fileEntry.rows.length - newRows.length;
    if (newRows.length === 0) continue;

    try {
      await ingestRows(config, 'OrgDocument', newRows);
      for (const r of newRows) known[r.content_hash] = true;
      ingested += newRows.length;
    } catch (e) {
      warnings.push(`OrgDocument ingest failed for "${fileEntry.sourceFile}": ${e.message}`);
    }
  }

  writeImportedHashes(hashesPath, known);
  return { ingested, skipped, warnings };
}
