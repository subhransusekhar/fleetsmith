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

Requires only **Node.js ≥ 18** (any OS). No build step, no global tooling, no editor/agent-specific setup; the single runtime dependency (`yaml`) is fetched from the npm registry.

**Zero-install (run from any machine or project):**

```bash
npx --yes github:subhransusekhar/fleetsmith patterns
npx --yes github:subhransusekhar/fleetsmith init my-fleet --pattern pipeline --domain "..."
npx --yes github:subhransusekhar/fleetsmith build fleet.yaml --target all
```

**Clone (for development, or to use the bundled meta-fleet):**

```bash
git clone https://github.com/subhransusekhar/fleetsmith.git
cd fleetsmith
npm ci
npm test                      # 13 tests, node --test

# optional: make the CLI available globally as `fleetsmith`
npm link
```

## How to use

### 1. Scaffold a fleet spec

```bash
node src/cli.js init my-fleet --pattern pipeline --domain "REST API code review"
# or with npm link:  fleetsmith init my-fleet --pattern pipeline --domain "..."
```

Pick a pattern with `fleetsmith patterns`:

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
node src/cli.js validate fleet.yaml
node src/cli.js build fleet.yaml --target all            # or claude-code | opencode | goose
node src/cli.js build fleet.yaml --target all --dry-run  # list files without writing
```

`--out DIR` writes elsewhere; `--force` overwrites existing files (re-runs). In combined builds, skills are emitted once to `.claude/skills/` — opencode and goose read that directory natively, so there's exactly one copy to maintain.

### 4. Run the fleet in each tool

| Tool | Invoke |
|------|--------|
| **Claude Code** | the `run-<fleet>` orchestrator skill triggers on domain requests, or ask for it by name |
| **opencode** | `/run-<fleet>` command, or switch to the `run-<fleet>` primary agent |
| **goose** | `goose run --recipe .goose/recipes/run-<fleet>.yaml` (skills need goose ≥ 1.25) |

The orchestrator handles fresh runs, partial re-runs ("redo the X part"), and resumption — fleet state lives in `_fleet/LEDGER.md` and `_fleet/handoffs/`, so any run is auditable and resumable.

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
npm test                                  # schema, validator, all three adapters, merge behavior
npm run build:example                     # compile fleet.example.yaml into dist-example/
```

## License

MIT
