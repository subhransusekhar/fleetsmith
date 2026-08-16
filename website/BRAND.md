# Infinia design brand spec

**`https://atlas.xailon.ai/` is the default design brand spec for every Infinia
property.** Not a reference to borrow from — the source of truth. A new Infinia
site starts from this document, and an existing one is judged against it.

This file is **canonical and identical** in every repo that ships an Infinia
site. Its machine-readable half is [`brand.json`](brand.json), whose `design`
object is byte-identical across repos on purpose:

```bash
# must print nothing, in any direction
diff <(jq -S .design brand.json) <(jq -S .design ../other-repo/.../brand.json)
```

Only `brand.json`'s `product` object differs per site. If a property needs a
design value this file does not have, add it **here first**, then to every repo.
Forking a token is how a family stops looking like one.

Sites currently governed by this spec:

| Site                                                   | Repo                        | Published by                         |
| ------------------------------------------------------ | --------------------------- | ------------------------------------ |
| `infinia-automation.adid.dev` + `-studio` + `-browser` | `infinia-automation-studio` | Cloudflare Worker with static assets |
| `infinia-workspace.adid.dev`                           | `infinia-workspace`         | Cloudflare R2 + a root Worker        |
| `infinia-office.adid.dev`                              | `infinia-office`            | Cloudflare R2 + a root Worker        |
| `infinia-harness.adid.dev`                             | `rnd/agent-harness`         | Cloudflare Pages                     |

---

## Ground

Light. White page, deep indigo ink, and the indigo→blue gradient as the only
loud colour. Everything else is atmosphere.

A light ground is a **brand decision, not a style preference** — it is what
makes an Infinia property recognisable next to Atlas. Do not propose inverting
it. The applications are a separate question: their in-app themes are dark and
this spec does not govern them.

---

## Palette

Every value is measured against the ground it is used on. **AA is 4.5:1 for body
text, 3:1 for large text and meaningful non-text.** Re-check with
`node contrast.mjs` in this directory after touching any token.

| Token                          | Value                             | On         | Ratio      | Use                                  |
| ------------------------------ | --------------------------------- | ---------- | ---------- | ------------------------------------ |
| `--ink`                        | `#110b35`                         | white      | **17.1:1** | headings, logo, dark islands         |
| `--ink-2`                      | `#2b1c8b`                         | white      | **10.4:1** | gradient start, secondary indigo     |
| `--blue`                       | `#2563eb`                         | white      | **5.2:1**  | links, gradient end, primary buttons |
| `--blue-deep`                  | `#134678`                         | `--tint-2` | **8.4:1**  | inline code, link hover              |
| `--text`                       | `#0d0d0d`                         | white      | **19.5:1** | strong body copy                     |
| `--body`                       | `#3a3a3a`                         | white      | **10.9:1** | ordinary body copy                   |
| `--muted`                      | `#5b5b5b`                         | white      | **7.0:1**  | captions, roles, tags                |
| `--faint`                      | `#6e6a85`                         | white      | **5.3:1**  | section eyebrows                     |
| `--ok`                         | `#0b7a44`                         | white      | **5.0:1**  | success **text**                     |
| `--warn`                       | `#a06100`                         | white      | **5.0:1**  | warning text                         |
| `--red`                        | `#c5221f`                         | white      | **5.9:1**  | error text and marks                 |
| `--rule`                       | `#d3dff2`                         | —          | —          | borders, dividers, table cells       |
| `--rule-2`                     | `#e6eefb`                         | —          | —          | the softer edge on soft-fill cards   |
| `--bg` / `--tint` / `--tint-2` | `#ffffff` / `#f6faff` / `#edf2ff` | —          | —          | grounds                              |
| `--card-a` / `--card-b`        | `#e4f1ff` / `#f3f9ff`             | —          | —          | the soft card fill, top → bottom     |

### Decorative only — never text, never a control boundary

`--cyan` `#00b4d8` (2.5:1), `--cyan-pale` `#a9edff`, `--glow-lilac` `#eaddff`,
`--glow-warm` `#f6e7ce`, `--violet` `#613bb3`, `--ok-bright` `#0f9d58` (3.6:1).

These carry no information, so WCAG 1.4.11 does not apply and they are **not**
darkened — `--cyan` is Infinia's own primary and stays exact. They appear in the
hero glow blobs, decorative gradient bars, and graphical marks such as status
dots and timeline nodes. Success _text_ uses `--ok`.

`--violet` is Atlas's own `#613bb3` from its nav text gradient. It is not the
retired `#8b5cf6`: there is no purple of that kind anywhere in this palette.

### Values that must never come back

The dark themes' accents were picked to sit on near-black and behave completely
differently on white:

