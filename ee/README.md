# fleetsmith-ee — Enterprise Edition

Everything under `ee/` is licensed **AGPL-3.0-only** (see `ee/LICENSE`).
Everything outside `ee/` remains **MIT** and is complete on its own — the
file backend and git are the supported OSS answer, forever. See
[`docs/licensing.md`](../docs/licensing.md) for what each license permits and
the standing BYOL rules for RelataDB.

## What lives here

The v0.7.0 Intelligence Grid (`docs/milestones/v0.7.0-intelligence-grid.md`):

- `src/memory/` — RelataDB adapter behind the core memory port (BYOL: speaks
  REST to a customer-supplied instance; no engine code is vendored, ever)
- `src/grid/` — the sync daemon (`fleetsmith grid`), grid ontology,
  projections, overlap intelligence, org-knowledge import, governance verbs
- `console/` — the cortex admin console (stateless BFF + web UI)

## How it loads

Core never imports from `ee/`. The `fleetsmith` CLI attempts
`import('fleetsmith-ee')` (or `FLEETSMITH_EE_PATH`) at startup, fail-soft;
this package's entrypoint registers backends and commands through
`src/lib/registry.js`. Deleting `ee/` (or not installing the package) leaves
core at exact OSS behavior — that property is CI-enforced.

## Rules (CI-enforced)

1. No file under `src/` (core) may import from `ee/`.
2. Every file under `ee/src/` carries `// SPDX-License-Identifier: AGPL-3.0-only`.
3. No RelataDB binary or source is vendored anywhere in this repo.
4. Every ee capability names its degraded core answer; nothing is ee-only.
