# Harness Context in a Multi-Developer Setting

**Status:** design · **Created:** 2026-08-04 · **Supersedes:** the "un-ignore `_fleet/CHANGELOG.md`" suggestion on issue #2

## The problem

`_fleet/` is gitignored **on purpose**: it is per-developer runtime state, and committing it would mean two developers running the same fleet fight over handoff files, ledger rows, and run logs on every pull. That exclusion is correct and stays.

But v0.5.0 introduces artifacts that are the *opposite* of runtime state — they are the point of the whole milestone:

| Artifact | Introduced by | Nature |
|---|---|---|
| Harness changelog | T1 | team knowledge, permanent |
| Learned playbook bullets | T10 | team knowledge, permanent |
| Promotion decisions | T13 | audit lineage, permanent |
| Eval noise floor | T7 | shared baseline, permanent |
| Run event logs | T4 | per-developer, ephemeral |
| Handoffs, ledger | existing | per-developer, ephemeral |

Putting the first four in a gitignored directory loses them; putting the last three in git creates conflicts on every run. **The workspace has two tiers that were never separated**, and one `.gitignore` line cannot express that.

A self-evolving harness makes this urgent rather than cosmetic: the DGM safety argument turns on *traceable lineage*, and lineage that exists only on one laptop is not lineage.

## Three tiers, not two

The project-level split is the new part, but it sits inside an existing one — fleetsmith already installs at `--scope user` or `--scope project`. The full model:

| Tier | Location | Committed | Lifetime | Answers |
|---|---|---|---|---|
| **User-global** | `~/.claude/skills/`, `~/.config/opencode/`, `~/.config/goose/` | no (outside repo) | across projects | "methodologies I reuse everywhere" |
| **Project-shared** | `_fleet/shared/` | **yes** | permanent | "what this team has learned about this fleet" |
| **Project-local** | `_fleet/local/` | no | per-run | "what my current run is doing" |

Plus the two things already committed and already correct: `fleet.yaml` (the spec) and the compiled harness (`.claude/`, `.opencode/`, `.goose/`), which is derived output guarded by `fleetsmith qa --built` drift detection.

### Precedence

Two different rules, because the tiers answer different questions:

- **Methodology** (skills, playbooks): **project-shared wins over user-global.** The more specific context is the more correct one — a fleet's own playbook beats a generic personal skill.
- **Runtime state** (ledger, handoffs, current run): **project-local only.** Shared state is never consulted for what a run is currently doing, because that is precisely what must not be shared.

## Layout

```
repo/
├── fleet.yaml                        # spec — committed, reviewed in PRs
├── .claude/ .opencode/ .goose/       # compiled harness — committed, drift-checked
└── _fleet/
    ├── shared/                       # COMMITTED (git-tracked exception)
    │   ├── CHANGELOG.md              #   append-only; one row per change
    │   ├── playbooks/<agent>.md      #   ACE bullets: stable ids + counters
    │   ├── decisions.jsonl           #   promotion decisions (T13)
    │   └── evals/noise.json          #   measured noise floor (T7)
    └── local/                        # GITIGNORED (per developer)
        ├── LEDGER.md
        ├── handoffs/
        ├── runs/<actor>-<ts>/events.jsonl
        ├── health.json
        └── CURRENT
```

`.gitignore` becomes:

```
_fleet/*
!_fleet/shared/
```

One workspace root, so the mental model stays "everything fleet lives under `_fleet/`", while the tier is visible in the path. An implementer who sees `_fleet/local/` does not have to remember a rule.

## Why the shared tier merges cleanly

Committing shared state only works if concurrent edits do not conflict constantly. Three properties, all of which v0.5.0 already needs for other reasons:

1. **Append-only.** New rows and bullets go at the end. Two developers appending different lines merge without conflict; git handles this natively.
2. **Stable unique ids.** ACE bullets are already `[pb-<agent>-<seq>]`. Ids make a merge resolvable by rule rather than by reading prose, and make "the same lesson learned twice" detectable.
3. **One record per line.** JSONL and markdown table rows merge; nested YAML does not. This is the reason `decisions.jsonl` is JSONL and not YAML.

