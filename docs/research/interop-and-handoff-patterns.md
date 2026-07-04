# Cross-Tool Agent Configuration Standards & Multi-Agent Handoff Patterns — 2025–2026 Reference

Researched 2026-07-04 (fleetsmith research fleet).

## 1. AGENTS.md — cross-tool instruction standard

Plain-Markdown file at a repo (or subdir) root giving coding agents project instructions — build/test commands, code style, testing, security, PR rules. **No required sections, no reserved schema**: "AGENTS.md is just standard Markdown. Use any headings you like; the agent simply parses the text you provide." Common sections: Project overview, Build/test commands, Code style, Testing, Security, Dev environment tips, PR instructions.

**Timeline & governance:** formalized as open spec **Aug 2025** (OpenAI + Amp, Google Jules, Cursor, Factory); donated to the **Agentic AI Foundation under the Linux Foundation** in **Dec 2025** — now vendor-neutral. Adoption: **60,000+ repos**, **20+ tools**.

**Nested AGENTS.md (important for the compiler):** monorepos can have many AGENTS.md; resolution rule is **"closest to the edited file wins"** — proximity-based override (nearest ancestor), not merge/concatenation. OpenAI's own monorepo ships **88** of them. Emit a root file for global conventions + per-package files for local overrides; don't rely on cross-file inheritance beyond nearest-ancestor.