| Was                   | On white               | Replaced by            |
| --------------------- | ---------------------- | ---------------------- |
| `#a0ffa0` inline code | **~1.3:1 — invisible** | `--blue-deep`          |
| `#34d399` green       | 2.3:1                  | `--ok` / `--ok-bright` |
| `#22d3ee` cyan        | 2.4:1                  | decorative use only    |
| `#fbbf24` amber       | 1.8:1                  | `--warn`               |
| `#8b5cf6` purple      | —                      | **retired**            |
| `#b26b00` warn        | 4.2:1 — fails AA       | `--warn` `#a06100`     |

---

## Type

| Token       | Stack                    | Use                                    |
| ----------- | ------------------------ | -------------------------------------- |
| `--display` | Space Grotesk → `--sans` | headings, logo wordmark, at `-0.022em` |
| `--sans`    | Inter → system           | body, eyebrows, buttons, table headers |
| `--mono`    | SF Mono → system mono    | code, CLI ids, terminal islands        |

This is a **deliberate divergence from Atlas**, which sets Cairo. Headings and
the logo lockup are Space Grotesk and body copy is Inter across the family;
changing either is a brand decision, not a tidy-up. Say so in the CSS so nobody
"fixes" it later.

**Never write a font family inline.** `grep -n font-family` over the stylesheet
must return only the three token definitions.

---

## The six layout signatures

Palette alone does not make a page look like Atlas. These do, and a site is not
aligned until it has all six.

1. **Floating pill nav.** Fixed, `top:1rem`, one pill of `max-width:1340px`,
   `border-radius:999px`, `backdrop-filter:blur(18px)`. **Fully transparent over
   the hero**, taking `rgba(255,255,255,0.82)` + `--rule-2` border +
   `nav_scrolled` shadow only once the page has scrolled. That transition is the
   single most recognisable thing about the header — a permanently white bar is
   not this spec.
2. **The hero horizon.** A centered hero over a band of
   `gradients.horizon` (white → `#288ef4`), overlaid with a `39px` grid of
   `colors.grid_line` and two blurred glow blobs. A white bloom sits on the
   horizon line so the band brightens back into the page.
   _The band must finish its fade before the hero's own edge_ — heroes clip their
   overflow, and blue still painted at the clip line shows up as a hard seam.
3. **Sharp cards on the soft fill.** `gradients.card_soft`, `1px solid
--rule-2`, and **`border-radius:0`**. Square corners on a soft blue fill is
   the most imitable Atlas signature; rounding them undoes the alignment on its
   own. Hover raises `shadow.card_hover`.
4. **4px buttons.** Primary is `gradients.brand` with white text and
   `shadow.button`. Secondary is a gradient hairline border around white with
   `--ink-2` text. Both lift `2px` on hover. Pills stay `999px`; buttons never do.
5. **Grey sentence-case eyebrows.** `--sans`, `1.05rem`, weight 600, `--faint`,
   no tracking, **not** uppercase, above a heavy display heading. The old
   uppercase micro-label in `--blue` is not this spec.
6. **The mirrored CTA.** The closing section rises back into the same horizon,
   so a page opens and closes on one field instead of reading as a stack of
   bands. Same clip-before-the-edge rule as the hero.

Container is `1013px`. Section rhythm alternates white and `--tint`.

---

## Dark islands — do not "finish" the inversion

These stay dark on every Infinia site, on purpose:

| Element                    | Why                                                           |
| -------------------------- | ------------------------------------------------------------- |
| install / command box      | a command you paste into a terminal should read as a terminal |
| ascii architecture diagram | it is terminal output                                         |
| numbered step markers      | solid `--ink` discs                                           |
| terminal transcripts       | real output, framed as a real terminal                        |

Text inside them is `dark_island_text` `#dde4ff` on `--ink` — **14.8:1**.

Inline `code` in prose is _not_ an island: `--tint-2` ground, `--blue-deep` text.
Give it `overflow-wrap:anywhere` — unbreakable URLs and flag lists otherwise push
a phone-width page sideways, where `overflow-x:hidden` clips them silently rather
than scrolling.

---

## Logo

Same geometry across the family; only the fills differ.

| Path          | Fill               |
| ------------- | ------------------ |
| large chevron | `--ink` `#110b35`  |
| small chevron | `--blue` `#2563eb` |

A single flat fill reads washed out on a light ground. `logo.svg` and every
inline copy carry the two-tone treatment. **Check the favicon at 16px in a real
tab** — two-tone marks can lose the second colour at that size; ship a
single-fill `--ink` variant if it smudges.

---

## Before you publish

```bash
node contrast.mjs        # every pair clears its threshold
```

Then check the page itself at **390 / 768 / 1440**: no horizontal overflow, no
console errors, and terminal blocks scrolling rather than wrapping a command
across lines. A wrapped command is a lie — someone will paste it.
