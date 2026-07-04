import { buildClaudeCode } from './claude-code.js';
import { buildOpencode } from './opencode.js';
import { buildGoose } from './goose.js';
import { FileSet } from '../lib/fs-utils.js';

export const ADAPTERS = {
  'claude-code': buildClaudeCode,
  opencode: buildOpencode,
  goose: buildGoose,
};

/**
 * Build every target. Each adapter's files are disjoint by construction
 * (.claude/, .opencode/, .goose/) except shared scaffolding (workspace,
 * AGENTS.md), which is generated identically and deduplicated here.
 *
 * Skills are emitted once, to .claude/skills/ — both opencode and goose
 * read that directory natively (Claude-compatible search paths), so
 * duplicating them per tool would create three drift-prone copies.
 */
export function buildAll(spec, options = {}) {
  const out = new FileSet();
  const perAdapter = {
    'claude-code': options,
    opencode: { ...options, emitSkills: false },
    goose: { ...options, emitSkills: false },
  };
  for (const [name, build] of Object.entries(ADAPTERS)) {
    const fs = build(spec, perAdapter[name] ?? options);
    for (const [p, c] of fs.files) {
      if (out.files.has(p)) {
        if (out.files.get(p) !== c) {
          throw new Error(`Adapter "${name}" produced conflicting content for shared file ${p}`);
        }
        continue;
      }
      out.add(p, c);
    }
  }
  return out;
}
