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
- Never merge two people with the same name. If a name could be an existing person from the roster or a new person, prefer the existing roster id ONLY on an exact case-insensitive name match; otherwise use a new tempId and set confidence to "low".
- Resolve relative words ONLY if unambiguous: "my dad" = parent of the speaker, "my mom" = parent of the speaker. "My uncle", "my aunt", "my cousin" are AMBIGUOUS — do not guess a link; return a person proposal at most, and ask in the reply which side of the family they are on.
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
  "reply": "a short friendly summary of what you think you heard, and what to confirm",
  "proposals": [
    { "id": "p1", "kind": "person", "tempId": "temp-minh", "displayName": "Minh", "birthYear": 1960, "birthPlace": "Hanoi", "reason": "You said: \\"...\\"", "confidence": "high" },
    { "id": "p2", "kind": "relationship", "fromRef": "temp-minh", "toRef": "<existing person id or tempId>", "relationshipType": "PARENT_OF", "reason": "You said: \\"...\\"", "confidence": "high" }
  ]
}
- kind is only "person" or "relationship". relationshipType is only "PARENT_OF" (from = parent, to = child), "SPOUSE_OF", "PARTNER_OF", or "SIBLING_OF" (symmetric, store once). fromRef/toRef must be an existing roster id or a tempId from a person proposal in the same response. Grandparents, aunts/uncles and cousins are derived from parent/spouse/sibling edges, never emitted as their own edge types.
- If nothing clear can be extracted, return an empty proposals array and a reply asking for one fact, e.g. "My dad is Minh, born 1960 in Hanoi".`;

type OllamaProposal = Proposal & { [key: string]: unknown };

function normalizeProposals(raw: unknown): Proposal[] {
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
    out.push({
      id: typeof p.id === "string" && p.id ? p.id : `ollama-${i}`,
      kind: p.kind,
      tempId: typeof p.tempId === "string" ? p.tempId : undefined,
      displayName: typeof p.displayName === "string" ? p.displayName : undefined,
      preferredName: typeof p.preferredName === "string" ? p.preferredName : null,
      birthYear: typeof p.birthYear === "number" ? p.birthYear : null,
      birthPlace: typeof p.birthPlace === "string" ? p.birthPlace : null,
      bio: typeof p.bio === "string" ? p.bio : null,
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
    });
  });
  return out;
}

function graphLines(
  roster: RosterPerson[],
  relationships: RosterRelationship[]
): string[] {
  const nameFor = (id: string): string => {
    const p = roster.find((x) => x.id === id);
    return p ? p.displayName : id;
  };
  return relationships.map((r) => {
    const from = nameFor(r.fromPersonId);
    const to = nameFor(r.toPersonId);
    if (r.type === "PARENT_OF") return `- ${from} is a parent of ${to}`;
    if (r.type === "SPOUSE_OF") return `- ${from} is married to ${to}`;
    if (r.type === "PARTNER_OF") return `- ${from} is a partner of ${to}`;
    if (r.type === "SIBLING_OF") return `- ${from} is a sibling of ${to}`;
    return `- ${from} is related to ${to}`;
  });
}

async function tryOllama(
  message: string,
  roster: RosterPerson[],
  egoId: string | null,
  relationships: RosterRelationship[],
  history: ChatHistoryItem[]
): Promise<{ reply: string; proposals: Proposal[]; modelUsed: string } | null> {
  const host = process.env.OLLAMA_HOST || "http://localhost:11434";
  const model = process.env.OLLAMA_MODEL || "gemma4:12b";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const lines = graphLines(roster, relationships);
    const userPrompt = [
      `Existing people (roster, id + name + birth year/place if known):`,
      roster.length > 0
        ? roster
            .map(
              (p) =>
                `- ${p.id}: ${p.displayName}${p.preferredName ? ` (${p.preferredName})` : ""}${p.birthYear ? `, born ${p.birthYear}` : ""}${p.birthPlace ? ` in ${p.birthPlace}` : ""}`
            )
            .join("\n")
        : "- (none yet)",
      `Existing relationships (use these to resolve "my dad", "my brother", "Thuc's wife", etc.):`,
      lines.length > 0 ? lines.join("\n") : "- (none yet)",
      `Speaker (ego) id: ${egoId ?? "(not set yet — the first 'I am ...' person is the speaker)"}`,
      history.length > 0
        ? `Earlier chat in this conversation (for pronouns and relative words):\n${history
            .map((h) => `${h.role}: ${h.text}`)
            .join("\n")}`
        : ``,
      ``,
      `New message to extract from:`,
      message,
    ].join("\n");

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
        options: { temperature: 0.2 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data?.message?.content;
    if (typeof content !== "string" || !content.trim()) return null;
    let parsed: { reply?: unknown; proposals?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }
    const proposals = normalizeProposals(parsed.proposals);
    const reply =
      typeof parsed.reply === "string" && parsed.reply.trim()
        ? parsed.reply
        : "Please review the proposal cards below and accept the ones that are right.";
    return { reply, proposals, modelUsed: `ollama:${model}` };
  } catch {
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
    const relationships: RosterRelationship[] = Array.isArray(
      body.relationships
    )
      ? body.relationships.filter(
          (r: unknown) =>
            r != null &&
            typeof r === "object" &&
            typeof (r as RosterRelationship).fromPersonId === "string" &&
            typeof (r as RosterRelationship).toPersonId === "string" &&
            ["PARENT_OF", "SPOUSE_OF", "PARTNER_OF", "SIBLING_OF"].includes(
              (r as RosterRelationship).type
            )
        )
      : [];
    const history: ChatHistoryItem[] = Array.isArray(body.history)
      ? body.history
          .filter(
            (h: unknown) =>
              h != null &&
              typeof h === "object" &&
              typeof (h as ChatHistoryItem).text === "string"
          )
          .map((h: unknown) => ({
            role:
              (h as ChatHistoryItem).role === "assistant"
                ? ("assistant" as const)
                : ("user" as const),
            text: (h as ChatHistoryItem).text,
          }))
          .slice(-8)
      : [];
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
    const ollama = await tryOllama(
      message,
      roster,
      egoId,
      relationships,
      history
    );
    if (ollama) return NextResponse.json(ollama);

    const fallback = extractFallback(
      message,
      roster,
      egoId,
      relationships,
      history
    );
    return NextResponse.json(fallback);
  } catch {
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
