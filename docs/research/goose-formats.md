# goose Extensibility Formats — Code Generator Reference (2025–2026)

Researched 2026-07-04; **re-verified 2026-08-01** against source. See `platform-optimizations-2026-08.md` §3 for the full current surface.

**Canonical locations (changed since the original pass):** docs live at **`https://goose-docs.ai/docs`** (the old `block.github.io/goose/docs` now 404s) and the repo is **`github.com/aaif-goose/goose`** (`block/goose` 301-redirects). The project moved out of Block.

**Corrections applied 2026-08-01:**
- There is **no `context[]` recipe field** — it is absent from the `Recipe` struct (`crates/goose/src/recipe/mod.rs`).
- **`GOOSE_LEAD_MODEL` no longer exists.** Cost control is `GOOSE_FAST_MODEL` (auxiliary calls) plus per-recipe `settings.goose_model`.
- The **Temporal scheduler backend is gone**; `scheduler.rs` uses `tokio_cron_scheduler` with local-timezone jobs. Cron accepts **only 5- or 6-field** expressions (5-field auto-prepends `0` for seconds); 7 fields is a parse error, despite docs claiming otherwise.
- Subagents are **disabled in every `GOOSE_MODE` except `auto`**.
- goose now also discovers **custom agents** from `.claude/agents/`, `.agents/agents/`, `.goose/agents/` — the `.claude/` tree is natively consumable.

## 1. Recipes (YAML, Jinja/MiniJinja `{{ param }}` templating)

**Top-level fields:** `version` (default `"1.0.0"`), `title` (**req**), `description` (**req**), `instructions`* (system-level), `prompt`* (initial user message; **required for headless `goose run`**), `parameters[]`, `extensions[]`, `settings`, `response`, `retry`, `sub_recipes[]`, `activities[]` (Desktop chips — **ignored by CLI and scheduled jobs**), `author` (`contact`,`metadata`). *At least one of instructions/prompt.

**`parameters[]`:** `key` (req), `input_type` (req: `string`|`number`|`boolean`|`date`|`file`|`select`), `requirement` (req: `required`|`optional`|`user_prompt`), `description` (req), `default` (only/required for `optional`; not allowed for `file`), `options[]` (required for `select`). `user_prompt` → interactive prompt if unsupplied.

**`extensions[]`:** same shape as config.yaml entries — `type` (`builtin`|`stdio`|`streamable_http`|`platform`|`frontend`|`inline_python`), `name`, `cmd`/`args`, `env_keys`/`envs`, `timeout` (default 300), `bundled`, `uri`/`headers`, `available_tools` (restrict), `code`/`dependencies` (inline_python). Loaded per-run, then discarded.

**`settings`:** `goose_provider`, `goose_model`, `temperature`, `max_turns`.

**`response`:** `json_schema: {...}` for structured output. **`retry`:** `max_retries` (req), `checks[]` (req; `type: shell`, `command`, exit 0 = success), `timeout_seconds` (300), `on_failure`.

**Locations/discovery:** cwd, `GOOSE_RECIPE_PATH` (colon-separated), `GOOSE_RECIPE_GITHUB_REPO`, `~/.config/goose/recipes` conventional. `/recipe` generates one from session history.

**CLI:** `goose run --recipe r.yaml --params k=v [-i] [--no-session] [--sub-recipe extra.yaml]`; `goose recipe validate|deeplink|list`.

## 2. Subagents & sub-recipes

**Subagents:** ephemeral, spawned from natural language (platform extension). Max turns 25 default (`GOOSE_SUBAGENT_MAX_TURNS` / `settings.max_turns`), 5-min timeout, **max 10 concurrent** (hard-coded, shared budget), inherit all extensions. Sequential by default; parallel on "parallel"/"simultaneously"/"concurrently". Parallel failure → only successful results returned.

**`sub_recipes[]`:** `name` (req; becomes tool name), `path` (req), `values` (pin params), `sequential_when_repeated` (bool), `description` (guidance for selection). Each exposed as a callable tool; runs in an **isolated session**; **nesting is forbidden** (a sub-recipe may not declare its own `sub_recipes`); returns `response` json or final text.

**Parallelism (verified 2026-08-01):** *different* sub-recipes run **sequentially by default** — the only way to parallelize them is prose in the `prompt` ("run these in parallel"); there is no YAML key. The *same* sub-recipe repeated runs **in parallel by default** (`sequential_when_repeated: true` is the brake). Concurrency is capped by `GOOSE_MAX_BACKGROUND_TASKS` (default 5) alongside the documented 10-worker limit.

