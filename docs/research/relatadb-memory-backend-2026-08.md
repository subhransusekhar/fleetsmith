# RelataDB as an Enterprise Memory Backend — Evaluation (2026-08)

**Purpose:** evidence base for Milestone v0.6.0 (`docs/milestones/v0.6.0-enterprise-memory.md`) — offering richer agent memory as an enterprise-tier feature backed by RelataDB, while the OSS tier stays file-based.

**Verdict up front: GO, as an optional adapter behind a memory port. Not structural.** BYOL dissolves the licensing objection. What remains is concentrated vendor risk, and the mitigation is architectural: keep the file backend as the default and only bundled implementation, so a license change or abandonment costs a deleted file rather than a rewrite.

**Provenance:** compiled 2026-08-04. Core-repo facts were read through an authenticated `gh` token; the repository is **private**, so those quotes are not independently verifiable by anyone outside its collaborator list — including customers and counsel. Items marked ⚠️ are lower-confidence.

---

## 1. What it is

Governed **bi-temporal knowledge database in Rust**, single binary, by **ZySec AI** (UAE). `relatadb.dev` · `hello@zysec.ai`.

Genuinely hybrid rather than a vector store with extras: bi-temporal relational rows + graph + vector/HNSW + BM25 full-text + ontology-as-schema. Its distinguishing trick is **protocol impersonation** — one binary answers on the Postgres, S3, Neo4j/Bolt, ClickHouse, Redis, MongoDB, Arrow Flight, and SPARQL wire protocols, so existing drivers connect unmodified.

The three questions it markets itself on:

| Question | Capability |
|---|---|
| "What did the system know at time *T*?" | bi-temporal `AS OF` queries |
| "Where did this belief come from?" | PROV-O assertions + tamper-evident audit chain |
| "Who is allowed to see this?" | cell-level ACL + tenant isolation |

**Agent memory is the primary marketed use case, not a bolt-on.** Twelve cognitive verbs, each exposed as both an MCP tool and a REST endpoint: `remember`, `remember_batch`, `recall` (+SSE streaming), `recognize`, `episodes_in`, `justify`, `consolidate`, `forget`, `remember_procedure`, `recall_procedure`, `associate`, `resolve`, `summarise`. Recall is hybrid BM25 ⊕ vector fused via RRF, re-scored by confidence × recency × an Ebbinghaus forgetting curve.

---

## 2. Licensing — clean for a BYOL integration

**Stock AGPL-3.0.** `LICENSE` is the 661-line verbatim GNU AGPL v3, unmodified. `Cargo.toml` declares `license = "AGPL-3.0-only"`, `publish = false`. No added terms, no CLA in `CONTRIBUTING.md`, no field-of-use limits, no audit clauses, no integrator obligations. **No anti-SaaS clause** — that is SSPL/BUSL; this is AGPL.

Three clauses decide the question:

**§0 — the one that makes BYOL work:**
> "To 'convey' a work means any kind of propagation that enables other parties to make or receive copies. **Mere interaction with a user through a computer network, with no transfer of a copy, is not conveying.**"

**§2:**
> "This License explicitly affirms your **unlimited permission to run the unmodified Program**."

**§13 — narrower than commonly assumed; the trigger is MODIFICATION, not network use:**
> "Notwithstanding any other provision of this License, **if you modify the Program**, your modified version must prominently offer all users interacting with it remotely through a computer network … an opportunity to receive the Corresponding Source of your version…"

Run it unmodified and §13 never fires, however it is exposed over a network.

**Free vs paid (licensing v3, dated 2026-08-01).** `PAID_CAPABILITIES` is **empty** — no feature is paywalled. Every protocol, at-rest encryption, disk paging, columnar Arrow, FTS, vectors, graph, and MCP are free. From `docs/src/guides/license-sop.md`:
> "What the license actually carries are two **numeric** `NodeConfig` parameters — `storage_max_gb` (0 = unlimited; Free fixed at 10 GB) and `max_tenants` (0 = unlimited; **Free/server fixed at 1**, Cluster reads the license value)."

