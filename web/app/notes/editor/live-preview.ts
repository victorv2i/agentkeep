// Inline "render-in-place" markdown preview for the notes editor.
//
// The editor shows finished markdown wherever the caret is *not*, and falls
// back to raw source the moment the caret (or a selection) lands inside a
// construct so it can be edited. Emphasis/heading/code marks disappear; list
// bullets, task checkboxes, blockquotes, rules, images, tables, plain links,
// and `[[wikilinks]]`/`![[embeds]]` all show as their rendered form.
//
// Design: one `StateField` recomputes the whole decoration set from the syntax
// tree on every relevant transaction. A single tree walk dispatches each node
// to a small handler keyed by node name (see `NODE_HANDLERS`); each handler
// pushes ranges into a shared collector. The collector remembers which ranges
// replace source with an interactive widget so a sibling `atomicRanges` facet
// can make the caret step over them. Recomputing wholesale is cheap here — the
// parse tree is already incremental and notes are small — and it keeps the
// "reveal under caret" logic in exactly one place.
//
// Link resolution is not decided here: whether a `[[target]]` is a real note is
// asked of the injected `isResolved` callback, and every click is forwarded to
// `onWikiLink`/`onMarkdownLink`. This module owns presentation, nothing else.

import { syntaxTree } from '@codemirror/language'
import {
  type EditorState,
  type Extension,
  type Range,
  RangeSet,
  StateField,
  type Transaction,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { findDuplicateTitleLine, frontmatterRange } from './note-shape'

// ─────────────────────────────────────────────────────────────────────────────
// Public contract
// ─────────────────────────────────────────────────────────────────────────────

/** Invoked when the user activates a rendered `[text](url)` link. */
export type MarkdownLinkClick = (url: string) => void

/** A parsed `[[target|alias]]` / `[[target#heading]]` / `![[…]]` reference. */
export interface WikiLinkParts {
  /** Note/file target, stripped of any `#heading` / `^block` suffix. */
  target: string
  /** The trailing anchor, or null when the reference points at a whole note. */
  anchor: { kind: 'heading' | 'block'; value: string } | null
  /** The display text after `|`, or null when none was given. */
  alias: string | null
}

/** Invoked when the user activates a rendered wiki link or embed. */
export type WikiLinkClick = (parts: WikiLinkParts) => void

/** Everything the live preview needs from its host. */
interface LivePreviewOptions {
  onWikiLink: WikiLinkClick
  onMarkdownLink: MarkdownLinkClick
  /** True when a wiki-link target already names a real note. */
  isResolved: (target: string) => boolean
  /** The current editor view, used to dispatch the task-toggle edit. */
  getView: () => EditorView | null
  /** The note's display title, used to dim a redundant leading H1. */
  getTitle: () => string
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection / range geometry
// ─────────────────────────────────────────────────────────────────────────────

/** True when the closed intervals [aFrom,aTo] and [bFrom,bTo] touch or overlap. */
function intervalsTouch(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return aFrom <= bTo && bFrom <= aTo
}

/** True when any selection range intersects [from, to] — i.e. "the caret is here". */
function caretTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => intervalsTouch(from, to, r.from, r.to))
}

// CSS classes shared with theme.ts. Centralised so a rename is one edit.
const CLS = {
  bullet: 'cm-lp-bullet',
  checkbox: 'cm-lp-checkbox',
  taskDone: 'cm-lp-task-done',
  blockquote: 'cm-lp-blockquote',
  hr: 'cm-lp-hr',
  image: 'cm-lp-image',
  embed: 'cm-lp-embed',
  embedIcon: 'cm-lp-embed-icon',
  embedTitle: 'cm-lp-embed-title',
  embedTag: 'cm-lp-embed-tag',
  embedNew: 'cm-lp-embed-new',
  table: 'cm-lp-table',
  frontmatter: 'cm-lp-frontmatter',
  dupTitle: 'cm-lp-dup-title',
  lineHidden: 'cm-lp-line-hidden',
  wikiLink: 'cm-wikilink',
  wikiLinkNew: 'cm-wikilink-new',
  link: 'cm-lp-link',
} as const

