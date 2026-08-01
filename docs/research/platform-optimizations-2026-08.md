# Platform Optimization Research — August 2026

Research for the next fleetsmith release ("harness optimization"). Verified 2026-08-01 against live docs, config schemas, and source for all three targets. This document is the evidence base for the milestone in `docs/milestones/v0.4.0-harness-optimizations.md`; each task there cites a section here.

Method: four parallel research agents — one per platform (docs + schema + source verification) plus one on cross-platform harness-engineering best practices. Findings marked **[uncertain]** were not fully verifiable and must be re-checked before implementation.

---

## 0. Breaking changes discovered (fix regardless of feature work)

These invalidate parts of the July 2026 research docs and current adapter output:

| # | Platform | Finding | Impact |
|---|----------|---------|--------|
| B1 | goose | Project moved: `github.com/block/goose` → **`github.com/aaif-goose/goose`**; docs `block.github.io/goose/docs` (now 404) → **`https://goose-docs.ai/docs`** | All goose doc links in `docs/research/goose-formats.md` and any generated output are dead |
| B2 | goose | **`GOOSE_LEAD_MODEL` removed.** Replacement: `GOOSE_FAST_MODEL` (auxiliary calls) + per-recipe `settings.goose_model` | Never emit lead/worker env config |
| B3 | goose | Temporal scheduler backend removed; `scheduler.rs` uses `tokio_cron_scheduler`. Cron accepts **only 5 or 6 fields** (docs claiming 7 are wrong — verified in `scheduler.rs:306-321`) | Emit 6-field cron (`"0 0 9 * * *"`); never 7 |
| B4 | Claude Code | Docs moved: `docs.anthropic.com/en/docs/claude-code/*` → **`code.claude.com/docs/en/*`** (301) | Update all links in research docs and generated harnesses |
| B5 | opencode | Docs/PRs now under `github.com/anomalyco/opencode` (`sst/opencode` still resolves) | Adapter comment already correct; keep links current |
| B6 | opencode | `subagent_depth` defaults to **1** — subagents cannot spawn subagents by default | Any fleet where a subagent delegates further **silently fails** unless fleetsmith emits `opencode.json` with `subagent_depth ≥ 2` |
| B7 | goose | Different sub-recipes run **sequentially by default**; parallelism requires "in parallel" **prose in the prompt** (no YAML key). Same sub-recipe repeated = parallel by default (10 workers; `sequential_when_repeated: true` is the brake) | fleetsmith's parallel phases currently get no concurrency on goose |
| B8 | goose | Subagents are **disabled in every `GOOSE_MODE` except `auto`** | Fleets running under `approve`/`smart_approve` silently lose delegation — must be documented in generated output |

---

## 1. Claude Code (verified against v2.1.219 docs + changelog)

