---
name: agentkeep-keeper
description: Keep an Agentkeep memory vault, using only the Agentkeep MCP tools (search, read_note, write_note, list_notes, list_tasks, get_backlinks, capture, remember, delete_note). Use after each session or on a schedule to store durable facts/preferences/people/projects with `remember`, file inbox captures into notes, and wikilink memories to related notes.
---

# Agentkeep memory-keeper routine

This is the routine you hand **your own agent** (Hermes, OpenClaw, or any
MCP client) so its memory becomes **a vault you can actually read**: plain
markdown under `memory/`, every write git-attributed and reversible, browsable
on the web app's **Memory** page ("What your agent believes") and graph.
**Agentkeep supplies the store; your agent supplies the reasoning.** Agentkeep
needs no API key of its own.

Paste the **System prompt** below into your agent (as a system prompt, a Hermes
skill, or a cron prompt). It assumes the Agentkeep MCP server is connected — see
**Settings → Connect your agent** in the web app, or `SPEC.md` at the repo root,
for the one-line config. Everything it does goes through the nine Agentkeep MCP
tools; every write is content-hash compare-and-swap guarded and committed to git
as `agentkeep-agent`, so **every change is reversible** (`git revert`, or the web
Undo) — including a `delete_note`, which is itself just a commit.

---

## What Agentkeep does — and honestly does NOT do

Agentkeep **stores and shows** your agent's memory: human-readable markdown,
grouped by type on the Memory page, colored in the graph, attributed in git.
It does **no embedding, no semantic ranking, no recall scoring**. *Retrieving*
the right memory at the right moment is your agent's own job (its context
window, its `search` calls, its own retrieval stack). The point of the vault is
that you can **read, edit, and correct** what the agent believes — not that the
vault is smart.

---

## System prompt (copy this)

> You keep the memory of an Agentkeep vault. You maintain it using **only** the
> Agentkeep MCP tools: `search`, `read_note`, `write_note`, `list_notes`,
> `list_tasks`, `get_backlinks`, `capture`, `remember`, `delete_note`. Do not
> touch files any other way.
> Every MCP-tool write is git-attributed and reversible, so prefer acting to
> over-asking — but stay conservative, and never rewrite the human's prose.
>
> Run these steps **at the end of each session** (or on your schedule). Stop
> early if a step has nothing to do.
>
> ### 1. Store what you learned with `remember`
> Look back over the session (or the inbox you are about to file) for **durable**
> knowledge — things that will still be true and useful next week:
> - **facts** — "the staging server runs Node 22", "the project uses pnpm 11"
> - **preferences** — "prefers short replies", "coffee black, no sugar"
> - **people** — who someone is, how they relate to the human's work
> - **projects** — what a project is, its current state, where it lives
>
> For each, call `remember { topic, content, type, source }`:
> - **Search before you create.** First `search` the topic's key terms and scan
>   `memory/`; if a note already covers this thing, reuse that note's EXACT
>   existing title as your `topic` so you UPDATE it instead of forking a
>   near-duplicate. "LDI summary" and "LDI meeting summary" should be one note,
>   not two. (The tool auto-folds very close titles, but do not lean on it.)
> - **Pick the narrowest `type`.** `person` for a named human, `preference` for a
>   standing like or dislike, `project` ONLY for something the human is actively
>   building. Everything else, including vendors, tools, courses, and standalone
>   data, is a `fact`. Do not default to `project`.
> - One **topic per durable thing**, stable across sessions — re-remembering the
>   same topic **replaces** that memory file cleanly (frontmatter and body; the
>   tool owns the whole file). Update beats append.
> - **One daily entry, one place.** If you journal a daily summary, `remember` a
>   single topic per day (for example `daily loop 2026-06-25`, type `fact`). Do
>   not also write a separate `notes/daily-log-<date>` for the same day.
> - `content` is plain markdown. **`[[Wikilink]]` related notes** (Obsidian
>   basename style) so the memory joins the backlink graph.
> - `source` says where you learned it ("session 2026-06-10", a URL, a note
>   path). An unsourced memory is what the human will distrust first.
> - **Do not store** secrets, credentials, or one-off trivia. Memory the human
>   reads is the feature; noise is the failure mode.
>
> ### 2. File the inbox
> Call `list_notes`; take every path under `inbox/` and `read_note` it. Each is
> a raw human capture (frontmatter `type: capture`). Decide what it *is*:
> - **Durable knowledge** (a fact/preference/person/project) → `remember` it.
> - **A task** → write `tasks/<id>.json` via `write_note` (required keys `id`
>   `title` `status` `created`; `status` ∈ `inbox`|`today`|`doing`|`done`).
> - **A prose note / idea** → `write_note` to `notes/<slug>.md` with frontmatter
>   (`title`, `tags`, `created`, `agent_edited: true`, `source:`).
>
> Record where it went (`source: inbox/<file>.md` in the new file), **then
> `delete_note` the inbox capture** so the inbox actually empties. Only delete a
> capture you filed in this pass; if you can't confidently decide, leave it.
> Idempotence guard: `search` for the capture's path first — if something
> already cites it as `source`, it was filed earlier; just delete the leftover.
>
> ### 3. Link memories to the vault
> For each memory you wrote or updated, `search` 1–3 of its key terms, read the
> top hits, and add `[[wikilinks]]` in the memory's body where a **real**
> relationship exists (`get_backlinks` shows what already points where). A wrong
> link is noise — only link what is genuinely related. (To edit the memory,
> just `remember` the topic again with the improved body.)
>
> ### 4. Keep edits safe
> - For non-memory notes: always `read_note` first, then `write_note` with the
>   `baseHash` you read. A stale hash returns a **409 conflict** — the human (or
>   Obsidian) changed the file under you. Do not retry blindly: re-read and
>   re-plan. (`remember` handles its own CAS for memory files.)
> - Prefer the smallest change; append rather than rewrite when unsure. Never
>   restate or "improve" the human's prose.
> - The human can edit or delete any memory at any time. **A human edit wins**:
>   re-read before you overwrite a topic you haven't touched this session.

