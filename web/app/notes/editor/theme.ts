// CodeMirror 6 theme + syntax highlighting tuned to the app's "Reading Room"
// language: transparent editor bg over the warm page, reading-lamp green
// cursor/selection/links, readable ink body. Tokens mirror
// globals.css (--acc green, --ink/--mut/--faint).

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { EditorView } from '@codemirror/view'
import { WikiLinkTag, WikiLinkMarkTag, HashtagTag } from './wikilink-lang'

// Drive the editor palette from the SAME CSS vars as globals.css (--acc/--ink/
// --mut/--faint, and --accg = the accent rgb triplet for tints). They cascade
// from <html data-theme>, so the editor re-colors on a light/dark toggle with
// no remount — the values below are just references, resolved at paint time.
const ACCENT = 'var(--acc)'
const INK = 'var(--ink)'
const MUT = 'var(--mut)'
const FAINT = 'var(--faint)'

const editorTheme = EditorView.theme(
  {
    '&': {
      color: INK,
      backgroundColor: 'transparent',
      fontSize: '15px',
      height: '100%',
    },
    '.cm-scroller': {
      fontFamily: 'var(--font-geist), system-ui, sans-serif',
      lineHeight: '1.7',
      padding: '8px 0 80px',
    },
    '.cm-content': { caretColor: ACCENT, maxWidth: '720px' },
    '&.cm-focused .cm-cursor': { borderLeftColor: ACCENT },
    '.cm-cursor': { borderLeftColor: ACCENT },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'rgba(var(--accg),0.18)',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(var(--accg), 0.05)' },
    '.cm-gutters': { display: 'none' },
    '&.cm-editor.cm-focused': { outline: 'none' },
    '.cm-line': { padding: '0 2px' },
    // The collapsed wikilink pill (rendered by the live-preview widget).
    '.cm-wikilink': {
      color: ACCENT,
      cursor: 'pointer',
      borderBottom: '1px solid rgba(var(--accg),0.35)',
    },
    '.cm-wikilink:hover': { borderBottomColor: ACCENT },
    '.cm-wikilink:focus-visible, .cm-lp-link:focus-visible, .cm-lp-embed:focus-visible': {
      outline: '2px solid var(--acc)',
      outlineOffset: '3px',
      borderRadius: '3px',
    },
    // An unresolved (uncreated) link reads as a placeholder — dimmer + dashed.
    '.cm-wikilink-new': {
      color: FAINT,
      borderBottom: '1px dashed var(--faint)',
    },
    // The autocomplete popover, themed to the panels.
    '.cm-tooltip.cm-tooltip-autocomplete': {
      backgroundColor: 'var(--panel)',
      border: '1px solid var(--line-2)',
      borderRadius: '3px',
      boxShadow: 'var(--lift)',
    },
    '.cm-tooltip-autocomplete > ul > li': {
      fontFamily: 'var(--font-geist), system-ui, sans-serif',
      padding: '5px 12px',
      color: MUT,
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'rgba(var(--accg),0.12)',
      color: INK,
    },
    '.cm-completionDetail': { color: FAINT, fontStyle: 'normal', marginLeft: '8px' },

    // ── live-preview rendered elements ──────────────────────────────────────
    // A line hidden by `hideBlockSource` (multi-line tables) takes no height.
    '.cm-lp-line-hidden': { display: 'none' },

    // Lists: a muted • in place of the `-`/`*`/`+` marker. The mark stays
    // quiet so list TEXT reads as body ink and links/code keep their contrast.
    '.cm-lp-bullet': {
      color: MUT,
      // Pull the glyph to sit where the marker char was; the ListItem's hanging
      // indent (padding-left + text-indent) handles wrapped/nested alignment.
      display: 'inline-block',
      width: '1ch',
      // The span inherits the line's negative text-indent and would paint the
      // glyph left of its own box, outside the scroller, where it is clipped.
      textIndent: '0',
    },

    // Task checkbox: a real input, muted like the other list marks. text-indent
    // reset for the same clipping reason as the bullet above.
    '.cm-lp-checkbox': { display: 'inline-block', width: '1.6ch', textIndent: '0' },
    '.cm-lp-checkbox input': {
      accentColor: MUT,
      // color-scheme is inherited from <html> (set per data-theme in globals.css)
      // so the native box renders dark-on-dark / light-on-light, never a bright
      // square louder than the text it belongs to.
      cursor: 'pointer',
      margin: '0',
      verticalAlign: '-2px',
      width: '14px',
      height: '14px',
    },
    '.cm-lp-checkbox input:focus-visible': {
      outline: '2px solid var(--acc)',
      outlineOffset: '3px',
    },
    '.cm-lp-task-done': { color: FAINT, textDecoration: 'line-through' },

    // Blockquote: a left rule + muted italic ink, indented off the bar.
    '.cm-lp-blockquote': {
      borderLeft: `3px solid rgba(var(--accg),0.4)`,
      paddingLeft: '14px',
      color: MUT,
      fontStyle: 'italic',
    },

    // Horizontal rule: a centered hairline that fills the measure.
    '.cm-lp-hr': { display: 'inline-block', width: '100%', verticalAlign: 'middle' },
    '.cm-lp-hr hr': {
      border: 'none',
      borderTop: '1px solid rgba(var(--accg),0.28)',
      margin: '0.4em 0',
    },

    // Inline image: rounded, capped to the measure, soft frame.
    '.cm-lp-image': { display: 'inline-block', lineHeight: '0' },
    '.cm-lp-image img': {
      maxWidth: '100%',
      maxHeight: '420px',
      borderRadius: '3px',
      border: '1px solid var(--line)',
    },

    // Plain `[text](url)` link: same accent as a wikilink, no pill.
    '.cm-lp-link': {
      color: ACCENT,
      cursor: 'pointer',
      textDecoration: 'none',
      borderBottom: '1px solid rgba(var(--accg),0.35)',
    },
    '.cm-lp-link:hover': { borderBottomColor: ACCENT },

    // Note embed block (`![[note]]`): a calm bordered card, clickable to open.
    '.cm-lp-embed': {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      padding: '4px 11px',
      margin: '1px 0',
      borderRadius: '3px',
      border: '1px solid var(--line)',
      borderLeft: '2px solid var(--acc)',
      background: 'var(--panel)',
      color: INK,
      cursor: 'pointer',
      verticalAlign: 'baseline',
    },
    '.cm-lp-embed:hover': { borderColor: 'rgba(var(--accg),0.5)' },
    '.cm-lp-embed-icon': { color: ACCENT, fontSize: '13px' },
    '.cm-lp-embed-title': { fontWeight: '600' },
    '.cm-lp-embed-tag': {
      fontFamily: 'var(--font-mono)',
      fontSize: '10px',
      letterSpacing: '0.8px',
      textTransform: 'uppercase',
      color: FAINT,
    },
    '.cm-lp-embed-new': { borderStyle: 'dashed', color: MUT },

    // Table: an aligned, padded grid with a faint header rule.
    '.cm-lp-table': { margin: '6px 0', overflowX: 'auto' },
    '.cm-lp-table table': {
      borderCollapse: 'collapse',
      fontSize: '14px',
      color: INK,
      minWidth: '50%',
    },
    '.cm-lp-table th, .cm-lp-table td': {
      border: '1px solid var(--line)',
      padding: '6px 12px',
      textAlign: 'left',
    },
    '.cm-lp-table th': {
      color: ACCENT,
      fontWeight: '600',
      background: 'rgba(var(--accg),0.06)',
    },

    // YAML frontmatter: a quiet mono block, never louder than the body. The
    // `span` override outranks the markdown heading styles that the closing
    // `---` (a setext underline to the parser) would otherwise bold keys with.
    '.cm-lp-frontmatter': { fontFamily: 'var(--font-mono)', fontSize: '13px', color: FAINT },
    '.cm-lp-frontmatter span': {
      color: FAINT,
      fontWeight: 'normal',
      fontStyle: 'normal',
      fontFamily: 'var(--font-mono)',
    },

    // A leading H1 that just repeats the page title above it: strongly dimmed,
    // presentation only (the file content is untouched; cursor reveals it).
    '.cm-lp-dup-title': { opacity: '0.3' },
  },
  { dark: true },
)

