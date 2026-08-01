# Agent Harness Best Practices (2025–2026): Research-Backed Techniques for a Fleet Compiler

Researched 2026-08-01. Companion to `platform-optimizations-2026-08.md` (platform-specific findings). This document covers cross-platform harness-engineering evidence; each technique notes how a fleet **compiler** could bake it into generated output.

**Bottom line:** the strongest evidence says the failure surface of a multi-agent harness is not the agents — it's the **handoff contract and the role decomposition**. The best-evidenced study (MAST, NeurIPS 2025 D&B, 1,600+ annotated traces, inter-annotator κ=0.88) attributes ~42% of multi-agent failures to specification/design issues, ~37% to inter-agent misalignment, and ~21% to weak verification. That maps almost exactly onto what a fleet compiler controls.

Sourcing labels: **[OFFICIAL]** vendor docs · **[PRODUCTION]** engineering writeup with real numbers · **[BENCHMARK]** · **[OPINION]**. §7 lists widely-repeated claims that are NOT actually documented.

---

## 0. The four findings that should change fleetsmith's defaults

### 0.1 Decompose by context, not by problem **[CHANGES DEFAULTS]** — [OFFICIAL]
Anthropic's 2026 guidance names **problem-centric decomposition as the critical anti-pattern**: dividing a fleet by work type (planning/implementation/testing) creates "constant coordination overhead" and "telephone game" losses. The recommended alternative is **context-centric decomposition** — group work by *shared context needs*, split only where "context can be truly isolated." Good boundaries: independent research paths, blackbox verification. Bad boundaries: sequential phases of the same work.

This is a direct hit on how most generated fleets — including fleetsmith's own meta-fleet (domain-analyst → fleet-architect → skill-smith → harness-qa) — are structured. That pipeline is problem-centric by construction. It may still be right, since a file-based handover is the documented mitigation, but the compiler should be asking "do these two agents need the same context?" and merging when the answer is yes.
https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them
> **Compiler hook:** validation pass flagging adjacent phases that share most of their inputs/artifacts as merge candidates — "agents A and B are phases of one context; consider one agent with a checklist."

### 0.2 Single-writer rule: parallelize readers and reviewers, serialize writers **[CHANGES DEFAULTS]**
Every 2026 source converges here from different directions. Cognition's 2025 "Don't Build Multi-Agents" argued parallel agents diverge on *implicit decisions* (style, edge-case handling) no task brief captures **[OPINION]**. Their 2026 reversal narrows it precisely: multi-agent works "when writes stay single-threaded and the additional agents contribute intelligence rather than actions" **[PRODUCTION]**. Scott Chacon's Grit project (Git in Rust, 360k LOC, ~45B tokens, 99.3% tests passing) supplies the hard anecdote: "one of a group of parallel agents broke a fundamental part of the testing harness," dropping test passage from ~80% to near zero **[PRODUCTION]**.
https://cognition.com/blog/dont-build-multi-agents · https://cognition.com/blog/multi-agents-working · https://blog.gitbutler.com/true-grit
> **Compiler hook:** make `parallel: true` legal only for phases whose declared artifacts are read-only or write to disjoint paths; warn/reject on parallel phases with overlapping write globs.

### 0.3 The orchestrator's paraphrase is a measurable accuracy leak **[CHANGES DEFAULTS]** — [BENCHMARK]
LangChain's head-to-head (modified τ-bench retail, 100 examples, 6 distractor domains × 19 tools) found the **supervisor topology was the weakest multi-agent option** — beaten by flat peer handoff (swarm) on both accuracy and token cost. Root cause: "the supervisor agent had to play telephone between the sub agents and the user." Fixing the message-passing contract so subagent output reaches the consumer unparaphrased yielded "a nearly 50% increase in performance on this benchmark." Small-N, one domain family — but it's the only public head-to-head, and it corroborates MAST's coordination bucket.
https://www.langchain.com/blog/benchmarking-multi-agent-architectures
> **Compiler hook:** make handoff files the *canonical artifact* and instruct the orchestrator to cite/link them rather than restate their contents — "cite the handoff file, do not summarize it." Natural fit for fleetsmith's existing protocol; the change is a prose rule in the orchestrator prompt plus a LEDGER entry pointing at the artifact path.

