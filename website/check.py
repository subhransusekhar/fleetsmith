from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8899"
OUT = "/tmp/infinia-harness-shots"
PAGES = ["/", "/architecture.html", "/quickstart.html", "/guide.html"]

import os
os.makedirs(OUT, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    errors = []
    # 390 / 768 / 1440 — the three widths BRAND.md requires before publishing.
    for label, vp in [
        ("desktop", {"width": 1440, "height": 1000}),
        ("tablet", {"width": 768, "height": 1024}),
        ("mobile", {"width": 390, "height": 844}),
    ]:
        page = browser.new_page(viewport=vp, device_scale_factor=2)
        page.on("console", lambda m: errors.append(f"[console:{m.type}] {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
        for path in PAGES:
            page.goto(BASE + path)
            page.wait_for_load_state("networkidle")
            name = (path.strip("/") or "index").replace(".html", "")
            page.screenshot(path=f"{OUT}/{name}-{label}.png", full_page=True)
            # horizontal overflow check — the page body must never scroll sideways
            ow = page.evaluate("document.documentElement.scrollWidth")
            iw = page.evaluate("document.documentElement.clientWidth")
            if ow > iw + 1:
                errors.append(f"[overflow] {path} @{label}: scrollWidth {ow} > clientWidth {iw}")

            # BRAND.md: terminal blocks scroll, they never wrap. "A wrapped
            # command is a lie — someone will paste it." This has regressed
            # once already, as a well-meant mobile fix.
            wrapped = page.evaluate("""() => {
              const bad = [];
              document.querySelectorAll('pre')
                .forEach(el => {
                  const ws = getComputedStyle(el).whiteSpace;
                  if (ws !== 'pre') bad.push(ws + ' :: ' + el.innerText.slice(0, 40));
                });
              return bad;
            }""")
            for w in wrapped:
                errors.append(f"[wrap] {path} @{label}: terminal block is not white-space:pre — {w}")
        page.close()

    # measure the logo lockup: both lines must share left and right edges
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.goto(BASE + "/")
    page.wait_for_load_state("networkidle")
    box = page.evaluate("""() => {
      const l1 = document.querySelector('.nav-logo-text .l1').getBoundingClientRect();
      const l2 = document.querySelector('.nav-logo-text .l2').getBoundingClientRect();
      return {l1: {l: l1.left, r: l1.right, w: l1.width}, l2: {l: l2.left, r: l2.right, w: l2.width}};
    }""")
    print("LOCKUP", box)
    dl = abs(box["l1"]["l"] - box["l2"]["l"])
    dr = abs(box["l1"]["r"] - box["l2"]["r"])
    print(f"LOCKUP delta left={dl:.2f}px right={dr:.2f}px")
    if dl > 1 or dr > 1:
        errors.append(f"[lockup] lines not flush: left off by {dl:.2f}px, right by {dr:.2f}px")
    page.close()
    browser.close()

import sys

if errors:
    print("\n".join(errors))
    sys.exit(1)
print("NO ERRORS")
