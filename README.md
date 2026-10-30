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

### Deploying with Ollama Cloud

A hosted deployment can't reach your local Ollama, so point it at
[Ollama Cloud](https://docs.ollama.com/cloud) instead. It serves the
same open models through the same API. Set these on the host (never
in client code):

```
OLLAMA_HOST=https://ollama.com
OLLAMA_MODEL=gemma4:31b      # any name from https://ollama.com/api/tags
OLLAMA_API_KEY=...           # created in your ollama.com account
OLLAMA_TIMEOUT_MS=30000      # optional; keep it under the host's request limit
```

Cloud requests are billed per token (one chat message is roughly
2–3K tokens). Family data does leave the machine in this mode; Ollama
says it does not log or train on cloud prompts. In production the
`/api/chat` route only logs timings and counts, not message text or
names. If the key is missing or wrong, the server log says so and the
chat uses the fallback parser.

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
3. **Confirmation** — each reply comes with a checklist, and the
   checked items show up in the tree as dashed preview cards. Nothing
   enters the tree until the user presses "Add to tree" (with Undo).
   This is deliberate: it stops the model merging two people with the
   same name or inventing dates.
4. **Tree** — `lib/tree.ts` derives parents, children, spouses, and
   siblings from just two stored edge types (`PARENT_OF`,
   `SPOUSE_OF`/`PARTNER_OF`), labels everyone relative to the speaker
   ("Mother", "Sister-in-law"), and draws parent/child links as family
   bars. Cards can be dragged (positions are saved; "Tidy up" resets
   them), and the canvas zooms and fits. Clicking a card opens a side
   panel to edit details, the story, the avatar and photos, and to add
   relatives.
5. **Photos** — the "Photos" button opens a family-wide gallery, and
   each person's panel has their own. One photo can be tagged with
   several people, so a wedding photo shows up on everyone's page.
   Uploads are resized (2000px long edge plus a 400px thumbnail) and
   stored in IndexedDB; only captions, years, and tags go in
   localStorage with the tree.

Try it with:

> I'm Lan. My dad is Minh, born 1960 in Hanoi. He married my mom, Hoa.

Press "Add all to tree" and the tree renders Lan with Minh and Hoa as
parents, linked as spouses.

## What is in this MVP — and what is deliberately not

In: chat extraction, proposal review with tree preview and undo,
draggable/zoomable tree, relationship labels, person details,
bio/story editing, avatar upload (resized, stored as a data URL),
photo galleries for the family and each person (IndexedDB), manual
add/edit/delete, localStorage persistence (tree, chat history, and
card positions), and JSON export/import of the tree (people, links,
avatars, stories, and card positions) via the Export / Import buttons
in the header.

Out (for later): user accounts and sharing, a real database,
React Flow, GEDCOM import/export, voice recording, AI avatar
generation, automatic duplicate merging, timeline view.

## Upgrade path

- **Persistence:** replace the localStorage code in `app/page.tsx`
  with Prisma + Postgres (a `Person` table and a `Relationship`
  table, as sketched in the data-model note). The `Person` /
  `Relationship` types in `lib/types.ts` already match that shape.
  Photos would become a `Photo` table plus files in object storage
  (S3, R2) uploaded via presigned URLs, replacing `lib/photo-store.ts`.
  Until then, photos live only in this browser and are not part of
  any export.
- **Tree rendering:** the hand-rolled layout in `lib/tree.ts` plus
  drag/zoom in `app/page.tsx` is enough for one family; swap to React
  Flow for panning, minimaps, or very large trees.
- **Extraction:** keep the proposal shape, but add more tool calls
  (update person, add story, ask clarification) and a proper agent
  framework such as Mastra or LangGraph for multi-turn memory.
- **Deploy:** host the app on Vercel, Render or DigitalOcean and use
  Ollama Cloud for the model (see "Deploying with Ollama Cloud"), or
  deploy only a demo with the fallback parser.
