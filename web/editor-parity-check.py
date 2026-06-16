#!/usr/bin/env python3
"""Real-browser verification of the /notes Live Preview render.

Opens the seeded "Editor parity demo" note in a built+running Next server,
screenshots it RENDERED (cursor parked away), then moves the cursor into the
bulleted list and screenshots that line revealed as RAW markdown. Finally clicks
the open task checkbox and reports whether the doc text toggled `[ ]`→`[x]`.
"""
import sys
from playwright.sync_api import sync_playwright

import os

BASE = "http://127.0.0.1:3220"
OPEN = "notes/Editor parity demo.md"
_HERE = os.path.dirname(os.path.abspath(__file__))
RENDER_PNG = os.path.join(_HERE, "editor-parity-render.png")
RAW_PNG = os.path.join(_HERE, "editor-parity-raw.png")
# The actual vault file on disk — we read it to prove the checkbox toggle saved.
VAULT_NOTE = os.path.join(_HERE, "..", "dev-vault", "notes", "Editor parity demo.md")


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 1600})
        page.goto(f"{BASE}/notes?open={OPEN.replace(' ', '%20')}", wait_until="networkidle")

        # Wait for the editor to mount + the note to load (title in the header).
        page.wait_for_selector("h1", timeout=15000)
        page.wait_for_selector(".cm-content", timeout=15000)
        # Wait for at least one rendered widget (the • bullet) to appear.
        page.wait_for_selector(".cm-lp-bullet", timeout=15000)
        # Give async images (the /api/image fetch) a beat to paint.
        page.wait_for_timeout(800)

        # Park the cursor far from the content: click the editor, then press
        # Ctrl+Home so the selection sits at the very top (heading line), leaving
        # every list/task/table/image/embed below it RENDERED.
        page.click(".cm-content")
        page.keyboard.press("Control+Home")
        page.wait_for_timeout(400)

        # ── assertions: everything is rendered ──────────────────────────────
        checks = {
            "bullet (•)": ".cm-lp-bullet",
            "checkbox": ".cm-lp-checkbox input",
            "blockquote": ".cm-lp-blockquote",
            "horizontal rule": ".cm-lp-hr hr",
            "inline image": ".cm-lp-image img",
            "markdown link": ".cm-lp-link",
            "wikilink pill": ".cm-wikilink",
            "table": ".cm-lp-table table",
            "note embed": ".cm-lp-embed",
        }
        results = {}
        for name, sel in checks.items():
            results[name] = len(page.query_selector_all(sel))
        print("RENDERED element counts:")
        for name, n in results.items():
            print(f"  {'OK ' if n else 'MISS'} {name}: {n}")

        # Count the images that actually loaded (naturalWidth > 0 → bytes served).
        loaded_imgs = page.eval_on_selector_all(
            ".cm-lp-image img",
            "els => els.filter(e => e.naturalWidth > 0).length",
        )
        print(f"  images with bytes loaded (naturalWidth>0): {loaded_imgs}")

        page.screenshot(path=RENDER_PNG, full_page=True)
        print(f"wrote {RENDER_PNG}")

        bullets_rendered = len(page.query_selector_all(".cm-lp-bullet"))

        # ── reveal raw: put the cursor ON the first list marker ──────────────
        # Click the first list item's text, then Home to land the cursor on the
        # `-` marker → that bullet reverts to raw `-` (Obsidian reveal-on-mark).
        page.get_by_text("A bulleted item with a real", exact=False).first.click()
        page.keyboard.press("Home")
        page.wait_for_timeout(400)
        bullets_after_enter = len(page.query_selector_all(".cm-lp-bullet"))
        revealed = bullets_after_enter < bullets_rendered
        print(
            f"bullets rendered before/after cursor-on-marker: "
            f"{bullets_rendered}/{bullets_after_enter} (raw `-` revealed on that line: {revealed})"
        )
        page.screenshot(path=RAW_PNG, full_page=True)
        print(f"wrote {RAW_PNG}")

        # ── toggle a task checkbox + confirm the SOURCE changed on DISK ──────
        # The widget's own `mouseup` listener does the toggle and dispatches a
        # normal editor change, which autosaves through the CAS to the vault
        # file. Read the file before/after to PROVE the source flipped + saved.
        # (We dispatch the `mouseup` the widget listens for; a real user click in
        # a browser delivers the same event — Playwright's synthetic mouse over a
        # tiny input inside a contenteditable host does not, hence the dispatch.)
        page.keyboard.press("Control+Home")
        page.wait_for_timeout(300)
        with open(VAULT_NOTE, encoding="utf-8") as f:
            file_before = f.read()
        open_before = "- [ ] This task is still open" in file_before
        print(f"vault file has open task `- [ ]` BEFORE: {open_before}")

        page.eval_on_selector_all(
            ".cm-lp-checkbox input",
            "els => els[1].dispatchEvent(new MouseEvent('mouseup', {bubbles:true, cancelable:true}))",
        )
        # Wait out the 1.2s autosave debounce + the write.
        page.wait_for_timeout(2200)
        with open(VAULT_NOTE, encoding="utf-8") as f:
            file_after = f.read()
        done_after = "- [x] This task is still open" in file_after or "- [X] This task is still open" in file_after
        print(f"vault file has done task `- [x]` AFTER click: {done_after}")
        toggled = open_before and done_after
        print(f"SOURCE toggled `[ ]`→`[x]` + saved via CAS: {toggled}")

        browser.close()

        missing = [n for n, c in results.items() if not c]
        ok = True
        if missing:
            print(f"FAIL: missing rendered elements: {missing}")
            ok = False
        if loaded_imgs < 1:
            print("FAIL: no inline image loaded bytes via /api/image")
            ok = False
        if not revealed:
            print("FAIL: entering the list did not reveal the raw bullet")
            ok = False
        if not toggled:
            print("FAIL: clicking the checkbox did not toggle the source")
            ok = False
        if ok:
            print("PASS: all live-preview elements rendered + interactions work")
            return 0
        return 1


if __name__ == "__main__":
    sys.exit(main())
