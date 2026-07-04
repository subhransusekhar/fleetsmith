import fs from 'node:fs';
import path from 'node:path';

/**
 * A FileSet is the universal output of every adapter: a map of
 * relative path -> file content. Keeping generation pure (no I/O)
 * makes adapters trivially testable and lets the CLI do dry runs.
 */
export class FileSet {
  constructor() {
    this.files = new Map();
  }

  add(relPath, content) {
    if (this.files.has(relPath)) {
      throw new Error(`FileSet collision: ${relPath} written twice`);
    }
    this.files.set(relPath, content);
    return this;
  }

  merge(other) {
    for (const [p, c] of other.files) this.add(p, c);
    return this;
  }

  /** Write all files under outDir. Returns list of written paths. */
  write(outDir, { force = false } = {}) {
    const written = [];
    for (const [rel, content] of this.files) {
      const abs = path.join(outDir, rel);
      if (!force && fs.existsSync(abs)) {
        const existing = fs.readFileSync(abs, 'utf8');
        if (existing === content) continue; // unchanged, skip silently
        throw new Error(
          `Refusing to overwrite existing file: ${abs} (pass --force to overwrite)`
        );
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      written.push(rel);
    }
    return written;
  }

  list() {
    return [...this.files.keys()].sort();
  }
}
