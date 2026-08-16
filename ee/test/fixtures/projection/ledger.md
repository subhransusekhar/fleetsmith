# demo-fleet — Task Ledger

Single source of truth for fleet progress. The orchestrator updates this
after every phase; agents append rows for work they spawn.

| # | Task | Owner | Depends on | Status | Artifact |
|---|------|-------|-----------|--------|----------|
| 1 | analyze requirements | analyst | - | done | handoffs/01-analyst-to-builder.md |
| 2 | implement feature | builder | 1 | in-progress | handoffs/02-builder-to-reviewer.md |
| 3 | cross-actor dependent task | reviewer | @bob#4 | pending | - |
| garbage | not a real row: bad seq | ??? | - | pending | - |
| 5 | too few cells |
| 6 | bad status value | builder | - | almost-done | - |

Status values: pending / in-progress / done / blocked / dropped.
Never delete rows — mark them dropped with a reason.
