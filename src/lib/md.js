import YAML from 'yaml';

/**
 * Serialize a markdown file with YAML frontmatter.
 * Keys with undefined/null values are dropped so adapters can pass
 * sparse objects without emitting noise.
 */
export function mdWithFrontmatter(frontmatter, body) {
  const clean = prune(frontmatter);
  const yaml = YAML.stringify(clean, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.trim()}\n`;
}

export function prune(obj) {
  if (Array.isArray(obj)) return obj.map(prune).filter((v) => v !== undefined);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      const p = prune(v);
      if (p !== undefined && !(typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length === 0)) {
        out[k] = p;
      }
    }
    return out;
  }
  return obj;
}

export function slugify(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