// Reused zero-cost decorations.
const REMOVE = Decoration.replace({}) // collapse a source span to nothing
const HIDE_LINE = Decoration.line({ class: CLS.lineHidden }) // drop a whole line

// ─────────────────────────────────────────────────────────────────────────────
// Decoration collector
// ─────────────────────────────────────────────────────────────────────────────

// Building both the visible decoration set and the atomic-range set in the same
// pass avoids walking the tree twice. The collector records every range, and
// separately the subset that is an interactive widget replacement (so arrow
// keys can skip those — but not, say, a hidden mark or a line class).
class Collector {
  readonly decorations: Range<Decoration>[] = []
  readonly atomic: Range<Decoration>[] = []

  /** Hide a source span (no widget, no height change on its own). */
  conceal(from: number, to: number): void {
    if (to > from) this.decorations.push(REMOVE.range(from, to))
  }

  /** Add a line-level class (bullet indent, blockquote tint, frontmatter, …). */
  lineClass(deco: Decoration, lineFrom: number): void {
    this.decorations.push(deco.range(lineFrom))
  }

  /** Add an inline mark (e.g. strike-through of a finished task). */
  mark(deco: Decoration, from: number, to: number): void {
    this.decorations.push(deco.range(from, to))
  }

  /**
   * Replace [from, to] with a widget. When `atomicStep` is set the range also
   * joins the atomic set so the caret jumps over it instead of into it.
   */
  widget(deco: Decoration, from: number, to: number, atomicStep: boolean): void {
    const r = deco.range(from, to)
    this.decorations.push(r)
    if (atomicStep) this.atomic.push(r)
  }

  /** Place a zero-width or block widget at a single offset. */
  point(deco: Decoration, at: number): void {
    this.decorations.push(deco.range(at))
  }

  /**
   * Conceal a (possibly multi-line) source range so the line that hosts a block
   * widget survives in the DOM while the rest collapses. A single multi-line
   * `replace` would behave as one atom and swallow caret entry from below; doing
   * it line-by-line keeps every line independently addressable. `keepLine`
   * picks which boundary line stays visible to host the widget.
   */
  concealBlock(
    state: EditorState,
    from: number,
    to: number,
    keepLine: 'first' | 'last',
  ): void {
    const firstLine = state.doc.lineAt(from)
    const lastLine = state.doc.lineAt(to)
    if (firstLine.number === lastLine.number) {
      this.conceal(from, to)
      return
    }
    // First line.
    if (keepLine === 'first') this.conceal(from, firstLine.to)
    else if (from === firstLine.from) this.lineClass(HIDE_LINE, firstLine.from)
    else this.conceal(from, firstLine.to)
    // Interior lines always vanish entirely.
    for (let n = firstLine.number + 1; n < lastLine.number; n++) {
      this.lineClass(HIDE_LINE, state.doc.line(n).from)
    }
    // Last line.
    if (keepLine === 'last') this.conceal(lastLine.from, to)
    else if (to === lastLine.to) this.lineClass(HIDE_LINE, lastLine.from)
    else this.conceal(lastLine.from, to)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Widgets
// ─────────────────────────────────────────────────────────────────────────────

/** A muted • standing in for a `-`/`*`/`+` list marker. */
class BulletWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const dot = document.createElement('span')
    dot.className = CLS.bullet
    dot.textContent = '•' // • BULLET
    return dot
  }
}

/** A thematic-break rule replacing `---` / `***` / `___`. */
class RuleWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const box = document.createElement('span')
    box.className = CLS.hr
    box.appendChild(document.createElement('hr'))
    return box
  }
}

/**
 * A real checkbox for a `[ ]` / `[x]` task. Clicking it rewrites the bracket
 * character through a normal editor transaction, so the change saves on the
 * same path as any keystroke. The widget never lets the click reach CodeMirror
 * (which would move the caret into the now-replaced range and tear the widget
 * down before the toggle runs).
 */
