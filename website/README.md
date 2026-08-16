# Infinia Harness — the public site

The documentation site for fleetsmith and fleetsmith-ee, published at
**https://infinia-harness.adid.dev**, plus the one-command installer served from it.

No build step, no framework, no dependencies. `public/` **is** the deployable —
what is on disk is what ships.

```
BRAND.md             canonical Infinia design spec — identical in every Infinia repo
brand.json           its machine-readable half; only `product` differs per site
contrast.mjs         the WCAG gate; run before every publish
check.py             render gate at 390 / 768 / 1440
public/
├── index.html          landing: what it is, why, editions, install
├── architecture.html   the compile model, handover protocol, the grid
├── quickstart.html     install + the full installer env-var reference
├── guide.html          command reference, authoring, loops, day-to-day
├── install.sh          the one-command installer (POSIX sh)
├── site.css            the design system
├── site.js             nav scroll state, copy buttons, tabs, rail scrollspy
├── logo.svg            the Infinia mark
├── _headers            Cloudflare Pages headers (CSP, install.sh content-type)
├── robots.txt
└── sitemap.xml
```

## Design

Governed by [`BRAND.md`](BRAND.md), whose source of truth is `atlas.xailon.ai`.
That file and [`brand.json`](brand.json) are copied verbatim from
`infinia-office/deploy/site/` — the spec requires them to be identical in every
repo that ships an Infinia site, with only `brand.json`'s `product` object
differing. The invariant it asks you to check:

```sh
# must print nothing
diff <(jq -S .design brand.json) \
     <(jq -S .design ../../../infinia-office/deploy/site/brand.json)
```

`site.css` is the family stylesheet **byte-identical down to its closing brace**,
followed by one clearly marked block of docs-site additions. The palette, the
Inter/Space Grotesk ramp, the six layout signatures and the dark islands are all
inherited, and the additions introduce **no new colour** — the two statused
callouts reuse `--tint`, `--warn` and `--ok-bright` rather than adding an amber
and a green wash.

> One row was added to `BRAND.md`'s governed-sites table for this site. Since
> that file is meant to be identical everywhere, the same one-line addition
> should land in `infinia-office`, `infinia-workspace` and
> `infinia-automation-studio` to keep the copies in sync.

Two things are specific to this site:

- **The lockup.** `INFINIA` over `Harness`, both lines flush at both edges.
  "INFINIA" sets the width; "Harness" is a flex row of individually wrapped
  letters that stretches to meet it. Letter-spacing cannot do this — it is
  glyph-width dependent and drifts at every font size, while `space-between` is
  exact at every size. There is a regression check for it in `check.py`.
- **The docs shell.** A sticky rail beside the prose from 1000px, and below
  that the same links as a horizontally scrolling strip pinned under the nav —
  because the nav links are also hidden on phones, and a documentation site
  with no in-page navigation is not one.

## Local preview

```sh
cd public && python3 -m http.server 8899
```

## Checks — both must pass before publishing

```sh
node contrast.mjs           # the palette gate BRAND.md requires
python3 check.py            # the render gate (needs the server above + Playwright)
```

`contrast.mjs` is the family script, extended with the pairs this site's own
additions introduce. That extension immediately earned itself: `--warn` on
`--tint-2` measures **4.46:1**, under the 4.5 floor — the same failure that
retired `#b26b00`. The statused callouts sit on `--tint` (4.77:1) because of it.

`check.py` renders all four pages at **390 / 768 / 1440** and fails on:

| Check | Why it exists |
|---|---|
| console errors | — |
| horizontal page overflow | a `padding` shorthand on an element that also carries `.wrap`, and a bare `1fr` grid track, each silently made the whole page scroll sideways on a phone. Both happened here |
| terminal blocks that wrap | BRAND.md: *"a wrapped command is a lie — someone will paste it."* This regressed once already, as a well-meant mobile fix |
| lockup lines >1px out of alignment | the two-line wordmark is the site's one bespoke brand element |

Also verified by hand, per BRAND.md's publish checklist: `grep font-family` over
`site.css` returns only `var(--token)` uses, and the two-tone favicon still
resolves both chevrons at 16px, so no single-fill `--ink` variant is needed.

## The installer

`public/install.sh` is the artifact behind
`curl -fsSL https://infinia-harness.adid.dev/install.sh | sh`.

Every decision resolves in this order: environment variable → command-line flag
→ a question with a safe default. With no terminal attached, every question
takes its default, so the same command works unchanged in CI. The no-input path
always produces a working OSS install and never writes outside `$HOME`.

Test it without installing anything:

```sh
sh public/install.sh --dry-run
FLEETSMITH_NONINTERACTIVE=1 sh public/install.sh --edition ee --dry-run
shellcheck -s sh public/install.sh
```

Keep it POSIX. It runs under bash on macOS, dash on Debian, and busybox ash in
containers — no bashisms, no arrays, no `[[ ]]`.

### RelataDB

The cortex is bring-your-own-license and is never vendored. Verified facts as of
2026-08-16, which is why the installer is shaped the way it is:

| Source | State |
|---|---|
| `openworkbench/relata-db:v2.0.0` on Docker Hub | **public, multi-arch (amd64 + arm64)** — the default |
| `github.com/relatadb/RelataDB` v2.0.0 release | repo is **private**; the release and its signed tarballs are real but need an authorised `gh` |
| `ghcr.io/relatadb/relata` | access-gated; `docker pull` is denied |
| `relatadb.dev/install.sh` | 404 |

So `--cortex docker` is the default and the only path that works for everyone.
`--cortex binary` covers the private release properly — it goes through
`gh release download`, verifies the published SHA256, and refuses with a clear
message when `gh` is missing or unauthorised, rather than retrying a URL that
cannot work. Note `docs/enterprise/deployment.md` in the parent repo still points
at `ghcr.io` and `relatadb.dev/install.sh`; both were checked on 2026-08-16 and
neither is reachable.

Without any of them, the installer still installs the enterprise package and runs
on the file backend — the designed degradation, not a failure.

## Deploying

Cloudflare Pages, project `infinia-harness`, deploy directory `public/`:

```sh
wrangler login              # the account that owns the adid.dev zone
wrangler pages deploy public --project-name infinia-harness
wrangler pages domain add infinia-harness.adid.dev --project-name infinia-harness
```

The `adid.dev` zone is on a **different Cloudflare account** from the one that
owns `fleetsmith-website` and `subhransu-work`. Be logged into the zone's account
before attaching or changing the hostname.

### Why Pages, when the rest of the family uses R2

`infinia-office.adid.dev` and `infinia-workspace.adid.dev` are R2 buckets on
custom domains, each needing a small root-path Worker — because an R2 custom
domain maps a request path straight to an object key and does no directory-index
resolution, so `/install.sh` works while `/` 404s. `infinia-office`'s
`root-worker/index.js` says outright that it exists only because moving that
hostname to Pages would detach R2 and break every published install URL and the
update feed already baked into shipped binaries.

This site has none of those constraints: it is new, it ships no binaries, and it
has no update feed. Pages resolves directory indexes natively, honours
`_headers` (which is how `install.sh` gets its content type and the whole site
gets its CSP), and needs no Worker at all. The divergence is recorded in
`brand.json` as `product.published_via`, which is a per-product field.

If it ever needs to move to R2 for consistency, it also needs the root Worker —
budget for that, not just a bucket.
