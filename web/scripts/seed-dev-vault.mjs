// Seed ./dev-vault with real notes + tasks + a north-star so the web app renders
// genuine core data (not hardcoded). Idempotent-ish: removes any existing
// dev-vault first for a clean, deterministic seed.
//
// Run from the repo root: `node web/scripts/seed-dev-vault.mjs`
// (it imports the core source directly, the same module the web app uses.)

import { rm, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// Import the COMPILED core (dist) so plain Node can run this seed. The web app
// itself imports the TS source via the package `exports` map + Next transpile;
// this standalone script just needs the same API, and `tsc` already produces
// dist/. (Run `npx tsc` first if dist/ is stale.)
import {
  openVault,
  writeTask,
} from '../../dist/core/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const root = process.env.AGENTKEEP_VAULT
  ? path.resolve(process.env.AGENTKEEP_VAULT)
  : path.resolve(repoRoot, 'dev-vault')

// Date the seed to the SAME UTC "today" the web app computes
// (new Date().toISOString().slice(0,10)), so the brief always renders the full
// picture (loops closed overnight + the closed-by-agent item land in today's
// window) no matter when the seed runs. `OVERNIGHT` is a couple hours into the
// UTC day, inside the brief's `sinceISO = <date>T00:00:00Z` overnight window.
const DATE = new Date().toISOString().slice(0, 10)
const OVERNIGHT = `${DATE}T02:00:00.000Z`
const CREATED = `${DATE}T01:30:00.000Z`

await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })

// Pre-init the vault's OWN git repo. The dev-vault lives inside this repo's
// working tree, so without its own `.git`, the core's `checkIsRepo()` walks up,
// finds the PARENT repo, and `git add .` then trips the parent `.gitignore`
// (which ignores dev-vault/). A nested `.git` makes git treat the vault as its
// own toplevel — exactly how a real standalone vault behaves.
execFileSync('git', ['init', '-q', root], { stdio: 'inherit' })

const app = await openVault(root)
const { core } = app

async function note(rel, body) {
  await core.write(rel, body.endsWith('\n') ? body : body + '\n', {
    author: 'human',
    baseHash: null,
  })
}

async function task(t) {
  await writeTask(core, { created: CREATED, ...t }, 'human', null)
}

// ── North star ─────────────────────────────────────────────────────────────
await note(
  'north-star.md',
  `---
type: north-star
---

# North star

- Launch Agentkeep v1
`,
)

// ── Notes (give the connection surfacer a real backlink to find) ────────────
// The "active" note: its basename matches the doing-task title "q3-invoice".
await note(
  'notes/q3-invoice.md',
  `---
type: note
---

# Q3 invoice

The unpaid Q3 invoice thread — same amount, still open.
`,
)

// A NON-active inbox note that links to the active note → the surfaced edge.
// It has a real `title:` (its file basename is the "0914-sam-invoice" slug), so
// the brief proves it surfaces the human TITLE, never the slug.
await note(
  'inbox/0914-sam-invoice.md',
  `---
type: capture
title: Sam's note on the Q3 invoice
created: ${CREATED}
---

Note from Sam about the [[q3-invoice]] — three weeks old, same amount, still unpaid.
Worth raising when you write today.
`,
)

// A captured-last-night inbox note your connected agent would file from here.
await note(
  'inbox/coffee-notion-pm.md',
  `---
type: capture
created: ${CREATED}
---

Coffee with the Notion PM (Jordan Lee). Talked roadmap + a possible intro.
`,
)

// ── A small cross-linked cluster so the editor shows live `[[wikilinks]]` and a
//    populated backlinks panel. These are real Obsidian-style notes: the FILE
//    basename is the human title (spaces and all), so `[[Title]]` resolves by
//    basename the Obsidian way (no slugs anywhere). ──────────────────────────
await note(
  'notes/Launch plan.md',
  `# Launch plan

The path to shipping Agentkeep v1. The single bet is **honesty** — your bytes
stay yours, every agent action is a reversible commit.

Three threads carry the launch:

- The editor: [[Obsidian in your browser]] is the co-headline. It must feel
  *raw but pretty* — markdown round-trips exactly.
- The agent seam: see [[BYO-agent seam]] for the MCP + file-only paths.
- The brief: the [[Morning Brief]] is the daily lead. Every clip opens with it.

Open question from the standup: [[Pricing]] is still a placeholder note.
`,
)

await note(
  'notes/Obsidian in your browser.md',
  `# Obsidian in your browser

The browser editor that makes the vault feel native. CodeMirror 6 over a Lezer
markdown tree with a first-class \`[[wikilink]]\` node, live-preview hide-marks,
and \`[[\` autocomplete from the vault.

Every save funnels through the write-core compare-and-swap, so you and the agent
never clobber each other. Drives the [[Launch plan]].
`,
)

