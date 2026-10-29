import { NextResponse } from "next/server";
import type {
  ChatHistoryItem,
  Proposal,
  RosterPerson,
  RosterRelationship,
} from "@/lib/types";
import { extractFallback } from "@/lib/extract-fallback";

const SYSTEM_PROMPT = `You extract family-tree facts from ONE chat message. You do NOT chat freely.

Rules:
- Only extract what is EXPLICITLY stated in this message. Never invent a date, place, spelling, or relationship.
- If a value is vague ("around 1960", "in the 60s"), keep the year and set the proposal confidence to "low". Do not make it exact.
- Relative ages ARE stated facts, not guesses: "he is 2 years younger than me" / "younger than me 2 years" / "I am 3 years older than Thuc". When one side's birth year is given (in this message or in the roster), compute the other side's birth year and emit a person update for them too (the speaker included — use the speaker's roster id as tempId). E.g. Thuc born 1990 and "he is younger than me 2 years" means the speaker was born in 1988. Set that proposal's confidence to "medium" and put the arithmetic in "reason", e.g. "Worked out from: Thuc born 1990, 2 years younger than you".
- Never merge two people with the same name. If a name could be an existing person from the roster or a new person, prefer the existing roster id ONLY on an exact case-insensitive name match; otherwise use a new tempId and set confidence to "low".
- Resolve relative words ONLY if unambiguous: "my dad" = parent of the speaker, "my mom" = parent of the speaker. "My uncle", "my aunt", "my cousin" are AMBIGUOUS — do not guess a link; return a person proposal at most, and ask in the reply which side of the family they are on.
- Use the "Known relationships" and each roster person's relation to the speaker to resolve references to people already in the tree. E.g. if Thuc is listed as "speaker's sibling", "my brother Thuc" or "my only sibling" means that existing id — do not ask who the parents are when they are already known, and never re-propose a relationship that is already listed. "My dad"/"my mom" refers to one of the speaker's existing parents; pick by name if the message makes it clear, otherwise ask which one.
- To add or correct details of a person already in the roster (full name, birth year, place), emit a "person" proposal whose tempId is that person's existing roster id, with only the stated fields set. Never create a new tempId for someone who is already in the roster.
- Pronouns ("he", "she", "they") refer to the most recent person in this message only. If unclear, ask in the reply instead of guessing.
- Handle these phrasings exactly like "My dad is X": "My dad name is X", "My dad's name is X", "My mom name is X", "I have a brother, his name is X", "I have a sister, her name is X", and "My name is Dang, full name is Tran Hai Dang".
- If a name is given as "Hoa (Tran Hieu Hoa)" or "Tran Hieu Hoa (Hoa)", use the full name as displayName and the short name as preferredName.
- If the user says "I have a brother/sister" and the parents are known in the same message, also emit PARENT_OF from each known parent to that sibling, so siblings are derived from shared parents.
- USE THE EXISTING RELATIONSHIPS AND HISTORY. They are given in the prompt, not just the roster. "My dad" means the speaker's parent from the graph/history, not just any roster person. "My dad's brother" means a sibling of that dad. "Thuc's wife" means the spouse of the roster person named Thuc. "My brother's wife" means the spouse of the speaker's sibling from the graph. Pronouns and "my dad/mom/brother" in a later turn refer back to earlier turns in the history — do not treat each turn as a fresh tree.
- Siblings are derived from shared parents OR an explicit SIBLING_OF edge. If two people are siblings but their shared parents are unknown (for example, a dad's brother when the grandparents are not in the tree), emit SIBLING_OF between them. Never invent their parents to force a derivation.
- If a relative phrase is still ambiguous from the graph and history (for example, "my grandma" with no side given, or "my uncle" with no side given), return a person proposal at most and ask in the reply which side / whose sibling they are. Do not guess.
- Every proposal must include the exact user quote it came from in "reason".
- Output ONLY JSON, no prose, no markdown fences, with this exact shape:
{
  "reply": "a short friendly summary of what you think you heard, and what to confirm. Nothing is in the tree until the user accepts, so never say you added or saved anything; say what you propose instead",
  "proposals": [
    { "id": "p0", "kind": "person", "tempId": "temp-lan", "displayName": "Lan", "isSpeaker": true, "reason": "You said: \\"I'm Lan\\"", "confidence": "high" },
    { "id": "p1", "kind": "person", "tempId": "temp-minh", "displayName": "Minh", "birthYear": 1960, "birthPlace": "Hanoi", "reason": "You said: \\"...\\"", "confidence": "high" },
    { "id": "p2", "kind": "relationship", "fromRef": "temp-minh", "toRef": "<existing person id or tempId>", "relationshipType": "PARENT_OF", "reason": "You said: \\"...\\"", "confidence": "high" }
  ]
}
- Set "gender": "male" or "female" on a NEW person proposal when the words imply it (dad, father, brother, son, husband, he/his → male; mom, mother, sister, daughter, wife, she/her → female). Omit it otherwise. Never guess gender from a name.
- Set "isSpeaker": true only on the person proposal for the speaker themself ("I'm Lan", "My name is Dang"), and only when no speaker id is set yet.
- kind is only "person" or "relationship". relationshipType is only "PARENT_OF" (from = parent, to = child), "SPOUSE_OF", "PARTNER_OF", or "SIBLING_OF" (symmetric, store once). fromRef/toRef must be an existing roster id or a tempId from a person proposal in the same response. Grandparents, aunts/uncles and cousins are derived from parent/spouse/sibling edges, never emitted as their own edge types.
- If nothing clear can be extracted, return an empty proposals array and a reply asking for one fact, e.g. "My dad is Minh, born 1960 in Hanoi".`;