class TaskBoxWidget extends WidgetType {
  private root?: HTMLElement
  constructor(
    private readonly done: boolean,
    private readonly seedPos: number, // best-guess offset of the inner bracket char
    private readonly getView: () => EditorView | null,
  ) {
    super()
  }
  eq(other: TaskBoxWidget): boolean {
    return other.done === this.done && other.seedPos === this.seedPos
  }
  toDOM(): HTMLElement {
    const root = document.createElement('span')
    root.className = CLS.checkbox
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = this.done
    // Swallow the press itself; act on release so a drag-off cancels naturally.
    const swallow = (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
    }
    input.addEventListener('mousedown', swallow)
    input.addEventListener('click', swallow)
    const toggle = (e: Event) => {
      e.stopPropagation()
      const view = this.getView()
      // Re-resolve the live position: the document may have shifted since this
      // widget was built. Fall back to the seed offset if the DOM lookup fails.
      let pos = this.seedPos
      if (view && this.root) {
        try {
          pos = view.posAtDOM(this.root, 0) + 1
        } catch {
          /* keep seedPos */
        }
      }
      flipTaskBox(view, pos)
    }
    input.addEventListener('mouseup', toggle)
    input.addEventListener('keydown', (e) => {
      if (!isActivationKey(e)) return
      e.preventDefault()
      toggle(e)
    })
    root.appendChild(input)
    this.root = root
    return root
  }
  // Default ignoreEvent (true): clicks inside stay ours, never CodeMirror's.
}

/** An <img> for `![alt](url)` and `![[image.ext]]`. */
class ImageWidget extends WidgetType {
  constructor(
    private readonly src: string,
    private readonly alt: string,
  ) {
    super()
  }
  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt
  }
  toDOM(): HTMLElement {
    const box = document.createElement('span')
    box.className = CLS.image
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    if (this.alt) img.title = this.alt
    // Remote http(s)/data image URLs go straight to the source server/embed —
    // never leak the vault note's path/referrer to it. Local vault images go
    // through our own /api/image route, so no cross-origin referrer applies.
    if (/^(https?:|data:)/i.test(this.src)) img.referrerPolicy = 'no-referrer'
    box.appendChild(img)
    return box
  }
  ignoreEvent(): boolean {
    return false
  }
}

// Schemes a rendered `<a href>` is allowed to navigate to directly. Anything
// else (javascript:, data:, vbscript:, file:, ...) must never reach a live
// href — a click is fully intercepted by our own handler below (never the
// browser's default navigation), but the href is also what a user sees via
// hover/copy-link/middle-click/drag, so it must be inert for those paths too.
const SAFE_LINK_SCHEME_RE = /^(https?|mailto):/i
// A scheme-qualified URL (`foo:bar`) that ISN'T one of the safe schemes above.
// A bare relative/internal target (`notes/foo`, `#heading`, `foo.md`) has no
// scheme prefix and is intentionally left alone — those are resolved by
// `onClick` (open the note / prompt to create it), not by the anchor's href.
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

/**
 * Pure helper: the `href` attribute value to actually put on the rendered
 * anchor for a markdown `[text](url)` link. Safe schemes (http/https/mailto)
 * and scheme-less (relative/internal) targets pass through unchanged; any
 * other scheme (javascript:, data:, vbscript:, file:, ...) is rendered inert
 * (`#`) so it is never a live, navigable href.
 */
export function sanitizeLinkHref(url: string): string {
  if (HAS_SCHEME_RE.test(url) && !SAFE_LINK_SCHEME_RE.test(url)) return '#'
  return url
}

/** A clickable inline link replacing `[text](url)`. */
class LinkWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly url: string,
    private readonly onClick: MarkdownLinkClick,
  ) {
    super()
  }
  eq(other: LinkWidget): boolean {
    return other.text === this.text && other.url === this.url
  }
  toDOM(): HTMLElement {
    const a = document.createElement('a')
    a.className = CLS.link
    a.textContent = this.text
    a.href = sanitizeLinkHref(this.url)
    a.title = this.url
    if (/^https?:\/\//i.test(this.url) || this.url.startsWith('mailto:')) {
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
    }
    a.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    a.addEventListener('click', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      this.onClick(this.url)
    })
    return a
  }
  ignoreEvent(): boolean {
    return false
  }
}

