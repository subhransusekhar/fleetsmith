# fleetsmith

**Meta agent-fleet builder.** Describe a fleet of AI agents once — roles, skills, handoff graph — and compile it into native harnesses for **Claude Code**, **opencode**, and **goose**. Say *"build a harness for this project"* in Claude Code and the bundled meta-fleet designs, authors, compiles, and QA-gates a domain-tailored harness for you.

```
fleet.yaml ──► fleetsmith ──┬──► .claude/agents/*.md + .claude/skills/*/SKILL.md + CLAUDE.md
                            ├──► .opencode/agents/*.md + commands/ + skills/ + AGENTS.md
                            ├──► .goose/recipes/*.yaml (+ AGENTS.md, read first-class by goose)
                            └──► _fleet/ (portable handover protocol: handoffs + ledger)
```

## Why

Every agentic CLI grew its own harness format: Claude Code has subagents + Agent Skills + teams, opencode has primary/subagent markdown + commands, goose has recipes + sub-recipes. The concepts are isomorphic — a named specialist with a prompt, scoped permissions, a methodology, and a way to pass work on. fleetsmith treats that shared shape as a compile target:

- **One spec, three harnesses.** No hand-porting agents between tools.
- **Capabilities, not tool names.** Agents declare `read/edit/run/web/spawn`; each adapter maps that onto the tool's permission model (Claude Code `tools:` allowlist, opencode `permission:` allow/deny maps, goose extensions + stated constraints).
- **Handover as a first-class contract.** Every edge in the fleet carries an artifact + acceptance criteria. The generated protocol is file-based (the only channel all three tools share), so fleet behavior is portable, auditable, and resumable. Claude Code agent-team messaging is layered on top when available — the message is the doorbell, the file is the payload.

## Installation

Pick whichever fits — in order of "least setup":

**A. Standalone binary (no Node.js required).** Download the executable for your OS from the [latest release](https://github.com/subhransusekhar/fleetsmith/releases/latest) and run it directly:

```bash
# macOS (Apple Silicon) example
curl -L -o fleetsmith https://github.com/subhransusekhar/fleetsmith/releases/latest/download/fleetsmith-macos-arm64
chmod +x fleetsmith
./fleetsmith version
```

Assets: `fleetsmith-linux-x64`, `fleetsmith-macos-arm64`, `fleetsmith-macos-x64`, `fleetsmith-windows-x64.exe`. Each is a single self-contained file (Node runtime + code + the one dependency baked in) — copy it onto any machine, no install step.

**B. Global CLI via npm (needs Node.js ≥ 18):**

```bash
npm install -g fleetsmith      # then: fleetsmith <command>
```

**C. Zero-install via npx (needs Node.js ≥ 18):**

```bash
npx --yes github:subhransusekhar/fleetsmith patterns
npx --yes github:subhransusekhar/fleetsmith init my-fleet --pattern pipeline --domain "..."
```

**D. Clone (for development, or to use the bundled meta-fleet):**

```bash
git clone https://github.com/subhransusekhar/fleetsmith.git
cd fleetsmith
npm ci
npm test                       # node --test
npm link                       # optional: exposes `fleetsmith` globally
npm run build:binary           # optional: build a standalone binary for this OS -> dist/bin/
```

The only runtime dependency (`yaml`) is bundled into the binary and installed automatically by npm/npx. `esbuild` and `postject` are build-time-only devDependencies used to produce binaries — they never reach end users.

> **The rest of this guide uses the command `fleetsmith`.** That's the binary you downloaded (option A — write `./fleetsmith` if it's not on your `PATH`), the global npm install (B), or an `npm link`ed checkout (D). For the zero-install path (C), replace `fleetsmith` with `npx --yes github:subhransusekhar/fleetsmith`. Running from a clone without linking? Use `node src/cli.js`.

## Quickstart (60 seconds, using the binary)

Go from nothing to a working, multi-tool agent harness in four commands:

