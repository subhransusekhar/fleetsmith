# Deployment (v0.7.0 G10.2)

How to choose and stand up the RelataDB instance ("the cortex") that backs the Intelligence Grid. RelataDB is
BYOL (bring-your-own-license) — fleetsmith never vendors, patches, or ships it; see
[`docs/licensing.md`](../licensing.md) for the standing rules and [`ee/README.md`](../../ee/README.md) for how
the `ee/` package attaches to core once a cortex exists.

## Which profile

RelataDB reports its own profile at `GET /status` (surfaced on the console's health screen, G8.7). fleetsmith
never sets or requires a profile — this is entirely the cortex operator's choice, made once at engine install
time.

```
Do you need more than one org/tenant sharing this cortex?
├── No  → do you need this for real day-to-day team use?
│         ├── No  (evaluation / a solo trial)        → free
│         └── Yes (one team, real work)               → server   ← recommended default
└── Yes → cluster (paid license, early-adopter — see the caveats below)
```

| Profile | Tenants | Storage cap | Cost | When to pick it |
|---|---|---|---|---|
| **free** | 1 (hard) | 10 GB (metered against the real `relata_store_total_stored_bytes` Prometheus metric — see `ee/console/server/routes/health.js`) | none | Evaluating the grid, a single small team, or CI/test fixtures. This is what `ee/test/fixtures/relata-compose.yml` runs. |
| **server** | 1 (hard) | unlimited | paid license, node-hash-bound | **The recommended default for one org.** One org = one tenant = one cortex instance — the grid's own design assumption throughout `ee/src/grid/`, not just a pricing tier. |
| **cluster** | many (license-controlled) | unlimited | paid license | Only if you are genuinely hosting more than one organization's data behind one cortex. Multi-tenant mode is **fatal at startup below cluster tier** — `RELATA_TENANCY_MODE=multi` refuses to boot on `free`/`server`. Framed here as **early-adopter**: sub-tenant namespaces are stored but not enforced by the engine (see `docs/architecture/intelligence-grid.md`'s load-bearing decisions — "never build isolation on namespaces"), so a cluster deployment is not yet a hard multi-tenant security boundary on its own. |

No fleetsmith capability is paywalled by the engine (`PAID_CAPABILITIES` is empty in RelataDB's own source) — the
only paid boundary is these two numeric knobs (tenant count, storage cap). Nothing in `ee/` gates a feature by
profile; grid capability differences you'll actually notice come only from the profile's storage/tenant limits
themselves.

## Install paths

RelataDB is a single Rust binary, a separate process (not a Node-embeddable library), macOS and Linux only (no
Windows). Three ways to get it running, in the order most deployments will reach for them:

1. **Install script (the vendor's own quickstart):**
   ```sh
   curl -sSf https://relatadb.dev/install.sh | sh
   relata serve
   ```
2. **Docker:**
   ```sh
   docker run -p 9090:9090 -v ~/.relata:/data ghcr.io/relatadb/relata:<tag>
   ```
   Pin `<tag>` to a specific version, not `latest` — see `ee/test/fixtures/relata-compose.yml`'s own header for
   why (and for the specific tag this project's own contract-pin suite, G9.3, is written against).
3. **Helm.** RelataDB publishes a Helm chart; fleetsmith has not itself operated a Helm-deployed cortex in this
   project's own testing (every live verification in this milestone used a natively-installed or
   `docker run` instance — see the relatadb-local-instance-and-v2-api-shapes project history). Treat Helm as
   the right choice for an existing Kubernetes-native shop, but validate the same setup checklist below against
   it before relying on it for production.

Also available via Homebrew, per the vendor's own docs.

## Sizing

- Free's 10 GB storage cap is the only sizing constraint fleetsmith can report on directly (via the console's
  health screen). Beyond that, sizing is an ordinary "how much team knowledge + grid row history will this
  org accumulate" question RelataDB's own operational docs are the authority on — fleetsmith does not
  independently benchmark or recommend hardware here.
- Grid rows are small, typed, and pruned by nothing (this project's own standing rule: never delete peer rows,
  only supersede them bi-temporally) — the practical growth driver over time is `OrgDocument` import volume
  (meeting/discussion/decision/spec chunks via `fleetsmith grid import`), not day-to-day task/presence sync.

## License issuance and the container caveat

RelataDB's paid licenses (`server`/`cluster`) are Ed25519-signed blobs at `~/.relata/node.dat`, **bound to a
node hash**, issued manually by ZySec with a roughly 24-hour turnaround (verified directly against a real
license file this project holds — see the relatadb-local-instance-and-v2-api-shapes project note). An expired
or exhausted-grace-token node exits (observed: exit code 78 on a real container) rather than silently
continuing unlicensed — see [`degradation.md`](degradation.md) row 4 for exactly what a customer's fleetsmith
integration does when that happens (degrades to the file backend, one warning, no run failure).

**The operational objection you will hit:** node-hash binding means a container that gets recreated,
rescheduled, or autoscaled gets a *new* node hash and needs re-licensing — the 24-hour manual turnaround does
not fit a container lifecycle that can churn in minutes. This is being raised with ZySec/RelataDB directly
(intra-group alignment, since ZySec AI is an Infinia group company) as issue #78 — track that issue for the
outcome (an internal SLA commitment, or a technical path such as floating/org-level licenses) before
committing a customer to a containerized or autoscaling cortex deployment. Until that lands, the safe
recommendation is a **stable, non-autoscaled host** (a VM or a pinned, non-rescheduled container) for any
`server`/`cluster` deployment that needs to stay licensed continuously.

## Positioning

The file backend + git is the complete, supported answer with no cortex at all — every capability in this
milestone names its degraded core behavior (see [`degradation.md`](degradation.md)). The grid is additive: it
buys pre-commit cross-developer awareness, semantic recall across a team's memory, provenance-tracked
organizational knowledge, and purpose-audited governance — never a capability that stops working without it.

## See also

- [`ee/console/README.md`](../../ee/console/README.md) — starting the admin console once a cortex is reachable
- [`setup.md`](setup.md) — the end-to-end walkthrough from a cortex existing to two developers syncing through it
- [`governance.md`](governance.md) — purposes, approvals, equip scoping, audit
- [`docs/architecture/intelligence-grid.md`](../architecture/intelligence-grid.md) — why the grid is shaped this way
- [`docs/licensing.md`](../licensing.md) — the MIT/AGPL split and BYOL rules