/** A pill replacing a `[[wikilink]]`; dashed/dim when the target is uncreated. */
class WikiLinkWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly parts: WikiLinkParts,
    private readonly resolved: boolean,
    private readonly onClick: WikiLinkClick,
  ) {
    super()
  }
  eq(other: WikiLinkWidget): boolean {
    return (
      other.text === this.text &&
      other.resolved === this.resolved &&
      sameParts(other.parts, this.parts)
    )
  }
  toDOM(): HTMLElement {
    const pill = document.createElement('span')
    pill.className = this.resolved ? CLS.wikiLink : `${CLS.wikiLink} ${CLS.wikiLinkNew}`
    pill.textContent = this.text
    pill.setAttribute('role', 'link')
    pill.setAttribute('tabindex', '0')
    pill.title = this.resolved ? this.parts.target : `${this.parts.target} (not yet a note)`
    pill.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    pill.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.onClick(this.parts)
    })
    pill.addEventListener('keydown', (e) => onKeyboardActivate(e, () => this.onClick(this.parts)))
    return pill
  }
  ignoreEvent(): boolean {
    return false
  }
}

/** A bordered card replacing a `![[note]]` / `![[note#heading]]` transclusion. */
class EmbedCardWidget extends WidgetType {
  constructor(
    private readonly parts: WikiLinkParts,
    private readonly resolved: boolean,
    private readonly onClick: WikiLinkClick,
  ) {
    super()
  }
  eq(other: EmbedCardWidget): boolean {
    return other.resolved === this.resolved && sameParts(other.parts, this.parts)
  }
  toDOM(): HTMLElement {
    const card = document.createElement('span')
    card.className = this.resolved ? CLS.embed : `${CLS.embed} ${CLS.embedNew}`
    const icon = document.createElement('span')
    icon.className = CLS.embedIcon
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 14 14')
    svg.setAttribute('width', '14')
    svg.setAttribute('height', '14')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.3')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.setAttribute('aria-hidden', 'true')
    const top = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    top.setAttribute('d', 'M3 4.5h8')
    const mid = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    mid.setAttribute('d', 'M3 7h8')
    const bot = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    bot.setAttribute('d', 'M3 9.5h5.5')
    svg.append(top, mid, bot)
    icon.append(svg)
    const title = document.createElement('span')
    title.className = CLS.embedTitle
    title.textContent = this.parts.anchor
      ? `${this.parts.target} / ${this.parts.anchor.value}`
      : this.parts.target
    const tag = document.createElement('span')
    tag.className = CLS.embedTag
    tag.textContent = this.resolved ? 'embed' : 'embed · not yet a note'
    card.append(icon, title, tag)
    card.setAttribute('role', 'link')
    card.setAttribute('tabindex', '0')
    card.title = `Open ${this.parts.target}`
    card.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    card.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.onClick(this.parts)
    })
    card.addEventListener('keydown', (e) => onKeyboardActivate(e, () => this.onClick(this.parts)))
    return card
  }
  ignoreEvent(): boolean {
    return false
  }
}

type ColumnAlign = 'left' | 'center' | 'right' | null

