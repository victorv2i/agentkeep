#!/usr/bin/env python3
"""Screenshot the Brief home at desktop width. Usage: shot-brief.py <url> <out>."""
import sys
from playwright.sync_api import sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:7331/"
out = sys.argv[2] if len(sys.argv) > 2 else "brief-home-render.png"

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900}, device_scale_factor=2)
    page.goto(url, wait_until="networkidle", timeout=30000)
    # Let the local fonts settle before capturing.
    page.wait_for_timeout(600)
    page.screenshot(path=out, full_page=True)
    browser.close()
print(f"saved {out}")