The paid boundary is exactly two numbers: **storage over 10 GB, and more than one tenant.** Sharpen the tenancy point — multi-tenant requires the **cluster** tier; a `server` license stays pinned to one tenant and `RELATA_TENANCY_MODE=multi` is fatal at startup below cluster.

**Caveat for counsel: "BYOL" is not a term RelataDB uses.** There is no BYOL program, partner tier, integrator agreement, or EULA; `relatadb.dev/get-license` collects contact details and shows no terms. What we have is the *absence of anything prohibiting* the integration. Under a stock AGPL that is genuinely the good outcome, but there is no document to point at.

### Why the adapter pattern is unencumbered

Three independent reasons, any one sufficient:
1. APIs and wire protocols are not the licensed work.
2. The official client SDKs are **Apache-2.0 and public** — an affirmative invitation to build clients.
3. §0: network interaction without transferring a copy is not conveying.

No protocol restriction, no anti-circumvention term, no "authorized client" concept exists.

**Three rules to encode:**
- **Never ship or vendor the binary.** That is conveying, and the source obligation could not be satisfied anyway while the repo is private.
- **Never patch or fork the engine.** That is the only §13 trigger.
- **Degrade gracefully to the file backend** on connection failure, license expiry, or exhausted grace tokens.

**Trademark:** no policy exists, and Apache-2.0 §6 affirmatively withholds trademark rights. Nominative naming ("RelataDB adapter", "works with RelataDB") is unrestricted. Get written permission before using the logo or naming a fleetsmith tier after them.

---

## 3. Maturity — the real risk, and it is not close

| Signal | Value |
|---|---|
| First commit | **2026-07-05 — one month old** |
| Commits since | 3,389, tagged to v1.5.7 (`Cargo.toml` already says 2.0.0) |
| Contributors | `venkycs` 2,145 · `github-actions[bot]` 1,010 · `claude` 5 · `dependabot` 5 — **one human** |
| Stars / forks / watchers | **0 / 0 / 0**, forking disabled |
| Visibility | **Private** |
| Prior identity | renamed once; npm metadata still points at `OpenWorkBench-Co` |

**Relicensed twice in three months.** ADR-015 (2026-05-18) chose Apache-2.0 and explicitly *rejected* AGPL ("AGPL scares enterprises"); ADR-197 describes Elastic 2.0; today it is AGPL-3.0-only. ADR-015 now reads "Superseded — engine relicensed to AGPL-3.0-only … **A dedicated ADR for the Apache-2.0 → AGPL-3.0-only switch is a pending follow-up.**" The license changed without its own ADR, and no CLA constrains the sole author from doing it again.

**Their own quality numbers are disclaimed by them** (`docs/benchmarks/memory.md`):
> "The `multi_hop_qa/*` and `long_context/*` numbers below are measured on a **synthetic corpus**, not real HotpotQA / 2WikiMultihopQA / LoCoMo / LongMemEval data. … This doc previously implied the recall@10 ≈ 1.000 numbers came from real HotpotQA-style data; they do not."

Credit for the honesty; treat every recall figure as unvalidated.

**Licensing-discipline red flag (not our obligation):** binaries are distributed via `curl | sh` and ghcr.io while the source repo is private. AGPL §6 entitles every binary recipient to Corresponding Source. That is ZySec's obligation to their customers, not ours.

---

## 4. Fit with fleetsmith's self-evolution loop

Three primitives map unusually well onto v0.5.0's design, and each is something the file backend does poorly:

| RelataDB primitive | What it solves for us |
|---|---|
| **`ProcedureMemory`** — versioned instruction set with auto-incrementing `version` + `supersedes` chaining | Our ACE-style playbooks (v0.5.0 T10) with revision history for free — currently id'd bullets in flat markdown with no lineage |
| **`DecisionRecord` + `justify`** | Auditable "why was this mutation promoted" — the lineage the DGM safety argument depends on (v0.5.0 T13) |
| **Bi-temporal `AS OF`** | "What did the agent believe when it made that call" — genuinely painful over JSONL + markdown |