### 0.4 KV-cache stability is a 10× cost constraint that forbids per-phase prompt mutation **[CHANGES DEFAULTS]**
Manus reports cache hit rate is "the single most important metric for a production-stage AI agent," with cached tokens at $0.30/MTok vs $3/MTok uncached and an agent input:output ratio "around 100:1" **[PRODUCTION]**. Anthropic's caching docs give the mechanism: invalidation cascades in the order `tools → system → messages`, so **any change to the tool list or system prompt invalidates everything downstream** **[OFFICIAL]**. Current minimum cacheable prefix: 512 tokens (Opus 5 / Fable 5), 1,024 (Sonnet 5 / Haiku 4.5). Cache reads 0.1×; 5m writes 1.25×, 1h writes 2×. Manus notes timestamps in prompts "kill your cache hit rate."
https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus · https://platform.claude.com/docs/en/build-with-claude/prompt-caching
> **Compiler hook:** emit agent prompts with an invariant prefix (role, protocol, tool guidance) and push all per-phase/per-iteration variance — current phase, iteration counter, timestamps — to the *end*, into the handoff file rather than the system prompt. A harness that rewrites its own system prompt per phase silently pays ~10×.

---

## 1. Context engineering

**1.1 Smallest high-signal token set / "minimal ≠ short"** — [OFFICIAL] "Finding the *smallest possible* set of high-signal tokens that maximize the likelihood of some desired outcome," but explicitly "minimal does not necessarily mean short." Target the "Goldilocks zone" between brittle hardcoded logic and vague high-level guidance. Structure with distinct sections (`<background_information>`, `<instructions>`, `## Tool guidance`).
https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
> **Compiler hook:** emit every agent prompt with the same fixed section skeleton; lint for prompts that are all prose with no headers.

**1.2 Context rot is empirically real** — [BENCHMARK, strongest external evidence] Chroma tested 18 models (GPT-4.1, Claude 4, Gemini 2.5, Qwen3 families): performance degrades with input length even on trivial retrieval and text replication; degradation is worse when needle and question are semantically rather than lexically similar; **a single distractor measurably lowers accuracy**; LongMemEval showed every model family scoring "significantly higher on focused prompts compared to full prompts." Mechanism per Anthropic: transformers produce n² pairwise relationships for n tokens.
https://www.trychroma.com/research/context-rot · https://github.com/chroma-core/context-rot
> **Compiler hook:** this is the *justification* to put in generated docs for why handoff files are summaries, not transcripts — so users don't "helpfully" widen the context.

**1.3 Progressive disclosure, three levels, one level deep** — [OFFICIAL] Metadata (name+description) preloaded for every skill → SKILL.md read when judged relevant → bundled files on demand. The under-cited constraint: **references must be one level deep from SKILL.md**, because "Claude may partially read files when they're referenced from other referenced files," using `head -100`-style previews. So `SKILL.md → advanced.md → details.md` is an anti-pattern. Corollary: reference files over 100 lines need a table of contents so a partial read still reveals scope.
https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
> **Compiler hook:** mechanical lint — reject generated skills whose `references/` files link to further references; auto-insert a TOC into any reference over 100 lines.

**1.4 Just-in-time retrieval over preloading (hybrid in practice)** — [OFFICIAL] Agents hold "lightweight identifiers" (file paths, queries, links) and load at runtime. Tradeoff stated honestly: "runtime exploration is slower than retrieving pre-computed data"; hybrid works best.
> **Compiler hook:** handoff files carry *paths and queries*, not pasted file contents.

