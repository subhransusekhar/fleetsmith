import { execFileSync } from 'node:child_process';
import { OPS } from './patch.js';
import { MAX_BULLET_CHARS } from '../playbook/index.js';

/**
 * The single model call in the entire system.
 *
 * Everything else — telemetry, health, qa, eval, patch, playbooks — is
 * deterministic. This is the one place a model is asked for judgment, and the
 * boundary is deliberate: the model *proposes*, and deterministic checks
 * dispose. Nothing it returns is trusted until it has cleared qa, eval stage 1,
 * and a paired stage-2 comparison.
 *
 * Two production findings from Decagon's GEPA postmortem are encoded here
 * rather than left to chance:
 *  - **Reflection needs a frontier model.** A small model as reflector left
 *    prompts essentially unchanged; this step is reasoning about reasoning.
 *    So the command is not tier-configurable by accident — it defaults to the
 *    strongest available and says so.
 *  - **Length constraints belong in the proposer, not in post-processing.**
 *    Unconstrained reflective optimization grows instructions without bound;
 *    a cap applied afterwards truncates mid-thought, while a cap stated up
 *    front produces something written to fit.
 */

/** Ops each target kind may legally receive, stated so the model does not guess. */
const KIND_RULES = {
  // The legal-op list depends on whether there is anything to count. Listing
  // update-bullet-counter against an empty playbook is contradictory guidance,
  // and the model reliably takes it — three dogfood runs proposed a counter
  // op for a bullet that did not exist.
  playbook: (name, { hasBullets = false } = {}) =>
    `"${name}" is a PROTECTED, human-authored agent. You may NOT edit its definition. ` +
    (hasBullets
      ? 'Legal ops: "add-playbook-bullet" (field "body") for a new lesson, or "update-bullet-counter" (payload {id, kind}) using an id listed under "Current learned notes". '
      : 'Its playbook is EMPTY, so the ONLY legal op is "add-playbook-bullet" (field "body"). Do not propose "update-bullet-counter" — there is no bullet to count. ') +
    `A playbook bullet is an advisory note appended to the agent. The HARD limit is ${MAX_BULLET_CHARS} characters and ` +
    `anything longer is rejected outright, so aim for under ${Math.floor(MAX_BULLET_CHARS * 0.75)} — writing to the exact ` +
    `limit overshoots it. One specific, reusable lesson; not a paragraph, not a restatement of the agent's role.`,
  skill: (name) => `"${name}" is a machine-authored skill; you may edit its body or description.`,
  agent: (name) => `"${name}" is a machine-authored agent; you may edit its instruction body.`,
};

export function buildPrompt({ target, dossier, caps }) {
  return `You are improving one module of an agent harness. You are NOT writing prose for a human — your entire reply must be a single JSON array of typed operations.

${dossier}

## Your task

Propose the smallest set of operations that would fix the failures above for "${target.name}".

**Constraint for this target:** ${(KIND_RULES[target.kind] ?? (() => ''))(target.name, target)}

## Rules

1. Reply with ONLY a JSON array. No markdown fence, no commentary.
2. Every element: {"op": ..., "target": "${target.name}", "body"|"payload": ..., "rationale": "...", "confidence": 0.0-1.0, "evidence": ["..."]}
3. Legal ops: ${OPS.filter((o) => o !== 'contract-change').join(', ')}
   - Use "update-skill-description" (field: "description") when the failure is a routing/trigger problem: a skill firing on the wrong request, or losing one it should win. The description is the entire trigger mechanism.
   - You may rewrite a description, but you may NOT change the trigger corpus it is judged against.
4. NEVER propose "contract-change". An agent's declared inputs, outputs, and handoff sections are relied on by every downstream agent; changing one is a human decision.
5. Skill bodies must stay under ${caps.skillLines} lines and agent bodies under ${caps.agentLines}. Write to fit — do not write long and expect truncation.
6. Ground every operation in specific evidence from the dossier. Cite the failing check or case in "evidence". If the dossier shows no failure you can act on, reply with an empty array [] — proposing a speculative change is worse than proposing nothing, because it costs a validation cycle and risks a regression for no reason.
7. Prefer editing what exists over adding something new.`;
}

/**
 * Ask Claude Code headlessly for ops. Returns [] on any failure: a proposer
 * that cannot be reached must stall the loop, never crash a run.
 */
export function claudeProposer({ command = 'claude', model = null, timeout = 180_000 } = {}) {
  return async ({ target, dossier, caps }) => {
    const args = ['-p', buildPrompt({ target, dossier, caps }), '--output-format', 'json'];
    if (model) args.push('--model', model);
    let raw;
    try {
      raw = execFileSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
    } catch (e) {
      throw new Error(`proposer unavailable (${command}): ${e.message}`);
    }
    return parseOps(raw);
  };
}

/**
 * Pull the ops array out of a model reply.
 *
 * Tolerant of the wrapper Claude Code puts around results and of a stray
 * fence, because failing to parse a good proposal wastes a frontier-model
 * call. Not tolerant of anything that is not an array of objects with an `op`.
 */
export function parseOps(raw) {
  let text = String(raw ?? '').trim();
  if (!text) return [];

  // Claude Code's JSON output wraps the reply; unwrap when present.
  try {
    const outer = JSON.parse(text);
    if (outer && typeof outer === 'object' && !Array.isArray(outer)) {
      text = String(outer.result ?? outer.content ?? outer.text ?? text);
    } else if (Array.isArray(outer)) {
      return validateOps(outer);
    }
  } catch {
    /* not JSON at the top level; fall through to extraction */
  }

  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  try {
    return validateOps(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return [];
  }
}

function validateOps(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((o) => o && typeof o === 'object' && typeof o.op === 'string' && typeof o.target === 'string');
}
