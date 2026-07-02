import { describe, it, expect } from 'vitest'
import { sanitizeLinkHref } from './live-preview'

// A rendered `[text](url)` link's href must never be a directly-navigable
// dangerous scheme (javascript:, data:, vbscript:, file:, ...) — a click is
// always intercepted by our own handler, but the href is also what shows via
// hover/copy-link/middle-click/drag, so it must be inert for those paths too.
// Safe navigable schemes (http/https/mailto) and scheme-less internal/relative
// targets (resolved by our own click handler, never the browser) pass through.

describe('sanitizeLinkHref', () => {
  it('renders javascript: hrefs inert', () => {
    expect(sanitizeLinkHref('javascript:alert(1)')).toBe('#')
  })

  it('renders data: hrefs inert', () => {
    expect(sanitizeLinkHref('data:text/html,<script>alert(1)</script>')).toBe('#')
  })

  it('renders vbscript: and file: hrefs inert', () => {
    expect(sanitizeLinkHref('vbscript:msgbox(1)')).toBe('#')
    expect(sanitizeLinkHref('file:///etc/passwd')).toBe('#')
  })

  it('passes through http/https URLs unchanged', () => {
    expect(sanitizeLinkHref('https://example.com/page')).toBe('https://example.com/page')
    expect(sanitizeLinkHref('http://example.com')).toBe('http://example.com')
  })

  it('passes through mailto: unchanged', () => {
    expect(sanitizeLinkHref('mailto:a@b.com')).toBe('mailto:a@b.com')
  })

  it('passes through a scheme-less relative/internal target unchanged', () => {
    expect(sanitizeLinkHref('notes/foo')).toBe('notes/foo')
    expect(sanitizeLinkHref('#heading')).toBe('#heading')
    expect(sanitizeLinkHref('foo.md')).toBe('foo.md')
  })
})
