# Degradation matrix (v0.7.0 G9.1)

Every failure mode of the enterprise stack, and what actually happens — verified against a table-driven test
suite (`ee/test/degradation-matrix.test.js`), not asserted from documentation alone. The one invariant that
holds across every row: **grid state can never gate an agent.** `gate_pass`/`gate_block` events come from
`_fleet/local/scripts/validate-handoff.sh`, and no file under `ee/src/` references that script at all — a
standing, statically-checked invariant (reaffirmed in the test suite itself), not something re-derived per
failure mode. So "gates behave identically to OSS" holds for every row below for the same structural reason,
regardless of which subsystem is degrading.

| # | Mode | What happens |
|---|---|---|
| 1 | No grid config at all | Pure v0.6 behavior. `resolveGridConfig()` returns `null`; `syncOnce()` returns `{degraded: true, notConfigured: true, warnings: []}` — **zero** warnings, not even one line. |
| 2 | Config present, cortex never reachable | Exactly one warning (the reachability failure reason). `_fleet/local/grid/unreachable-since` is created (first-failure timestamp, not reset on later failures); `GRID.md`'s header gets a targeted "unreachable since … — peer data may be stale" edit, not a rebuild. The memory backend (`withDegradation`) trips on the same first `RelataNetworkError` and falls back to the file backend for the rest of the process — also exactly one warning. |
| 3 | Cortex dies mid-run (memory + grid both active) | Both subsystems degrade **independently** — the memory backend's own warning count and the grid daemon's own warning count never share or inflate each other. Each still caps at one warning for its own failure. |
| 4 | License exhaustion response (engine 4xx) | `checkCortexReachable()` does not distinguish *why* a request failed — a license-exhaustion-shaped 4xx (e.g. `402: license exhausted, grace period ended`) degrades a sync cycle exactly like Row 2. The memory backend's `looksLikeLicenseExhaustion()` detector (a best-effort regex over the error message, never independently verified against a real exhausted license) trips immediately, same as Row 3. Separately, and NOT something fleetsmith's own code ever branches on: a real RelataDB Docker container observed this session exited with **code 78** on a startup misconfiguration (KMS/encryption). That is the engine's own process, on the machine the customer runs it — fleetsmith never spawns or waits on it. |
| 5 | Token revoked mid-SSE | A 401 on the SSE connect attempt is treated as a stream failure (`PullError`), signaling `'sse-error'` immediately and reconnecting with backoff — indefinitely, until the token is fixed. **Correction to G7.1's own `identity.md`**: there is no "~15s stream re-auth" — G3.3 already found `/graph/changes` never emits a frame on this engine profile at all, so there is no open stream to re-authenticate on any interval. The SAME revoked token also fails ordinary `/query`/`/ingest` calls, so an ordinary sync cycle degrades exactly like Row 2 regardless of SSE. Recovery, once the token is valid again, is just the next reconnect/sync attempt succeeding — no special-cased "recovery" code path exists or is needed. |
| 6 | Cortex returns garbage (malformed JSON) | **Fixed as part of G9.1, not merely documented**: a 2xx response with a non-JSON body used to silently resolve to `null` (`request()`'s own `JSON.parse` failure fell through to `null` unconditionally), which could reach a caller (e.g. `recall()`'s `result.rows`) as an unclassified `TypeError` — neither degrading gracefully nor giving a clear error. A new `RelataMalformedResponseError` (`ee/src/memory/errors.js`) is now thrown for a non-empty, unparseable 2xx body, classified by `degrade.js` as an immediate trip (same tier as an unreachable cortex) and by `checkCortexReachable()` as a normal thrown failure (same tier as Row 2). An intentionally EMPTY 2xx body is not treated as malformed — only a non-empty one that fails to parse is. A non-2xx response with a non-JSON body was already fine before this fix (its raw text becomes the `RelataHttpError`'s own detail message). |

## What this table does not (yet) prove

Every row above is proven against fake/scripted servers, the same infrastructure `ee/test/degrade.test.js`,
`pull.test.js`, and `daemon.test.js` already rely on for their own passing suites — not against a live,
fault-injected container. A live RelataDB Docker image (`openworkbench/relata-db:latest`) was pulled and
started successfully this session (confirmed reachable via `docker exec` internally), but the host-to-
container port mapping reset every connection attempted from the host (`curl`, `nc`, and Node's `fetch` all
failed identically) — a real, reproducible Docker Desktop for Mac networking limitation on this machine, not
a fleetsmith defect, and not resolved within this task's own scope. CI is also currently disabled by explicit
user instruction (see project history), so the "all six rows green in CI" acceptance criterion is unverified
in the literal CI sense — the suite is green locally, repeatedly, and ready to run in CI the moment it is
re-enabled.

This project also has no automated harness for running a real coding-agent fleet end to end (the closest
thing, `test/grid-eval-exec.test.js`, is deliberately gated behind `FLEETSMITH_GRID_EVAL_LIVE=1` since it costs
a real, multi-minute model session per run) — so "gate outcomes byte-identical to a no-grid baseline run" is
proven structurally (grid code cannot reference the gate script at all, by static analysis) rather than by
diffing two live agent runs' event logs row by row.
