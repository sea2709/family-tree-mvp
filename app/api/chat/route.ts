import { NextResponse } from "next/server";
import type { Proposal, RosterPerson } from "@/lib/types";
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
- If the user says "I have a brother/sister" and the parents are known in the same message, also emit PARENT_OF from each known parent to that sibling, so siblings are derived from shared parents. Never emit a sibling edge type.
- Every proposal must include the exact user quote it came from in "reason".
- Output ONLY JSON, no prose, no markdown fences, with this exact shape:
{
  "reply": "a short friendly summary of what you think you heard, and what to confirm",
  "proposals": [
    { "id": "p1", "kind": "person", "tempId": "temp-minh", "displayName": "Minh", "birthYear": 1960, "birthPlace": "Hanoi", "reason": "You said: \\"...\\"", "confidence": "high" },
    { "id": "p2", "kind": "relationship", "fromRef": "temp-minh", "toRef": "<existing person id or tempId>", "relationshipType": "PARENT_OF", "reason": "You said: \\"...\\"", "confidence": "high" }
  ]
}
- kind is only "person" or "relationship". relationshipType is only "PARENT_OF" (from = parent, to = child), "SPOUSE_OF", or "PARTNER_OF". fromRef/toRef must be an existing roster id or a tempId from a person proposal in the same response. Siblings, grandparents, aunts/uncles and cousins are derived, never emitted as relationships.
- If nothing clear can be extracted, return an empty proposals array and a reply asking for one fact, e.g. "My dad is Minh, born 1960 in Hanoi".`;

type OllamaProposal = Proposal & { [key: string]: unknown };

function log(...args: unknown[]) {
  console.log(`[chat ${new Date().toISOString().slice(11, 23)}]`, ...args);
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
        p.relationshipType === "PARTNER_OF"
          ? p.relationshipType
          : undefined,
      reason: typeof p.reason === "string" ? p.reason : "From your message",
      confidence,
    });
  });
  return out;
}

async function tryOllama(
  message: string,
  roster: RosterPerson[],
  egoId: string | null
): Promise<{ reply: string; proposals: Proposal[]; modelUsed: string } | null> {
  const host = process.env.OLLAMA_HOST || "http://localhost:11434";
  const model = process.env.OLLAMA_MODEL || "gemma4:12b";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  const started = Date.now();
  try {
    const userPrompt = [
      `Existing people (roster, id + name + birth year/place if known):`,
      roster.length > 0
        ? roster
            .map(
              (p) =>
                `- ${p.id}: ${p.displayName}${p.birthYear ? `, born ${p.birthYear}` : ""}${p.birthPlace ? ` in ${p.birthPlace}` : ""}`
            )
            .join("\n")
        : "- (none yet)",
      `Speaker (ego) id: ${egoId ?? "(not set yet — the first 'I am ...' person is the speaker)"}`,
      ``,
      `New message to extract from:`,
      message,
    ].join("\n");

    log(`ollama → ${host} model=${model}, prompt ${userPrompt.length} chars`);
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
    const proposals = normalizeProposals(parsed.proposals);
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
    log(`request: "${preview(message)}" (roster ${roster.length}, ego ${egoId ?? "none"})`);
    const ollama = await tryOllama(message, roster, egoId);
    if (ollama) {
      logProposals(ollama.modelUsed, ollama.proposals);
      return NextResponse.json(ollama);
    }

    const started = Date.now();
    const fallback = extractFallback(message, roster, egoId);
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