Sources: [sub-agents](https://code.claude.com/docs/en/sub-agents) · [skills](https://code.claude.com/docs/en/skills) · [hooks](https://code.claude.com/docs/en/hooks) · [agent-teams](https://code.claude.com/docs/en/agent-teams) · [workflows](https://code.claude.com/docs/en/workflows) · [scheduled-tasks](https://code.claude.com/docs/en/scheduled-tasks) · [prompt-caching](https://code.claude.com/docs/en/prompt-caching) · [permissions](https://code.claude.com/docs/en/permissions) · [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)

### 1.1 Subagent frontmatter — fleetsmith emits 4 of 15 supported fields

Unused fields worth emitting: `disallowedTools`, `permissionMode` (`plan` for analysts, `acceptEdits` for implementers), `maxTurns` (hard cost ceiling), **`skills:` (preloads full skill content — the native agent↔skill binding)**, `mcpServers` (per-agent MCP scoping), `hooks` (per-agent gates), `memory: project` (persistent `.claude/agent-memory/<name>/`), `background`, `effort` (`low`…`max` reasoning budget), **`isolation: worktree`** (parallel implementers without file collisions; branches from the default branch, auto-cleaned if unchanged), `color`, `initialPrompt`.

Caveats to encode in the generator:
- Plugin-distributed agents **silently ignore** `hooks`, `mcpServers`, `permissionMode`.
- Subagents are **background-by-default** (v2.1.198) and background agents get a **reduced tool set** — `AskUserQuestion`, `ExitPlanMode`, `Workflow` are always stripped; emitting them in `tools:` produces an agent that can't do what the spec claims.
- Agent-teams path: teammates spawned from an agent definition honor `tools`/`model` but **`skills:` and `mcpServers` frontmatter are NOT applied** — the prose "load your skills" instruction must stay for team mode.
- Limits: spawn depth default 3; 200 subagents/session; 20 concurrent.

### 1.2 Skills frontmatter — fleetsmith emits 2 fields; the useful set is much larger

`context: fork` + `agent: <type>` (+ `background: false` when the result is needed synchronously), `allowed-tools` (turn-scoped pre-approval, combine with `${CLAUDE_SKILL_DIR}` for prompt-free script execution), `disallowed-tools` (documented use: strip `AskUserQuestion` from autonomous loop skills), `disable-model-invocation` (also blocks `skills:` preloading and scheduled prompts), `user-invocable`, `paths` (glob auto-activation), `model`/`effort`, `argument-hint`, `arguments` (named `$name` placeholders), `when_to_use` (**`description` + `when_to_use` truncated at 1,536 chars — enforce at generation time**), `hooks`, `shell`.

Dynamic context injection: `` !`command` `` inlines command output into the skill prompt **before** the model sees it — e.g. inject the ledger/handoff state instead of instructing the agent to go read it. Substitutions: `$ARGUMENTS`, `$N` (0-based), `$name`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`.

Context economics: an invoked skill stays in context all session; post-compaction, re-attached skills keep only the first 5,000 tokens each within a shared 25,000-token budget (most-recent-first) — keep SKILL.md lean, references on demand.

### 1.3 Hooks — 30 events; the handover-gate mechanism

Types: `command`, `http`, `mcp_tool`, `prompt`, `agent`. Key events for fleets: **`SubagentStop` (blocking — exit 2 forces the agent to keep working; the deterministic handover-artifact validator)**, `SubagentStart` (matcher = agent name; seed scratch/stub), `PreToolUse` (blocking guard rails), `PostToolUse` (artifact linting), `TaskCreated`/`TaskCompleted`/`TeammateIdle` (team-mode gates), `SessionStart` (`initialUserMessage` auto-submit). `Stop` in agent frontmatter auto-converts to `SubagentStop`.

Footguns: project-level agent frontmatter hooks don't run until **workspace trust** is accepted (silently skipped — generated README must warn); `dir/**` path matching is cwd-anchored (use `**/dir/**`); hook commands support `${CLAUDE_PROJECT_DIR}`.

### 1.4 Cost & caching

- Model aliases now include **`fable`**; `inherit` is default. `CLAUDE_CODE_SUBAGENT_MODEL` env overrides all frontmatter.
- Built-in `Explore` **no longer defaults to Haiku** (v2.1.198 — inherits main model). Emitting a project-level `Explore` override with `model: haiku` restores cheap exploration.
- Caching: each subagent builds its own cache at **5-min TTL** (1-hour is main-conversation only) — fewer, longer agents cache better; **model and effort are part of the cache key** (per-agent tiering pays fresh cache builds); forks (`context: fork`) read the parent's cache — cheaper than a fresh subagent for same-context work; skill invocation never invalidates cache; bare tool-name deny rules invalidate cache, scoped rules don't.

### 1.5 Orchestration — four primitives

Subagents (background-by-default) · agent teams (experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, shared task list + SendMessage; one implicit team, `TeamCreate`/`TeamDelete` removed) · **dynamic workflows** (`.claude/workflows/*.js`, v2.1.154+: `export const meta`, `agent()`/`pipeline()`, 16 concurrent / 1,000 total — fleetsmith's phase graph is exactly what a workflow script encodes; candidate fourth compile target) · scheduled tasks (`/loop` + `CronCreate`; recurring tasks **auto-expire after 7 days**, fire-time **jitter up to 30 min**, `disable-model-invocation` skills won't fire as scheduled prompts; project-level **`.claude/loop.md`** overrides the bare-`/loop` prompt — clean emission target for recurring fleets).

### 1.6 Settings & permissions worth emitting

`.claude/settings.json` permission allowlist derived from the fleet's declared tooling (prompt-free out of the box); `Agent(name)`, `Skill(name *)`, `Tool(param:value)` matching (`Agent(isolation:worktree)`, `Bash(run_in_background:true)`; deny/ask only; content fields not matchable). `.mcp.json` (types `stdio`/`http`/`ws`; `sse` deprecated; approval gated by trust). Output styles apply only to the main conversation, not subagents. Statusline stdin JSON includes `context_window.used_percentage` and cache token counts — fleet cache-health surface.

**[uncertain]** Exact payload schemas for `prompt`/`agent` hook handler types.

---

## 2. opencode (verified against live `opencode.ai/config.json` schema + `anomalyco/opencode` dev source)

Sources: [agents](https://opencode.ai/docs/agents/) · [permissions](https://opencode.ai/docs/permissions/) · [commands](https://opencode.ai/docs/commands/) · [models](https://opencode.ai/docs/models/) · [plugins](https://opencode.ai/docs/plugins/) · [custom-tools](https://opencode.ai/docs/custom-tools/) · [skills](https://opencode.ai/docs/skills/) · [references](https://opencode.ai/docs/references/)

### 2.1 Agent frontmatter fleetsmith doesn't emit

`model` (**tiers currently silently dropped** — subagents inherit invoker's model), `variant` (reasoning-budget preset; Anthropic built-ins `high`/`max`, custom variants under `provider.<id>.models.<model>.variants`), **`steps`** (max agentic iterations = per-agent cost cap; `maxSteps` deprecated), `hidden` (hide internal agents from `@` autocomplete), `color`, provider-passthrough of any unknown key (`reasoningEffort`, `textVerbosity`). Directories: loaders glob `{agent,agents}/**/*.md` — recursive, so namespacing under `.opencode/agent/<fleet>/` works (name derives from path — verify before adopting).

Built-in subagents `explore` (read-only codebase search) and `scout` (read-only external docs/dependency research) can serve fleet researcher roles without custom webfetch grants.

### 2.2 Permissions — `permission.task` encodes the handoff graph

Pattern→action maps on `read`/`edit`/`glob`/`grep`/`list`/`bash`/`task`/`external_directory`/`lsp`/`skill`; last matching rule wins. **A subagent denied under `permission.task` is removed from the task tool description entirely** — the handoff graph becomes an enforced, token-saving constraint instead of prose. `permission.skill` scopes each agent to its own skills. New key `doom_loop` gates stuck-agent recovery prompts — relevant to loop-engineered agents. **[uncertain]** exact `doom_loop` runtime semantics.

### 2.3 Commands

Valid frontmatter keys (schema-closed): `template`, `description`, `agent`, `model`, `variant`, **`subtask`** (forces subagent isolation — the kickoff command should set it). Templating: `$ARGUMENTS`, `$1..$n`, `` !`command` `` shell injection (project root), `@path` file inlining — a `/fleet-status` command can inject the live ledger.

### 2.4 opencode.json — currently not emitted at all

- **`subagent_depth`** (default 1 — see B6, correctness trap)
- `default_agent` (point at the fleet orchestrator)
- `compaction` (`prune: true`, `tail_turns`) for long-running loops
- `tool_output` caps (`max_lines`/`max_bytes`)
- `instructions` (paths, globs, remote URLs), `skills` (`paths`/`urls` — remote skill distribution, cached)
- `references` (named git/local repo refs without `external_directory` grants)
- `small_model` (cheap model for auxiliary calls)
- `experimental`: `batch_tool` **[uncertain semantics]**, `primary_tools`, `policies`

### 2.5 Plugins & custom tools

Plugin config now accepts **options tuples**: `"plugin": [["fleetsmith/opencode", {"autobuild": true}]]` — replaces the `FLEETSMITH_OPENCODE_AUTOBUILD` env var. Full verified hook list includes `tool.definition` (rewrite task-tool description at runtime), **`experimental.session.compacting`** (inject ledger/handoff state into the compaction prompt — cross-agent context survives compaction), `permission.ask` (auto-approve writes scoped to the fleet workspace), and the `event` stream (`session.idle` + `tui.prompt.append` = native loop driver).

**`.opencode/tool/*.ts` custom tools need no plugin and no `@opencode-ai/plugin` dependency** — export a plain `{description, args, execute}` object (args via own zod import). Filename = tool name; `context.agent` allows per-caller behavior. Emitting `fleet_*` as standalone tool files removes the peer dep and install step; keep the plugin only for hook-based behavior.

### 2.6 Skills

opencode reads `.opencode/skills/`, **`.claude/skills/`**, `.agents/skills/` (project + global, walking up to the worktree root) — the combined-build strategy (emit once to `.claude/skills/`) is confirmed correct. Frontmatter recognized: `name` (must match dir name, `^[a-z0-9]+(-[a-z0-9]+)*$`), `description` (1–1024 chars), `license`, `compatibility`, `metadata`. **No `allowed-tools` equivalent** — restriction happens via agent permissions. Loading is genuinely progressive (name+description listed; body loaded via `skill({name})`).

---

## 3. goose (verified against `aaif-goose/goose` @ main, incl. `crates/goose/src/recipe/mod.rs`, `scheduler.rs`, `checks/mod.rs`)

Sources: [recipe-reference](https://goose-docs.ai/docs/guides/recipes/recipe-reference) · [subrecipes](https://goose-docs.ai/docs/guides/recipes/subrecipes) · [cli](https://goose-docs.ai/docs/guides/goose-cli-commands) · [goosehints](https://goose-docs.ai/docs/guides/context-engineering/using-goosehints) · [skills](https://goose-docs.ai/docs/guides/context-engineering/using-skills) · [hooks](https://goose-docs.ai/docs/guides/context-engineering/hooks) · [plugins](https://goose-docs.ai/docs/guides/context-engineering/plugins) · [code-mode](https://goose-docs.ai/docs/guides/managing-tools/code-mode)

### 3.1 Recipe fields fleetsmith doesn't emit

`settings` (`goose_provider`, `goose_model` — **model tiers currently dropped on goose**, `temperature`, `max_turns` — per-agent cost ceiling), `response.json_schema` (structured output: goose validates against schema via internal `final_output` tool, self-corrects on mismatch; result = last stdout line), `retry` on *agent* recipes (today only the orchestrator gets one), `author`. No `context` field exists (stale note in July research). `.yml` extension unsupported — always `.yaml`. Parameter validation is strict both ways (every template var needs a param; every param must be used). `input_type: file` substitutes **file contents** — clean handover-artifact injection. Jinja templating supports `{% extends %}`/`{% block %}` — a shared fleet base recipe replaces copy-pasted preamble; `{{ recipe_dir }}` built-in.

### 3.2 Sub-recipes & parallelism (see B7)

Sub-recipes run in isolated sessions; nesting forbidden; each becomes a tool. `values` pin parameters; unpinned ones are inferred from conversation incl. prior sub-recipe output. Per-sub-recipe `settings.max_turns` else inherits (precedence: tool call > recipe > `GOOSE_SUBAGENT_MAX_TURNS` > default 25). Failed/timed-out (5-min) subagents return **no output**; parallel runs return only successes. Concurrency: 10 workers documented, `GOOSE_MAX_BACKGROUND_TASKS` default 5 **[uncertain which caps in practice]**.

### 3.3 Scheduling (see B3)

`goose schedule add --schedule-id <id> --cron <6-field> --recipe-source <path>` **snapshots the recipe** into `~/.local/share/goose/scheduled_recipes` — regenerating fleet files does NOT update scheduled jobs; users must re-add. Subagents cannot manage schedules. ACP server mode needs `--enable-scheduler`.

### 3.4 The `.claude/` compatibility win

goose discovers **skills** from `.agents/skills/`, **`.claude/skills/`** (+ globals) and **custom agents** (Markdown, `name`/`description`/`model` frontmatter) from `.agents/agents/`, **`.claude/agents/`**, `.goose/agents/`. The `.claude/` tree fleetsmith already emits is natively consumable by goose — recipes remain necessary only for parameters, extension pinning, retry, structured output, and scheduling. `CONTEXT_FILE_NAMES='["CLAUDE.md", ".goosehints"]'` makes goose read CLAUDE.md directly. AGENTS.md loads before `.goosehints` (already exploited).

### 3.5 Extensions, permissions, cost

**`available_tools`** per-extension allowlist — docs warn goose performs best **<25 total tools**; the cheapest reliability lever. **An explicit `extensions:` block suppresses default platform extensions** — recipes that delegate but declare extensions must add `- type: platform / name: summon` (recipes with `sub_recipes` get it auto-injected). `env_keys` triggers interactive keyring prompts (CI hang risk — pre-seed). Emittable cost levers: `settings.goose_model`, `settings.max_turns`, `GOOSE_FAST_MODEL`, `GOOSE_AUTO_COMPACT_THRESHOLD`, `GOOSE_DISABLE_SESSION_NAMING` (free savings on scheduled runs). Code Mode (3 meta-tools) recommended at 5+ extensions. No recipe-level tool allow/deny; `GOOSE_MODE` ≠ `auto` disables subagents (B8).

### 3.6 Headless/CI & new surfaces

`goose run` flags: `--no-session`, `--max-turns`, **`--max-tool-repetitions`** (breaks identical-call loops), `--output-format json|stream-json`, **`--render-recipe`** (render without running — golden-file QA), `--container`. `goose recipe validate` + `goose recipe list --format json` = CI gates. Sessions now SQLite.

New surfaces: **hooks** (Open Plugins spec; `PreToolUse`/`Stop` block via exit 2; regex matchers — bare `"*"` silently skipped, use `".*"`; `SubagentStart/Stop` NOT emitted — don't generate them), **plugins** (`goose plugin install <git-url>` → whole-fleet distribution unit), **`goose review` + `.agents/checks/*.md`** (parallel Rust-driven review orchestrator; frontmatter `name`/`description`/`model`/`turn-limit`/`tools`/`severity-default`; strictly better than a serial review sub-recipe for verify phases).

---

## 4. Cross-platform harness-engineering best practices

Full report with sources and evidence grades: **`docs/research/harness-best-practices-2026-08.md`**. Headline findings that change fleetsmith defaults:

1. **Decompose by context, not by problem** (Anthropic 2026): pipelines split by work type are the named anti-pattern; the compiler should flag adjacent phases sharing most inputs as merge candidates. (§0.1)
2. **Single-writer rule**: parallelize readers/reviewers, serialize writers. `parallel: true` should be legal only for read-only phases or disjoint write paths. (§0.2)
3. **Cite, don't paraphrase**: supervisor paraphrasing is a measured ~50% accuracy leak (LangChain τ-bench). Handoff files are the canonical artifact; orchestrators link, never restate. (§0.3)
4. **KV-cache-stable prompts**: cached tokens are ~10× cheaper; invariant prefix first, all per-phase/iteration variance at the end or in files — never timestamps in system prompts. (§0.4)
5. **MAST failure taxonomy** (NeurIPS 2025): ~42% specification/design, ~37% inter-agent misalignment, ~21% weak verification — the handoff contract is the failure surface a compiler controls.
6. **Every loop needs an objective verifier** (shell exit code, not prose) plus **three-part stop conditions**: success check, no-progress rule, hard cap. (§4.1, §4.3)
7. **Skill-description budget**: Claude Code truncates at 1,536 chars/skill and budgets the listing at 1% of context — large fleets silently lose trigger keywords; sum-and-fail QA gate needed. (§5.2)
8. **Four-field delegation brief** (objective, output format, tool/source guidance, boundaries) on every handoff; reviewer agents get *minimal* context (artifact + criteria only) plus the "flag only correctness-affecting gaps" counterweight. (§2.3, §2.5, §2.6)
9. **Eval emission**: `evals/evals.json` with should-trigger/should-not-trigger prompts per skill — also serves as model-upgrade drift detection. (§6.1, §6.2)
10. **Worker compression contract**: subagents return 1,000–2,000-token distilled summaries; handoffs carry paths/queries, not pasted contents; keep a `## Failed approaches` section compaction must not drop. (§1.5, §1.4, §1.8)

---

## 5. Consolidated opportunity map

| Theme | Claude Code | opencode | goose |
|-------|------------|----------|-------|
| **Model/cost tiering** | `model` + `effort` per agent; Explore override | `model` + `variant` + `steps`; `small_model` | `settings.goose_model` + `max_turns`; `GOOSE_FAST_MODEL` |
| **Enforced handoff graph** | `Agent(...)` allowlists, permissions | `permission.task` glob maps (removes denied agents from tool description) | sub_recipes list is already the graph |
| **Enforced handover gates** | `SubagentStop` hook, exit 2 = retry | plugin `tool.execute.after` / `permission.ask` | per-recipe `retry.checks` |
| **Skill binding** | `skills:` frontmatter preload | `permission.skill` scoping | Summon auto-discovery of `.claude/skills/` |
| **Structured handoffs** | prose + validator script | prose + validator script | `response.json_schema` (native validation) |
| **Parallel safety** | `isolation: worktree` | — (worktree via plugin ctx) | isolated sub-recipe sessions (default) |
| **Loops/recurring** | `/loop`, `.claude/loop.md`, cron (7-day expiry, jitter) | plugin `session.idle` + `tui.prompt.append` | `goose schedule` (6-field, snapshot caveat), `--max-tool-repetitions` |
| **Context hygiene** | lean skills, fork-reads-parent-cache, `!`cmd`` injection | `compaction.prune`, `tool_output` caps, compaction hook | `available_tools` <25, Code Mode, auto-compact threshold |
| **Config emission** | `.claude/settings.json`, `.mcp.json`, statusline | `opencode.json` (subagent_depth!, default_agent) | config gotchas documented, `summon` injection |
| **Review/verify phases** | verifier agents + hooks | verifier agents | `.agents/checks/*.md` + `goose review` (native parallel) |
| **Distribution** | plugin (caveat: drops hooks/mcp/permissionMode) | `skills.urls`, npm plugin | `goose plugin install <git-url>` |
| **New target** | `.claude/workflows/*.js` (deterministic orchestration) | — | — |
