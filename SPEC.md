# Agentkeep vault spec — point your agent at your vault

Agentkeep is a self-hosted, MIT, **Obsidian-compatible** vault that your agent
keeps tidy. The vault is **just markdown + JSON in a folder** — open it in
Obsidian, edit it by hand, or let an agent drive it. Nothing to export, no lock-in.

There are two ways an agent can drive the vault:

1. **MCP server (recommended, governed).** Run `agentkeep-mcp <vault-path>` and
   point any MCP client at it. Every write goes through the
   write-core: content-hash compare-and-swap, atomic write, git commit, attributed
   `agentkeep-agent`. You get **undo, attribution, and no-clobber for free**. This
   is the safe interface that raw "agent → files" does not give you.
2. **File-only (this spec).** Agents that can only read/write files work
   directly against the layout below. They are **second-class writers by
   design**: no hash guard at write time, no automatic Agentkeep git attribution,
   and no MCP `{ error, code }` values. The standalone `agentkeep-mcp` server
   indexes the vault at startup and reindexes its own tool-writes synchronously;
   **live re-indexing of external file-only edits** (an agent or Obsidian writing
   files while a server runs) is handled by the long-running web daemon's file
   watcher, not the stdio MCP binary. Honest tradeoff — prefer MCP `write_note`
   with a `baseHash` when you can.

Through MCP or the web app, **every mutation is a git commit**, so every governed
change is reversible. Raw file-only writes are ordinary filesystem edits until
you or another tool commit them.

## Vault layout

```
vault/
├── inbox/                 # raw captures, one markdown file per item
├── notes/                 # prose notes: markdown + frontmatter; [[wikilinks]]
├── memory/                # the agent's memory, one note per topic (the `remember` tool)
├── tasks/                 # optional sharded JSON, one file per task
├── brief/2026-06-08.md    # optional generated brief note
├── north-star.md          # optional goals file used by brief helpers
└── .agentkeep/            # app state + rebuildable index cache (NOT your prose)
# .git/ lives on the host, outside any synced path
```

An **existing Obsidian vault keeps its own structure** — these folders are the
fresh-vault convention, not a requirement. `agentkeep init` currently creates
only `inbox/` and `memory/`; the other folders/files above are optional core
conventions and are created on demand by tools or by your agent. Agentkeep
indexes every `.md` file wherever it sits (dotfolders like `.agentkeep/`,
`.obsidian/`, `.git/` are skipped).

## Notes (`notes/`, prose)

A note is markdown with an optional YAML frontmatter block:

```markdown
---
title: Widgets research
tags: [research, widgets]
created: "2026-06-08T09:00:00.000Z"
agent_edited: true
source: https://example.com/widgets
---

# Widgets research

Connects to [[beta]] and the #widgets project.
```

Conventions:

- **`[[wikilinks]]`** — Obsidian style. Aliases (`[[target|alias]]`), heading
  (`[[target#H]]`) and block (`[[target^id]]`) anchors and the `!` embed prefix
  are all understood; only the bare target feeds the backlink graph. The resolver
  is basename-based (Obsidian semantics). In the web editor a `[[target#H]]` /
  `[[target^id]]` link **navigates** — clicking it opens the target note and
  scrolls to that `#heading` / `^block`. `![[image.ext]]` renders as an **inline
  image** (served from the vault via `/api/image`); `![[note]]` renders as a
  read-only **embed block** (a card linking to the note, not a full inline copy).
  *Full inline transclusion of a note's body is roadmap, not v1.*
- **Tags** — frontmatter `tags` (a YAML list, or a comma string) **and** inline
  `#tag` (nested `#proj/sub` allowed). People are a tag convention: `person/<name>`.
- **`title`** — frontmatter `title`, else the first `# H1`, else the filename.
- **`source` / citation** — when an agent writes something it learned from a URL
  or note, record it (`source:` in frontmatter, or an inline cite). *Claims cite
  their source* — optional brief helpers can surface uncited agent prose for your
  eyes.
- **`agent_edited: true`** — set by the agent when it touched a note, so the UI can
  visually mark agent edits. (Git authorship `agentkeep-agent` is the source of
  truth; this flag is a convenience for fast rendering.)

### Frontmatter rules (so diffs stay clean)

- **Read** frontmatter by splitting only (we use `gray-matter`); **write** a
  single key with a format-preserving editor (we use `eemeli/yaml`) so comments,
  key order, and whitespace survive. **Never** rewrite the whole block with a
  dumb stringify — it reorders keys and drops comments. Golden rule: an untouched
  file must round-trip to **zero diff**.
- The web editor edits **raw markdown source**, so your exact bytes round-trip
  (CRLF stays CRLF, quoting is preserved).
- Quote ambiguous scalars (ISO timestamps, `yes`/`no`/`on`/`off`) as strings, or
  the YAML-1.1 read side coerces them to a `Date`/boolean.

## Tasks (`tasks/<id>.json`)

Structured fields markdown can't carry → one JSON file per task:

```json
{
  "id": "t_3f9a2b10",
  "title": "Email Sam about the invoice",
  "status": "today",
  "due": "2026-06-10",
  "priority": "high",
  "tags": ["billing"],
  "created": "2026-06-08T09:00:00.000Z",
  "source": "inbox/cap_8a1c0e44.md",
  "closedAt": "2026-06-09T17:30:00.000Z"
}
```

- `id` (required) · `title` (required) · `status` (required): one of
  `inbox` | `today` | `doing` | `done` · `created` (required, ISO).
- Optional: `due` (ISO date) · `priority` (`low`|`med`|`high`) · `tags` (string[])
  · `source` (where it came from) · `closedAt` (ISO, set when moved to `done` — the
  brief uses it to count "loops closed overnight").
