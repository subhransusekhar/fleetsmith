import YAML from 'yaml';
import { normalizeSpec } from '../spec/schema.js';
import { validateSpec } from '../spec/validate.js';

/**
 * The typed mutation API — the only legal way anything writes to a fleet.yaml
 * other than a human with an editor.
 *
 * Three properties, each earned:
 *
 *  1. **Format-preserving.** Mutations run against the `yaml` Document/CST
 *     API, never against the normalized object. `normalizeSpec` fills defaults,
 *     so re-serializing it produces a file that no longer resembles what the
 *     author wrote — comments gone, defaults materialized, key order churned.
 *     A diff like that is unreviewable, which would defeat the entire
 *     git-as-review-surface design.
 *
 *  2. **Typed.** Every change is one of a fixed vocabulary, so it can be
 *     classified, rule-triggered, and reviewed. Unconstrained "let the model
 *     rewrite the file" produces diffs no human can audit — the failure SkillOps
 *     names as skill technical debt.
 *
 *  3. **Refuses protected targets.** Human-authored artifacts are off limits
 *     (see normalizeProvenance in spec/schema.js). This is the in-process half
 *     of a two-layer guard; CI holds the other half, out of process, because a
 *     control living inside the agent's runtime is reachable by inputs that
 *     influence the agent.
 *
 * Applying anything leaves the file either fully changed and still valid, or
 * byte-identical. There is no partial-apply state.
 */

/** Ops that only ever touch machine-owned content. */
const SKILL_OPS = new Set([
  'add-skill',
  'update-skill-body',
  'merge-skills',
  'repair-skill',
  'retire-skill',
  'add-validator',
]);
const AGENT_OPS = new Set(['update-agent-body']);
const PLAYBOOK_OPS = new Set(['add-playbook-bullet', 'update-bullet-counter']);

/**
 * Contract changes are their own class. An agent's declared inputs, outputs,
 * and required handoff sections are the rails the rest of the fleet is built
 * on: let the loop rewrite an instruction body freely, but a changed contract
 * silently breaks every downstream agent. So these are refused unless asked
 * for explicitly, and never auto-applied.
 */
const CONTRACT_OPS = new Set(['contract-change']);

export const OPS = [...SKILL_OPS, ...AGENT_OPS, ...PLAYBOOK_OPS, ...CONTRACT_OPS];

export class PatchError extends Error {}

/**
 * The form this file takes after a round trip. Running it once on a spec makes
 * every later patch a minimal diff.
 */
export function canonicalize(source) {
  const doc = YAML.parseDocument(source);
  if (doc.errors?.length) throw new PatchError(`fleet.yaml does not parse: ${doc.errors[0].message}`);
  return doc.toString({ lineWidth: 0 });
}

/**
 * Apply ops to a fleet.yaml source string.
 *
 * @returns {{ source: string, applied: object[], skipped: object[] }}
 * @throws {PatchError} when an op is refused or the result would be invalid —
 *         in which case nothing has been written.
 */