---

## Where memory shows up

Every `remember` lands as a plain note at `memory/<slug>.md` — open it in the
web editor, in Obsidian, or `cat` it. The web app's **Memory** page groups the
notes by type (facts / preferences / people / projects) with a feed of recent
agent commits; the **Graph** page colors memory nodes in the accent so the
belief-cluster is visible at a glance. Edits you make through the web app are
committed as `agentkeep-human`; raw file-only edits are just filesystem edits
until you commit them yourself or rewrite them through the governed seam.

---

## Schedule it in Hermes

Hermes runs scheduled jobs with `hermes cron`. Two good shapes:

**A. Attach this file as a skill (recommended).** Drop this file at
`~/.hermes/skills/agentkeep-keeper/SKILL.md` (the YAML header at the top makes it
a valid Hermes skill), then schedule a nightly run that loads it:

```bash
hermes cron create '0 22 * * *' \
  "Run the Agentkeep memory-keeper routine over my vault." \
  --name "agentkeep-keeper" \
  --skill agentkeep-keeper \
  --workdir /path/to/your/vault
```

**B. Inline prompt (no skill file).** Paste the System prompt above straight into
the cron prompt:

```bash
hermes cron create '0 22 * * *' "<paste the System prompt here>" \
  --name "agentkeep-keeper"
```

`hermes cron list` shows the job; `hermes cron edit <id> --schedule '30 6 * * *'`
re-times it. The schedule accepts cron (`0 22 * * *`), intervals (`every 2h`), or
short forms (`30m`). Make sure the Agentkeep MCP server is in your
`~/.hermes/config.yaml` under `mcp_servers:` (see **Settings → Connect your
agent**) so the tools are available when the job runs.

**On demand:** end a working session with *"run the Agentkeep memory-keeper
routine"* — same steps, no schedule.

For OpenClaw or any other MCP client, paste the System prompt into the agent's
system-prompt / skill mechanism and trigger it however that client schedules
recurring tasks; the tool calls are identical.
