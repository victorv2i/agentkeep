// Markdown language for the notes editor.
//
// `@codemirror/lang-markdown` ships CommonMark; this module layers GFM on top
// and teaches the inline parser two Obsidian constructs the base grammar does
// not know about:
//
//   * `[[target]]`, `[[target|alias]]`, and the `![[…]]` embed variant — so the
//     resolution target and the optional display alias each become their own
//     node in the syntax tree.
//   * `#tag` (with `nested/paths`) — so a hashtag is one addressable node.
//
// Giving these constructs real tree nodes means the single incremental parse
// drives everything downstream: the highlight theme (via the exported tags),
// the live-preview decorations (which walk the tree), and `[[` autocomplete.
//
// Link *resolution* is intentionally not the parser's concern — this file only
// shapes the tree. Turning a target into a vault note happens elsewhere
// (`web/lib/vault.ts`, Obsidian basename resolution).

import { markdown } from '@codemirror/lang-markdown'
import type { Language } from '@codemirror/language'
import { Tag, styleTags } from '@lezer/highlight'
import { GFM } from '@lezer/markdown'
import type { InlineContext, MarkdownConfig } from '@lezer/markdown'

// Highlight tags the theme keys off of. Exported so `theme.ts` can colour the
// link body, the `[[`/`]]`/`|` punctuation, and hashtags independently.
export const WikiLinkTag = Tag.define()
export const WikiLinkMarkTag = Tag.define()
export const HashtagTag = Tag.define()

// Tree node names. The live-preview engine and the highlighter both look these
// up by string, so they are part of this module's contract.
const NODE_WIKI = 'WikiLink'
const NODE_WIKI_PAGE = 'WikiLinkPage'
const NODE_WIKI_ALIAS = 'WikiLinkAlias'
const NODE_WIKI_MARK = 'WikiLinkMark'
const NODE_HASHTAG = 'Hashtag'

// Character codes used by the inline parsers (the markdown engine hands us the
// next code point, so comparing codes avoids per-char string allocation).
const CH_BANG = 33 // !
const CH_HASH = 35 // #
const CH_OPEN_BRACKET = 91 // [

// `[[target]]` / `[[target|alias]]` / `![[target]]`. Captures, in order: an
// optional embed bang, the target (anything up to `]`, `|`, or end), and an
// optional `|alias` (anything up to the closing `]]`). The target may be empty
// (`[[]]`) — we still emit the node so the cursor has something to sit in.
const WIKI_PATTERN = /^(!?)\[\[([^\]|\n]*)(?:\|([^\]\n]*))?]]/

// `#tag`, optionally with `/`- or `-`-joined segments. The first char after `#`
// must be a letter, digit, or underscore so a bare `#` or `# heading` is not a
// tag.
const HASHTAG_PATTERN = /^#[\p{L}\p{N}_][\p{L}\p{N}_/-]*/u

/**
 * Emit the child nodes of a wiki link given the slice positions of its pieces.
 * Splitting this out keeps {@link parseWikiLink} readable: it computes offsets,
 * this turns them into tree elements.
 */
function wikiLinkChildren(
  cx: InlineContext,
  start: number,
  openLen: number, // length of the `[[` or `![[` opener
  targetLen: number, // chars in the target slice (may be 0)
  aliasLen: number | null, // chars in the alias slice, or null when no `|`
  end: number,
) {
  const targetStart = start + openLen
  const targetEnd = targetStart + targetLen
  const children = [
    cx.elt(NODE_WIKI_MARK, start, targetStart), // `[[` / `![[`
    cx.elt(NODE_WIKI_PAGE, targetStart, targetEnd), // resolution target
  ]
  if (aliasLen !== null) {
    const pipe = targetEnd // the `|` sits immediately after the target
    children.push(cx.elt(NODE_WIKI_MARK, pipe, pipe + 1))
    children.push(cx.elt(NODE_WIKI_ALIAS, pipe + 1, pipe + 1 + aliasLen))
  }
  children.push(cx.elt(NODE_WIKI_MARK, end - 2, end)) // closing `]]`
  return children
}

/** Inline parser for `[[wikilinks]]` and `![[embeds]]`. */
function parseWikiLink(cx: InlineContext, next: number, pos: number): number {
  // Cheap rejection before touching the regex: a wiki link can only begin with
  // `[` (plain) or `!` (embed).
  if (next !== CH_OPEN_BRACKET && next !== CH_BANG) return -1

  const m = WIKI_PATTERN.exec(cx.slice(pos, cx.end))
  if (!m) return -1

  const [whole, bang, target, alias] = m
  const openLen = bang.length + 2 // `[[` is 2, `![[` is 3
  const end = pos + whole.length

  return cx.addElement(
    cx.elt(
      NODE_WIKI,
      pos,
      end,
      wikiLinkChildren(cx, pos, openLen, target.length, alias === undefined ? null : alias.length, end),
    ),
  )
}

/** Inline parser for `#hashtags`. */
function parseHashtag(cx: InlineContext, next: number, pos: number): number {
  if (next !== CH_HASH) return -1

  // A `#` glued to the end of a word is not a tag (e.g. `issue#42`, `a#b`); a
  // tag must stand on its own. Look one char back to enforce that.
  if (pos > 0 && /[\p{L}\p{N}]/u.test(cx.slice(pos - 1, pos))) return -1

  const m = HASHTAG_PATTERN.exec(cx.slice(pos, cx.end))
  if (!m) return -1

  return cx.addElement(cx.elt(NODE_HASHTAG, pos, pos + m[0].length))
}

// The combined extension: node declarations, the two inline parsers, and the
// highlight mapping. Running both parsers `after: 'Emphasis'` lets the built-in
// emphasis/code rules win first, so a `#` inside `**bold**` still parses as
// emphasis text rather than swallowing the construct.
const wikiExtension: MarkdownConfig = {
  defineNodes: [
    { name: NODE_WIKI },
    { name: NODE_WIKI_PAGE },
    { name: NODE_WIKI_ALIAS },
    { name: NODE_WIKI_MARK },
    { name: NODE_HASHTAG },
  ],
  parseInline: [
    { name: NODE_WIKI, parse: parseWikiLink, after: 'Emphasis' },
    { name: NODE_HASHTAG, parse: parseHashtag, after: 'Emphasis' },
  ],
  props: [
    styleTags({
      [`${NODE_WIKI_PAGE} ${NODE_WIKI_ALIAS}`]: WikiLinkTag,
      [NODE_WIKI_MARK]: WikiLinkMarkTag,
      [NODE_HASHTAG]: HashtagTag,
    }),
  ],
}

/**
 * The editor's markdown {@link Language}: CommonMark + GFM (tables, task lists,
 * strikethrough, …) plus the wiki-link and hashtag nodes above. GFM is required
 * explicitly — without it the tree carries no `Table`/`Task` nodes for the
 * live-preview to render.
 */
export function extendedMarkdownLanguage(): Language {
  return markdown({ extensions: [GFM, wikiExtension] }).language
}
