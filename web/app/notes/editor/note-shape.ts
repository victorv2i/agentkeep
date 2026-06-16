// Pure note-shape helpers for the live preview: where the YAML frontmatter
// block sits, and whether the body opens with an H1 that just repeats the
// note title shown in the pane header. DOM-free on purpose so the logic is
// testable in node (see note-shape.test.ts); the decorators in
// live-preview.ts stay thin over these.

import type { EditorState } from '@codemirror/state'

/** The range of a YAML frontmatter block at the very top of the doc, or null. */
export function frontmatterRange(
  state: EditorState,
): { from: number; to: number } | null {
  const doc = state.doc
  if (doc.lines < 2) return null
  const first = doc.line(1)
  if (first.text.trimEnd() !== '---') return null
  for (let n = 2; n <= doc.lines; n++) {
    const line = doc.line(n)
    const t = line.text.trimEnd()
    if (t === '---' || t === '...') return { from: first.from, to: line.to }
  }
  return null
}

/** Case/whitespace-insensitive form for title comparison. */
export function normalizeTitle(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * The line range of a leading `# H1` whose text equals `title` (after
 * normalization), or null. Only the first non-blank line after any
 * frontmatter counts: an H1 deeper in the body is real content.
 */
export function findDuplicateTitleLine(
  state: EditorState,
  title: string,
): { from: number; to: number } | null {
  const wanted = normalizeTitle(title)
  if (wanted === '') return null
  const doc = state.doc
  const fm = frontmatterRange(state)
  let n = fm ? doc.lineAt(fm.to).number + 1 : 1
  while (n <= doc.lines && doc.line(n).text.trim() === '') n++
  if (n > doc.lines) return null
  const line = doc.line(n)
  const m = /^#\s+(.+)$/.exec(line.text)
  if (!m || normalizeTitle(m[1]!) !== wanted) return null
  return { from: line.from, to: line.to }
}