await note(
  'notes/BYO-agent seam.md',
  `# BYO-agent seam

Point your existing agent at the vault. Two paths: an **MCP server** for MCP
agents, and a documented **file/frontmatter spec** for file-only agents.

The seam is the distribution surface — it ties straight back to the
[[Launch plan]] and shares the [[Morning Brief]] as the daily artifact.
`,
)

await note(
  'notes/Morning Brief.md',
  `# Morning Brief

One opinionated format the agent writes each morning: *N loops closed overnight ·
M need you*, then Today, What matters, One connection, Needs-your-eyes.

It is the home page and the lead of every demo — central to the [[Launch plan]].
`,
)

// ── Editor parity demo: exercises EVERY live-preview render ──────────────────
// Lists, tasks, blockquote, rule, inline image, `![[image]]` embed, markdown
// link, `[[Note#Heading]]` anchor link, GFM table, and an `![[note]]` embed.
// Backs `dev/web/editor-parity-check.py` (the Obsidian-parity render verification).
// A tiny vault image (committed as bytes) feeds the inline + embed images.
{
  const W = 64
  const H = 40
  const raw = Buffer.alloc(H * (1 + W * 3))
  let o = 0
  for (let y = 0; y < H; y++) {
    raw[o++] = 0 // PNG filter byte
    const t = y / (H - 1)
    const r = Math.round(0x10 + t * (0xa6 - 0x10))
    const g = Math.round(0x16 + t * (0xc0 - 0x16))
    const b = Math.round(0x2a + t * (0xff - 0x2a))
    for (let x = 0; x < W; x++) {
      raw[o++] = r
      raw[o++] = g
      raw[o++] = b
    }
  }
  const crcTable = (() => {
    const tbl = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      tbl[n] = c >>> 0
    }
    return tbl
  })()
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const typeBuf = Buffer.from(type, 'latin1')
    const body = Buffer.concat([typeBuf, data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: RGB
  const { deflateSync } = await import('node:zlib')
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
  const { writeFile, mkdir: mkdirP } = await import('node:fs/promises')
  await mkdirP(path.join(root, 'assets'), { recursive: true })
  await writeFile(path.join(root, 'assets', 'cosmos-tile.png'), png)
}

await note(
  'notes/Editor parity demo.md',
  `# Editor parity demo

A scratch note that exercises every Live Preview render — lists, tasks, quotes,
rules, images, links, embeds, and tables. Jump to [[Editor parity demo#Tables]]
to see the grid, or open the [[Launch plan]].

## Lists

- A bulleted item with a real • marker
- Another bullet
  - A nested bullet that hangs under its parent
- Back to the top level

1. First numbered step
2. Second numbered step
3. Third numbered step

## Tasks

- [x] This task is done and struck through
- [ ] This task is still open — click the box to toggle it

## Quote and rule

> The single bet is honesty — your bytes stay yours, every agent action is a
> reversible commit.

---

## Images

An inline image from the vault:

![Cosmos tile](assets/cosmos-tile.png)

The same image as an Obsidian embed:

![[cosmos-tile.png]]

## Links

A plain markdown link to [the Obsidian site](https://obsidian.md), and an
internal one to [the launch plan](Launch%20plan).

## Tables

| Feature      | Status | Notes                 |
| ------------ | :----: | --------------------- |
| Lists        |   ✓    | bullets + numbers     |
| Tasks        |   ✓    | clickable checkbox    |
| Tables       |   ✓    | aligned HTML grid     |

## Embeds

A read-only note embed (click to open):

![[Launch plan]]
`,
)

// ── Tasks ───────────────────────────────────────────────────────────────────
// Today (status:'today' or due===DATE) — shown under "Today".
await task({
  id: 'email-sam-q3-invoice',
  title: 'Email Sam about the Q3 invoice',
  status: 'today',
  due: DATE,
  priority: 'high',
  tags: ['agentkeep'],
})
await task({
  id: 'ship-v1-spec',
  title: 'Ship the Agentkeep v1 spec',
  status: 'today',
  tags: ['agentkeep'],
})
// A done loop that also lands in Today (due today) — "closed by your agent".
await task({
  id: 'reply-mira-demo',
  title: 'Reply to Mira re: demo time',
  status: 'done',
  due: DATE,
  closedAt: OVERNIGHT,
})

// Two more loops closed overnight (→ 3 total) — not in today's list.
await task({
  id: 'file-4-captures',
  title: 'File 4 overnight captures',
  status: 'done',
  closedAt: OVERNIGHT,
})
await task({
  id: 'prune-stale-thread',
  title: 'Prune 1 stale thread',
  status: 'done',
  closedAt: OVERNIGHT,
})

// A 'doing' task whose title matches the active note basename → drives the
// "one connection you'd have missed" edge without cluttering Today.
await task({
  id: 'q3-invoice-thread',
  title: 'q3-invoice',
  status: 'doing',
})

console.log(`seeded dev-vault at ${root} (date ${DATE})`)
