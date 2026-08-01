# Spike report — Claude Code dynamic workflows as a compile target

**Date:** 2026-08-01 · **Task:** milestone T15 · **Status:** prototype built, tests green
**Verdict: conditional go — ship as an opt-in experimental target in v0.4.0, do not add it to `--target all`, and revisit promotion in v0.5 once it has been run against a real fleet.**

## What was built

`src/adapters/claude-workflow.js` compiles a fleet spec into
`.claude/workflows/<orchestrator>.js` plus a `WORKFLOW.md` explaining when to
prefer it. Reachable as `--target claude-workflow`; deliberately excluded from
`--target all` (see *Why opt-in* below).

The mapping turned out to be almost mechanical, which is the main finding:

| Spec construct | Compiles to |
|---|---|
| `orchestrator.phases[]` | `phase("…")` + sequential `await` in program order |
| `phases[].parallel` | `await parallel([...])` |
| `phases[].loop` | a real `while` with all three stops as control flow |
| `phases[].gate` | a gate agent + early `return { status: 'blocked' }` |
| `agents[]` | `agent(brief, { agentType: '<name>' })` — reuses `.claude/agents/<name>.md` |
| `agents[].model` / `.effort` | `model` / `effort` opts |
| `handoff.schema` | per-agent `schema`, so results come back structured |
| parallel editors | `isolation: 'worktree'`, same rule as the main target |

Verified: all five archetypes plus the example fleet produce syntactically valid
scripts (checked in the contexts they actually run in — `meta` as module-level
ESM, the body inside an async function). Five tests cover syntax, `agentType`
reuse, loop control flow, parallel/worktree handling, and the opt-in boundary.

## What the workflow target actually buys

**Intermediate results leave the context window.** In the skill orchestrator,
every handoff summary the orchestrator carries between phases is context spent
on coordination rather than work. Here they are entries in a `results` object.
For a long pipeline or a loop that runs several passes, that is the whole
argument.

**Loop bounds stop being a request.** The prose version asks a model to stop
after N passes or when two passes make no progress. The script *cannot* run a
fourth pass — `while (pass < 3)` is not a suggestion. Same for gates, which
become an early return rather than a paragraph the model may read past.

**Resumability improves for free.** Re-running caches completed agents up to the
first that did not finish, which favors the many-small-agents shape a fleet
already has.

## What it costs, honestly

**The graph is frozen at build time.** This is the real limitation, and it is
not fixable within the approach. A skill orchestrator can decide to skip a
phase, add an unplanned verification pass, or reorder work once it sees what the
first agent found. A workflow does exactly what the spec said, forever. For
fleets whose value is adaptive routing — `expert-pool` most obviously, where the
router's entire job is deciding who to invoke — the workflow is a worse fit than
the skill, and the generated script for that pattern is close to meaningless.

**No shell in the script.** Workflow scripts have no filesystem or Node access,
so a phase `check` (`npm test`) cannot be executed by the control flow that
depends on it. The prototype works around this with a cheap agent that runs the
command and reports exit status through a schema — which works, but means the
deterministic gate has a model in the middle of it. That is strictly weaker than
goose's native `retry.checks`, and weaker than the Claude Code `SubagentStop`
hook, both of which run the command directly.

**Availability.** Claude Code only, paid plans only, and subject to a
`disableWorkflows` setting. The skill orchestrator runs everywhere fleetsmith
targets, which is why it stays the default.

**A second thing to keep in sync.** The workflow and the skill describe the same
phase graph. They are generated from one spec so they cannot drift silently, but
any future change to phase semantics now has two emitters to update.

## Why opt-in rather than part of `--target all`

`--target all` should produce a harness the user can actually run. Emitting a
paid-plan-only script into every build would put a file in the repo that most
users cannot execute, next to three that they can — and it would read as though
the fleet needs it. Opt-in also keeps the blast radius small while the target is
unproven against a real run.

## What would move this to a full "go" in v0.5

1. **Run it.** The prototype is verified structurally — syntax, wiring, control
   flow — but has not driven a real fleet end to end. Everything below depends
   on that.
2. **Confirm `agentType` composes with `schema` as expected**, and that the
   subagent definition's `tools`/`model` genuinely apply on this path. If the
   agent definition is ignored, the value proposition (one definition, two
   drivers) collapses and each call would have to restate the prompt.
3. **Decide what to do about `expert-pool` and `supervisor`.** Both are
   dynamic-routing patterns; compiling them to a fixed graph produces a script
   that misrepresents the fleet. The honest options are to refuse the target for
   those patterns, or to emit a single delegating agent rather than a graph.
4. **Measure it.** The claim is lower context use and better resumption. That is
   testable against the skill orchestrator on the same fleet, and should be
   measured rather than asserted before this is recommended to anyone.

## Recommendation

Ship it experimental. The mapping is clean, the generated code is legible, and
the constraint that produced most of the design (no shell in-script) is
documented in the adapter so the next person does not rediscover it. But keep
the skill orchestrator as the default: it works on all three tools, adapts when
a run surprises it, and its loop gates are enforced by hooks that run the check
directly rather than by an agent reporting on one.