type OllamaProposal = Proposal & { [key: string]: unknown };

function log(...args: unknown[]) {
  console.log(`[chat ${new Date().toISOString().slice(11, 23)}]`, ...args);
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    | ${line}`)
    .join("\n");
}

function preview(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function logProposals(modelUsed: string, proposals: Proposal[]) {
  log(`result via ${modelUsed}: ${proposals.length} proposal(s)`);
  const nameOf = (ref?: string) =>
    proposals.find((p) => p.kind === "person" && p.tempId === ref)?.displayName ?? ref;
  for (const p of proposals) {
    if (p.kind === "person") {
      const aka = p.preferredName ? ` (${p.preferredName})` : "";
      const born = p.birthYear ? ` b.${p.birthYear}${p.birthPlace ? ` ${p.birthPlace}` : ""}` : "";
      log(`  + person ${p.displayName}${aka}${born} [${p.confidence}]`);
    } else {
      log(`  + ${nameOf(p.fromRef)} ${p.relationshipType} ${nameOf(p.toRef)} [${p.confidence}]`);
    }
  }
}

// Ollama reports durations in nanoseconds.
function nsToMs(ns: unknown): string {
  return typeof ns === "number" ? `${Math.round(ns / 1e6)}ms` : "?";
}

function normalizeProposals(
  raw: unknown,
  roster: RosterPerson[],
  egoId: string | null
): Proposal[] {
  if (!Array.isArray(raw)) return [];
  const out: Proposal[] = [];
  raw.forEach((item, i) => {
    if (!item || typeof item !== "object") return;
    const p = item as OllamaProposal;
    if (p.kind !== "person" && p.kind !== "relationship") return;
    const confidence =
      p.confidence === "high" || p.confidence === "medium" || p.confidence === "low"
        ? p.confidence
        : "medium";
    const tempId =
      typeof p.tempId === "string" && p.tempId
        ? p.tempId
        : p.kind === "person"
          ? `temp-${i}`
          : undefined;
    // Updates to an existing person often carry only the changed fields.
    const rosterName = tempId ? roster.find((r) => r.id === tempId)?.displayName : undefined;
    out.push({
      id: typeof p.id === "string" && p.id ? p.id : `ollama-${i}`,
      kind: p.kind,
      tempId,
      displayName: typeof p.displayName === "string" && p.displayName.trim() ? p.displayName : rosterName,
      preferredName: typeof p.preferredName === "string" ? p.preferredName : null,
      birthYear: typeof p.birthYear === "number" ? p.birthYear : null,
      birthPlace: typeof p.birthPlace === "string" ? p.birthPlace : null,
      bio: typeof p.bio === "string" ? p.bio : null,
      gender: p.gender === "male" || p.gender === "female" ? p.gender : null,
      fromRef: typeof p.fromRef === "string" ? p.fromRef : undefined,
      toRef: typeof p.toRef === "string" ? p.toRef : undefined,
      relationshipType:
        p.relationshipType === "PARENT_OF" ||
        p.relationshipType === "SPOUSE_OF" ||
        p.relationshipType === "PARTNER_OF" ||
        p.relationshipType === "SIBLING_OF"
          ? p.relationshipType
          : undefined,
      reason: typeof p.reason === "string" ? p.reason : "From your message",
      confidence,
      isSpeaker: p.kind === "person" && p.isSpeaker === true && !egoId,
    });
  });

  // Models often omit the flag. Without it the page cannot tell the
  // speaker's card from their dad's, so fall back to the person whose
  // quote is "I'm X" / "My name is X", else the first new person.
  if (!egoId && !out.some((p) => p.isSpeaker)) {
    const newPeople = out.filter(
      (p) => p.kind === "person" && !roster.some((r) => r.id === p.tempId)
    );
    const speaker =
      newPeople.find((p) => /\b(i am|i'm|my name is)\b/i.test(p.reason)) ?? newPeople[0];
    if (speaker) speaker.isSpeaker = true;
  }

  // A relationship whose side is neither a roster id nor a tempId in
  // this batch can never be applied; drop it instead of showing a
  // card that silently does nothing.
  const known = new Set([
    ...roster.map((r) => r.id),
    ...out.filter((p) => p.kind === "person").map((p) => p.tempId as string),
  ]);
  return out.filter(
    (p) =>
      p.kind === "person" ||
      (p.relationshipType &&
        p.fromRef &&
        p.toRef &&
        p.fromRef !== p.toRef &&
        known.has(p.fromRef) &&
        known.has(p.toRef))
  );
}

function normalizeRelationships(raw: unknown, roster: RosterPerson[]): RosterRelationship[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set(roster.map((p) => p.id));
  return raw.filter(
    (r): r is RosterRelationship =>
      !!r &&
      typeof r === "object" &&
      ids.has(r.fromPersonId) &&
      ids.has(r.toPersonId) &&
      (r.type === "PARENT_OF" ||
        r.type === "SPOUSE_OF" ||
        r.type === "PARTNER_OF" ||
        r.type === "SIBLING_OF")
  );
}

function normalizeHistory(raw: unknown): ChatHistoryItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (h): h is ChatHistoryItem =>
        !!h && typeof h === "object" && typeof h.text === "string"
    )
    .map((h) => ({
      role: h.role === "assistant" ? ("assistant" as const) : ("user" as const),
      text: h.text,
    }))
    .slice(-8);
}

// Labels each person relative to the speaker so the model can resolve
// "my dad" / "my brother" to an existing id instead of asking again.
function relationToEgo(
  personId: string,
  egoId: string | null,
  rels: RosterRelationship[],
  roster: RosterPerson[]
): string | null {
  if (!egoId) return null;
  if (personId === egoId) return "the speaker";
  const parentsOf = (id: string) =>
    rels.filter((r) => r.type === "PARENT_OF" && r.toPersonId === id).map((r) => r.fromPersonId);
  const egoParents = parentsOf(egoId);
  if (egoParents.includes(personId)) {
    const gender = roster.find((p) => p.id === personId)?.gender;
    return gender === "male" ? "speaker's father" : gender === "female" ? "speaker's mother" : "speaker's parent";
  }
  if (parentsOf(personId).includes(egoId)) return "speaker's child";
  const linked = (r: RosterRelationship) =>
    (r.fromPersonId === egoId && r.toPersonId === personId) ||
    (r.toPersonId === egoId && r.fromPersonId === personId);
  const partner = rels.find(
    (r) => (r.type === "SPOUSE_OF" || r.type === "PARTNER_OF") && linked(r)
  );
  if (partner) return partner.type === "SPOUSE_OF" ? "speaker's spouse" : "speaker's partner";
  if (rels.some((r) => r.type === "SIBLING_OF" && linked(r))) return "speaker's sibling";
  if (parentsOf(personId).some((id) => egoParents.includes(id))) return "speaker's sibling";
  if (egoParents.some((id) => parentsOf(id).includes(personId))) return "speaker's grandparent";
  return null;
}

function buildUserPrompt(
  message: string,
  roster: RosterPerson[],
  rels: RosterRelationship[],
  egoId: string | null,
  history: ChatHistoryItem[]
): string {
  const nameOf = (id: string) => roster.find((p) => p.id === id)?.displayName ?? id;
  const people =
    roster.length > 0
      ? roster
          .map((p) => {
            const aka = p.preferredName && p.preferredName !== p.displayName ? ` (${p.preferredName})` : "";
            const born = p.birthYear ? `, born ${p.birthYear}` : "";
            const place = p.birthPlace ? ` in ${p.birthPlace}` : "";
            const relation = relationToEgo(p.id, egoId, rels, roster);
            const gender = p.gender ? `, ${p.gender}` : "";
            return `- ${p.id}: ${p.displayName}${aka}${born}${place}${gender}${relation ? ` — ${relation}` : ""}`;
          })
          .join("\n")
      : "- (none yet)";
  const edges =
    rels.length > 0
      ? rels
          .map((r) => `- ${nameOf(r.fromPersonId)} (${r.fromPersonId}) ${r.type} ${nameOf(r.toPersonId)} (${r.toPersonId})`)
          .join("\n")
      : "- (none yet)";
  return [
    `Existing people (roster: id, name (preferred name), birth year/place if known, relation to speaker):`,
    people,
    ``,
    `Known relationships already in the tree (do NOT propose these again):`,
    edges,
    ``,
    `Speaker (ego) id: ${egoId ?? "(not set yet — the first 'I am ...' person is the speaker)"}`,
    ``,
    ...(history.length > 0
      ? [
          `Earlier chat in this conversation (for pronouns and relative words):`,
          history.map((h) => `${h.role}: ${h.text}`).join("\n"),
          ``,
        ]
      : []),
    `New message to extract from:`,
    message,
  ].join("\n");
}

async function tryOllama(
  message: string,
  roster: RosterPerson[],
  rels: RosterRelationship[],
  egoId: string | null,
  history: ChatHistoryItem[]
): Promise<{ reply: string; proposals: Proposal[]; modelUsed: string } | null> {
  const host = process.env.OLLAMA_HOST || "http://localhost:11434";
  const model = process.env.OLLAMA_MODEL || "gemma4:12b";
  // Large local models (e.g. gemma4:31b) can need well over 90s for a
  // multi-fact message, so the limit is configurable.
  const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS) || 90_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const userPrompt = buildUserPrompt(message, roster, rels, egoId, history);

    log(`ollama → ${host} model=${model}, prompt ${userPrompt.length} chars:\n${indent(userPrompt)}`);
    const res = await fetch(`${host.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        format: "json",
        stream: false,
        // Thinking models (e.g. gemma4) otherwise reason for thousands of
        // tokens, fill the context window, and return empty content.
        think: false,
        options: { temperature: 0.2 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      log(`ollama ✗ HTTP ${res.status} after ${Date.now() - started}ms: ${preview(errText)}`);
      return null;
    }
    const data = await res.json();
    console.log(`ollama response: ${JSON.stringify(data)}`);
    log(
      `ollama ✓ responded in ${Date.now() - started}ms`,
      `(load ${nsToMs(data?.load_duration)},`,
      `prompt ${data?.prompt_eval_count ?? "?"} tok / ${nsToMs(data?.prompt_eval_duration)},`,
      `output ${data?.eval_count ?? "?"} tok / ${nsToMs(data?.eval_duration)},`,
      `done_reason ${data?.done_reason ?? "?"})`
    );
    const content = data?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      const thinkingLen = typeof data?.message?.thinking === "string" ? data.message.thinking.length : 0;
      log(`ollama ✗ empty message content (thinking ${thinkingLen} chars, done_reason ${data?.done_reason ?? "?"})`);
      return null;
    }
    let parsed: { reply?: unknown; proposals?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch {
      log(`ollama ✗ invalid JSON: ${preview(content, 300)}`);
      return null;
    }
    const rawCount = Array.isArray(parsed.proposals) ? parsed.proposals.length : 0;
    const proposals = normalizeProposals(parsed.proposals, roster, egoId);
    log(`ollama proposals: ${proposals.length} kept of ${rawCount} returned`);
    const reply =
      typeof parsed.reply === "string" && parsed.reply.trim()
        ? parsed.reply
        : "Please review the proposal cards below and accept the ones that are right.";
    return { reply, proposals, modelUsed: `ollama:${model}` };
  } catch (err) {
    const elapsed = Date.now() - started;
    if (controller.signal.aborted) {
      log(`ollama ✗ timed out after ${elapsed}ms`);
    } else {
      const cause = (err as { cause?: { code?: string } })?.cause?.code;
      log(`ollama ✗ ${cause ?? (err as Error)?.message ?? err} after ${elapsed}ms (is Ollama running at ${host}?)`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const message = typeof body.message === "string" ? body.message : "";
    const roster: RosterPerson[] = Array.isArray(body.roster) ? body.roster : [];
    const relationships = normalizeRelationships(body.relationships, roster);
    const history = normalizeHistory(body.history);
    const egoId = typeof body.egoId === "string" ? body.egoId : null;
    if (!message.trim()) {
      return NextResponse.json({
        reply: "Tell me a family fact to get started — for example, “My dad is Minh, born 1960 in Hanoi.”",
        proposals: [],
        modelUsed: "fallback",
      });
    }

    // Ollama first (open-weight model, local when OLLAMA_HOST is
    // localhost). Any failure — not running, bad JSON, timeout —
    // falls through to the deterministic fallback. Never crash.
    log(
      `request (roster ${roster.length}, relationships ${relationships.length}, history ${history.length}, ego ${egoId ?? "none"}):\n${indent(message)}`
    );
    const ollama = await tryOllama(message, roster, relationships, egoId, history);
    if (ollama) {
      logProposals(ollama.modelUsed, ollama.proposals);
      return NextResponse.json(ollama);
    }

    const started = Date.now();
    const fallback = extractFallback(message, roster, egoId, relationships, history);
    log(`fallback parser ran in ${Date.now() - started}ms`);
    logProposals(fallback.modelUsed, fallback.proposals);
    return NextResponse.json(fallback);
  } catch (err) {
    log("request failed, returning safe reply:", err);
    // Last-resort guard: the chat UI must never get a 500 for a
    // normal message, even if the request body was malformed.
    try {
      const fallback = extractFallback("", [], null);
      return NextResponse.json({
        reply: "Something went wrong reading that message — could you try again with one fact, like “My dad is Minh, born 1960 in Hanoi”?",
        proposals: fallback.proposals,
        modelUsed: "fallback" as const,
      });
    } catch {
      return NextResponse.json({
        reply: "Something went wrong — please try again.",
        proposals: [],
        modelUsed: "fallback",
      });
    }
  }
}