export function applyOps(source, ops, { allowContractChange = false } = {}) {
  const doc = YAML.parseDocument(source);
  if (doc.errors?.length) throw new PatchError(`fleet.yaml does not parse: ${doc.errors[0].message}`);

  // Re-serializing normalizes whitespace inside flow collections, and the
  // library applies one padding rule to both maps and sequences. A file mixing
  // styles therefore picks up unrelated churn on its first patch, which buries
  // the real change. Detect it here so the caller can canonicalize once,
  // deliberately, instead of discovering it inside an evolution diff.
  const reformatted = canonicalize(source) !== source;

  const before = normalizeSpec(doc.toJS());
  const applied = [];

  for (const [i, op] of ops.entries()) {
    const where = `ops[${i}]`;
    if (!op || typeof op !== 'object' || !op.op) throw new PatchError(`${where}: missing "op"`);
    if (!OPS.includes(op.op)) {
      throw new PatchError(`${where}: unknown op "${op.op}" (known: ${OPS.join(', ')})`);
    }
    if (CONTRACT_OPS.has(op.op) && !allowContractChange) {
      throw new PatchError(
        `${where}: "${op.op}" changes a handoff contract, which every downstream agent depends on. ` +
          'Pass --allow-contract-change and expect human review; it is never auto-applied.'
      );
    }
    assertTargetMutable(before, op, where);
    applyOne(doc, op, where);
    applied.push(op);
  }

  // Stringify options chosen to keep the diff minimal rather than to
  // re-pretty-print. lineWidth 0 disables re-wrapping: the default of 80 would
  // reflow every long description into a different shape, burying the real
  // change in noise. Flow padding stays at the library default, which matches
  // how these specs are written (`{ read: true }`); forcing it off rewrites
  // every capability map in the file.
  const source2 = doc.toString({ lineWidth: 0 });

  // The result must be a spec, not merely valid YAML. On failure the caller
  // still holds the original string, so nothing has been written.
  let after;
  try {
    after = normalizeSpec(doc.toJS());
  } catch (e) {
    throw new PatchError(`patch produced a spec that does not normalize: ${e.message}`);
  }
  const { errors } = validateSpec(after);
  if (errors.length > 0) {
    throw new PatchError(`patch produced an invalid spec:\n  ${errors.join('\n  ')}`);
  }

  return { source: source2, applied, skipped: [], reformatted };
}

/**
 * Refuse to touch anything the loop did not author. Checked against the
 * *pre-patch* spec: an op cannot make its own target writable by first
 * flipping the target's origin.
 */
function assertTargetMutable(spec, op, where) {
  const name = op.target;
  if (!name) throw new PatchError(`${where}: missing "target"`);

  // Contract ops target an agent, so they are subject to the same protection
  // as any other agent edit. Returning early here would have let a
  // contract-change walk straight past the protected set — the one op class
  // where that matters most, since a changed contract breaks downstream agents.
  const collection = SKILL_OPS.has(op.op)
    ? spec.skills
    : AGENT_OPS.has(op.op) || CONTRACT_OPS.has(op.op)
      ? spec.agents
      : null;
  if (!collection) return; // playbook ops write files, not the spec

  // Adding a brand-new skill has no existing target to protect.
  if (op.op === 'add-skill') {
    if (collection.some((x) => x.name === name)) {
      throw new PatchError(`${where}: skill "${name}" already exists — use update-skill-body`);
    }
    return;
  }

  const target = collection.find((x) => x.name === name);
  if (!target) throw new PatchError(`${where}: no such target "${name}"`);
  if (target.protected) {
    throw new PatchError(
      `${where}: "${name}" is protected (origin: ${target.origin}). ` +
        'Evolution may only modify what evolution generated — propose the change for human review instead.'
    );
  }
}

function applyOne(doc, op, where) {
  switch (op.op) {
    case 'add-skill':
      return addSkill(doc, op, where);
    case 'update-skill-body':
      return setIn(doc, ['skills', idxOf(doc, 'skills', op.target, where), 'body'], required(op, 'body', where));
    case 'repair-skill':
      return setIn(doc, ['skills', idxOf(doc, 'skills', op.target, where), 'body'], required(op, 'body', where));
    case 'update-agent-body':
      return setIn(doc, ['agents', idxOf(doc, 'agents', op.target, where), 'prompt'], required(op, 'body', where));
    case 'add-validator':
      return addValidator(doc, op, where);
    case 'merge-skills':
      return mergeSkills(doc, op, where);
    case 'retire-skill':
      return retireSkill(doc, op, where);
    case 'contract-change':
      return contractChange(doc, op, where);
    // Playbook ops live in files, not the spec; the CLI routes them to the
    // playbook writer. Accepting them here keeps one op vocabulary.
    case 'add-playbook-bullet':
    case 'update-bullet-counter':
      return;
    default:
      throw new PatchError(`${where}: unhandled op "${op.op}"`);
  }
}

