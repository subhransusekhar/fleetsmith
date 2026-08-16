/* Infinia Harness — shared page behaviour.
 *
 * Four small things, no framework, no build step. Every one of them is an
 * enhancement: the pages are complete and readable with this file blocked.
 */

// ── 1. The nav pill is transparent over the hero and takes on its white glass
//       background only once the page has scrolled — family signature 1.
;(function () {
  var nav = document.querySelector('nav')
  if (!nav) return
  var sync = function () {
    nav.classList.toggle('scrolled', window.scrollY > 8)
  }
  sync()
  addEventListener('scroll', sync, { passive: true })
})()

// ── 2. Copy buttons. data-copy is a selector for the element to read.
document.querySelectorAll('.copy-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var el = document.querySelector(btn.dataset.copy)
    if (!el || !navigator.clipboard) return
    navigator.clipboard.writeText(el.innerText.trim()).then(
      function () {
        var prev = btn.textContent
        btn.textContent = 'Copied'
        setTimeout(function () {
          btn.textContent = prev
        }, 1600)
      },
      function () {
        btn.textContent = 'Press ⌘C'
      }
    )
  })
})

// ── 3. Tab groups. Each .tabs owns the panels sharing its data-group.
document.querySelectorAll('.tabs').forEach(function (group) {
  var name = group.dataset.group
  group.querySelectorAll('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      group.querySelectorAll('.tab').forEach(function (t) {
        t.classList.toggle('active', t === tab)
        t.setAttribute('aria-selected', t === tab ? 'true' : 'false')
      })
      document.querySelectorAll('[data-panel-group="' + name + '"]').forEach(function (p) {
        p.hidden = p.dataset.panel !== tab.dataset.tab
      })
    })
  })
})

// ── 4. Docs rail scrollspy.
//
//   IntersectionObserver fires on *crossings*, so on a page where nothing is
//   currently crossing — a short last section, a fresh deep link — it never
//   fires at all and the rail would show nothing highlighted. Tracking the
//   last-passed heading on scroll instead is always defined, which matters
//   more here than the observer's efficiency: the list is a few dozen items.
;(function () {
  var rail = document.querySelector('.docs-rail')
  if (!rail) return
  var links = [].slice.call(rail.querySelectorAll('a[href^="#"]'))
  if (!links.length) return

  var targets = links
    .map(function (a) {
      return { link: a, el: document.getElementById(decodeURIComponent(a.hash.slice(1))) }
    })
    .filter(function (t) {
      return t.el
    })

  var ticking = false
  var sync = function () {
    ticking = false
    var line = window.scrollY + 130 // just under the fixed nav
    var current = targets[0]
    for (var i = 0; i < targets.length; i++) {
      if (targets[i].el.offsetTop <= line) current = targets[i]
    }
    // At the very bottom the last section may be too short to ever reach the
    // line; nothing below it exists, so it is the honest answer.
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 4) {
      current = targets[targets.length - 1]
    }
    targets.forEach(function (t) {
      t.link.classList.toggle('active', t === current)
    })
  }
  var onScroll = function () {
    if (ticking) return
    ticking = true
    requestAnimationFrame(sync)
  }
  sync()
  addEventListener('scroll', onScroll, { passive: true })
  addEventListener('resize', onScroll, { passive: true })
})()