**1.5 Sub-agent context isolation with a compression contract** — [OFFICIAL] Each subagent "might explore extensively, using tens of thousands of tokens or more, but returns only a condensed, distilled summary of its work (often **1,000–2,000 tokens**)."
> **Compiler hook:** explicit token budget line in every generated worker prompt — "return 1,000–2,000 tokens: findings, artifact paths, open questions — not your search trace."

**1.6 Compaction, and the tool-result-clearing variant** — [OFFICIAL] Summarize a near-full window and reinitialize. Tuning order: "maximize recall to ensure your compaction prompt captures every relevant piece of information, then iterate to improve precision." Lightest-touch form is **tool result clearing**. LangChain's deepagents publishes concrete thresholds: offload tool inputs/results >20,000 tokens to files and replace with references; truncate older file ops to pointers at 85% context; Claude Code auto-compacts at 95%.
https://docs.langchain.com/oss/python/deepagents/context-engineering
> **Compiler hook:** emit a phase-boundary compaction instruction — "before handing off, write findings to the handoff file, then treat prior tool output as discardable."

**1.7 Structured note-taking + recitation** — [OFFICIAL + PRODUCTION] Anthropic: agents persist notes outside the window and reload them. Manus adds **recitation** — rewrite `todo.md` every step to push the objective into recent attention and defeat lost-in-the-middle.
> **Compiler hook:** LEDGER.md already is this. The addition is *recitation* — instruct agents to re-read and rewrite the open-items block each iteration, not just append.

**1.8 Keep the wrong stuff in** — [PRODUCTION] Manus: leave failed actions and stack traces in context. "Without evidence, the model can't adapt." Under-represented in Anthropic's guidance and cuts against naive compaction.
> **Compiler hook:** handoff templates need a `## Failed approaches` section that compaction is instructed *not* to drop.

**1.9 Preserve reasoning traces across tool calls** — [BENCHMARK] OpenAI: τ-bench Retail rose **73.9% → 78.2%** purely by retaining reasoning between tool calls (Responses API `previous_response_id`). Quiet corroboration of "share full traces" for the *writer* role.
https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide

---

## 2. Multi-agent orchestration