function addSkill(doc, op, where) {
  const skill = { name: op.target, origin: 'evolved', ...(op.payload ?? {}) };
  if (!skill.description) throw new PatchError(`${where}: add-skill needs payload.description`);
  if (!doc.has('skills')) doc.set('skills', doc.createNode([]));
  doc.getIn(['skills'], true).add(doc.createNode(skill));
}

function addValidator(doc, op, where) {
  const i = idxOf(doc, 'skills', op.target, where);
  const cases = required(op, 'payload', where).cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new PatchError(`${where}: add-validator needs payload.cases[]`);
  }
  const path = ['skills', i, 'evals'];
  const existing = doc.getIn(path)?.toJSON?.() ?? [];
  setIn(doc, path, [...existing, ...cases]);
}

/**
 * Merge is only safe to automate when the bodies are already identical —
 * anything else is an editorial judgement, not a mechanical one.
 */
function mergeSkills(doc, op, where) {
  const from = required(op, 'payload', where).from;
  if (!from) throw new PatchError(`${where}: merge-skills needs payload.from`);
  const spec = normalizeSpec(doc.toJS());
  const a = spec.skills.find((s) => s.name === op.target);
  const b = spec.skills.find((s) => s.name === from);
  if (!b) throw new PatchError(`${where}: no such skill "${from}"`);
  if (b.protected) throw new PatchError(`${where}: "${from}" is protected and cannot be merged away`);
  if (a.body.trim() !== b.body.trim()) {
    throw new PatchError(
      `${where}: merge-skills refuses non-identical bodies ("${op.target}" vs "${from}"). ` +
        'Merging differing methodology is an editorial decision — propose it for review.'
    );
  }
  removeByName(doc, 'skills', from);
  retargetSkillRefs(doc, from, op.target);
}

/** Retirement is not deletion: aged out, renamed, and only a human removes it. */
function retireSkill(doc, op, where) {
  const i = idxOf(doc, 'skills', op.target, where);
  // Kebab-case, because skill names are validated as such — an underscore
  // suffix makes the retired spec fail validation and the patch roll back.
  const retired = `${op.target}-retired`;
  setIn(doc, ['skills', i, 'name'], retired);
  retargetSkillRefs(doc, op.target, null);
}

function contractChange(doc, op, where) {
  const i = idxOf(doc, 'agents', op.target, where);
  const payload = required(op, 'payload', where);
  for (const [k, v] of Object.entries(payload)) setIn(doc, ['agents', i, 'handoff', k], v);
}

// --- helpers ---------------------------------------------------------------

function idxOf(doc, collection, name, where) {
  const items = doc.get(collection)?.items ?? [];
  const i = items.findIndex((n) => n.get?.('name') === name);
  if (i < 0) throw new PatchError(`${where}: no ${collection.slice(0, -1)} named "${name}"`);
  return i;
}

function setIn(doc, path, value) {
  doc.setIn(path, typeof value === 'string' ? value : doc.createNode(value));
}

function required(op, field, where) {
  const v = op[field] ?? op.payload?.[field];
  if (v === undefined) throw new PatchError(`${where}: "${op.op}" needs "${field}"`);
  return v;
}

function removeByName(doc, collection, name) {
  const seq = doc.get(collection);
  const i = (seq?.items ?? []).findIndex((n) => n.get?.('name') === name);
  if (i >= 0) seq.items.splice(i, 1);
}

/** Keep agent skill lists consistent when a skill is merged away or retired. */
function retargetSkillRefs(doc, from, to) {
  for (const agent of doc.get('agents')?.items ?? []) {
    const skills = agent.get('skills');
    if (!skills?.items) continue;
    for (let i = skills.items.length - 1; i >= 0; i--) {
      const v = skills.items[i].value ?? skills.items[i];
      if (v !== from) continue;
      if (to && !skills.items.some((n) => (n.value ?? n) === to)) skills.items[i].value = to;
      else skills.items.splice(i, 1);
    }
  }
}
