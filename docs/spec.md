# Fleet Spec Reference

The fleet spec is the single tool-agnostic source of truth. `normalizeSpec` fills defaults; `validateSpec` enforces the rules below; adapters never read raw specs.

## Top level

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `version` | number | `1` | spec schema version |
| `fleet` | object | — | fleet identity + topology |
| `defaults` | object | see below | inherited by every agent |
| `agents` | array | `[]` | must be non-empty |
| `skills` | array | `[]` | methodology units |
| `orchestrator` | object | derived | playbook config |
| `handover` | object | derived | protocol config |

## `fleet`

| Key | Default | Values |
|-----|---------|--------|
| `name` | `unnamed-fleet` | kebab-case slug |
| `domain` | `''` | one-line domain statement; feeds every description — leaving it empty makes the harness generic (validator warns) |
| `pattern` | `pipeline` | `pipeline`, `fanout`, `expert-pool`, `generate-verify`, `supervisor`, `hierarchical` |
| `execution` | `subagents` | `team` (Claude Code agent teams; degrades to orchestrated subagents on opencode/goose), `subagents`, `hybrid` (per-phase `mode`) |
| `workspace` | `_fleet` | coordination directory emitted into the project |
| `schedule` | `null` | recurring-loop config — see [Loop engineering](#loop-engineering) |

## `agents[]`

| Key | Default | Notes |
|-----|---------|-------|
| `name` | required | kebab-case; also the subagent/recipe filename |
| `role` | `''` | one sentence, "who am I" |
| `goal` | `''` | measurable outcome, feeds description + orchestrator |
| `model` | `defaults.model` | `smart` / `fast` / `cheap` / `inherit` — mapped per adapter (Claude Code: opus/sonnet/haiku/inherit) |
| `capabilities` | `{read: true}` | `read`, `edit`, `run`, `web`, `spawn` booleans — mapped to Claude Code `tools:` allowlist, opencode `tools:` booleans, goose extensions (+ stated read-only constraint, since goose has no tool-level sandbox) |
| `skills` | `[]` | names from `skills[]`; compiled prompt instructs the agent to load them |
| `principles` | `[]` | working principles injected verbatim |
| `prompt` | `''` | free-form extra instructions (appended last) |
| `handoff` | see below | outgoing edges |

### `agents[].handoff`

| Key | Default | Notes |
|-----|---------|-------|
| `to` | `[]` | receiving agent names; empty = terminal agent |
| `artifact` | `null` | primary artifact contract filename (validator warns if edges exist without one) |
| `criteria` | `[]` | acceptance criteria — compiled into the producer's prompt as hard requirements |
| `protocol` | `file` | `file` (portable, default), `task`/`message` reserved for team-mode emphasis |

## `skills[]`

| Key | Notes |
|-----|-------|
| `name` | kebab-case, ≤64 chars, no consecutive hyphens (Agent Skills spec). Combined builds emit once to `.claude/skills/<name>/` (opencode and goose read it natively); solo builds emit tool-local (`.opencode/skills/`, `.goose/skills/`) |
| `description` | **the only trigger mechanism** — validator errors if missing, warns under 60 chars. Write pushy: what it does + trigger phrases + follow-up keywords |
| `body` | SKILL.md content; validator warns past 500 lines — split into references |
| `references` | map `filename -> content`, loaded on demand |
| `scripts` | map `filename -> content`, executable helpers |
| `assets` | map `filename -> content` |

## `orchestrator`

| Key | Default | Notes |
|-----|---------|-------|
| `name` | `run-<fleet>` | skill/agent/recipe name of the playbook |
| `trigger` | `<domain> tasks` | phrase used in pointer files + descriptions |
| `phases` | derived from pattern | array of `{name, mode, agents[], parallel?, gate?, loop?}` |
| `happyPath` / `failurePath` | derived | test scenarios embedded in the playbook |

Pattern-derived phases: `pipeline` → one stage per agent; `fanout` → all-but-last parallel, last merges; `generate-verify` → first half generate, second half verify (**the Verify phase gets a default iteration loop**); `supervisor`/`hierarchical`/`expert-pool` → single Coordinate phase in team mode.

## Loop engineering

Two orthogonal loop constructs; both are declared in the spec and translated onto each target's native loop primitive with a portable prose fallback.

### Iteration loops — `orchestrator.phases[].loop`

Turns a one-shot phase into a **repeat-until-condition** refinement loop (generate → verify → refine).

| Key | Default | Notes |
|-----|---------|-------|
| `until` | `''` | human-readable exit condition — the loop's acceptance test |
| `max` | `3` | hard iteration bound (safety valve); validator warns above 10 |
| `check` | `null` | optional shell command, exit 0 = satisfied — the objective signal every target defers to |

A bare integer is shorthand for `{ max: N }`. Translation: the orchestrator playbook renders a "repeat until, refine with last-pass failures, stop at max with a documented gap" callout on **every** target (orchestration is LLM-prose-driven everywhere). When `check` is set, **goose** additionally emits a native recipe-level `retry:` block (`max_retries` + shell `checks[]` + `on_failure`) so the loop is enforced deterministically.

### Recurring loops — `fleet.schedule`

Runs the whole fleet on a schedule/interval/self-paced cadence. `null` (default) = one-shot fleet.

| Key | Default | Notes |
|-----|---------|-------|
| `cron` | `null` | 5-field cron expression (validator warns on malformed) |
| `interval` | `null` | human interval (`1h`, `15m`) for `/loop`-style re-firing |
| `note` | `''` | what each firing should accomplish |

Neither `cron` nor `interval` → self-paced. Setting both warns (cron wins). Translation (rendered in the orchestrator's "Recurring runs" section): **Claude Code** → `/loop <interval> /<orch>` or the `schedule` skill for cron; **opencode** → cron/`while sleep` wrapper around `opencode run`; **goose** → `goose run --recipe` under cron / `goose schedule`.

## `handover`

| Key | Default | Notes |
|-----|---------|-------|
| `strategy` | `file` | file protocol is always emitted; team channels layer on top |
| `ledger` | `true` | emit `<workspace>/LEDGER.md` + ledger duties in every prompt |
| `dir` | `<workspace>/handoffs` | handoff file location; naming: `{seq}-{from}-to-{to}.md` |

## Validation rules

Errors (block build): missing/duplicate/non-kebab agent or skill names, unknown pattern/execution/model/capability/protocol values, handoff to unknown agent, agent referencing unknown skill, skill without description, orchestrator phase referencing unknown agent, empty fleet.

Errors also: phase `loop.max` not a positive integer.

Warnings: empty domain, roleless agent, handoff edge without artifact, handoff cycle outside supervisor-family patterns, disconnected agent, unattached skill, short skill description, skill body >500 lines, `loop.max` >10, loop with no exit condition (no `until`/`check`), malformed `schedule.cron`, `schedule` with both cron and interval.
