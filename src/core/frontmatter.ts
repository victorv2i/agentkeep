import matter from 'gray-matter'
import { parseDocument, Scalar, isScalar } from 'yaml'

export interface ParsedNote {
  data: Record<string, unknown>
  body: string
}

// Match the SAME frontmatter shapes gray-matter accepts on the read side, so a
// note is never seen as "has frontmatter" on read but "has none" on write (which
// would prepend a second block and bury the original keys). That means tolerating
// trailing whitespace on either fence and a closing fence at end-of-input (a note
// that is frontmatter-only with no trailing newline).
const FM_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

// We WRITE with `yaml` (YAML 1.2) but the read side (gray-matter → js-yaml) is
// YAML 1.1, which coerces unquoted scalars js-yaml recognizes as non-strings:
// ISO timestamps → Date (`2026-...Z` comes back as `...000Z`), and `yes`/`no`/
// `on`/`off`/`y`/`n` → boolean. A string value we set would then NOT round-trip
// as a string. Force such ambiguous string values to a double-quoted scalar so
// the two parsers agree (a quoted scalar is unambiguously a string in both).
const YAML_TIMESTAMP_RE =
  /^\d{4}-\d{1,2}-\d{1,2}([Tt ]\d{1,2}:\d{1,2}:\d{1,2}(\.\d+)?([Zz]|[+-]\d{1,2}(:?\d{2})?)?)?$/
const YAML11_BOOL_RE = /^(y|n|yes|no|on|off|true|false)$/i

function needsQuoting(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (YAML_TIMESTAMP_RE.test(value) || YAML11_BOOL_RE.test(value))
  )
}

/** Read-only split (gray-matter). Never use gray-matter to WRITE. */
export function readNote(raw: string): ParsedNote {
  const g = matter(raw)
  return { data: g.data as Record<string, unknown>, body: g.content }
}

/**
 * Set a single frontmatter key while preserving comments, key order, quoting,
 * the body, and the source line ending exactly. Uses the `yaml` Document model
 * (not gray-matter.stringify). The `yaml` serializer always emits LF; when the
 * source frontmatter uses CRLF we re-emit the block (and fences) with CRLF so a
 * `\r\n` file round-trips byte-identical ("bytes round-trip exactly").
 */
export function setFrontmatterKey(raw: string, key: string, value: unknown): string {
  const m = raw.match(FM_RE)
  if (!m) {
    const doc = parseDocument('')
    setKey(doc, key, value)
    const block = doc.toString({ flowCollectionPadding: false }).replace(/\n$/, '')
    return `---\n${block}\n---\n${raw}`
  }
  // Detect the line ending used by the existing frontmatter block.
  const eol = m[0].includes('\r\n') ? '\r\n' : '\n'
  const doc = parseDocument(m[1] ?? '')
  setKey(doc, key, value)
  let block = doc.toString({ flowCollectionPadding: false }).replace(/\n$/, '')
  if (eol === '\r\n') block = block.replace(/\r?\n/g, '\r\n')
  const rest = raw.slice(m[0].length)
  return `---${eol}${block}${eol}---${eol}${rest}`
}

/**
 * Set a key on a yaml Document, force-quoting string values that the YAML-1.1
 * read side (gray-matter/js-yaml) would otherwise coerce away from string
 * (timestamps, `yes`/`no`/...). For all other values we delegate to `doc.set`,
 * which preserves the existing node's style on an in-place update (so the golden
 * no-op round-trip and CRLF tests still hold).
 */
function setKey(doc: ReturnType<typeof parseDocument>, key: string, value: unknown): void {
  if (needsQuoting(value)) {
    // Reuse the existing node when its quoted form already equals the value, so
    // a no-op set stays byte-identical; otherwise emit a double-quoted scalar.
    const existing = doc.get(key, true)
    if (isScalar(existing) && existing.value === value && existing.type === Scalar.QUOTE_DOUBLE) {
      return
    }
    const node = doc.createNode(value)
    ;(node as Scalar).type = Scalar.QUOTE_DOUBLE
    doc.set(key, node)
    return
  }
  doc.set(key, value as never)
}
