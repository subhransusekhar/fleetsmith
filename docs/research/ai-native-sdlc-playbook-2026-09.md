# The AI-native SDLC playbook, applied to fleetsmith

**Source:** [The AI-Native SDLC playbook](https://claude.com/blog/the-ai-native-sdlc-playbook), Anthropic Applied AI, 2026-08-21.
**Analysed:** 2026-09-10. **Status:** applied — every row marked *applied* below is compiled into generated harnesses and covered by `test/sdlc-plays.test.js`.

## What the playbook says, in one paragraph

Code is no longer the bottleneck; the human-speed stages around it are (plan, review, deploy). The fix is not to remove controls but to change how they are enforced: each stage ends by committing an artifact the next stage reads (`intent.md` → `spec.md` → `plan.md` → diff + review → incident record), so the chain of commits is the audit trail; institutional knowledge lives in versioned files the agent reads (`CLAUDE.md`, skills); every policy that must hold gets a deterministic layer behind the advisory one (hooks that allow / ask / block, and explain themselves); the agent verifies its own work before a human sees it, and cannot weaken the check; the configuration that steers agents is regression-tested in CI like code; review runs in identical severity-ranked passes; and the loop closes when a trigger with nobody in the invocation path writes what it found as a new `intent.md`. Human judgement stays above the loop; deterministic checks carry the gates.

## Why it maps onto fleetsmith so directly

A fleet run *is* a miniature SDLC: a request comes in, gets decomposed, designed, built, verified, and shipped through a chain of handoff files. fleetsmith already had most of the playbook's *shape* — file-based artifact chain, skills as methodology, a `SubagentStop` hook as a deterministic gate, `qa`/`eval` in CI, a changelog that routes corrections back into skills, verifier agents that cannot edit. What it lacked were four specific mechanisms the playbook names, and each gap was a place where a generated fleet fell back to hoping an agent would behave.

## Play-by-play

| Stage | Play | fleetsmith before | Decision | Where it landed |
|---|---|---|---|---|
| 1 Plan | **Capture as `intent.md`** — the request in the originator's words, reviewed and committed before anything acts on it | The request lived only in the orchestrator's context; each agent got a paraphrase in its brief, and the audit trail started at the first handoff | **Applied.** `00-intent.md` written by the orchestrator in Phase 0 from `INTENT.template.md` (problem, proposed outcome, affected users/systems, constraints, out of scope, open questions, revisions). Interactive runs confirm it with the originator before Phase 1; scheduled runs record `Accepted by: trigger`; partial re-runs append a revision row. Every agent reads it first and it outranks the brief. | `src/handover/protocol.js` (`intentTemplate`, `INTENT_FILE`, protocol block), `src/compile/orchestrator.js` (Phase 0, Completion step 3) |
| 1 Plan | Intent triggers the next stage | Same | Applied as "an accepted intent is what starts Phase 1" in the orchestrator; scheduled `loop.md` firings write found work as an intent before any agent runs (closes Stage 6 into Stage 1) | `src/adapters/claude-settings.js` (`loopMd`) |
| 2 Design | **Requirements + design in one session, policy applied while the spec is written**, flagged concerns first | The `fleet-architect` phase already does this for the meta-fleet (spec + validator warnings as flagged concerns; "show the user the roster before proceeding") | *Already present.* Nothing generic to compile for arbitrary domains; the pattern lives in `fleet-design` | — |
| 3 Build | **Plan mode before code; `plan.md` committed** | Phase gates + handoff artifacts play this role; the meta-fleet's Phase 2 gate is exactly the plan review | *Already present.* Not generalised: forcing a plan artifact on every fleet phase would add a handoff the data flow may not need | — |
| 3 Build | **`CLAUDE.md` as institutional knowledge; "twice rule" — a mistake made twice goes into the file** | Changelog + feedback routing existed, but only on explicit user feedback at Completion | **Applied.** Verifiers must label a repeat finding as a *harness defect*; the orchestrator's Completion applies the twice rule unprompted (route into the skill/agent definition, record the changelog row) | `src/compile/agent-prompt.js` (Reviewing), `src/compile/orchestrator.js` (Completion step 5) |
| 3 Build | **Skills as institutional knowledge, tested for triggering** | Core of fleetsmith (`skills[]`, `fleetsmith eval` trigger tests) | *Already present* | — |
| 3 Build | **Hooks as build-time guardrails**: block edits to protected paths; back any skill whose policy must hold without exception; a block explains itself | Only one hook existed (`SubagentStop` handover gate). "Do not edit X" was prose. An agent could edit its own gate script | **Applied.** `fleet.guardrails.protectedPaths` → Claude Code `PreToolUse` hook on Edit/Write/MultiEdit/NotebookEdit and Bash (`guard-paths.sh`: exit 2, reason on stderr, `guard_block` telemetry); opencode `permission.edit` denies on every agent and the orchestrator; goose stated constraint (truthfully labelled advisory). The fleet's own `<local>/scripts/**` is protected unconditionally. `qa` gains a `guardrails (compiled)` check | `src/compile/guardrails.js`, `src/adapters/*`, `src/qa/index.js` |
| 3 Build | **Parallel sessions + subagents; verifier subagent that reports and does not fix** | `isolation: worktree` for parallel editors, `isVerifier` guidance, read+run verifiers | *Already present* | — |
| 3 Build | Legacy systems and the source of truth | n/a for a compiler | *Noted*: the intent template's `Source:` line is the linkage hook (ticket id, incident id) | `INTENT.template.md` |
| 4 Test | **Give Claude a feedback loop**: verification is part of "done", output pasted from the toolchain, fix the code not the test, and **the loop itself needs protecting** | `loop.check` existed, but only the *orchestrator* saw it; the producing agent was never told to run it, and nothing stopped it editing the check's inputs | **Applied.** `checksFor(agent)` = checks of the phases it runs in plus the phases it hands into; those agents get a *Verifying your work* section, the handoff template gains `## Verification`, and the `SubagentStop` gate refuses their stop without it. The validator warns when a checked loop has no protected paths | `src/compile/agent-prompt.js` (`checksFor`), `src/adapters/claude-settings.js` (`validatorScript`), `src/spec/validate.js` |
| 4 Test | **Continuous evals in CI** on any change to `CLAUDE.md`, skills or hooks; incidents become permanent evals | fleetsmith's own CI ran `qa`+`eval`; a generated harness got nothing | **Applied (opt-in).** `fleet.ci: github` emits `.github/workflows/fleet-qa.yml` running `qa --built .` and `eval --stage 2` on changes to the spec, compiled output and `_fleet/shared/`. No API key: both are deterministic. Incident → eval is already `skills[].evals` / `add-validator` | `src/compile/ci.js` |
| 5 Deploy | **AI in the PR review loop; `REVIEW.md`** with named passes, an *Important* vs *Nit* line, a nit cap, exclusions for what CI already enforces | Verifier guidance said "flag only what affects correctness, evidence required" | **Applied.** Reviewing section now runs three tagged passes (Defects / Compliance against `00-intent.md` and acceptance criteria / Policy), ranks Important vs Nit, caps nits at five, excludes what a deterministic check already enforces, and cross-checks the producer's pasted verification against the verifier's own run | `src/compile/agent-prompt.js` |
| 5 Deploy | **Hooks as approval gates** (ask, not block); managed settings; sandboxing; per-environment autonomy tiers | Out of scope for a per-project compiler — these are organisation-level (managed settings, MDM) and OS-level controls | *Not applied; documented.* The guard's doc comment and `docs/spec.md` say plainly that the Bash heuristic is best-effort and OS sandboxing closes the gap. An `ask`-tier guardrail is a natural follow-up (`permissionDecision: ask`) | this doc |
| 5 Deploy | **CI/CD integration**: non-interactive runs, agent acts up to the production gate and not past it | fleetsmith fleets already run headless on all three targets; nothing in a fleet deploys | *Not applicable* | — |
| 6 Maintain | **Closing the loop**: deterministic detection, tiered response, findings written as `intent.md` | `fleet.schedule` + `loop.md` existed; a firing that found work carried it only in context | **Applied.** `loop.md` step 4: work found by a scheduled firing is written as `00-intent.md` (`Source: schedule`, `Accepted by: trigger`) before any agent runs, so it enters the same triage/review/audit path as a human request | `src/adapters/claude-settings.js` |
| 6 Maintain | Recurring codebase scans; Claude on call | Product features, not compiler concerns | *Not applicable* | — |
| — | **Measurement**: leading/lagging indicators per play | `fleetsmith health` aggregates gate passes/blocks per agent | *Partially.* `guard_block` is a new telemetry event so health can report how often the deterministic layer fired (the playbook's "time waiting on / violations at each gate"). Intent-to-verdict latency is derivable from run events; not surfaced yet | `src/compile/telemetry.js` |

## The governance stance, restated for fleets

The playbook's central line — "the skill makes violations rare and the hook makes them close to impossible" — was already fleetsmith's stance for *handoffs*. This pass extends it to the two other things a fleet must not be able to talk itself out of:

1. **What was asked.** An intent file the originator confirmed and every agent reads is not a paraphrase anyone can drift from, and a verifier's compliance pass has something concrete to check against.
2. **What counts as done.** A `check` command whose inputs nobody in the fleet can edit, run by the producer and re-run by the verifier, with the literal output required before the gate lets either stop.

The evolution loop's first invariant (*evolution may only modify what evolution generated*) is the same principle one level up; the new guard script joins `validate-handoff.sh` on that loop's hard-protected list for the same reason — a loop that can edit the hook that stops it editing its scorecards has write access to the scorecards.

## What was deliberately not done

- **No plan artifact per phase.** The playbook's `plan.md` is a build-stage artifact; in a fleet the handoff file already is the plan for the next agent. Adding another file per edge would add a paraphrase step, which is what the artifact chain exists to remove.
- **No `ask`-tier hook yet.** The playbook puts approval prompts at the release gate precisely because a prompt mid-build puts a person back on the critical path of every parallel session. Fleets run unattended; blocking with an explanation is the right default. `permissionDecision: ask` is available if a fleet ever needs a human-in-the-loop path.
- **No Bash sandboxing.** The guard's Bash arm is a heuristic (a protected prefix plus a write-shaped token) and says so; it will occasionally block a read that redirects to a file, and it will not catch every way a shell can write. The playbook is explicit that OS-level sandboxing is what closes this gap, and that is a Claude Code setting, not a compiler output.
- **CI workflow is opt-in.** Writing `.github/workflows/` into a project that may not be on GitHub is presumptuous; `fleet.ci: github` is one line.
- **Guardrails apply to every session in the project, not just fleet agents.** The hook payload does carry `agent_type` inside a subagent, so scoping was possible. The playbook's model — controls in repo configuration apply to all sessions — is the safer one, and it keeps the orchestrator (a main session) from making the edit on an agent's behalf.

## Measuring whether it worked

Following the playbook's habit of naming indicators per play:

| Play | Leading | Lagging |
|---|---|---|
| Intent | Every run has a `00-intent.md` with `Status: accepted` before Phase 1 (grep the workspace) | Fewer "that is not what I asked" corrections at Completion feedback; verifier compliance findings trend to zero |
| Guardrails | `guard_block` events per run, by agent (`fleetsmith health`) — the playbook's "time spent at each gate" | Zero runs where a check's inputs changed between intent and verdict (`git diff` on protected paths) |
| Self-verification | Share of checked producers whose handoff `## Verification` matches the verifier's own run | Fewer QA-loop passes per run on checked phases |
| CI | `fleet-qa.yml` green on every config PR | Drift and trigger regressions caught before merge rather than in a run |

## Sources

- [The AI-Native SDLC playbook](https://claude.com/blog/the-ai-native-sdlc-playbook) — the plays, governance considerations and indicators above
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks) — `PreToolUse` payload (`tool_input.file_path` / `notebook_path`, `agent_type` present only inside a subagent), exit-2 semantics, `CLAUDE_PROJECT_DIR`
- `docs/research/harness-best-practices-2026-08.md` §4 (verifier bottleneck, three-part stop rules) and `docs/evolution.md` invariant 1 — the prior evidence the guardrails extend