```bash
# 0. one-time: grab the binary (macOS arm64 shown; see Installation for other OSes)
curl -L -o fleetsmith https://github.com/subhransusekhar/fleetsmith/releases/latest/download/fleetsmith-macos-arm64 && chmod +x fleetsmith

# 1. scaffold a fleet spec for your domain
./fleetsmith init review-bot --pattern pipeline --domain "TypeScript PR review"

# 2. (edit review-bot's fleet.yaml if you like) then check it
./fleetsmith validate fleet.yaml

# 3. install the harness into a project so Claude Code / opencode / goose can use it
./fleetsmith install fleet.yaml --into ~/code/my-app --scope project
```

Now open `~/code/my-app` in any of the three tools and ask for the fleet by name (see [Run the fleet](#5-run-the-fleet-in-each-tool)). That's the whole loop: **init → (edit) → validate → install → run.** Everything below expands on each step.

## How to use

### 1. Scaffold a fleet spec

```bash
fleetsmith init my-fleet --pattern pipeline --domain "REST API code review"
```

`init` writes a ready-to-edit `fleet.yaml` (use `--out other.yaml` to name it, `--force` to overwrite). Pick a pattern with `fleetsmith patterns`:

| Pattern | Use for |
|---------|---------|
| `pipeline` | sequential stages (analyze → build → review) |
| `fanout` | parallel independent workers, then one merger |
| `generate-verify` | producers paired with adversarial checkers |
| `supervisor` | a coordinating lead + specialists (Claude Code agent teams) |
| `expert-pool` | a router + on-demand specialists |

### 2. Edit `fleet.yaml`

```yaml
fleet:
  name: api-hardening
  domain: "REST API security hardening"
  pattern: pipeline        # pipeline | fanout | expert-pool | generate-verify | supervisor | hierarchical
  execution: subagents     # team | subagents | hybrid

agents:
  - name: threat-analyst
    role: Maps the API surface and produces a prioritized threat model.
    model: smart           # smart | fast | cheap | inherit
    capabilities: { read: true, web: true }
    skills: [threat-modeling]
    handoff:
      to: [hardening-engineer]
      artifact: 01-threat-model.md
      criteria: [Every threat names endpoint + attack class + evidence]

skills:
  - name: threat-modeling
    description: "…pushy, trigger-rich description — it is the only trigger mechanism…"
    body: |
      # Methodology…
    references: { owasp-api-top10.md: "…loaded only when needed…" }

orchestrator:
  name: run-api-hardening
  phases:
    - { name: Threat modeling, agents: [threat-analyst], gate: "…" }
```

See [`fleet.example.yaml`](fleet.example.yaml) for the full-featured version and [`docs/spec.md`](docs/spec.md) for every field.

### 3. Validate and build

```bash
fleetsmith validate fleet.yaml
fleetsmith build fleet.yaml --target all            # or claude-code | opencode | goose
fleetsmith build fleet.yaml --target all --dry-run  # list files without writing
```

`validate` reports errors (block the build) and warnings (design smells — orphaned agents, missing artifact contracts, unused skills). `build` writes the harness into the current directory; `--out DIR` writes elsewhere, `--force` overwrites existing files (re-runs). In combined builds, skills are emitted once to `.claude/skills/` — opencode and goose read that directory natively, so there's exactly one copy to maintain.

Use `build` when you want the files in the current repo; use `install` (next) when you want them placed into a *different* app or into your global tool config.

### 4. Install into target apps

`build` writes files into a directory. `install` is the same generation plus placement into where the tools actually look — with tool detection and two scopes:

```bash
# into another project/repo so its agents work in that repo
fleetsmith install fleet.yaml --into /path/to/target-app --scope project

# into your user-global tool config so the agents work in EVERY project
fleetsmith install fleet.yaml --scope user

fleetsmith install fleet.yaml --scope user --dry-run   # preview first
```

| Scope | Where files go | What's installed |
|-------|----------------|------------------|
| `project` (default) | the target repo (`--into DIR`, default `.`) | full harness: agents, skills, orchestrator, pointer files, `_fleet/` workspace |
| `user` | `~/.claude/`, `~/.config/opencode/`, `~/.config/goose/` | reusable definitions only — agents, skills, commands, recipes |

`user` scope deliberately skips the shared pointer files (`CLAUDE.md`, `AGENTS.md`) and the project-specific `_fleet/` runtime workspace, so it never clobbers your global config. `install` prints which tools it detected on the machine.

### 5. Run the fleet in each tool

| Tool | Invoke |
|------|--------|
| **Claude Code** | the `run-<fleet>` orchestrator skill triggers on domain requests, or ask for it by name |
| **opencode** | `/run-<fleet>` command, or switch to the `run-<fleet>` primary agent |
| **goose** | `goose run --recipe .goose/recipes/run-<fleet>.yaml` (skills need goose ≥ 1.25) |

The orchestrator handles fresh runs, partial re-runs ("redo the X part"), and resumption — fleet state lives in `_fleet/LEDGER.md` and `_fleet/handoffs/`, so any run is auditable and resumable.

## Examples by category

Every example below is one `init` command that scaffolds an editable `fleet.yaml`. Change the `--domain` string to your own subject and edit the generated agents/skills — the pattern is what shapes the topology. After `init`, the loop is always the same: `validate → install → run`.

| Category | Pattern | Scaffold command |
|----------|---------|------------------|
| **Code review** | `pipeline` | `fleetsmith init pr-review --pattern pipeline --domain "TypeScript PR review"` |
| **Security audit** | `generate-verify` | `fleetsmith init sec-audit --pattern generate-verify --domain "smart-contract security audit"` |
| **Research / analysis** | `fanout` | `fleetsmith init market-scan --pattern fanout --domain "competitor landscape research"` |
| **Documentation** | `pipeline` | `fleetsmith init doc-writer --pattern pipeline --domain "API reference documentation"` |
| **Data / ETL** | `pipeline` | `fleetsmith init ingest --pattern pipeline --domain "CSV-to-warehouse ingestion"` |
| **Incident triage** | `expert-pool` | `fleetsmith init on-call --pattern expert-pool --domain "production incident triage"` |
| **Refactor / migration** | `supervisor` | `fleetsmith init py3-migrate --pattern supervisor --domain "Python 2 to 3 migration"` |
| **Content / marketing** | `generate-verify` | `fleetsmith init blog-team --pattern generate-verify --domain "technical blog drafting + fact-check"` |

### How to choose a pattern

- **`pipeline`** — the work is a chain where each stage needs the previous one's output (analyze → build → review). Most common.
- **`fanout`** — the work splits into independent slices explored in parallel, then merged (research, audits, multi-file sweeps).
- **`generate-verify`** — one agent produces, a second adversarially checks it (code + QA, draft + fact-check, fix + attempt-to-bypass).
- **`expert-pool`** — a router classifies each request and calls only the relevant specialist (triage, help desks, mixed request types).
- **`supervisor`** — a lead owns shared state and delegates dynamically to specialists; best with Claude Code agent teams (`execution: team`).

### Worked example: security audit

```bash
fleetsmith init sec-audit --pattern generate-verify --domain "smart-contract security audit"
```

This scaffolds a two-agent `generate-verify` fleet:

- **`generator`** — read/edit/run capabilities; produces the audit findings (`draft.md`).
- **`verifier`** — read/run only; tries to *break* each finding (repro or refute) rather than rubber-stamp it, and hands results back with `verdict.md`.

Open `fleet.yaml` and make it yours: rename the agents (e.g. `vuln-hunter` / `exploit-verifier`), tighten each `handoff.criteria` (e.g. *"every finding cites a file:line and a proof-of-concept transaction"*), and flesh out a `skills:` entry with your audit methodology (checklists, known-vuln catalog). Then:

```bash
fleetsmith validate fleet.yaml
fleetsmith install fleet.yaml --into ~/code/my-contracts --scope project
```

Ask for it in Claude Code (or `/run-sec-audit` in opencode, or `goose run --recipe .goose/recipes/run-sec-audit.yaml`) and the orchestrator runs generate → verify, looping findings that fail verification back to the generator.

### Reusable across every project

If a fleet is generally useful (a personal code-reviewer, say), install it at **user scope** so its agents show up in every project without re-installing:

```bash
fleetsmith install fleet.yaml --scope user
```

### Don't want to hand-write the spec?

Skip `init` entirely: open this repo in Claude Code and say **"build a harness for this project"** — the bundled [meta-fleet](#the-meta-fleet-build-a-harness-for-this-project) analyzes your codebase, designs the `fleet.yaml`, writes the skills, and QA-gates the result for you.

## The meta-fleet: "build a harness for this project"

This repo ships its own fleet in `.claude/agents/` — the agent-builder utility. Open the repo (or copy `.claude/` into your project) with Claude Code and say **"build a harness for this project"**:

| Agent | Does |
|-------|------|
| `domain-analyst` | explores the project/domain → decomposition brief |
| `fleet-architect` | designs `fleet.yaml`: pattern, roster, capabilities, handoff graph |
| `skill-smith` | authors skill methodologies (lean bodies, progressive disclosure) |
| `harness-qa` | adversarial gate: spec/compile checks, boundary cross-checks, trigger tests, capability-leak grep |

Orchestrated by the `harness-builder` skill (`.claude/skills/harness-builder/`). Deterministic file generation stays in the compiler; agents only do the judgment work — that division is the core design decision.

## Library API

```js
import { normalizeSpec, validateSpec, buildAll, ADAPTERS, archetype } from 'fleetsmith';

const spec = normalizeSpec(rawYamlObject);
const { errors, warnings } = validateSpec(spec);
const files = buildAll(spec, { today: '2026-07-04' });   // pure — returns a FileSet
files.write(projectRoot, { force: false });
```

Adapters are pure functions `spec -> FileSet`; adding a target (Cursor, Codex CLI, …) means one new file in `src/adapters/`.

## Design notes

- **Validation is graph-aware:** unknown handoff targets, orphaned agents, cycles (allowed for supervisor patterns, flagged otherwise), skills nobody uses, missing artifact contracts, Agent Skills spec limits (name ≤ 64 chars, description ≤ 1024).
- **Degradation is explicit:** opencode/goose have no agent-team runtime, so `execution: team` compiles to orchestrator-driven subagents there — same file protocol, no behavioral surprise. Claude Code agent teams are experimental (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`); compiled prompts include a subagent fallback.
- **Standards over invention:** pointers are emitted as AGENTS.md (Linux Foundation open standard, read by opencode and goose first-class) and CLAUDE.md; skills follow the Agent Skills spec (agentskills.io).
- **Format references** for all three tools plus the interop/handoff-pattern landscape (researched July 2026 from primary docs) live in [`docs/research/`](docs/research/).

## Repository layout

```
src/
├── cli.js               # fleetsmith init | validate | build | patterns
├── spec/                # schema defaults + graph-aware validator
├── adapters/            # claude-code, opencode, goose — pure spec -> FileSet
├── compile/             # shared prompt/orchestrator/pointer compilers
├── handover/            # portable file-based handoff protocol
└── patterns/            # fleet archetypes for `init`
.claude/                 # the meta-fleet (agents + harness-builder skill)
docs/spec.md             # full fleet.yaml reference
docs/research/           # format + interop research (4 docs, cited)
fleet.example.yaml       # full-featured example spec
test/                    # node --test suite
```

## Development

```bash
npm test                                  # schema, validator, adapters, install planner, portability
npm run bundle                            # esbuild -> dist/fleetsmith.cjs (single-file, node dist/fleetsmith.cjs)
npm run build:binary                      # bundle + Node SEA -> dist/bin/fleetsmith (standalone, this OS)
npm run build:example                     # compile fleet.example.yaml into dist-example/
```

## Releasing

Binaries are produced by CI, not committed. To cut a production release:

```bash
npm version patch     # or minor / major — bumps package.json + creates a git tag
git push --follow-tags
```

The `release` workflow (`.github/workflows/release.yml`) triggers on the `v*` tag:
1. runs the test suite on Linux/macOS/Windows,
2. builds a standalone binary per platform via `npm run build:binary` (esbuild bundle → Node [Single Executable Application](https://nodejs.org/api/single-executable-applications.html) → `postject`; macOS binaries are thinned with `lipo` and ad-hoc signed),
3. attaches `fleetsmith-<os>-<arch>` assets to a GitHub Release with generated notes.

`npm publish` runs in the same workflow only if the repo variable `PUBLISH_NPM=true` and secret `NPM_TOKEN` are set — otherwise releases are binary + GitHub-only. The published npm tarball contains just `src/`, `README.md`, and `LICENSE` (no tests, docs, or `node_modules`).

## License

MIT
