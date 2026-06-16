/**
 * A one-line, prose excerpt of a note body for the Memory list.
 *
 * Takes the first non-empty, non-structural line and strips the common markdown
 * so it reads as a sentence, not source: leading block markers (heading, list
 * bullet, numbered, task box, blockquote) and inline emphasis / code / links.
 * Pure and free of `server-only`/core imports so it is unit-testable on its own.
 */
export function excerptOf(body: string): string {
  for (const raw of body.split('\n')) {
    let line = raw.trim()
    if (line === '' || line === '---') continue

    // Leading block markers.
    line = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/^[-*+]\s+\[[ xX]\]\s+/, '') // task item: "- [ ] ..."
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+\.\s+/, '')

    // Inline emphasis / code / links → their text.
    line = line
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      // [[wikilink]] / ![[embed]] → display text (alias after |, else bare target)
      .replace(/!?\[\[([^\]]+?)\]\]/g, (_m, inner: string) =>
        (inner.includes('|') ? inner.slice(inner.indexOf('|') + 1) : inner.split(/[#^]/)[0]).trim(),
      )
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .trim()

    if (line === '') continue
    return line.length > 120 ? line.slice(0, 119).trimEnd() + '…' : line
  }
  return ''
}
