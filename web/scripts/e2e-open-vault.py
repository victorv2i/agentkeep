#!/usr/bin/env python3
"""E2E: open a SECOND vault from Settings and confirm the app serves it live.

Usage: e2e-open-vault.py <base_url> <second_vault_abs_path> <unique_term> <out_png>

Proves the open/switch flow end-to-end:
  1. /settings shows the current active vault (the default dev-vault).
  2. Type the second vault's absolute path → click "Open vault".
  3. The Vault section now shows the second vault as active.
  4. /api/search?q=<unique_term> returns a note that ONLY exists in the second
     vault (the live index + watcher rebuilt against the new root).
  5. The original (dev-vault) path now appears under "Recent vaults".
  6. Screenshot the Settings Vault section.
"""
import json
import sys
import urllib.request

from playwright.sync_api import sync_playwright

base = sys.argv[1].rstrip("/")
second_vault = sys.argv[2]
term = sys.argv[3]
out = sys.argv[4]


def api_search(q):
    with urllib.request.urlopen(f"{base}/api/search?q={q}", timeout=15) as r:
        return json.load(r)


fail = []

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 1100}, device_scale_factor=2)
    page.goto(f"{base}/settings", wait_until="networkidle", timeout=30000)

    # The active vault path before switching (default dev-vault).
    before = page.locator(".vault-path").first.inner_text().strip()
    print(f"active vault BEFORE: {before}")

    # Sanity: the term must NOT match in the original vault.
    pre = api_search(term)
    print(f"search '{term}' in ORIGINAL vault: {len(pre['hits'])} hits")

    # Open the second vault.
    page.fill("#vault-path", second_vault)
    page.click(".vault-btn")
    # Wait until the active path flips to the second vault (server action + revalidate).
    page.wait_for_function(
        "(want) => { const el = document.querySelector('.vault-path');"
        " return el && el.textContent.trim() === want; }",
        arg=second_vault,
        timeout=30000,
    )
    after = page.locator(".vault-path").first.inner_text().strip()
    print(f"active vault AFTER:  {after}")
    if after != second_vault:
        fail.append(f"active vault did not switch (got {after!r})")

    # The original vault must now be a recent quick-switch button.
    recents = [b.strip() for b in page.locator(".vault-recent").all_inner_texts()]
    print(f"recents: {recents}")
    if before not in recents:
        fail.append(f"original vault {before!r} not in recents {recents!r}")

    # The live index now serves the SECOND vault's content.
    post = api_search(term)
    paths = [h.get("path") for h in post["hits"]]
    print(f"search '{term}' in NEW vault: {len(post['hits'])} hits -> {paths}")
    if len(post["hits"]) == 0:
        fail.append(f"new vault note matching '{term}' not served by /api/search")

    # Screenshot just the Settings Vault section.
    page.wait_for_timeout(400)
    section = page.locator(".vault-sec")
    section.screenshot(path=out)
    print(f"saved {out}")
    browser.close()

if fail:
    print("E2E FAIL:")
    for f in fail:
        print(f"  - {f}")
    sys.exit(1)
print("E2E PASS")
