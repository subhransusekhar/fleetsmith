# Claude Code Extensibility Formats — Programmatic Reference (2025–2026)

Researched 2026-07-04 from official docs at `code.claude.com/docs/en/*`. All field names, allowed values, and paths are exact. Items marked *extension* are not part of the portable Agent Skills open standard.

## 1. Subagents — `.claude/agents/*.md`

Markdown: YAML frontmatter between `---` fences, then body (= system prompt verbatim).

**Locations & precedence (highest→lowest):** managed-settings `.claude/agents/` (org) → `--agents` CLI JSON (session) → `.claude/agents/` (project) → `~/.claude/agents/` (user) → plugin `agents/` dir. Scanned recursively; identity = `name` field only (not filename).

**Frontmatter (only `name`+`description` required):**

| Field | Values |
|---|---|
| `name` | **Req.** lowercase+hyphens. Hooks get it as `agent_type`. |
| `description` | **Req.** when to delegate. "use proactively" encourages it. |
| `tools` | Comma allowlist (`Read, Grep, Glob`). Inherits all if omitted. Supports `mcp__<server>`/`mcp__<server>__*`; `Agent(t1, t2)` restricts spawnable subagents. |
| `disallowedTools` | Denylist, applied before `tools`. `mcp__*` strips all MCP. |
| `model` | `sonnet`\|`opus`\|`haiku`\|`fable`\|full ID\|`inherit` (default `inherit`) |
| `permissionMode` | `default`\|`acceptEdits`\|`auto`\|`dontAsk`\|`bypassPermissions`\|`plan`\|`manual` (v2.1.200+) |
| `maxTurns` | int |
| `skills` | list of skill names preloaded (full content injected) |
| `mcpServers` | list: inline defs (`.mcp.json` schema) or string refs |
| `hooks` | lifecycle hooks scoped to subagent |
| `memory` | `user`\|`project`\|`local` |
| `background` | `true` = always background |
| `effort` | `low`\|`medium`\|`high`\|`xhigh`\|`max` |
| `isolation` | `worktree` (only value) |
| `color` | `red`\|`blue`\|`green`\|`yellow`\|`purple`\|`orange`\|`pink`\|`cyan` |
| `initialPrompt` | auto first turn when run as main agent via `--agent` |

Plugin subagents **ignore** `hooks`/`mcpServers`/`permissionMode`.

## 2. Agent Skills — `.claude/skills/<name>/SKILL.md`

Follows the open standard (agentskills.io). Standard fields: `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`. Rest are Claude Code extensions. Commands merged into skills (`.claude/commands/deploy.md` ≡ `/deploy`).

**Locations (precedence):** Enterprise > Personal `~/.claude/skills/` > Project `.claude/skills/` > Plugin (`plugin:skill` namespace). **Invocation command = directory name**, not `name` frontmatter.

**Frontmatter (all optional; `description` recommended):** `name` (display label), `description` + `when_to_use` (combined cap **1,536 chars**), `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools` (grants, not restricts; CLI-only), `disallowed-tools`, `model`, `effort`, `context: fork` (+ `agent`), `hooks`, `paths` (glob auto-activation), `shell`.

**Dir/progressive disclosure:** SKILL.md <500 lines; references loaded on demand; `scripts/` executed not loaded. Substitutions: `$ARGUMENTS`, `$N`, `$<name>`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`. Dynamic injection: `` !`cmd` ``.

## 3. Hooks — `settings.json` `hooks` block

30 events incl. `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `TeammateIdle`, `PreCompact`, `SessionEnd`. Handler types: `command`, `http`, `mcp_tool`, `prompt`, `agent` (experimental). Exit codes: `0`=success, `2`=block (stderr→Claude), other=non-blocking.

## 4. Plugins & marketplaces

Plugin layout: `.claude-plugin/plugin.json` (only `name` required) + `commands/ agents/ skills/ hooks/hooks.json .mcp.json output-styles/`. Marketplace: `.claude-plugin/marketplace.json` with `name`, `owner`, `plugins[]` (source types: relative path, `github`, `url`, `git-subdir`, `npm`).

## 5. Agent Teams

**Experimental, disabled by default.** Enable: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. `TeamCreate`/`TeamDelete` **removed** — team forms when first teammate spawns; main session is fixed lead; auto-cleanup on exit. Tools: `SendMessage`, `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate`/`TaskStop`. Runtime state in `~/.claude/teams/{team-name}/config.json` (do not author). `teammateMode` = `in-process`(default)\|`auto`\|`tmux`\|`iterm2`. **Teammates reuse subagent defs: honors `tools`+`model`; `skills`/`mcpServers` frontmatter not applied on this path.** Limits: one team/session, no nesting, fixed lead.

## 6. MCP — `.mcp.json`

`{"mcpServers": {"<name>": {...}}}`. `type`: `stdio` (`command`,`args`,`env`,`cwd`), `http` (`url`,`headers`,`timeout`,`alwaysLoad`), `sse` (deprecated), `ws`. Server name `workspace` reserved.

## 7. CLAUDE.md & rules

Load order: managed policy → user `~/.claude/CLAUDE.md` → project `./CLAUDE.md` or `./.claude/CLAUDE.md` → `./CLAUDE.local.md`. Target <200 lines. Imports via `@path`, max depth 4. **AGENTS.md not read directly — use `@AGENTS.md` import or symlink.** Path rules `.claude/rules/*.md` with `paths:` glob frontmatter.

## Generator gotchas (applied in fleetsmith)

- Subagent identity = `name` field, not filename (fleetsmith keeps them equal).
- Skill invocation name = directory name (fleetsmith keeps `name` == dir).
- Skills use hyphenated keys (`allowed-tools`); subagents use camelCase (`disallowedTools`).
- Subagent spawn tool is `Agent`; restrictable via `Agent(t1, t2)`.
- `skills:` frontmatter preloads content into subagents — but is ignored on the teammate path, so prompts must still instruct skill loading (fleetsmith does both).
- Skill `description`+`when_to_use` hard cap 1,536 chars (open-spec cap for `description` alone: 1,024 — fleetsmith enforces the stricter portable bound).
- Agent teams need the env var and have no authorable config file — fleetsmith compiles team behavior into prompts with subagent fallback.