const editorHighlight = HighlightStyle.define([
  { tag: t.heading1, color: INK, fontWeight: '700', fontFamily: 'var(--font-grotesk)' },
  { tag: t.heading2, color: INK, fontWeight: '700', fontFamily: 'var(--font-grotesk)' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], color: INK, fontWeight: '600', fontFamily: 'var(--font-grotesk)' },
  { tag: t.strong, color: INK, fontWeight: '700' },
  { tag: t.emphasis, color: INK, fontStyle: 'italic' },
  { tag: t.strikethrough, color: FAINT, textDecoration: 'line-through' },
  { tag: t.link, color: ACCENT },
  { tag: t.url, color: ACCENT },
  { tag: [t.monospace], color: ACCENT, fontFamily: 'var(--font-mono)' },
  // List CONTENT is body ink: lists are most of an agent note, so hierarchy
  // must come from the muted marks, never a block accent color.
  { tag: t.list, color: INK },
  { tag: t.quote, color: MUT, fontStyle: 'italic' },
  { tag: t.processingInstruction, color: FAINT },
  { tag: WikiLinkTag, color: ACCENT },
  { tag: WikiLinkMarkTag, color: FAINT },
  { tag: HashtagTag, color: ACCENT },
])

/** The combined theme + highlighting extensions. */
export function inkEditorTheme() {
  return [editorTheme, syntaxHighlighting(editorHighlight)]
}