Plus cell-level ACL and tenant isolation, which are the actual enterprise asks that the file backend cannot answer at all.

**Two integration caveats:**
- **Embeddings are caller-supplied** on the ingest hot path since v1.1 — we would own embedding generation, which is a real dependency decision for a project with one runtime dep.
- **Every query must declare a registered `purpose`** or the server returns HTTP 400.

**Deployment:** `curl -sSf https://relatadb.dev/install.sh | sh` then `relata serve` on :9090; also Homebrew, ghcr.io, Helm. No GPU. **macOS and Linux only — no Windows.** It is a separate *process*, not an embeddable library; there is no Node-embeddable build.

**Operational hazard under BYOL:** paid licenses are Ed25519-signed blobs at `~/.relata/node.dat` **bound to a node hash**, issued **manually, human-in-the-loop, within 24 h**. Anything with churning node identity — containers, autoscaling, CI runners, reimaged laptops — hits re-activation friction on a 24-hour turnaround. Expired nodes get 3 escalating grace tokens, then exit code 78. The 30-day trial is hard-capped in two places and unextendable.

**TypeScript SDK** (`sdks/typescript`, Apache-2.0, public) is unusually well-behaved: **zero runtime dependencies** (native `fetch`, `crypto.randomUUID()`, `AbortController`), ESM, Node 18+. Even full adoption is 2 direct deps and 0 transitive. **Recommended posture: don't take it.** The memory surface is plain REST plus MCP; native `fetch` gets everything at zero added dependencies, preserving fleetsmith's one-dep promise exactly. Offer the SDK as a documented optional peer dep for users who want typed builders.

---

## 5. Alternatives

Licenses verified 2026-08-04. Under BYOL the license column stops being decisive (a customer-supplied AGPL server is no worse than a customer-supplied Apache one), so **adoption becomes the differentiator**:

| Project | License | Stars |
|---|---|---|
| Mem0 | Apache-2.0 | 62k |
| Qdrant | Apache-2.0 | 34k |
| Graphiti | Apache-2.0 | 30k |
| Chroma | Apache-2.0 | 29k |
| Letta | Apache-2.0 | 24k |
| pgvector | PostgreSQL | 22k |
| LanceDB | Apache-2.0 | 11k |
| sqlite-vec | Apache-2.0 | 8k |
| Zep | Apache-2.0 | 4.8k |
| **RelataDB** | **AGPL-3.0** | **0 (private)** |

Nothing on that list matches RelataDB's combination of bi-temporal + provenance + cell-level ACL + versioned procedure memory in one self-hostable binary. That combination is a real differentiator for a regulated-enterprise pitch — which is precisely the tier this milestone targets.

---

## 6. Decision

**GO — optional adapter behind a memory port, gated on a customer-supplied URL + token.**

The architecture *is* the risk mitigation. A narrow port (`remember`, `recall`, `consolidate`, `forget`, `justify` — mirror their vocabulary, it is sensible regardless of backend), file-based as the default and only bundled backend, and a ~200-line `fetch` adapter. One-dep promise intact, OSS tier unchanged, and abandonment or another relicense costs a deleted file.

**Two things to obtain from ZySec AI before shipping the adapter publicly** (tracked as its own issue, and a genuine gate on the public release rather than a formality):
1. **Trademark permission** to name the integration and use the mark in docs.
2. **A statement of intent on license stability** for a version range — given Apache-2.0 → Elastic 2.0 → AGPL-3.0 in twelve weeks, the last change shipped without its ADR.

If they will not answer on trademark, ship with purely nominative naming; that alone is not a blocker. Pricing is the customer's negotiation under BYOL, but indicative numbers would help us advise.