The ACE design chosen in T10 for *review* reasons — deterministic non-LLM merge, id'd deltas instead of whole-file rewrites — turns out to be exactly what makes the artifact mergeable across developers. That is not a coincidence: both problems are "many small attributable edits beat one opaque rewrite."

**Counter-updates are the one genuine conflict.** Two developers each incrementing a bullet's helpful counter produces a textual conflict on that line. Resolution rule: **take the sum of the deltas, not either side.** This is deterministic and belongs in a documented `fleetsmith playbook merge` command used as a git merge driver, not left to whoever hits the conflict.

## Actor identity

Multi-user needs attribution, and run ids are currently `<timestamp>` — which collides when two developers share a checkout (pair machine, CI runner, devcontainer) and, more importantly, loses *who*.

**Run id becomes `<actor>-<timestamp>`**, where actor resolves in order: `FLEETSMITH_ACTOR` → `git config user.email` (local part) → `$USER` → `unknown`. Cheap, no configuration for the common case, and it means:

- Concurrent runs in one checkout land in separate directories rather than interleaving into one `events.jsonl`.
- Health metrics can be attributed, so "this agent fails for everyone" is distinguishable from "this agent fails for one person's setup" — a distinction the evolution loop must not get wrong, since the second is not a harness defect.
- `CURRENT` becomes `CURRENT-<actor>`, so one developer's `run_end` cannot close another's run.

## Promotion: local learning becomes shared knowledge

Nothing should write to the shared tier automatically. A lesson from one developer's run is a *candidate*; the shared tier is reviewed content, which is what makes it trustworthy.

```
local run produces a candidate lesson        (_fleet/local/runs/…)
        │
        ├── evolve --propose evaluates it against the gates   (v0.5.0 T11)
        │
        └── accepted → written to _fleet/shared/ on a branch  (v0.5.0 T13)
                     → reviewed in a PR like any other change
                     → merged; now every developer has it on next pull
```

This is the same promotion ladder v0.5.0 already defines for spec mutations, applied to learned context. **One review path, not two** — and it means the answer to "how does a learning become team knowledge" is "it goes through a PR", which needs no new machinery and no new trust model.

## What this changes in v0.5.0

| Task | Change |
|---|---|
| T1 (#2) | Changelog moves to `_fleet/shared/CHANGELOG.md`; still preserve-class, now also committed. **Replaces the un-ignore suggestion.** |
| T4 (#5) | Runs move under `_fleet/local/`; run id gains an actor prefix; `CURRENT` becomes per-actor |
| T5 (#6) | `health.json` is local; metrics gain actor attribution so per-developer failures are distinguishable |
| T7 (#8) | `noise.json` is shared — a noise floor measured once benefits everyone |
| T10 (#11) | Playbooks are shared; adds a documented counter-merge rule and a merge driver |
| T13 (#14) | `decisions.jsonl` is shared; promotion writes to the shared tier on a branch |
| T12 (#13) | Protected-path list covers `_fleet/shared/` — the loop may propose changes there, never write them directly |

## Migration

The split is mechanical and one-time. `fleetsmith build` seeds both tiers; existing installs get a `fleetsmith migrate-workspace` that moves current paths into `local/`, leaves `shared/` empty, and is idempotent. Since `_fleet/` was never committed, no history is at stake — the only cost is developers with in-flight runs, so the command must refuse to run when a `CURRENT-*` marker exists.

## Alternatives considered

- **Separate top-level `_fleet.shared/`** — clearer at a glance, but adds a second root directory to every project and splits the mental model. Rejected for ergonomics.
- **Keep everything local, sync via a backend** (the v0.6.0 RelataDB direction) — solves sharing but makes team knowledge require infrastructure. Rejected as the *default*: the OSS tier must work with git alone. It remains the enterprise answer for teams that want semantic recall and multi-tenancy on top.
- **Commit everything, resolve conflicts as they come** — what the current single-tier layout would force. Rejected: it puts a merge conflict in the path of every run, which is how developers learn to `git checkout --theirs` the audit trail.
