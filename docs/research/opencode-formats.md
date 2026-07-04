# opencode Extensibility Formats — Code Generator Reference (2025–2026)

Researched 2026-07-04 against `anomalyco/opencode` (`dev` branch — `sst/opencode` redirects here) docs source and `opencode.ai/docs`.

**Critical convention:** current opencode uses **plural** directory names — `.opencode/agents/`, `.opencode/commands/`, `.opencode/skills/<name>/`, `.opencode/plugins/`. (Singular may still resolve for back-compat; generate plural.) Config JSON keys are **singular**: `"agent"`, `"command"`. Config file: `opencode.json`/`.jsonc` with `"$schema": "https://opencode.ai/config.json"`.

## 1. Agents

**Locations:** project `.opencode/agents/<name>.md`, global `~/.config/opencode/agents/<name>.md`. Filename (minus `.md`) = agent id. Body after frontmatter = system prompt.

**Frontmatter fields:**

| Field | Values | Notes |
|---|---|---|
| `description` | string (required) | drives automatic subagent selection |
| `mode` | `primary` \| `subagent` \| `all` | |
| `model` | `provider/model-id` | e.g. `anthropic/claude-sonnet-4-20250514` |
| `temperature` | 0.0–1.0 | |
| `top_p` | 0.0–1.0 | |
| `prompt` | string / `{file:./path}` | body serves this in md agents |
| `permission` | object | per-tool gating — **preferred** |
| `tools` | `{tool: bool}` | **deprecated** — prefer `permission` |
| `disable` | bool | |

**Primary vs subagent:** primary = direct-conversation (Tab to cycle; built-ins Build/Plan); subagent = invoked automatically by description or manually via `@mention` (built-ins General/Explore/Scout). `mode: all` = both. Top-level `default_agent` sets startup primary.

**Task tool & orchestration:** primaries invoke subagents via the `task` tool; gate with permission glob→action maps against subagent names: `"task": {"*": "deny", "review": "allow"}`. A denied subagent is removed from the task tool description. Subagents run in isolated **child sessions**. No native handoff primitive — orchestration = primary driving subagents.

**Permission keys (authoritative):** `read`, `edit` (gates write/edit/apply_patch), `glob`, `grep`, `list`, `bash`, `task`, `external_directory`, `todowrite`, `webfetch`, `websearch`, `lsp`, `skill`, `question`, `doom_loop`. Actions: `"allow" | "ask" | "deny"`; file/exec keys accept `{glob: action}` maps, last matching pattern wins. Patterns match underlying tool names, so MCP tools work (`"mymcp_*": "deny"`).

## 2. Custom commands

**Locations:** `.opencode/commands/<name>.md`, `~/.config/opencode/commands/<name>.md`. Filename → `/<name>`. Frontmatter (all optional): `description`, `agent`, `model`, `subtask` (force subagent isolation). Body = template: `$ARGUMENTS`, `$1..$n`, `` !`command` `` shell injection, `@path` file injection.

## 3. `opencode.json` highlights

`model` / `small_model` (`provider/model`), `provider` (options.apiKey `{env:VAR}`), `mcp` (`{"type": "local"|"remote", "command"/"url", "enabled", "environment"/"headers"}`), `permission` (global defaults), `agent`, `command`, `instructions` (array of rule files; globs + remote URLs), `plugin` (npm names), `compaction`, `watcher`. Merge precedence: remote → global → project → `.opencode` dirs. TUI settings live in separate `tui.json`.

## 4. AGENTS.md

Search order: project `AGENTS.md` (cwd upward, nearest wins) → global `~/.config/opencode/AGENTS.md` → `~/.claude/CLAUDE.md` fallback (only if no AGENTS.md). `instructions` config layers additional files. `@file` references inside AGENTS.md lazy-load. Claude compat env vars: `OPENCODE_DISABLE_CLAUDE_CODE*`.

## 5. Skills — fully supported

**Search locations (all loaded):** `.opencode/skills/<name>/SKILL.md`, `~/.config/opencode/skills/`, **`.claude/skills/` and `~/.claude/skills/` (Claude-compatible)**, `.agents/skills/` and `~/.agents/skills/`. Existing Claude-style skills work as-is.

**Frontmatter (only these recognized):** `name` (required; regex `^[a-z0-9]+(-[a-z0-9]+)*$`, 1–64 chars, must match dir name), `description` (required, 1–1024 chars), `license`, `compatibility`, `metadata` (string map).

**Invocation:** native `skill` tool (`skill({name})`); gate via `permission.skill` glob maps globally or per-agent.

## 6. Plugins

JS/TS at `.opencode/plugins/*.{ts,js}` (project) / `~/.config/opencode/plugins/` (global) or npm via `"plugin": [...]`. Module exports async fn `({project, client, $, directory, worktree}) => hooks`. Hooks: `tool.execute.before/after`, `session.*`, `message.*`, `command.executed`, `file.edited`, `shell.env`, `tui.*`, etc. Plugins can define custom tools.

## Applied in fleetsmith

- Plural dirs (`agents/`, `commands/`, `skills/`).
- `permission:` maps instead of deprecated `tools:` booleans; read-only agents get `edit: {"*": deny, "<workspace>/**": allow}` so handoff files stay writable.
- Orchestrator = `mode: primary` with `task` permission allowlisting exactly the fleet agents.
- Kickoff `/command` targets the orchestrator agent with `$ARGUMENTS`.
- Combined builds emit skills only to `.claude/skills/` (read natively by opencode); solo opencode builds emit `.opencode/skills/`.
