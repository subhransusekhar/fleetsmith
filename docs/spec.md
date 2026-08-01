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
| `workspace` | `_fleet` | coordination directory emitted into the project. Must be a safe relative path (`[A-Za-z0-9._-/]`, no leading `/`, no `..`) — it is interpolated into generated shell scripts and config, so anything else is an error |
| `schedule` | `null` | recurring-loop config — see [Loop engineering](#loop-engineering) |
| `mcp` | `null` | map `name -> {type, url \| command, args, env}`. Compiles to `.mcp.json` (Claude Code), `opencode.json` `mcp`, and goose recipe `extensions`. Validator errors if a remote server has no `url` or a stdio server no `command` |
| `allowParallelWrites` | `false` | escape hatch for the single-writer rule (see [Validation rules](#validation-rules)) — set only when concurrent writers provably touch disjoint paths |

## `defaults`

| Key | Default | Notes |
|-----|---------|-------|
| `model` | `inherit` | tier inherited by every agent |
| `capabilities` | `{read: true}` | capability defaults for every agent |
| `opencodeModels` | `null` | map tier → concrete `provider/model-id`, e.g. `{smart: "anthropic/claude-opus-5"}`. opencode needs provider-qualified ids, so tiering is emitted **only** when supplied — fleetsmith never guesses a provider string |
| `gooseModels` | `null` | same, for goose `settings.goose_model` |

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
| `effort` | `null` | `minimal` / `low` / `medium` / `high` / `max` reasoning budget. Claude Code `effort` (`minimal`→`low`); opencode `variant`; goose has no equivalent (ignored). Absent = inherit the session default |
| `turns` | `null` | positive integer hard turn cap. Claude Code `maxTurns`, opencode `steps`, goose `settings.max_turns`. Validator warns above 200 |
| `hidden` | `false` | hide from `@`-mention autocomplete (opencode only; no-op elsewhere) — for internal fleet agents |
| `memory` | `false` | durable cross-session notes. Claude Code `memory: project`; other targets get a prose instruction to keep notes in the fleet workspace |

### `agents[].handoff`

| Key | Default | Notes |
|-----|---------|-------|
| `to` | `[]` | receiving agent names; empty = terminal agent |
| `artifact` | `null` | primary artifact contract filename (validator warns if edges exist without one) |
| `criteria` | `[]` | acceptance criteria — compiled into the producer's prompt as hard requirements |
| `protocol` | `file` | `file` (portable, default), `task`/`message` reserved for team-mode emphasis |
| `schema` | `null` | machine-checkable artifact contract: map `field -> description`, or `true` for the default four-field delegation brief (`objective`, `output_format`, `sources_and_tools`, `boundaries`). Compiles to goose `response.json_schema`; on Claude Code/opencode it shapes the handoff template and the `SubagentStop` validator gate |

## `skills[]`

| Key | Notes |
|-----|-------|
| `name` | kebab-case, ≤64 chars, no consecutive hyphens (Agent Skills spec). Combined builds emit once to `.claude/skills/<name>/` (opencode and goose read it natively); solo builds emit tool-local (`.opencode/skills/`, `.goose/skills/`) |
| `description` | **the only trigger mechanism** — validator errors if missing, warns under 60 chars. Write pushy: what it does + trigger phrases + follow-up keywords |
| `body` | SKILL.md content; validator warns past 500 lines — split into references |
| `references` | map `filename -> content`, loaded on demand |
| `scripts` | map `filename -> content`, executable helpers |
| `assets` | map `filename -> content` |
| `freedom` | `high` / `medium` (default) / `low` — how much latitude the methodology gives. `low` emits exact-command framing for fragile, consistency-critical work; `high` emits heuristics |
| `triggers` | `{should: [...], shouldNot: [...]}` example prompts. Compiled into `evals/evals.json` so triggering can be measured separately from output quality |

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
| `noProgress` | `2` | consecutive no-change passes that end the loop early |

A bare integer is shorthand for `{ max: N }`.

**Three-part stop rule.** The playbook renders all three exits on every target: **success** (the `until` condition, with `check` as the objective signal whose command and output go in the ledger — not the agent's opinion of them), **no progress** (`noProgress` consecutive passes with no material change; a pass that fixes nothing will not start fixing things), and **cap** (`max` passes, then proceed with a documented gap). A cap alone burns the whole budget on a loop that stopped improving after pass one. Where the check is test-shaped, the callout also warns against satisfying the check without satisfying the requirement.

When `check` is set, **goose** additionally emits a native recipe-level `retry:` block (`max_retries` + shell `checks[]` + `on_failure`) so the loop is enforced deterministically.

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

Errors also: phase `loop.max` not a positive integer, unknown `agents[].effort` tier, unknown `skills[].freedom` level, `fleet.mcp` entry missing `url` (remote) or `command` (stdio), `fleet.workspace` / `handover.dir` not a safe relative path, a skill `description` over 1,536 chars (it would be truncated in the skill listing, cutting off its trigger vocabulary), and a `parallel` phase containing more than one editing agent (override with `fleet.allowParallelWrites` only when the writers provably touch disjoint paths).

Warnings: empty domain, roleless agent, handoff edge without artifact, handoff cycle outside supervisor-family patterns, disconnected agent, unattached skill, short skill description, skill body >500 lines, `agents[].turns` >200, `loop.max` >10, loop with no exit condition (no `until`/`check`), malformed `schedule.cron`, `schedule` with both cron and interval.