- Pretty-printed JSON + a trailing newline so git diffs are reviewable. A malformed
  shard is skipped, never fatal.

## Capture (the fastest way in)

Drop a timestamped markdown file in `inbox/` and let the agent file it later:

```markdown
---
id: cap_8a1c0e44
created: "2026-06-08T09:00:00.000Z"
type: capture
---

Remember to ship phase 5.
```

- Filename and `id` are `cap_<8 hex of sha256(text)>` (content-derived → the same
  text maps to the same inbox file, so a double-capture is idempotent, not a dupe).
- Captures are a **human** action; the agent reads `inbox/`, then proposes notes/
  tasks and (on approval) files them.
- Via MCP: the `capture` tool does exactly this for you.

## Memory (`memory/<slug>.md`)

The agent's durable memory, one plain markdown note per topic — what the web
app's **Memory** page ("What your agent believes") renders. Written by the
`remember` MCP tool. You can open and edit a memory note like any other, but the
agent owns the file (see the clobber note below), so durable human prose belongs
in a normal note that the memory note `[[wikilinks]]`:

```markdown
---
title: Coffee preference
type: preference
source: session 2026-06-10
updated: "2026-06-10"
---

The user takes their coffee black, no sugar. See [[Morning routine]].
```

- **Path**: `memory/<slug>.md` — the slug is the lowercased topic, runs of
  non-alphanumerics collapsed to single dashes (`'My  Topic!!'` → `my-topic`).
- **Frontmatter**: `title` keeps the human topic (the UI shows titles, never
  slugs); `type` is one of `fact` | `preference` | `person` | `project`
  (default `fact`); `source` is free text recording where the agent learned it
  (omitted when unknown); `updated` is the date of the last `remember`
  (quoted, so it stays a string).
- **The `remember` tool owns the whole file**: each call replaces the
  frontmatter AND body for that topic — re-remembering supersedes cleanly. This
  means **any hand-edit to a `memory/*` note is overwritten when the agent next
  remembers that topic** — not just extra frontmatter keys you add, but edits to
  the body prose too. The replacement is silent (no conflict, no merge): the next
  `remember` writes the topic fresh from what the agent now believes. So treat a
  memory note as the agent's scratch copy of one belief. To keep durable human
  prose, put it in a normal note and `[[wikilink]]` it from the memory note;
  correcting a belief for good means telling the agent, so its next `remember`
  writes the corrected version.
- **Body**: the memory in plain markdown, wikilinked liberally so it joins the
  backlink graph (memory nodes are accented in the graph view).
- Honest scope: Agentkeep **stores and shows** memory. It does no embedding,
  ranking, or recall — your agent's own context/retrieval does that.

## north-star.md (optional)

One pinned goals file. Goals are the **top-level list items** (`- ` / `* `) and
`## ` headings; plain prose paragraphs are not goals. The Morning Brief weights
"what matters" against these. The current memory-first app does not require this
file; it is a core helper convention for agents that choose to generate briefs.

## Agent etiquette (the two-driver contract)

- **Never clobber human prose.** Edit frontmatter and agent-owned sections; append
  rather than rewrite when unsure. The human can edit, run, and override anything;
  the agent only ever **proposes**.
- **Prefer MCP `write_note` with a `baseHash`.** Read first, write with the hash you
  read. A stale hash returns a **409 conflict** (your write is rejected, the human's
  bytes are safe) — that is the feature, not a failure.
- **Cite your sources.** Record `source` for anything learned externally.
- **Mark agent edits** (`agent_edited: true`) and let git carry the real provenance.
- **Governed writes are reversible.** Each MCP/web change is one git commit
  attributed to `agentkeep-human` or `agentkeep-agent` — `git revert` (or the web
  Undo) is the universal undo. Raw file-only writes need their own commit
  discipline.

## MCP tool reference (the governed seam)

`agentkeep-mcp <vault-path>` serves these nine tools over stdio. `write_note`,
`capture`, `remember`, and `delete_note` mutate through the governed seam (CAS /
git rm + git commit + `agentkeep-agent`); the rest read.

- **`search`** `{ query }` → ranked `{ path, title, score }[]`, best first.
- **`read_note`** `{ path }` → `{ content, hash }`. Use `hash` as the `baseHash`
  for a safe `write_note`. Missing file → a not-found result (not an error throw).
- **`write_note`** `{ path, content, baseHash? }` → `{ hash, commit }`. Omit
  `baseHash` to create; pass it to update. Stale hash → a **409 conflict** result.
- **`list_notes`** `{}` → every markdown path, sorted.
- **`list_tasks`** `{}` → every task object.
- **`get_backlinks`** `{ path }` → notes that link to the target.
- **`capture`** `{ text }` → `{ path, id }`; lands an `inbox/` file.
- **`remember`** `{ topic, content, type?, source? }` → `{ path, hash, commit }`.
  Upserts `memory/<slugified-topic>.md` as the agent (frontmatter `title` /
  `type` (default `fact`) / `source` / `updated: today` + the content body — the tool
  owns the WHOLE file, see the Memory section above). CAS-guarded against a
  concurrent edit (→ **409**); empty topic/content → **400** (values, not throws).
- **`delete_note`** `{ path }` → `{ ok, commit }`. Removes a note as the agent
  (git rm + commit) — use it to clear an `inbox/` capture once you've filed it,
  so the inbox empties. The removal is one commit, so it's git-reversible
  (`git revert`, or the web Undo) — not a destructive erase. Missing path → a
  **404** result; a path escaping the vault → **400** (both values, not throws).

A failing tool result comes back as an MCP tool error (`isError: true`) carrying
`{ error, code }` — e.g. `{ "code": 409, "error": "Conflict on ..." }` — so the
client can react without the call throwing.