**Tools that read it (from spec's list, 25+):** OpenAI Codex, Claude Code, GitHub Copilot, Cursor, Gemini CLI, Google Jules, Factory, Aider, goose, opencode, Zed, Warp, VS Code, Devin, UiPath Autopilot, JetBrains Junie, Amp, RooCode, Kilo Code, Phoenix, Semgrep, Ona, Windsurf, Augment Code. (Claude Code historically reads CLAUDE.md; recent versions also honor AGENTS.md — many teams symlink.)

## 2. Agent Skills — open capability standard (SKILL.md)

A skill = **directory with a `SKILL.md`** (YAML frontmatter + Markdown body) + optional `scripts/`, `references/`, `assets/`. Built by Anthropic, **open standard late 2025**; canonical spec at **agentskills.io/specification** (the `anthropics/skills` repo file is just a redirect pointer). Validator `skills-ref` lives in `agentskills/agentskills`.

**Frontmatter (exact):**

| Field | Req | Constraints |
|---|---|---|
| `name` | Yes | 1–64 chars; lowercase alnum + hyphens; no leading/trailing/consecutive hyphens; **must match parent dir name** |
| `description` | Yes | 1–1024 chars; state *what* AND *when to use*; keyword-rich for routing |
| `license` | No | license name / bundled file ref |
| `compatibility` | No | ≤500 chars; env requirements (product, packages, network) |
| `metadata` | No | arbitrary string→string map (sanctioned escape hatch for client extras) |
| `allowed-tools` | No | **experimental**; space-separated, e.g. `Bash(git:*) Bash(jq:*) Read` |

**Progressive disclosure (3 levels):** (1) metadata ~100 tokens (name+description of ALL skills at startup — the router match surface); (2) full SKILL.md body <5000 tokens / <500 lines on activation; (3) resources loaded on demand, references kept one level deep.

**Cross-tool adoption (the portability win):** **opencode** (native), **goose** (built-in, auto-discovers `~/.config/goose/skills/`, can read `~/.claude/skills/`), **Cursor**, **Copilot in VS Code**, **Codex/ChatGPT**, **Gemini CLI**, **Roo Code**, **Trae**, **Windsurf**, **Amp**, **Factory**. Distribution converging on `npx skills add` across ~40 clients. One SKILL.md folder is portable across Claude Code / opencode / goose near-unchanged.

**Division of labor:** AGENTS.md = project-level, always-loaded context; SKILL.md = task-level, load-on-demand capability. Complementary.

## 3. MCP as extension/interop layer

Current spec **2025-11-25**. Harness-relevant highlights:
- **Async Tasks** (experimental): any request becomes "call-now, fetch-later" via a task handle — key for long-running work / A2A-style lifecycles.
- **Sampling with Tools (SEP-1577):** servers can initiate sampling *with tool definitions* → **server-side agent loops**.
- **Auth:** OIDC Discovery 1.0, incremental scope consent via `WWW-Authenticate`, tighter OAuth alignment.
- **Extensions framework** + icon metadata; `description` on `Implementation` to match registry `server.json`.
- **Errors:** input-validation errors returned as Tool Execution Errors (not Protocol Errors) for model self-correction.
- **Governance:** formal Working/Interest Groups + SDK tiering.
- **Forward (2026-07-28 RC):** stateless HTTP core, MCP Apps (server-rendered UIs), Tasks as formal extension. Target 2025-11-25 as stable floor.

## 4. Handoff / orchestration mechanisms

**OpenAI Agents SDK:** handoff compiled into a tool `transfer_to_<agent>` (via `handoffs` param); receiver sees **full prior history** by default. Tunable: `input_filter` prunes input; `RunConfig.nest_handoff_history` collapses transcript into a single assistant summary in a `<CONVERSATION HISTORY>` block; structured metadata attachable. Selection = LLM chooses which transfer tool.

**LangGraph (supervisor vs swarm):** both use **`Command` from handoff tools** — `create_handoff_tool` returns `Command(goto=<agent>, graph=Command.PARENT)`, `Command.update` writes shared state. Supervisor = central router LLM (more accurate, extra hop); swarm (`langgraph-swarm-py`) = peer-to-peer with persisted `active_agent` marker (faster, more misroutes). Context via **shared graph state**, not transcript replay. Advice: start supervisor, graduate to swarm on latency data.

**CrewAI (crews vs flows):** Crews = role/goal/tool teams; Hierarchical Process has a manager agent delegating + validating, with `allowed_agents` constraining delegation targets. Context via sequential task outputs + shared memory (`memory=True`); each delegation is an LLM call. Flows = lower-level event-driven `@start`/`@listen`/`@router` Python class sequencing crews/functions/agents deterministically.

**Microsoft Agent Framework (AutoGen + Semantic Kernel merged):** preview Oct 1 2025, **1.0 GA Apr 7 2026** (.NET + Python). Patterns: **sequential, concurrent, handoff, group chat, Magentic-One**, all with streaming/checkpointing/HITL/pause-resume. Handoff = context-driven LLM-selected transfer. Adds graph-based workflows. Commits to **MCP, A2A, OpenAPI**.

**Google ADK + A2A:** ADK = model-/deploy-agnostic orchestrator; A2A = cross-vendor wire protocol. Discovery via **Agent Cards** (capability/modality/auth descriptors). Work = **Tasks** with lifecycle `submitted→working→input-required→completed/canceled/failed`. Handoff = structured A2A request/response (works across languages; ADK ships a handoff inspector). **v0.2** added stateless interactions + OpenAPI-style auth. A2A is the de-facto inter-framework standard, complementary to MCP (tools).

**Two families:** *transcript-based* (OpenAI/MS/ADK-A2A: next agent gets history, optionally filtered/summarized) vs *shared-state-based* (LangGraph `Command.update`, CrewAI memory: common store, no dialogue replay). Selection = LLM-as-router vs declarative routing (flows/graph edges). fleetsmith's file protocol is shared-state-based with A2A-like task lifecycle in the ledger.

## 5. Meta-agent / harness-builder tools (prior art)

- **Superpowers (obra)** — generates enforced workflow methodology (brainstorm→design→plan→TDD→2-stage review) as SKILL.md skills. **8 harnesses**: Claude Code, Codex, Factory Droid, Gemini CLI, OpenCode, Cursor, Copilot CLI. Closest existing cross-harness skill distribution.
- **BMAD-METHOD** — full agile lifecycle w/ personas (analyst/PM/architect/dev/QA), approval gates, 12+ personas (v6). Criticized as bloat for teams <5.
- **wshobson/agents** — **emits harness-native artifacts to Claude Code, Codex CLI, Cursor, OpenCode, Gemini CLI, Copilot from ONE Markdown source** — closest architectural analog to fleetsmith. Single maintainer, no versioned releases.
- **Ruflo (ex-Claude-Flow)** — v3.5 Rust/WASM rewrite. Swarm orchestration, ~100+ agents, topologies/consensus (Raft/BFT/Gossip/CRDT). Runtime-oriented, not a portable config emitter.
- **Agent OS (buildermethods)** — Claude-Code-centric standards management via slash commands. Narrow portability.
- **VoltAgent** — TS agent *framework* (supervisor + isolated-context sub-agents), plus curated `awesome-claude-code-subagents` (100+) portable Markdown definitions.
- **Open Agent Specification (arXiv 2510.04173)** — describes agent execution graphs *independent of runtime* for cross-framework portability; nearest spec-level prior art to a runtime-agnostic fleet spec.

**Positioning takeaway:** ecosystem converging on **SKILL.md as transport** + `npx skills add`. wshobson/agents & Superpowers already prove "one source → many harness artifacts." fleetsmith differentiates at **fleet composition + handoff topology**, not per-artifact format — emit AGENTS.md + SKILL.md + per-harness config, don't invent a file the tools won't read.

## 6. File-based context-handover best practices

- **Semantic file roles (de-facto vocab):** AGENTS.md = context interface/conventions; CLAUDE.md = project conventions; MEMORY.md = cross-session knowledge index; RULES.md = constraints; Plan.md = planning state.
- **Structured, minimal handoff docs:** metadata (timestamp, model, git branch), goal, progress/build/test status, uncommitted changes, design decisions, **failed approaches**, blockers, critical files w/ exact paths, resumption instructions.
- **No-duplication rule:** never paste transcripts; reference PRDs/plans/ADRs/issues/commits. Handoff = pointers + deltas, not archives.
- **Narrative recasting:** reframe inherited messages as *context* (not new agent's outputs), attribute tool calls to originating agent, rebuild working context from new agent's perspective.
- **Task ledgers / state files** (Magentic-One, ADK Tasks, LangGraph state): shared append-only status record — file-based mirror of A2A's Task lifecycle. For a file harness: single ledger + per-handoff docs, both under the no-duplication rule.

## Load-bearing conclusions applied in fleetsmith

1. **Emit the two adopted formats, not a new one:** AGENTS.md (closest-wins nesting) + SKILL.md folders — read unchanged by Claude Code, opencode, goose today.
2. **SKILL.md is the portability backbone** — stable validated frontmatter (name ≤64 chars matching dir, description ≤1024); `metadata` is the sanctioned extras hatch; `allowed-tools` experimental.
3. **Handoff has two interoperable models** — transcript-passing vs shared-state. fleetsmith's file harness is shared-state (ledger + handoff docs) with A2A-like task lifecycle statuses.
4. **Prior art to study, not duplicate:** wshobson/agents + Superpowers for one-source→many-artifacts; fleetsmith's edge is typed handoff topology + validation.
5. **Target MCP 2025-11-25**; watch the stateless-core 2026 RC.

## Sources

[AGENTS.md](https://agents.md) · [InfoQ AGENTS.md](https://www.infoq.com/news/2025/08/agents-md/) · [Agent Skills spec](https://agentskills.io/specification) · [anthropics/skills](https://github.com/anthropics/skills) · [agentskills/agentskills](https://github.com/agentskills/agentskills) · [opencode Skills](https://opencode.ai/docs/skills/) · [goose Skills](https://goose-docs.ai/docs/guides/context-engineering/using-skills/) · [Willison: Agent Skills](https://simonwillison.net/2025/Dec/19/agent-skills/) · [MCP 2025-11-25 changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog) · [2026 MCP roadmap](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/) · [OpenAI SDK Handoffs](https://openai.github.io/openai-agents-python/handoffs/) · [langgraph-supervisor](https://reference.langchain.com/python/langgraph-supervisor) · [langgraph-swarm-py](https://github.com/langchain-ai/langgraph-swarm-py) · [CrewAI Crews](https://docs.crewai.com/en/concepts/crews) · [MS Agent Framework](https://learn.microsoft.com/en-us/agent-framework/overview/) · [Google ADK+A2A](https://developers.googleblog.com/build-cross-language-multi-agent-team-with-google-agent-development-kit-and-a2a/) · [obra/Superpowers](https://github.com/obra/Superpowers) · [wshobson/agents](https://github.com/wshobson/agents) · [Agent OS](https://buildermethods.com/agent-os) · [VoltAgent](https://github.com/VoltAgent/awesome-claude-code-subagents) · [Open Agent Spec arXiv](https://arxiv.org/html/2510.04173v1)
