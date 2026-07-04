/**
 * Fleet archetypes: starting-point specs for `fleetsmith init --pattern X`.
 * Each returns a raw (un-normalized) spec the user then edits.
 * These are deliberately small — 3 focused agents beat 5 vague ones.
 */

export const ARCHETYPES = {
  pipeline: {
    summary: 'Sequential stages, each consuming the previous handoff (analyze -> build -> review).',
    spec: (name, domain) => ({
      version: 1,
      fleet: { name, domain, pattern: 'pipeline', execution: 'subagents' },
      agents: [
        {
          name: 'analyst',
          role: 'Turns the raw request into precise, testable requirements.',
          goal: 'Produce a requirements document a builder can implement without asking questions.',
          capabilities: { read: true, web: true },
          skills: [],
          handoff: { to: ['builder'], artifact: '01-analyst-requirements.md', criteria: ['Every requirement is testable', 'Out-of-scope items are listed explicitly'] },
        },
        {
          name: 'builder',
          role: 'Implements the requirements.',
          goal: 'Deliver a working implementation that satisfies every requirement.',
          capabilities: { read: true, edit: true, run: true },
          skills: [],
          handoff: { to: ['reviewer'], artifact: '02-builder-implementation.md', criteria: ['Implementation maps 1:1 to requirements', 'How-to-verify steps included'] },
        },
        {
          name: 'reviewer',
          role: 'Adversarially reviews the implementation against the requirements.',
          goal: 'Confirm or refute, with evidence, that the build meets the spec.',
          capabilities: { read: true, run: true },
          skills: [],
          handoff: { to: [], artifact: '03-reviewer-verdict.md' },
        },
      ],
    }),
  },

  fanout: {
    summary: 'Independent parallel workers, then one merger (research fleets, audits).',
    spec: (name, domain) => ({
      version: 1,
      fleet: { name, domain, pattern: 'fanout', execution: 'subagents' },
      agents: [
        { name: 'worker-a', role: 'Covers slice A of the problem.', capabilities: { read: true, web: true }, handoff: { to: ['synthesizer'], artifact: 'a-findings.md' } },
        { name: 'worker-b', role: 'Covers slice B of the problem.', capabilities: { read: true, web: true }, handoff: { to: ['synthesizer'], artifact: 'b-findings.md' } },
        {
          name: 'synthesizer',
          role: 'Merges all worker findings, resolves conflicts with sources cited, flags gaps.',
          capabilities: { read: true, edit: true },
          handoff: { to: [], artifact: 'final-synthesis.md', criteria: ['Every conflict lists both sources', 'Coverage gaps are named, not hidden'] },
        },
      ],
    }),
  },

  'generate-verify': {
    summary: 'Producers paired with adversarial checkers (codegen + QA, content + fact-check).',
    spec: (name, domain) => ({
      version: 1,
      fleet: { name, domain, pattern: 'generate-verify', execution: 'subagents' },
      agents: [
        { name: 'generator', role: 'Produces the artifact.', capabilities: { read: true, edit: true, run: true }, handoff: { to: ['verifier'], artifact: 'draft.md' } },
        {
          name: 'verifier',
          role: 'Tries to break the artifact: cross-checks interfaces, runs it, hunts for the boundary bugs the generator cannot see.',
          goal: 'A verdict with reproducible evidence, not opinions.',
          capabilities: { read: true, run: true },
          handoff: { to: ['generator'], artifact: 'verdict.md', criteria: ['Every defect has a repro or file:line evidence'] },
        },
      ],
    }),
  },

  supervisor: {
    summary: 'A coordinating lead plus specialists; the lead owns state and delegates dynamically (agent teams).',
    spec: (name, domain) => ({
      version: 1,
      fleet: { name, domain, pattern: 'supervisor', execution: 'team' },
      agents: [
        {
          name: 'lead',
          role: 'Owns the ledger, decomposes work, assigns tasks, arbitrates conflicts, integrates results.',
          capabilities: { read: true, edit: true, spawn: true },
          handoff: { to: ['specialist-a', 'specialist-b'] },
        },
        { name: 'specialist-a', role: 'Deep expert for domain slice A.', capabilities: { read: true, edit: true, run: true }, handoff: { to: ['lead'], artifact: 'a-result.md' } },
        { name: 'specialist-b', role: 'Deep expert for domain slice B.', capabilities: { read: true, edit: true, run: true }, handoff: { to: ['lead'], artifact: 'b-result.md' } },
      ],
    }),
  },

  'expert-pool': {
    summary: 'A router agent plus on-demand specialists; only relevant experts are invoked per request.',
    spec: (name, domain) => ({
      version: 1,
      fleet: { name, domain, pattern: 'expert-pool', execution: 'subagents' },
      agents: [
        {
          name: 'router',
          role: 'Classifies the request and invokes only the relevant expert(s); answers trivial requests itself.',
          capabilities: { read: true, spawn: true },
          handoff: { to: ['expert-a', 'expert-b'] },
        },
        { name: 'expert-a', role: 'Specialist A.', capabilities: { read: true, edit: true }, handoff: { to: ['router'], artifact: 'a-answer.md' } },
        { name: 'expert-b', role: 'Specialist B.', capabilities: { read: true, edit: true }, handoff: { to: ['router'], artifact: 'b-answer.md' } },
      ],
    }),
  },
};

export function archetype(pattern, name, domain) {
  const a = ARCHETYPES[pattern];
  if (!a) {
    throw new Error(`Unknown pattern "${pattern}". Available: ${Object.keys(ARCHETYPES).join(', ')}`);
  }
  return a.spec(name, domain);
}
