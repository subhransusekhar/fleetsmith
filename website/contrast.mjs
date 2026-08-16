#!/usr/bin/env node
/**
 * WCAG contrast check for the Infinia site palette.
 *
 * Reads the palette out of brand.json rather than restating it, so this script
 * cannot drift from the spec it is checking — the failure mode that made it
 * necessary in the first place. The dark themes' accents were chosen for a
 * near-black ground and several were unreadable once inverted: #a0ffa0 on white
 * is about 1.3:1, and it was the colour of inline code.
 *
 * Ratios quoted in BRAND.md are this script's output, not estimates.
 *
 *   node contrast.mjs        # exits non-zero on a failure
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const { design } = JSON.parse(readFileSync(join(HERE, 'brand.json'), 'utf8'))
const c = design.colors

/** WCAG 2.1 relative luminance. */
function luminance(hex) {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(h.substr(i, 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** [label, foreground, background, minimum] — 4.5 body text, 3 graphics. */
const PAIRS = [
  ['--text on --bg', c.text, c.bg, 4.5],
  ['--body on --bg', c.body, c.bg, 4.5],
  ['--body on --tint', c.body, c.tint, 4.5],
  ['--muted on --bg', c.muted, c.bg, 4.5],
  ['--muted on --tint', c.muted, c.tint, 4.5],
  ['--muted on --tint-2', c.muted, c.tint_2, 4.5],
  ['--faint eyebrow on --bg', c.faint, c.bg, 4.5],
  ['--faint eyebrow on --tint', c.faint, c.tint, 4.5],
  ['--ink heading on --bg', c.ink, c.bg, 4.5],
  ['--ink heading on --card-a', c.ink, c.card_a, 4.5],
  ['--ink-2 on --bg', c.ink_2, c.bg, 4.5],
  ['--blue link on --bg', c.blue, c.bg, 4.5],
  ['--blue link on --tint', c.blue, c.tint, 4.5],
  ['--blue-deep code on --tint-2', c.blue_deep, c.tint_2, 4.5],
  ['--ok text on --bg', c.ok, c.bg, 4.5],
  ['--ok text on --card-a', c.ok, c.card_a, 4.5],
  ['--warn text on --bg', c.warn, c.bg, 4.5],
  ['--red text on --bg', c.red, c.bg, 4.5],
  ['white on --ink-2 (gradient start)', c.bg, c.ink_2, 4.5],
  ['white on --blue (gradient end)', c.bg, c.blue, 4.5],
  ['dark-island text on --ink', design.dark_island_text, c.ink, 4.5],
  ['--ok-bright mark (graphical)', c.ok_bright, c.bg, 3],

  // ── pairs this site's own additions introduce ──
  // The docs layer adds statused callouts and renders prose on the soft card
  // fill. Those combinations do not occur on the Office page, so the shared
  // list above never covered them — and an unchecked pair is how #a0ffa0
  // happened. Everything here uses existing tokens; nothing is a new colour.
  //
  // The two statused callouts sit on --tint rather than the family's --tint-2
  // precisely because this list caught --warn at 4.46:1 on --tint-2.
  ['--warn label on --tint (callout)', c.warn, c.tint, 4.5],
  ['--ok label on --tint (callout)', c.ok, c.tint, 4.5],
  ['--blue-deep label on --tint-2 (callout)', c.blue_deep, c.tint_2, 4.5],
  ['--ink on --card-b (soft card, bottom)', c.ink, c.card_b, 4.5],
  ['--muted chip on --bg', c.muted, c.bg, 4.5],
  ['--faint rail label on --bg', c.faint, c.bg, 4.5],
  ['--warn left border (graphical)', c.warn, c.tint, 3],
]

/**
 * The decorative_only tokens are deliberately absent. They appear on glow blobs,
 * 3px gradient bars and graphical marks — no information, so WCAG 1.4.11 does
 * not apply. Listing them here would force darkening Infinia's own --cyan to
 * satisfy a rule that does not govern it.
 */
const skipped = design.decorative_only.filter((k) => k !== 'ok_bright')

let failed = 0
for (const [label, fg, bg, min] of PAIRS) {
  const value = ratio(fg, bg)
  const pass = value >= min
  if (!pass) failed++
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${value.toFixed(2).padStart(5)}:1  (min ${min})  ${label}`,
  )
}
console.log(`\nskipped as decorative-only: ${skipped.join(', ')}`)
console.log(failed ? `${failed} pair(s) below threshold` : 'all pairs clear their threshold')
process.exit(failed ? 1 : 0)
