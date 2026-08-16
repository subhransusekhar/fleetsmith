// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The overlap engine (G5.1): pure, zero-I/O detection of cross-actor collisions among ACTIVE
 * (`status === 'in-progress'`) `FleetTask` rows (G2.1). Deliberately dependency-free of both `fs` and
 * RelataDB — the milestone's own architecture calls this out as the deterministic core that must stay
 * reusable outside the grid entirely (G5.5 feeds it rows built straight from git, no cortex involved; the
 * real daemon feeds it rows reconciled from RelataDB — `findOverlaps` cannot tell the difference and must
 * not need to).
 *
 * Four kinds, each a genuinely different way two developers can be about to waste effort or step on each
 * other, ranked by how expensive discovering it late tends to be:
 *  - `artifact`   — two tasks claim the same output path. Whoever finishes second silently overwrites the
 *                   first, or the two never converge to one artifact at all.
 *  - `dependency-cycle` — `@a#1` depends on `@b#2` depends on `@a#1` (any length): neither side can actually
 *                   finish first, a promise the ledger notation lets someone make by accident.
 *  - `symbol`     — the same named thing declared twice, independently — the wasted-reimplementation case
 *                   the grid-awareness skill's reuse-before-write step exists to catch before it happens.
 *  - `file`       — same file, different symbols: not necessarily wrong, but a large-diff collision waiting
 *                   to happen at merge time.
 *
 * Symbol comparison is case-insensitive (`normalizeSymbol`), the same comparison key G2.3's `declaredSymbols`
 * already de-duplicates by — G2.3's own extraction only ever captures bare identifiers (never a qualified
 * `Class.method` form), so lowercasing is the whole normalization needed here too; there is no further
 * qualifier to strip.
 */

export const OVERLAP_KINDS = ['artifact', 'dependency-cycle', 'symbol', 'file'];

/** Lower rank = more severe. Used both to sort output and as the numeric `severity` field on each record. */
const SEVERITY_RANK = Object.fromEntries(OVERLAP_KINDS.map((kind, rank) => [kind, rank]));

function normalizeSymbol(symbol) {
  return String(symbol).toLowerCase();
}

function taskId(task) {
  return `@${task.actor}#${task.task_seq}`;
}

/** Preserves `a`'s order and casing; used only for evidence lists, which are re-sorted before being returned regardless. */
function intersectExact(a, b) {
  const setB = new Set(b);
  return a.filter((x) => setB.has(x));
}

function pairwiseOverlaps(activeTasks) {
  const overlaps = [];
  for (let i = 0; i < activeTasks.length; i++) {
    for (let j = i + 1; j < activeTasks.length; j++) {
      const a = activeTasks[i];
      const b = activeTasks[j];
      if (a.actor === b.actor) continue; // a developer overlapping themselves is normal, not an overlap

      const actors = [a.actor, b.actor].sort();
      const tasks = [taskId(a), taskId(b)].sort();

      if (a.artifact && b.artifact && a.artifact === b.artifact) {
        overlaps.push({
          kind: 'artifact',
          actors,
          tasks,
          evidence: [a.artifact],
          note: `both actors declare the same artifact: "${a.artifact}"`,
        });
      }

      const fileHit = [...new Set(intersectExact(a.files_declared ?? [], b.files_declared ?? []))].sort();
      if (fileHit.length > 0) {
        overlaps.push({
          kind: 'file',
          actors,
          tasks,
          evidence: fileHit,
          note: `both actors declare file(s): ${fileHit.join(', ')}`,
        });
      }

      const bSymbolsNormalized = new Set((b.symbols_declared ?? []).map(normalizeSymbol));
      const symbolHit = [...new Set((a.symbols_declared ?? []).filter((s) => bSymbolsNormalized.has(normalizeSymbol(s))).map(normalizeSymbol))].sort();
      if (symbolHit.length > 0) {
        overlaps.push({
          kind: 'symbol',
          actors,
          tasks,
          evidence: symbolHit,
          note: `both actors declare symbol(s): ${symbolHit.join(', ')}`,
        });
      }
    }
  }
  return overlaps;
}

