# Family Tree — built by talking

A Hacktoberfest Week 4 MVP: build a family tree mostly through chat
conversation, with an interactive tree for details and avatars.

Theme fit: “Ghost in the Machine” — something that honours the past in
the spirit of Día de los Muertos. A tree you build by telling stories is
closer to an ofrenda than a genealogy database: names plus memories.

## How to run

Needs Node.js 20 or newer (Next.js 15 runs on 18.18, but the Vitest
test suite needs 20+).

```bash
npm install
cp .env.example .env.local
npm run dev
# open http://localhost:3000
```

For a production build, run `npm run build && npm start`.

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
chat uses the fallback parser. The header pill reads “Ollama Cloud”
with a blue dot in this mode, so users can see their messages leave
the server.

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
- “I have a brother, his name is Thuc” / “I have two sisters, Mai and Ha”
- “Thuc's wife is Hang” / “My dad's brother is Tuan” / “My brother's wife is Thu”
- “They have 3 kids: Thanh Ha, Tra My and Anh Khoi” / “We have two kids”
- “My brother's full name is Tran Dang Thuc. He was born in 1990”
- “Born on 5 March 1960” (a full date; ambiguous dates like 05/03/1960
  keep only the year)
- “He is 2 years younger than me” (works out the missing birth year)

It asks instead of guessing when a phrase is ambiguous, e.g. which side
of the family an uncle is on.

If a large model (e.g. `gemma4:31b`) keeps timing out, raise
`OLLAMA_TIMEOUT_MS` in `.env.local` (default 90000).

The pill in the header says where messages go, so nobody types family
names without knowing. On page load it asks `GET /api/chat`, which
returns only the mode and model name (never the host), and shows the
configured model. After each message it shows what actually handled it:

| `OLLAMA_HOST` | Pill | Dot |
|---|---|---|
| `localhost`, `127.x`, `::1` | Local AI · gemma4:12b | green |
| `ollama.com` | Ollama Cloud · gemma4:31b | blue |
| anything else (e.g. a home server) | Self-hosted AI · gemma4:12b | green |
| Ollama failed, fallback used | Built-in parser | grey |

Hovering the pill explains where the message was sent. The dot stays
grey until a message has actually gone through Ollama. In `npm run dev`, each
chat reply also has a collapsible debug line with the source, Ollama
host, timings, token counts, and why Ollama was skipped if it was. Set
`CHAT_DEBUG=1` to show it in a production build too (raw model output
is never included there).

### Checks

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint (next/core-web-vitals + next/typescript)
npm run lint:fix    # ESLint with --fix
npm test            # Vitest, tests live next to the code as *.test.ts
npm run test:watch  # Vitest in watch mode
npm run coverage    # Vitest + V8 coverage; HTML report in coverage/
npm run check       # typecheck + lint + test
```

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
   siblings from a few stored edge types (`PARENT_OF`,
   `SPOUSE_OF`/`PARTNER_OF`, and `SIBLING_OF` only when two siblings'
   shared parents are unknown), labels everyone relative to the speaker
   ("Mother", "Sister-in-law"), and draws parent/child links as family
   bars. Cards can be dragged (positions are saved; "Tidy up" resets
   them). Dragging empty space or scrolling pans the canvas;
   Ctrl/Cmd+wheel or a trackpad pinch zooms around the cursor, and
   "Fit" zooms to show everyone. Clicking a card opens a side
   panel to edit details, the story, the avatar and photos, and to add
   relatives. The add-relative box suggests people already in the tree
   as you type (accent-insensitive, so "Dang" finds "Đăng") and links
   them instead of creating a duplicate. It hides anyone who would
   become their own ancestor or give a child more than two parents.
5. **Photos** — the "Photos" button opens a family-wide gallery, and
   each person's panel has their own. One photo can be tagged with
   several people, so a wedding photo shows up on everyone's page.
   "Play slideshow" in the family gallery shows the current list full
   screen with captions, year and tagged names; it advances every 5
   seconds (Space pauses, arrows step, Escape exits). Any photo can
   also be used as a person's avatar. Uploads are resized (2000px long
   edge plus a 400px thumbnail) and stored in IndexedDB; only
   captions, years, and tags go in localStorage with the tree.

Try it with (on an empty tree, the "Try an example" chip above the
message box fills this in):

> I'm Lan. My dad is Minh, born 1960 in Hanoi. He married my mom, Hoa.

Press "Add all to tree" and the tree renders Lan with Minh and Hoa as
parents, linked as spouses.

## What is in this MVP — and what is deliberately not

In: chat extraction, proposal review with tree preview and undo,
draggable/pannable/zoomable tree, relationship labels, person details
(including a preferred name, shown on the card as "Full Name (Short)",
and a full birth date or just a year), bio/story editing, avatar upload
(resized, stored as a data URL), photo galleries for the family and
each person (IndexedDB), a family photo slideshow with captions, manual
add/edit/delete, linking existing people as relatives from the side
panel, localStorage persistence (tree, chat history, and card
positions), JSON export/import of the tree (people, links, avatars,
stories, and card positions) via the Export / Import buttons in the
header (importing over an existing tree asks first and can be undone),
a Reset button that clears the tree, layout, pending suggestions and
chat (with a confirmation and Undo), and Chat / Tree tabs on narrow
screens.

Out (for later): user accounts and sharing, a real database,
React Flow, GEDCOM import/export, voice recording, AI avatar
generation, automatic duplicate merging, timeline view.

## Upgrade path

- **Persistence:** replace the localStorage code in `app/page.tsx`
  with Prisma + Postgres (a `Person` table and a `Relationship`
  table). The `Person` /
  `Relationship` types in `lib/types.ts` already match that shape.
  Photos would become a `Photo` table plus files in object storage
  (S3, R2) uploaded via presigned URLs, replacing `lib/photo-store.ts`.
  Until then, photos live only in this browser and are not part of
  any export.
- **Tree rendering:** the hand-rolled layout in `lib/tree.ts` plus
  drag/pan/zoom in `app/page.tsx` is enough for one family; swap to
  React Flow for minimaps or very large trees.
- **Extraction:** keep the proposal shape, but add more tool calls
  (update person, add story, ask clarification) and a proper agent
  framework such as Mastra or LangGraph for multi-turn memory.
- **Deploy:** host the app on Vercel, Render or DigitalOcean and use
  Ollama Cloud for the model (see "Deploying with Ollama Cloud"), or
  deploy only a demo with the fallback parser.
