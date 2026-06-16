#!/usr/bin/env python3
"""Screenshot the Notes editor: open a cross-linked note so a live `[[wikilink]]`
renders in live-preview and the backlinks panel is populated. Also capture the
cursor-inside-link raw state. Usage: shot-notes.py <base-url> <out-dir>."""
import sys
from playwright.sync_api import sync_playwright

base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:7332"
outdir = sys.argv[2] if len(sys.argv) > 2 else "."

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900}, device_scale_factor=2)
    page.goto(f"{base}/notes", wait_until="networkidle", timeout=30000)
    page.wait_for_timeout(500)

    # Open "Launch plan" — its body has several resolved `[[wikilinks]]` rendered
    # as live-preview pills, and it is linked FROM "BYO-agent seam" + "Morning
    # Brief" so the backlinks panel is populated.
    page.get_by_role("button", name="Launch plan").first.click()
    # Wait for the editor + a rendered wikilink pill + the backlinks panel. The
    # backlinks panel can sit below the fold, so wait for it ATTACHED (not
    # "visible") — full_page capture below still includes it.
    page.wait_for_selector(".cm-editor", timeout=10000)
    page.wait_for_selector(".cm-wikilink", timeout=10000)
    page.wait_for_selector(".backlinks", state="attached", timeout=10000)
    page.wait_for_timeout(600)  # let fonts + decorations settle
    page.screenshot(path=f"{outdir}/notes-editor-render.png", full_page=True)
    print(f"saved {outdir}/notes-editor-render.png")

    # Cursor-inside-link raw state: click directly on the [[Launch plan]] pill's
    # source by placing the caret in it. Clicking the pill navigates, so instead
    # click just before it in the text and arrow into the link region — simplest
    # reliable approach: click into the paragraph line containing the link.
    pill = page.locator(".cm-wikilink").first
    box = pill.bounding_box()
    if box:
        # Click a hair to the LEFT of the pill so the caret lands adjacent, then
        # press ArrowRight to move the cursor INTO the link → reveals raw [[...]].
        page.mouse.click(box["x"] - 3, box["y"] + box["height"] / 2)
        for _ in range(2):
            page.keyboard.press("ArrowRight")
        page.wait_for_timeout(400)
        page.screenshot(path=f"{outdir}/notes-editor-raw-link.png", full_page=True)
        print(f"saved {outdir}/notes-editor-raw-link.png")

    browser.close()