/** Cross-actor `@<actor>#<task-seq>` references only (G2.2's own notation) — a same-actor `depends_on` entry is a bare task number, never `@`-prefixed, so this graph can never contain a same-actor edge by construction. */
function crossActorEdges(task) {
  const edges = [];
  for (const dep of task.depends_on ?? []) {
    const m = /^@([^#\s]+)#(\d+)$/.exec(String(dep).trim());
    if (m) edges.push(`@${m[1]}#${m[2]}`);
  }
  return edges;
}

/**
 * Rotates a cycle to begin at its lexicographically smallest task id — the same cycle found via DFS starting
 * from different nodes (which depends on `activeTasks`' input order, since that determines DFS start-node
 * iteration order) must produce an identical path here, or `evidence`/`note` would silently depend on input
 * order even though `tasks` (already sorted separately) would not.
 */
function canonicalCyclePath(cycle) {
  let minIndex = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i] < cycle[minIndex]) minIndex = i;
  }
  return [...cycle.slice(minIndex), ...cycle.slice(0, minIndex)];
}

function canonicalCycleKey(cycle) {
  return canonicalCyclePath(cycle).join('->');
}

/**
 * Every simple cycle (no repeated node except the closing edge) in the cross-actor dependency graph, any
 * length, found by DFS from every node — small graphs (a development team's concurrent in-flight task
 * count) make brute-force path exploration entirely adequate; this is not meant to scale to a large general
 * graph.
 */
function findDependencyCycles(activeTasks) {
  const byId = new Map(activeTasks.map((t) => [taskId(t), t]));
  const graph = new Map([...byId.keys()].map((id) => [id, crossActorEdges(byId.get(id)).filter((e) => byId.has(e))]));

  const cycles = [];
  const seenKeys = new Set();

  function dfs(start, current, path, onPath) {
    for (const next of graph.get(current) ?? []) {
      if (next === start) {
        const key = canonicalCycleKey(path);
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          cycles.push([...path]);
        }
      } else if (!onPath.has(next)) {
        onPath.add(next);
        dfs(start, next, [...path, next], onPath);
        onPath.delete(next);
      }
    }
  }
  for (const start of graph.keys()) dfs(start, start, [start], new Set([start]));
  return cycles;
}

function cycleOverlaps(activeTasks) {
  const byId = new Map(activeTasks.map((t) => [taskId(t), t]));
  return findDependencyCycles(activeTasks).map((cycle) => {
    const canonical = canonicalCyclePath(cycle);
    return {
      kind: 'dependency-cycle',
      actors: [...new Set(canonical.map((id) => byId.get(id).actor))].sort(),
      tasks: [...canonical].sort(),
      evidence: [`${canonical.join(' → ')} → ${canonical[0]}`],
      note: `dependency cycle: ${canonical.join(' → ')} → ${canonical[0]}`,
    };
  });
}

/** A fully content-derived sort key so output order depends only on WHAT was found, never on the order `tasks` happened to arrive in. */
function overlapSortKey(overlap) {
  return `${overlap.kind}|${overlap.actors.join(',')}|${overlap.tasks.join(',')}|${overlap.evidence.join(',')}`;
}

/**
 * `tasks` (any order) -> every detected `Overlap`, sorted by severity (kind rank ascending, i.e. `artifact` >
 * `dependency-cycle` > `symbol` > `file`), then by evidence count (descending — more shared ground is more
 * severe within one kind), then by a fully content-derived key so the final order never depends on input
 * order. Only tasks with `status === 'in-progress'` participate.
 */
export function findOverlaps(tasks) {
  const activeTasks = tasks.filter((t) => t.status === 'in-progress');
  const overlaps = [...pairwiseOverlaps(activeTasks), ...cycleOverlaps(activeTasks)];

  for (const overlap of overlaps) overlap.severity = SEVERITY_RANK[overlap.kind];

  overlaps.sort((x, y) => {
    if (x.severity !== y.severity) return x.severity - y.severity;
    if (x.evidence.length !== y.evidence.length) return y.evidence.length - x.evidence.length;
    return overlapSortKey(x).localeCompare(overlapSortKey(y));
  });

  return overlaps;
}