**2.1 Orchestrator-worker, with the real numbers** — [PRODUCTION] Lead agent plans, spawns 3–5 parallel subagents, synthesizes, separate citation pass. **90.2% better** than single-agent Opus 4 on internal research eval; parallel tool calling cut research time **up to 90%**; token usage alone explains **80% of performance variance** on browsing tasks. Cost ~**15×** chat tokens (Anthropic's 2026 blog gives a more conservative **3–10×** generally).
https://www.anthropic.com/engineering/multi-agent-research-system

**2.2 When multi-agent fails** — [PRODUCTION] Poor fit: domains needing shared context across agents, significant interdependencies, **most coding work** ("limited parallelizable components"), anything needing real-time coordination. OpenAI's posture is stricter: "maximize a single agent's capabilities first"; escalate only when agents "fail to follow complicated instructions or consistently select incorrect tools."
https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf
> **Compiler hook:** have the domain-analyst phase emit an explicit "why multi-agent" justification into the spec; default to fewer agents when the answer is weak.

**2.3 Delegation brief = objective + output format + tool/source guidance + boundaries** — [PRODUCTION] Anthropic's named fix for duplicated work. Their documented failure: early subagents "investigating overlapping time periods without clear labor division."
> **Compiler hook:** four-field required schema for every handoff file; fail generation if a phase lacks any field.

**2.4 Effort scaling heuristics embedded in the prompt** — [PRODUCTION] Simple fact-finding: 1 agent, 3–10 tool calls. Direct comparison: 2–4 subagents, 10–15 calls each. Complex research: 10+ subagents with clearly divided responsibilities.
> **Compiler hook:** emit this table verbatim into orchestrator prompts, scaled to fleet size.

**2.5 Reviewers work *better* with no shared context** — [PRODUCTION + OFFICIAL] Cognition 2026: the coder/reviewer loop improves when the reviewer sees only the diff and criteria. Anthropic agrees: "A reviewer running in a fresh subagent context sees only the diff and the criteria you give it, not the reasoning that produced the change, so it evaluates the result on its own terms." Devin Review catches ~2 bugs/PR, ~58% severe.
https://code.claude.com/docs/en/best-practices
> **Compiler hook:** generate QA/critic agents with *deliberately minimal* inputs — artifact + acceptance criteria only, explicitly not the producing agent's handoff.

**2.6 The counterweight most harnesses omit** — [OFFICIAL] "A reviewer prompted to find gaps will usually report some, even when the work is sound, because that is what it was asked to do. Chasing every finding leads to over-engineering... Tell the reviewer to flag only gaps that affect correctness or the stated requirements, and treat the rest as optional."
> **Compiler hook:** bake that sentence into every generated critic prompt. Free, and it prevents a common runaway.

**2.7 Adversarial verification / judge panels** — [OFFICIAL] Claude Code dynamic workflows run "independent agents adversarially review each other's findings before they're reported"; bundled `/deep-research` fans out, cross-checks, **votes on each claim**, filters claims that didn't survive, and lists unverifiable claims (rate limit, API error) as *unverified* rather than refuted.
https://code.claude.com/docs/en/workflows
> **Compiler hook:** for research-shaped fleets, generate a verification phase with a three-way outcome (verified / refuted / unverifiable), not binary pass-fail.

**2.8 Artifact systems beat coordinator filtering** — [PRODUCTION] "Specialized subagents output directly to filesystems, reducing 'game of telephone' information loss through repeated coordinator filtering." Validates fleetsmith's core design choice.

**2.9 Tool overlap, not tool count, is the split trigger** — [OPINION, hedged] OpenAI: "Some implementations successfully manage more than 15 well-defined, distinct tools while others struggle with fewer than 10 overlapping tools." Anthropic's version: "If a human engineer can't definitively say which tool should be used in a given situation, an AI agent can't be expected to do better."

**2.10 Contradictory layered prompts are actively expensive** — [VENDOR] GPT-5 "expends reasoning tokens searching for a way to reconcile the contradictions rather than picking one instruction at random." Relevant because a fleet stacks orchestrator + agent + skill prompts.
> **Compiler hook:** emit an explicit instruction-hierarchy line — "where this conflicts with the skill, the skill wins for methodology; this file wins for scope and handoff."

---

## 3. Cost and latency

**3.1 Model tiering per role** — [PRODUCTION + OFFICIAL] Anthropic's 90.2% result came specifically from **Opus 4 lead + Sonnet 4 subagents**. Claude Code exposes per-subagent `model:` frontmatter, resolution order `CLAUDE_CODE_SUBAGENT_MODEL` env → per-invocation param → frontmatter → main conversation.
> **Compiler hook:** per-agent tier mapped to each target's native mechanism. Default: strong model for orchestrator/architect roles, cheap model for mechanical/extraction roles.

**3.2 Effort/reasoning budgets as a knob** — [OFFICIAL + VENDOR] Claude Code supports `effort` on both skills and subagents. GPT-5 guidance treats agentic eagerness as tunable both directions: lower effort + explicit context-gathering budget + early-stop criteria + hard tool-call caps + an **escape hatch** ("even if it might not be fully correct") to reduce; raise effort + persistence prompts to increase.
> **Compiler hook:** expose `effort:` per agent; emit early-stop criteria into research roles and persistence language into implementation roles.

**3.3 Prompt caching alignment** — see §0.4. Additional mechanic: the **20-block lookback window** means long conversations lose the original cache entry; fix is a second explicit breakpoint mid-history. Up to 4 breakpoints allowed.

**3.4 Cursor's production lesson on over-thorough prompts** — [PRODUCTION] "Be THOROUGH when gathering information" caused GPT-5 to "overuse tools by calling search repetitively, when internal knowledge would have been sufficient." Fixed by softening plus "Bias towards not asking the user for help if you can find the answer yourself."
> **Compiler hook:** don't emit thoroughness superlatives into worker prompts by default; they cost tokens without improving output.

**3.5 One task per turn** — [VENDOR] "Peak performance occurs when distinct, separable tasks are broken up across multiple agent turns, with one turn for each task."

---

## 4. Reliability

**4.1 Give every loop an objective verifier — the central principle** — [OFFICIAL] "Claude stops when the work looks done. Without a check it can run, 'looks done' is the only signal available, and you become the verification loop... Give Claude something that produces a pass or fail, and the loop closes on its own." Four escalating levels: in-prompt → session-scoped `/goal` condition → deterministic `Stop` hook blocking turn end → verification subagent with fresh context. Also: "Have Claude show evidence rather than asserting success."
https://code.claude.com/docs/en/best-practices
> **Compiler hook:** `phases[].loop` should require a `check:` that is a *shell command with an exit code*, not a prose criterion — and the ledger should record the command and its output, not the agent's opinion of it.

**4.2 Documented iteration caps to wire up rather than reinvent** — [OFFICIAL]
- **Stop hook: 8 consecutive blocks**, then Claude Code overrides and ends the turn (documented only on best-practices — verify per version).
- `maxTurns` frontmatter per subagent.
- `/goal` accepts a turn/time clause; condition max 4,000 chars.
- Dynamic workflows: 16 concurrent agents, 1,000 total per run; advisory warning at >25 scheduled agents or >1.5M projected tokens.
- Subagent nesting depth: 3 (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`).
> **Compiler hook:** map `loop.max` onto `maxTurns` (Claude Code), goose native `retry`, prose cap for opencode — and *always* emit a numeric cap even when the spec omits one.

**4.3 Two stop rules beat a bare iteration cap** — [OFFICIAL] Anthropic's documented workflow prompts use fixpoint conditions, not just counters: "keep fixing the reported errors until the type check passes **or two rounds in a row make no progress**"; "stop once two rounds in a row find nothing new."
> **Compiler hook:** generate three-part stop conditions — success check, no-progress rule, hard cap.

**4.4 Hooks are the deterministic layer; exit-code contract** — [OFFICIAL] "Unlike CLAUDE.md instructions which are advisory, hooks are deterministic and guarantee the action happens." Exit 0 = success; **exit 2 = blocking error** (stderr fed back; on `SubagentStop` prevents the subagent stopping). Gotchas: matching hooks **run in parallel with no guaranteed ordering**; on resume "Claude Code replays the saved text rather than re-running the hook" — **hooks are not idempotent across resume**.

**4.5 Plan-validate-execute for destructive/batch work** — [OFFICIAL] analyze → write a `changes.json` plan file → validate the plan with a script → execute → verify. "Machine-verifiable... Reversible planning."
> **Compiler hook:** default shape for any generated phase whose artifacts include file mutations.

**4.6 Resumability and where it leaks** — [OFFICIAL + PRODUCTION] Agents "store essential information in external memory before proceeding" — the primary-source justification for a handover ledger. Claude Code workflow caching: "Cached results stop at the first agent that didn't finish, and every agent that started after that one runs again," therefore "**a workflow that fans work out across many small agents preserves more progress than one long agent**." Checkpoints only track file-edit tools, not Bash.
> **Compiler hook:** finer phase granularity; write a ledger entry at *phase start* as well as completion so a resumed run knows what was in flight.

**4.7 Deterministic sandboxing of writer agents** — [OFFICIAL] `PreToolUse` hook in the subagent's own frontmatter can validate individual operations (documented example: grep Bash for `INSERT|UPDATE|DELETE|DROP` and exit 2). Plus `permissionMode`, `isolation: worktree`.
> **Compiler hook:** read-only tool sets for analyst/QA roles by default; grant write tools only to agents whose declared artifacts require them.

**4.8 Reward hacking is a real failure mode** — [PRODUCTION] From Grit: agents implemented *just enough* to pass sha256 tests without implementing sha256.
> **Compiler hook:** generated verification phases should include "check the implementation, not only the test result" for any test-gated loop.

---

## 5. Skill and prompt design

**5.1 Description-as-router** — [OFFICIAL] The `description` is the *entire* routing signal. Hard rule: "**Always write in third person**." Must carry **what + when + literal trigger vocabulary**. Canonical shape: `Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.` Anti-examples: `Helps with documents`, `Processes data`.

**5.2 The description budget that silently truncates** — [OFFICIAL] `description` max **1,024 chars** platform-level; Claude Code truncates `description` + `when_to_use` at **1,536 chars**, and budgets the whole skill listing at **1% of the context window**. On overflow "Claude Code drops descriptions starting with the skills you invoke least" — **a large generated fleet can silently lose its own trigger keywords**. Diagnostics: `/doctor`, `--debug`, `Skills` row in `/context`. Tunables: `skillListingBudgetFraction`, `skillListingMaxDescChars`. Put the key use case first.
> **Compiler hook:** highest-value QA gate available — sum generated descriptions, compare against budget, fail loudly.

**5.3 SKILL.md under 500 lines** — [OFFICIAL] Split when approaching. Note: the claim that over-long skills "get ignored" is **not documented** for skills — that mechanism is documented for CLAUDE.md only.

**5.4 Code before prose** — [OFFICIAL + VENDOR] "Sorting a list via token generation is far more expensive than simply running a sorting algorithm." Bundled scripts: more reliable, save tokens, save time, consistent. Disambiguate intent: "Run `analyze_form.py`" (execute) vs "See `analyze_form.py` for the algorithm" (read). Script rules: **solve, don't defer** (handle errors in the script) and **no voodoo constants**.

**5.5 Degrees of freedom** — [OFFICIAL] Match specificity to fragility: high freedom (prose heuristics) when many approaches work; medium (pseudocode/parameterized scripts); low (exact commands, "Do not modify the command") when fragile and consistency-critical.
> **Compiler hook:** add `freedom: high|medium|low` per skill, selecting the emitted template.

**5.6 Documented anti-patterns — all mechanically lintable** — [OFFICIAL] (1) time-sensitive info; (2) Windows-style paths — always forward slashes; (3) too many options (one default + named escape hatch); (4) inconsistent terminology; (5) assuming tools installed; (6) unqualified MCP tool names (always `ServerName:tool_name`); (7) over-explaining ("Does this paragraph justify its token cost?"); (8) vague names — prefer **gerund form** (`processing-pdfs`, not `helper`/`utils`).
> **Compiler hook:** ship as a `fleetsmith lint` pass.

**5.7 Reasoning-based instructions beat rigid directives** — [OFFICIAL] "Do X because Y tends to cause Z" beats "ALWAYS do X, NEVER do Y." Iteration rule: "If pass rates plateau despite adding more rules, the skill may be over-constrained — try removing instructions."

**5.8 Skill lifecycle gotcha** — [OFFICIAL] "the rendered SKILL.md content enters the conversation as a single message and stays there for the rest of the session... write guidance that should apply throughout a task as **standing instructions** rather than one-time steps."
> **Compiler hook:** generated skills phrase methodology as standing rules, not "first do X, then do Y" — the latter decays after turn one.

**5.9 Workflow + checklist + validator gate** — [OFFICIAL] Multi-step skills ship a copyable checklist; paired with run validator → fix → repeat and "**Only proceed when validation passes.**"

---

## 6. Harness evaluation and observability

**6.1 Trigger tests are separate from output tests** — [OFFICIAL] "Measure two things separately: whether Claude invokes it on the prompts it should, and whether the output matches what you expect when it does." `skill-creator`'s description-tuning mode generates should-trigger and should-not-trigger prompts, measures hit rate, proposes description edits — Anthropic reports it **improved triggering on 5 of 6** public skills.
> **Compiler hook:** emit a `should-trigger`/`should-not-trigger` prompt list alongside every generated skill; harness-qa runs it.
> Silent-failure guard: **malformed YAML frontmatter makes Claude Code load the body with empty metadata** — `/skill-name` still works so it *looks* fine, but there's no description to match against. Only `--debug` shows it.

**6.2 Baseline-comparison golden runs (with-skill vs without-skill)** — [OFFICIAL] Paired A/B, not absolute score. Directory contract: `<skill>/evals/evals.json`, workspace `iteration-N/eval-<name>/{with_skill,without_skill}/`, `benchmark.json` (pass_rate, time, tokens, mean + stddev, delta). "A skill that adds 13 seconds but improves pass rate by 50 points is probably worth it. A skill that doubles token usage for a 2-point improvement might not be."
https://agentskills.io/skill-creation/evaluating-skills
> **Compiler hook:** generate `evals/evals.json` with 2–3 cases per skill. Doubles as the model-upgrade drift detector.

**6.3 Small N is fine: 2–3 per skill, ~20 per system** — [OFFICIAL + PRODUCTION] Early-stage effect sizes are large enough to detect with small N.

**6.4 Write assertions *after* the first run; scripts over judges for mechanical checks** — [OFFICIAL] "You often don't know what 'good' looks like until the skill has run." "For assertions that can be checked by code, use a verification script — scripts are more reliable than LLM judgment for mechanical checks." "**Require concrete evidence for a PASS.**"

**6.5 Assertion-pattern analysis** — [OFFICIAL] always-passes-in-both → delete; always-fails-in-both → assertion broken; passes-with/fails-without → where the skill earns its keep; high stddev → flaky eval; 3× time/token outliers → read the transcript.

**6.6 LLM-as-judge: use it, but narrowly** — [PRODUCTION + ACADEMIC] Anthropic: **a single LLM call outputting 0.0–1.0 plus pass/fail "was the most consistent"** — resist judge ensembles. Documented biases: position, verbosity (15–30 points inflation, Wang et al.), self-preference, calibration drift. Sharp risk in a pipeline: an unreliable judge **selects the wrong branch and the error compounds downstream**. Mitigations: randomize order, control for length, prefer deterministic checks.
https://arxiv.org/pdf/2410.02736 · https://arxiv.org/pdf/2410.21819
> **Compiler hook:** generated QA phases route mechanical assertions to scripts, reserve the judge for subjective dimensions, blind pairwise ordering for comparisons.

**6.7 Blind pairwise comparison for holistic quality** — [OFFICIAL] Present both outputs without revealing which version — complements assertion grading.

**6.8 End-state evaluation, not step-by-step** — [PRODUCTION] Grade the final artifact, not path adherence — agents legitimately find alternative valid routes.

**6.9 Eval-driven development: evals before docs** — [OFFICIAL] "**Create evaluations BEFORE writing extensive documentation.**" Five steps: run without the skill and document failures → build three scenarios → baseline → write minimal instructions to pass → iterate.

**6.10 The Claude A / Claude B authoring loop** — [OFFICIAL] Claude A designs the skill; **a fresh** Claude B uses it on real tasks. "A fresh session matters because leftover context from authoring the skill will mask gaps in the written instructions."
> **Compiler hook:** harness-qa should run generated skills in a *fresh* subagent, never in the authoring context.

**6.11 Observe navigation, not just outcomes** — [OFFICIAL] Diagnostics from watching Claude walk a skill's file tree: unexpected exploration paths, missed connections, overreliance on one file, never-accessed files.

**6.12 Per-agent, per-skill cost attribution via OpenTelemetry** — [OFFICIAL] `CLAUDE_CODE_ENABLE_TELEMETRY=1`; `claude_code.cost.usage` and `.token.usage` carry **`agent.name`, `skill.name`, `plugin.name`, `mcp_server.name`** attributes — spend attributable per agent/skill. Correlate via `prompt.id`, `message.uuid`; subagent spans included; content redacted by default.
https://code.claude.com/docs/en/monitoring-usage
> **Compiler hook:** emit a ready-to-use OTel config; per-agent cost attribution is the data needed to tune model tiering.

**6.13 Drift detection on model change** — [PRODUCTION] Keep `evals/` in the skill, re-run benchmark mode after model updates, diff `benchmark.json`. Plus: "Test with all models you plan to use" — Haiku (enough guidance?), Sonnet (clear and efficient?), Opus (avoids over-explaining?).

**6.14 Privacy-preserving tracing** — [PRODUCTION] Monitor "agent decision patterns and interaction structures — all without monitoring the contents of individual conversations."

---

## 7. Claims that could NOT be substantiated — do not encode

- **"Over-long skills get ignored."** The 500-line guidance is *performance* framing; the ignore mechanism is documented for CLAUDE.md only.
- **"Anthropic recommends 3–5 parallel sessions."** Third-party talk summaries only; the real 3–5 figure is subagents in the research system.
- **"Don't write mock implementations."** Was in the retired best-practices post (now 308-redirects); current page doesn't carry it. Historical only.
- **Stop-hook 8-block limit** appears only on the best-practices page, not the hooks reference — verify per version before hardcoding.
- **"Golden dataset / tiered eval cadence"** (smoke per PR → golden before merge → nightly) is vendor-blog sourced; directionally fine, superlatives are marketing.
- **"Trigger + topology + verifier + stop rule" loop vocabulary** is practitioner content, not Anthropic doctrine — though each component *is* documented.
- **LLM-judge κ = 0.31 case study** is a vendor blog without primary citation; underlying biases are arXiv-backed.

---

## 8. Priority for the next release

If only five things get encoded:

1. **Skill-description budget check as a hard QA gate** (§5.2, §6.1) — fleetsmith generates precisely the shape that silently overflows it.
2. **Required four-field handoff briefs + "cite, don't paraphrase" orchestrator rule** (§2.3, §0.3) — where MAST says ~79% of failures live.
3. **`check:` as a shell command with exit code on every loop, plus three-part stop rules** (§4.1, §4.3).
4. **Per-agent `model:`/`effort:` tiering mapped to all three targets** (§3.1, §3.2).
5. **Generated `evals/evals.json` with should-trigger/should-not-trigger prompts** (§6.1, §6.2) — also gives model-upgrade drift detection free.

Needs a design decision rather than implementation: **§0.1 context-centric decomposition** — it questions the phase-pipeline default, including fleetsmith's own meta-fleet.

---

## Primary sources
- Anthropic — [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) · [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) · [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- Claude — [When to use multi-agent systems](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them) · [Improving skill-creator](https://claude.com/blog/improving-skill-creator-test-measure-and-refine-agent-skills)
- Docs — [Agent Skills best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) · [Skills](https://code.claude.com/docs/en/skills) · [Subagents](https://code.claude.com/docs/en/sub-agents) · [Best practices](https://code.claude.com/docs/en/best-practices) · [Hooks](https://code.claude.com/docs/en/hooks) · [Workflows](https://code.claude.com/docs/en/workflows) · [/goal](https://code.claude.com/docs/en/goal) · [Monitoring](https://code.claude.com/docs/en/monitoring-usage) · [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Evaluating skills — agentskills.io](https://agentskills.io/skill-creation/evaluating-skills)
- Cognition — [Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents) · [Multi-Agents: What's Actually Working](https://cognition.com/blog/multi-agents-working)
- LangChain — [Context Engineering](https://www.langchain.com/blog/context-engineering-for-agents) · [Benchmarking Multi-Agent Architectures](https://www.langchain.com/blog/benchmarking-multi-agent-architectures) · [deepagents context engineering](https://docs.langchain.com/oss/python/deepagents/context-engineering)
- OpenAI — [A Practical Guide to Building Agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf) · [GPT-5 Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)
- Chroma — [Context Rot](https://www.trychroma.com/research/context-rot)
- Manus — [Context Engineering Lessons](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- [MAST: Why Do Multi-Agent LLM Systems Fail? (arXiv 2503.13657)](https://arxiv.org/abs/2503.13657)
- Scott Chacon — [True Grit](https://blog.gitbutler.com/true-grit)