**Scheduling:** `goose schedule add --schedule-id <id> --cron "<5-or-6-field>" --recipe-source <path>`. Adding **snapshots the recipe** into `~/.local/share/goose/scheduled_recipes` — regenerating fleet files does *not* update an existing scheduled job; re-add it. Subagents cannot manage schedules.

## 3. Extensions & `config.yaml`

`~/.config/goose/config.yaml`: `GOOSE_PROVIDER`, `GOOSE_MODEL`, `GOOSE_MODE` (`auto`|`approve`|`chat`|`smart_approve`), `extensions:` **map keyed by name** (not a list). Six types as above; `builtin` needs only `name`/`enabled`/`timeout`/`bundled`; `stdio` adds `cmd`/`args`/`env_keys`; `streamable_http` adds `uri`/`headers`.

**Generator gotchas (verified 2026-08-01):**
- **An explicit `extensions:` block suppresses the default platform extensions.** A recipe that lists extensions *and* needs delegation must include `- type: platform` / `name: summon`, or the `delegate`/`load` tools vanish. Recipes declaring `sub_recipes` get `summon` auto-injected and are exempt.
- `available_tools` is a per-extension tool allowlist — the cheapest reliability lever, since docs warn goose "performs best with fewer than 25 total tools".
- `env_keys` triggers an interactive keyring prompt on first run (scans sub-recipes too) — a hang risk in CI; pre-seed those variables for headless runs.
- Cost/context env levers: `GOOSE_FAST_MODEL`, `GOOSE_AUTO_COMPACT_THRESHOLD` (default 0.8), `GOOSE_TOOL_CALL_CUTOFF`, `GOOSE_DISABLE_SESSION_NAMING` (removes one model call per session — free savings on scheduled runs).

## 4. `.goosehints` & AGENTS.md

Default context filenames **in order: `AGENTS.md` then `.goosehints`** at each directory level — AGENTS.md is first-class. Global: `~/.config/goose/.goosehints` and `~/.agents/AGENTS.md`. Override via `CONTEXT_FILE_NAMES` (JSON array). `@filename.md` inlines content. Hierarchical loading up the tree + nested dirs entered during the session.

## 5. Agent Skills (SKILL.md) — supported, v1.25.0+

Via built-in **Summon** extension, auto-discovered at startup. Frontmatter: only `name` + `description` required.

**Search dirs:** `~/.agents/skills/` (global, recommended), `./.agents/skills/` (project), `~/.agents/plugins/<plugin>/`. Backward-compatible: **`~/.claude/skills/`, `./.claude/skills/`, `./.goose/skills/`**, `~/.config/goose/skills/`, `~/.config/agents/skills/`. Sharing with Claude via `~/.claude/skills/` explicitly supported.

**Invocation:** auto-loaded on description match, or explicit ("Use the code-review skill"); `/skills` lists.

**Plan mode:** `/plan` = interactive plan/clarify loop; distinct from recipes.

## 6. goosed / ACP

`goosed` = Rust daemon behind Desktop/API. **ACP (Agent Client Protocol) is becoming the primary interface** (`goose-acp` crate; drivable from Zed, JetBrains). Roadmap (Feb–Apr 2026): stabilize ACP-over-HTTP → TS TUI alpha → desktop migration → **remove `goosed` + `goose-cli`, ACP as single interface**. For generators today: recipe/config/skill file formats are the stable target; treat ACP wire integration as in-migration.

## Applied in fleetsmith

- One recipe per fleet agent (`title`/`description` required fields respected; `description` ≤200 chars), orchestrator recipe wires `sub_recipes` with `name`/`path`/`description`.
- Agent recipes take a required `task_brief` string parameter; orchestrator takes `request` with `requirement: user_prompt`.
- Capabilities → extensions (`developer` always for handoff file I/O; `computercontroller` for web); read-only intent enforced as a stated instruction constraint (goose has no tool-level sandbox).
- Combined builds emit skills only to `.claude/skills/` (goose auto-discovers it); solo goose builds emit `.goose/skills/`.
- AGENTS.md (first-class in goose) replaces `.goosehints` as the pointer file.
- Parallel phases stay within the 10-concurrent-subagent cap by construction (fleet sizes are small).
