# Family Tree — built by talking

A Hacktoberfest Week 4 MVP: build a family tree mostly through chat
conversation, with an interactive tree for details and avatars.

Theme fit: “Ghost in the Machine” — something that honours the past in
the spirit of Día de los Muertos. A tree you build by telling stories is
closer to an ofrenda than a genealogy database: names plus memories.

## How to run

```bash
npm install
cp .env.example .env.local
npm run dev
# open http://localhost:3000
```

### With Ollama (recommended — this is the open-AI core of the project)

Install Ollama from https://ollama.com, then pull a model:

```bash
ollama pull gemma4:12b   # recommended: the 12B Unified model; needs Ollama v0.30.5+
ollama pull gemma4:e4b   # lighter default (also what plain `gemma4` pulls)
ollama pull gemma4:e2b   # lightest, for low-RAM machines
ollama pull qwen3:8b     # strong structured output, good multilingual
```

Set the model in `.env.local`:

```
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=gemma4:12b
```

Ollama runs on your own machine by default, so family names, stories,
and photos never leave it when `OLLAMA_HOST` is localhost. That is the
“why open innovation matters” argument for the DEV write-up: the data
stays with the family, the model can be swapped, and the app does not
die if a closed service disappears.

### Without Ollama

The app still works. If Ollama is not running, returns bad JSON, or
times out, `/api/chat` falls back to a deterministic heuristic parser
(`lib/extract-fallback.ts`) that handles patterns like:

- “I'm Lan” / “My name is Lan”
- “My dad is Minh, born 1960 in Hanoi”
- “X is my mom”
- “He married my mom, Hoa” / “I am married to Y”
- “My brother / sister / son / daughter / wife / husband is X”
- “My parents are Minh and Hoa”
- “Thuc's wife is Hang” / “My dad's brother is Tuan”
- “They have 3 kids: Thanh Ha, Tra My and Anh Khoi”
- “My brother's full name is Tran Dang Thuc. He was born in 1990”

If a large model (e.g. `gemma4:31b`) keeps timing out, raise
`OLLAMA_TIMEOUT_MS` in `.env.local` (default 90000).

The chat header shows which path was used for the last message
(`ollama:gemma4:12b` vs `fallback`).

## Architecture: chat → proposals → confirmation → tree

1. **Chat** — the user talks naturally.
2. **Extraction** — `/api/chat` sends only the new message plus a
   compact roster of existing people to Ollama (or the fallback
   parser). It returns a friendly reply plus structured proposals.
3. **Confirmation** — proposals appear as cards. Nothing enters the
   tree until the user presses Accept. This is deliberate: it stops
   the model merging two people with the same name or inventing dates.
4. **Tree** — `lib/tree.ts` derives parents, children, spouses, and
   siblings from just two stored edge types (`PARENT_OF`,
   `SPOUSE_OF`/`PARTNER_OF`). Clicking a node opens details, a story
   editor, avatar upload, and add-parent/spouse/child shortcuts.

Try it with:

> I'm Lan. My dad is Minh, born 1960 in Hanoi. He married my mom, Hoa.

Accept the proposals and the tree renders Lan with Minh and Hoa as
parents, linked as spouses.

## What is in this MVP — and what is deliberately not

In: chat extraction, proposal confirmation, interactive tree,
person details, bio/story editing, avatar upload (stored as a data
URL), manual add/edit/delete, localStorage persistence.

Out (for later): user accounts and sharing, a real database,
React Flow, GEDCOM import/export, voice recording, AI avatar
generation, automatic duplicate merging, timeline view.

## Upgrade path

- **Persistence:** replace the localStorage code in `app/page.tsx`
  with Prisma + Postgres (a `Person` table and a `Relationship`
  table, as sketched in the data-model note). The `Person` /
  `Relationship` types in `lib/types.ts` already match that shape.
- **Tree rendering:** swap the simple generation layout in
  `lib/tree.ts` for React Flow when you need dragging, zooming,
  and richer node cards.
- **Extraction:** keep the proposal shape, but add more tool calls
  (update person, add story, ask clarification) and a proper agent
  framework such as Mastra or LangGraph for multi-turn memory.
- **Deploy:** host the frontend on Render or DigitalOcean and run
  the model there, or keep the model local and deploy only a demo
  with the fallback parser.