/** A rendered HTML table replacing GFM pipe-table source. */
class TableWidget extends WidgetType {
  constructor(
    private readonly header: string[],
    private readonly body: string[][],
    private readonly aligns: ColumnAlign[],
    private readonly source: string, // identity key for cheap eq()
  ) {
    super()
  }
  eq(other: TableWidget): boolean {
    return other.source === this.source
  }
  toDOM(): HTMLElement {
    const box = document.createElement('div')
    box.className = CLS.table
    const table = document.createElement('table')

    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    this.header.forEach((cell, i) => {
      const th = document.createElement('th')
      th.textContent = cell
      const a = this.aligns[i]
      if (a) th.style.textAlign = a
      headRow.appendChild(th)
    })
    thead.appendChild(headRow)
    table.appendChild(thead)

    const tbody = document.createElement('tbody')
    for (const row of this.body) {
      const tr = document.createElement('tr')
      row.forEach((cell, i) => {
        const td = document.createElement('td')
        td.textContent = cell
        const a = this.aligns[i]
        if (a) td.style.textAlign = a
        tr.appendChild(td)
      })
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)

    box.appendChild(table)
    return box
  }
  ignoreEvent(): boolean {
    return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Small shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Structural equality for two {@link WikiLinkParts} (anchors compared deeply). */
function sameParts(a: WikiLinkParts, b: WikiLinkParts): boolean {
  if (a.target !== b.target || a.alias !== b.alias) return false
  if (a.anchor === null || b.anchor === null) return a.anchor === b.anchor
  return a.anchor.kind === b.anchor.kind && a.anchor.value === b.anchor.value
}

function isActivationKey(event: KeyboardEvent): boolean {
  return event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar'
}

function onKeyboardActivate(event: KeyboardEvent, activate: () => void): void {
  if (!isActivationKey(event)) return
  event.preventDefault()
  event.stopPropagation()
  activate()
}

/** Toggle the `[ ]`↔`[x]` on the task line containing `pos`, via a real edit. */
function flipTaskBox(view: EditorView | null, pos: number): void {
  if (!view || view.state.readOnly) return
  const line = view.state.doc.lineAt(pos)
  const m = /\[( |x|X)]/.exec(line.text)
  if (!m) return
  const charPos = line.from + m.index + 1 // the space/x between the brackets
  view.dispatch({
    changes: { from: charPos, to: charPos + 1, insert: m[1] === ' ' ? 'x' : ' ' },
    userEvent: 'input',
  })
}

/** Resolve a markdown image URL to a fetchable src (remote/data pass through). */
function toImageSrc(rawUrl: string): string {
  const url = rawUrl.trim()
  if (/^https?:\/\//i.test(url) || url.startsWith('data:')) return url
  // Local vault paths go through the path-guarded route; decode %20 etc. so the
  // on-disk lookup matches, and drop a leading `./`.
  const relative = decodeURI(url.replace(/^\.\//, ''))
  return `/api/image?path=${encodeURIComponent(relative)}`
}

/** Map a basename embed (`![[pic.png]]`) to its served src. */
function embedImageSrc(target: string): string {
  return `/api/image?path=${encodeURIComponent(target)}`
}

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i

/** Split a wiki-link target into its base note name and trailing anchor. */
function splitTarget(raw: string): Pick<WikiLinkParts, 'target' | 'anchor'> {
  const hashAt = raw.indexOf('#')
  const caretAt = raw.indexOf('^')
  // `#heading` wins when it comes first (a `^` after it is part of the heading).
  if (hashAt !== -1 && (caretAt === -1 || hashAt < caretAt)) {
    return {
      target: raw.slice(0, hashAt).trim(),
      anchor: { kind: 'heading', value: raw.slice(hashAt + 1).trim() },
    }
  }
  if (caretAt !== -1) {
    return {
      target: raw.slice(0, caretAt).trim(),
      anchor: { kind: 'block', value: raw.slice(caretAt + 1).trim() },
    }
  }
  return { target: raw.trim(), anchor: null }
}

/** Read a column's alignment from a `:---:`-style delimiter cell. */
function alignOf(cell: string): ColumnAlign {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
}

/** Extract header text, body rows, and per-column alignment from a Table node. */
function readTable(
  state: EditorState,
  node: SyntaxNode,
): { header: string[]; body: string[][]; aligns: ColumnAlign[] } | null {
  const headerNode = node.getChild('TableHeader')
  if (!headerNode) return null
  const cellsOf = (n: SyntaxNode) =>
    n.getChildren('TableCell').map((c) => state.sliceDoc(c.from, c.to).trim())

  const header = cellsOf(headerNode)
  const body = node.getChildren('TableRow').map(cellsOf)

  // The alignment row is the one TableDelimiter node whose text holds dashes
  // (the per-cell `|` separators are also TableDelimiter nodes, but dash-free).
  let aligns: ColumnAlign[] = header.map(() => null)
  for (const delim of node.getChildren('TableDelimiter')) {
    const raw = state.sliceDoc(delim.from, delim.to)
    if (!raw.includes('-')) continue
    aligns = raw
      .split('|')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(alignOf)
    break
  }
  return { header, body, aligns }
}

/** The width, in source columns, that a list item's marker zone occupies. */
function markerZoneWidth(item: SyntaxNode, lineStart: number): number {
  const mark = item.firstChild
  if (!mark || mark.name !== 'ListMark') return 0
  const indent = mark.from - lineStart
  const markLen = mark.to - mark.from
  // A `[ ]`/`[x]` task marker plus its trailing space widens the zone.
  const taskMarker = item.getChild('Task')?.getChild('TaskMarker')
  const taskLen = taskMarker ? taskMarker.to - taskMarker.from + 1 : 0
  return indent + markLen + 1 + taskLen
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-node handlers
// ─────────────────────────────────────────────────────────────────────────────

// Context passed to every handler. `inFrontmatter` short-circuits constructs
// that are really YAML data (a `---` fence, a `- ` sequence item, …).
interface Ctx {
  state: EditorState
  out: Collector
  opts: LivePreviewOptions
  inFrontmatter: (from: number) => boolean
}

// A handler returns nothing; it pushes into ctx.out. The map is keyed by the
// exact Lezer node name. Inline-mark hiding for emphasis/code is folded into the
// emphasis/code handlers so the whole tree is handled in this one table.
type NodeHandler = (node: SyntaxNode, ctx: Ctx) => void

const MARK_CHILD_NAMES = new Set(['EmphasisMark', 'CodeMark', 'StrikethroughMark'])

/** Hide the punctuation marks inside an emphasis/code/strike span. */
function hideInlineMarks(node: SyntaxNode, ctx: Ctx): void {
  if (caretTouches(ctx.state, node.from, node.to)) return
  let child = node.firstChild
  while (child) {
    if (MARK_CHILD_NAMES.has(child.name)) ctx.out.conceal(child.from, child.to)
    child = child.nextSibling
  }
}

const handleHeading: NodeHandler = (node, { state, out }) => {
  if (caretTouches(state, node.from, node.to)) return
  // The leading `#`s are their own node; hide it plus the following space.
  const headerMark = node.firstChild
  if (!headerMark || headerMark.name !== 'HeaderMark') return
  let end = headerMark.to
  if (end < node.to && state.sliceDoc(end, end + 1) === ' ') end += 1
  out.conceal(node.from, end)
}

const handleListItem: NodeHandler = (node, { state, out, inFrontmatter }) => {
  if (inFrontmatter(node.from)) return
  // Hanging indent: pad every line the item spans by its marker width and pull
  // the first line back, so wrapped and nested text lines up under the content.
  const width = markerZoneWidth(node, state.doc.lineAt(node.from).from)
  if (width <= 0) return
  const style = `padding-left:${width}ch;text-indent:-${width}ch`
  const lineDeco = Decoration.line({ attributes: { style } })
  const first = state.doc.lineAt(node.from).number
  const last = state.doc.lineAt(node.to).number
  for (let n = first; n <= last; n++) out.lineClass(lineDeco, state.doc.line(n).from)
}

const handleListMark: NodeHandler = (node, { state, out, inFrontmatter }) => {
  if (inFrontmatter(node.from)) return
  if (caretTouches(state, node.from, node.to)) return
  // Ordered-list numbers stay as text; only bullet markers become a •.
  if (!/^[-+*]/.test(state.sliceDoc(node.from, node.to))) return
  // A task item's marker is replaced by the checkbox, so just hide the bullet
  // glyph there rather than doubling up.
  if (node.parent?.getChild('Task')) {
    out.conceal(node.from, node.to)
    return
  }
  out.widget(Decoration.replace({ widget: new BulletWidget() }), node.from, node.to, false)
}

const handleTask: NodeHandler = (node, { state, out, opts, inFrontmatter }) => {
  if (inFrontmatter(node.from)) return
  const marker = node.getChild('TaskMarker')
  if (!marker) return
  const raw = state.sliceDoc(marker.from, marker.to) // `[ ]` / `[x]` / `[X]`
  const done = raw === '[x]' || raw === '[X]'
  if (caretTouches(state, marker.from, marker.to)) return // editable under caret
  out.widget(
    Decoration.replace({ widget: new TaskBoxWidget(done, marker.from + 1, opts.getView) }),
    marker.from,
    marker.to,
    true,
  )
  if (!done) return
  // Strike the body text after the marker (skipping the gap) when uncovered.
  let strikeFrom = marker.to
  while (strikeFrom < node.to && ' \t'.includes(state.sliceDoc(strikeFrom, strikeFrom + 1))) {
    strikeFrom += 1
  }
  if (strikeFrom < node.to && !caretTouches(state, strikeFrom, node.to)) {
    out.mark(Decoration.mark({ class: CLS.taskDone }), strikeFrom, node.to)
  }
}

const handleQuoteMark: NodeHandler = (node, { state, out }) => {
  if (caretTouches(state, node.from, node.to)) return
  out.conceal(node.from, node.to)
  out.lineClass(Decoration.line({ class: CLS.blockquote }), node.from)
}

const handleHorizontalRule: NodeHandler = (node, { state, out, inFrontmatter }) => {
  // A `---` opening/closing the frontmatter is a fence, not a thematic break.
  if (inFrontmatter(node.from)) return
  if (caretTouches(state, node.from, node.to)) return
  out.widget(Decoration.replace({ widget: new RuleWidget() }), node.from, node.to, true)
}

const handleImage: NodeHandler = (node, { state, out }) => {
  if (caretTouches(state, node.from, node.to)) return
  const urlNode = node.getChild('URL')
  if (!urlNode) return
  const url = state.sliceDoc(urlNode.from, urlNode.to)
  // alt text is between the opening `![` and the first following LinkMark (`]`).
  const altFrom = node.from + 2
  const closing = node.getChildren('LinkMark').find((mk) => mk.from >= altFrom)
  const alt = closing ? state.sliceDoc(altFrom, closing.from) : ''
  out.widget(
    Decoration.replace({ widget: new ImageWidget(toImageSrc(url), alt) }),
    node.from,
    node.to,
    true,
  )
}

const handleLink: NodeHandler = (node, { state, out, opts }) => {
  if (caretTouches(state, node.from, node.to)) return
  const urlNode = node.getChild('URL')
  if (!urlNode) return
  const url = state.sliceDoc(urlNode.from, urlNode.to)
  const marks = node.getChildren('LinkMark')
  if (marks.length < 2) return
  const textFrom = marks[0]!.to // just past the opening `[`
  const closeBracket = marks.find(
    (mk) => mk.from >= textFrom && state.sliceDoc(mk.from, mk.to) === ']',
  )
  if (!closeBracket) return
  const textTo = closeBracket.from
  if (textTo <= textFrom) return // empty `[]()` link text → leave raw, don't vanish
  const text = state.sliceDoc(textFrom, textTo)
  out.conceal(node.from, textFrom) // `[`
  out.widget(
    Decoration.replace({ widget: new LinkWidget(text, url, opts.onMarkdownLink) }),
    textFrom,
    textTo,
    true,
  )
  out.conceal(textTo, node.to) // `](url)`
}

const handleTable: NodeHandler = (node, { state, out }) => {
  if (caretTouches(state, node.from, node.to)) return
  const model = readTable(state, node)
  if (!model) return
  const source = state.sliceDoc(node.from, node.to)
  // Collapse the raw rows, keep the first line to host a block-level widget.
  out.concealBlock(state, node.from, node.to, 'first')
  out.point(
    Decoration.widget({
      widget: new TableWidget(model.header, model.body, model.aligns, source),
      block: true,
      side: -1,
    }),
    node.from,
  )
}

const handleWikiLink: NodeHandler = (node, { state, out, opts }) => {
  if (caretTouches(state, node.from, node.to)) return // raw under caret
  const pageNode = node.getChild('WikiLinkPage')
  if (!pageNode) return
  const rawTarget = state.sliceDoc(pageNode.from, pageNode.to).trim()
  if (rawTarget === '') return
  const aliasNode = node.getChild('WikiLinkAlias')
  const alias = aliasNode ? state.sliceDoc(aliasNode.from, aliasNode.to).trim() : null

  // An embed (`![[…]]`) opens with a length-3 mark; a plain link with length-2.
  const opener = node.getChild('WikiLinkMark')
  const isEmbed = opener ? state.sliceDoc(opener.from, opener.to).startsWith('!') : false

  const { target, anchor } = splitTarget(rawTarget)
  const parts: WikiLinkParts = { target, anchor, alias }

  if (isEmbed && IMAGE_EXTENSION.test(target)) {
    out.widget(
      Decoration.replace({ widget: new ImageWidget(embedImageSrc(target), alias ?? target) }),
      node.from,
      node.to,
      true,
    )
    return
  }
  if (isEmbed) {
    out.widget(
      Decoration.replace({ widget: new EmbedCardWidget(parts, opts.isResolved(target), opts.onWikiLink) }),
      node.from,
      node.to,
      true,
    )
    return
  }
  const label = alias ?? (anchor ? `${target} / ${anchor.value}` : target)
  out.widget(
    Decoration.replace({ widget: new WikiLinkWidget(label, parts, opts.isResolved(target), opts.onWikiLink) }),
    node.from,
    node.to,
    true,
  )
}

// The dispatch table. Emphasis/code/strike share one mark-hiding handler.
const NODE_HANDLERS: Record<string, NodeHandler> = {
  Emphasis: hideInlineMarks,
  StrongEmphasis: hideInlineMarks,
  InlineCode: hideInlineMarks,
  Strikethrough: hideInlineMarks,
  ListItem: handleListItem,
  ListMark: handleListMark,
  Task: handleTask,
  QuoteMark: handleQuoteMark,
  HorizontalRule: handleHorizontalRule,
  Image: handleImage,
  Link: handleLink,
  Table: handleTable,
  WikiLink: handleWikiLink,
}

// ATXHeading1..6 carry a numeric suffix, so they need a prefix test rather than
// a direct map lookup.
function handlerFor(name: string): NodeHandler | undefined {
  if (name.startsWith('ATXHeading')) return handleHeading
  return NODE_HANDLERS[name]
}

// ─────────────────────────────────────────────────────────────────────────────
// The single decoration builder
// ─────────────────────────────────────────────────────────────────────────────

function buildAll(state: EditorState, opts: LivePreviewOptions): Collector {
  const out = new Collector()
  const fm = frontmatterRange(state)
  const inFrontmatter = (from: number) => fm !== null && from < fm.to
  const ctx: Ctx = { state, out, opts, inFrontmatter }

  // Frontmatter: dim every line of the YAML block as a quiet mono panel. The
  // markdown parser has no frontmatter concept (it reads the fences as a rule +
  // setext heading), so we tag the lines ourselves and the handlers above skip
  // anything inside the block.
  if (fm) {
    const lastLine = state.doc.lineAt(fm.to).number
    const fmLine = Decoration.line({ class: CLS.frontmatter })
    for (let n = 1; n <= lastLine; n++) out.lineClass(fmLine, state.doc.line(n).from)
  }

  // Duplicate leading H1: when the body opens with `# Title` matching the pane
  // header, dim that one line (presentation only) unless the caret is on it.
  const dup = findDuplicateTitleLine(state, opts.getTitle())
  if (dup && !caretTouches(state, dup.from, dup.to)) {
    out.lineClass(Decoration.line({ class: CLS.dupTitle }), dup.from)
  }

  // One walk over the tree, dispatching each node to its handler.
  syntaxTree(state).iterate({
    enter: (n) => {
      handlerFor(n.name)?.(n.node, ctx)
    },
  })

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// State field + atomic ranges + bundle
// ─────────────────────────────────────────────────────────────────────────────

// We stash both sets in the field value so the atomic-range facet can read the
// same computation the decorations came from (no second tree walk).
interface FieldValue {
  decorations: DecorationSet
  atomic: RangeSet<Decoration>
}

function makeFieldValue(state: EditorState, opts: LivePreviewOptions): FieldValue {
  const collected = buildAll(state, opts)
  return {
    decorations: Decoration.set(collected.decorations, true),
    atomic: RangeSet.of(collected.atomic, true),
  }
}

export function livePreview(opts: LivePreviewOptions): Extension {
  const field = StateField.define<FieldValue>({
    create: (state) => makeFieldValue(state, opts),
    update(value, tr: Transaction) {
      // During IME composition, keep the rendered set steady (just remap
      // positions) so half-formed characters don't flicker the preview.
      if (tr.isUserEvent('input.type.compose')) {
        if (!tr.docChanged) return value
        return {
          decorations: value.decorations.map(tr.changes),
          atomic: value.atomic.map(tr.changes),
        }
      }
      // Pure pointer-drag selections recompute the caret-driven reveal so a
      // click into a construct shows its source immediately.
      if (!tr.docChanged && !tr.selection) return value
      return makeFieldValue(tr.state, opts)
    },
    provide: (f) => [
      EditorView.decorations.from(f, (v) => v.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
    ],
  })
  return field
}
