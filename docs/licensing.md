# Licensing

This repository carries two licenses, split cleanly by directory.

| | License | Package | What's there |
|---|---|---|---|
| Everything **outside** `ee/` | **MIT** | `fleetsmith` | The core compiler: `fleet.yaml` → agents, skills, and a file-based handover protocol for Claude Code, opencode, and goose. Complete on its own. |
| Everything **under** `ee/` | **AGPL-3.0-only** | `fleetsmith-ee` | The v0.7.0 Intelligence Grid: a RelataDB-backed sync daemon, multi-developer memory, org-knowledge ingestion, and the cortex admin console. |

`rm -rf ee/` leaves core behaving exactly as it did before `ee/` existed — no feature regresses, no file changes. That property is enforced in CI (`test/ee-boundary.test.js`), not just asserted in prose: no file under `src/` may import from `ee/`, by any path form.

## Can I use core commercially?

**Yes, without restriction.** MIT permits commercial use, modification, redistribution, and sublicensing, with no obligation to share source or pay anything. This is the free, permanent answer for running fleetsmith — it does not degrade, expire, or get "enterprise-gated" out from under you.

## Can I fork `ee/` into my own SaaS?

**Yes — but AGPL-3.0's §13 source-sharing obligation follows you if you modify it.** Two clauses decide this:

- **§2 grants unlimited permission to run the unmodified program.** Deploying `fleetsmith-ee` as-is, even behind a network service, carries no source obligation on its own.
- **§13 triggers on *modification*, not on network exposure.** If you change `ee/`'s code and let others interact with your modified version remotely, you must offer them the corresponding source of *your* modified version. Running it unmodified — however it's exposed over a network — never triggers §13.

So: use `fleetsmith-ee` unmodified, commercially, with no source obligation. Modify it and serve the modified version to others, and AGPL requires you to offer them your changes back. This is the same shape as the RelataDB engine `fleetsmith-ee` talks to (see below) — deliberately, since the whole enterprise tier is built to the same BYOL discipline.

## Which npm package is which license?

- **`fleetsmith`** — MIT. `files: ["src/", "README.md", "LICENSE"]`. Never contains anything from `ee/`.
- **`fleetsmith-ee`** — AGPL-3.0-only, its own `LICENSE` (verbatim GPLv3 text, unmodified). Every file under `ee/src/` (and later `ee/console/`) declares this in its first two lines: `// SPDX-License-Identifier: AGPL-3.0-only`. CI fails a file that omits it.

They are peer-dependents, not a monorepo bundle: `fleetsmith-ee`'s `package.json` declares `"peerDependencies": {"fleetsmith": ">=0.7.0"}`. Installing one does not install the other's license terms onto it.

## Can this become a commercial license later, without touching core?

Yes — that's the reason for the split. A future commercial (non-AGPL) license on `ee/` is a decision about `ee/`'s terms alone; it requires no change to core's MIT license, no re-licensing of anything a user of the free tier already has, and no coordination with anyone who has only ever touched `src/`. Nothing about this document commits to that happening — it only records that the architecture doesn't block it.

## The standing BYOL rules for RelataDB

`ee/`'s memory backend and sync daemon talk to a **customer-run** RelataDB instance — "bring your own license," never a bundled or hosted one. Three rules are non-negotiable, everywhere in `ee/`:

1. **Never ship or vendor the engine's binary or source.** Doing so would be "conveying" under AGPL, and the source obligation couldn't be met regardless. `test/ee-boundary.test.js` scans for the shapes vendoring would leave behind (`.rs` files, `Cargo.toml`/`Cargo.lock`) under `ee/`.
2. **Never patch or fork the engine.** That is the one action that triggers RelataDB's own §13 obligation, and it isn't ours to trigger on a customer's behalf.
3. **Always degrade to the file backend** on connection failure, license expiry, or exhausted grace tokens — a customer's database being unreachable must never make a `fleetsmith` run fail. Every capability `ee/` adds names a working, if less capable, core+git answer; nothing is enterprise-only.

Communication with RelataDB is native `fetch` over its REST API — no vendored SDK, no protocol-level workaround, no assumption about license terms beyond what's stated in its own `LICENSE`.

## See also

- [`README.md`](../README.md) — project overview and the top-level License section
- [`ee/README.md`](../ee/README.md) — what's under `ee/` and how it loads
- [`docs/milestones/v0.7.0-intelligence-grid.md`](milestones/v0.7.0-intelligence-grid.md) — the full spec this boundary was built for
- [`docs/research/relatadb-memory-backend-2026-08.md`](research/relatadb-memory-backend-2026-08.md) — the source audit this page's RelataDB claims are drawn from
