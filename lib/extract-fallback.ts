import type { Proposal, RosterPerson } from "./types";

export type ExtractResult = {
  reply: string;
  proposals: Proposal[];
  modelUsed: "fallback";
};

let counter = 0;

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "person"
  );
}

function cleanName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,;:]+$/g, "")
    .trim();
}

function titleCaseName(name: string): string {
  // Keep the user's spelling; only tidy whitespace. Names are not
  // lowercased or reordered here — see the sketch on Vietnamese names.
  return cleanName(name);
}

// "Hoa (Tran Hieu Hoa)" or "Tran Hieu Hoa (Hoa)" -> display is the
// full name, the short name is the preferred name.
function parseName(raw: string): {
  displayName: string;
  preferredName?: string;
} {
  const cleaned = cleanName(raw);
  const m = cleaned.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (m) {
    const a = cleanName(m[1]);
    const b = cleanName(m[2]);
    if (a.split(/\s+/).length >= b.split(/\s+/).length) {
      return { displayName: a, preferredName: b };
    }
    return { displayName: b, preferredName: a };
  }
  return { displayName: cleaned };
}

/**
 * Deterministic heuristic extractor. Used ONLY when Ollama is
 * unavailable, so the demo still works without a model running.
 *
 * Guarantees (from the sketch):
 * - Only explicitly stated facts become proposals. No invented dates.
 * - A name that already exists in the roster is reused by id, never
 *   duplicated as a new person.
 * - Ambiguous relations (uncle/aunt/cousin, sibling without known
 *   parents) become a person proposal at most, never a guessed edge.
 * - "born 1960 in Hanoi" is stored as year_only, not an exact date.
 */
export function extractFallback(
  message: string,
  roster: RosterPerson[],
  egoId: string | null
): ExtractResult {
  const proposals: Proposal[] = [];
  const personByTemp = new Map<string, string>(); // tempId -> displayName
  const tempByName = new Map<string, string>(); // lowercase name -> tempId
  let egoRef: string | null = egoId;
  let lastRef: string | null = egoId;
  let lastName: string | null = null;
  let dadRef: string | null = null;
  let momRef: string | null = null;
  let pendingSiblingRole: "brother" | "sister" | null = null;
  const siblingRefs: { ref: string; sentence: string }[] = [];

  const findRoster = (name: string): RosterPerson | undefined => {
    const parsed = parseName(name);
    const candidates = [
      parsed.displayName.toLowerCase(),
      ...(parsed.preferredName ? [parsed.preferredName.toLowerCase()] : []),
    ];
    return roster.find(
      (p) =>
        candidates.includes(p.displayName.toLowerCase()) ||
        (p.preferredName != null &&
          candidates.includes(p.preferredName.toLowerCase()))
    );
  };

  // Returns a ref: an existing roster id, or a tempId for a proposal
  // created in this batch. Never creates two proposals for one name.
  const getOrCreate = (
    name: string,
    sentence: string,
    confidence: Proposal["confidence"]
  ): string => {
    const parsed = parseName(name);
    const displayName = titleCaseName(parsed.displayName);
    const preferredName = parsed.preferredName
      ? titleCaseName(parsed.preferredName)
      : undefined;
    const existing = findRoster(name);
    if (existing) return existing.id;
    const keys = [
      displayName.toLowerCase(),
      ...(preferredName ? [preferredName.toLowerCase()] : []),
    ];
    for (const key of keys) {
      const already = tempByName.get(key);
      if (already) {
        const proposal = proposals.find(
          (p) => p.kind === "person" && p.tempId === already
        );
        if (
          proposal &&
          proposal.displayName &&
          proposal.displayName.split(/\s+/).length <
            displayName.split(/\s+/).length
        ) {
          proposal.preferredName = proposal.displayName;
          proposal.displayName = displayName;
          personByTemp.set(already, displayName);
        }
        for (const k of keys) tempByName.set(k, already);
        return already;
      }
    }
    const tempId = `temp-${slug(displayName)}-${counter + 1}`;
    counter += 1;
    for (const key of keys) tempByName.set(key, tempId);
    personByTemp.set(tempId, displayName);
    proposals.push({
      id: nextId("prop"),
      kind: "person",
      tempId,
      displayName,
      preferredName: preferredName ?? null,
      reason: `You said: "${sentence.trim()}"`,
      confidence,
    });
    return tempId;
  };

  const addRelationship = (
    fromRef: string,
    toRef: string,
    type: "PARENT_OF" | "SPOUSE_OF" | "PARTNER_OF",
    sentence: string,
    confidence: Proposal["confidence"]
  ) => {
    if (!fromRef || !toRef || fromRef === toRef) return;
    const duplicate = proposals.some(
      (p) =>
        p.kind === "relationship" &&
        p.relationshipType === type &&
        ((p.fromRef === fromRef && p.toRef === toRef) ||
          (type !== "PARENT_OF" && p.fromRef === toRef && p.toRef === fromRef))
    );
    if (duplicate) return;
    proposals.push({
      id: nextId("prop"),
      kind: "relationship",
      fromRef,
      toRef,
      relationshipType: type,
      reason: `You said: "${sentence.trim()}"`,
      confidence,
    });
  };

  const attachBirth = (sentence: string, ref: string | null) => {
    if (!ref) return;
    const born = sentence.match(
      /\bborn\s+(?:around\s+|in\s+)?(\d{4})(?:\s+in\s+([A-Za-z][A-Za-z\s.'-]*?))?(?:[.,]|$)/i
    );
    if (!born) return;
    const year = Number(born[1]);
    if (!Number.isFinite(year) || year < 1800 || year > 2100) return;
    const place = born[2] ? cleanName(born[2]) : null;
    // Attach to the person proposal if this batch created it; if the
    // person already existed, the page's Accept step ignores a
    // birth-only update in this MVP (the detail panel can edit it).
    const proposal = proposals.find(
      (p) => p.kind === "person" && p.tempId === ref
    );
    if (proposal) {
      proposal.birthYear = year;
      if (place) proposal.birthPlace = place;
    }
  };

  const sentences = message
    .split(/(?<=[.!?])\s+/)
    .flatMap((s) =>
      s
        .split(/,\s+and\s+(?=my\s)/i)
        .flatMap((p) => p.split(/\s+and\s+(?=my\s)/i))
        .flatMap((p) =>
          p.split(/,\s+(?=his\s+name\s+is|her\s+name\s+is)/i)
        )
    )
    .map((s) => s.trim())
    .filter(Boolean);

  for (const sentence of sentences) {
    let sentenceRef: string | null = null;

    // 1. Ego: "I'm Lan" / "I am Lan" / "My name is Lan"
    const egoMatch = sentence.match(
      /\b(?:i am|i'm|my name is)\s+([A-Z][A-Za-z' -]+?)(?:[.,]|$)/i
    );
    if (egoMatch) {
      const name = cleanName(egoMatch[1]);
      const ref = getOrCreate(name, sentence, "high");
      if (!egoRef) egoRef = ref;
      sentenceRef = ref;
      lastRef = ref;
      lastName = name;

      const fullMatch = sentence.match(
        /\bfull name is\s+([A-Z][A-Za-z' -]+?)(?:[.,]|$)/i
      );
      if (fullMatch) {
        const full = cleanName(fullMatch[1]);
        const proposal = proposals.find(
          (p) => p.kind === "person" && p.tempId === ref
        );
        if (proposal && proposal.displayName !== full) {
          proposal.preferredName = proposal.displayName;
          proposal.displayName = full;
          personByTemp.set(ref, full);
        }
      }
    }

    // "I have a brother, his name is X" (split into two clauses above)
    const haveSiblingMatch = sentence.match(/\bi have a (brother|sister)\b/i);
    if (haveSiblingMatch && !/\bname\s+is\b/i.test(sentence)) {
      pendingSiblingRole = haveSiblingMatch[1].toLowerCase() as
        | "brother"
        | "sister";
    }
    const hisNameMatch = sentence.match(
      /\b(?:his|her|their)\s+name\s+is\s+(.+?)(?:[.,]|$)/i
    );
    if (hisNameMatch && pendingSiblingRole && egoRef) {
      const name = cleanName(hisNameMatch[1]);
      const ref = getOrCreate(name, sentence, "high");
      siblingRefs.push({ ref, sentence });
      sentenceRef = ref;
      lastRef = ref;
      lastName = name;
      pendingSiblingRole = null;
    }

    // 2. "My dad/father/mom/mother/brother/sister/son/daughter is X",
    //    also "My dad name is X", "My dad's name is X", "My mom nam is X"
    const relMatch = sentence.match(
      /\bmy\s+(dad|father|mom|mother|brother|sister|son|daughter|child)(?:'s)?\s+(?:(?:name|nam)\s+)?is\s+([A-Z][A-Za-z' -]+?(?:\s*\([^)]+\))?)(?:,|\.|$|\s+born\b|\s+and\s+my\s)/i
    );
    if (relMatch && egoRef) {
      const role = relMatch[1].toLowerCase();
      const name = cleanName(relMatch[2]);
      const ref = getOrCreate(name, sentence, "high");
      sentenceRef = ref;
      lastRef = ref;
      lastName = name;
      if (role === "dad" || role === "father" || role === "mom" || role === "mother") {
        addRelationship(ref, egoRef, "PARENT_OF", sentence, "high");
        if (role === "dad" || role === "father") dadRef = ref;
        else momRef = ref;
      } else if (role === "son" || role === "daughter" || role === "child") {
        addRelationship(egoRef, ref, "PARENT_OF", sentence, "high");
      } else {
        // brother/sister: no direct edge type exists (siblings are
        // derived from shared parents), so link via known parents
        // after the loop.
        siblingRefs.push({ ref, sentence });
        const person = proposals.find(
          (p) => p.kind === "person" && p.tempId === ref
        );
        if (person) person.confidence = "medium";
      }
    }

    // 3. Reversed: "X is my dad/mom/..."
    if (!relMatch) {
      const revMatch = sentence.match(
        /^([A-Z][A-Za-z' -]+?)\s+is\s+my\s+(dad|father|mom|mother|brother|sister|son|daughter|child)\b/i
      );
      if (revMatch && egoRef) {
        const name = cleanName(revMatch[1]);
        const role = revMatch[2].toLowerCase();
        const ref = getOrCreate(name, sentence, "high");
        sentenceRef = ref;
        lastRef = ref;
        lastName = name;
        if (role === "dad" || role === "father" || role === "mom" || role === "mother") {
          addRelationship(ref, egoRef, "PARENT_OF", sentence, "high");
          if (role === "dad" || role === "father") dadRef = ref;
          else momRef = ref;
        } else if (role === "son" || role === "daughter" || role === "child") {
          addRelationship(egoRef, ref, "PARENT_OF", sentence, "high");
        } else {
          siblingRefs.push({ ref, sentence });
        }
      }
    }

    // 4. Marriage: "He married my mom, Hoa" / "Minh married Hoa" /
    //    "She is married to Y"
    const marriedMatch = sentence.match(
      /\bmarried\s+(?:to\s+)?(?:my\s+(mom|mother|dad|father)\s*,\s*)?([A-Z][A-Za-z' -]+?)(?:[.,]|$)/i
    );
    if (marriedMatch) {
      const spouseName = cleanName(marriedMatch[2]);
      const spouseRef = getOrCreate(spouseName, sentence, "medium");
      const subjectAtStart = sentence.match(/^([A-Z][A-Za-z' -]+?)\s+(?:is\s+)?married\b/i);
      let subjectRef: string | null = lastRef;
      if (subjectAtStart && !/^(he|she|they)$/i.test(subjectAtStart[1])) {
        subjectRef = getOrCreate(cleanName(subjectAtStart[1]), sentence, "medium");
      }
      if (subjectRef) {
        addRelationship(subjectRef, spouseRef, "SPOUSE_OF", sentence, "medium");
      }
      // "my mom" / "my dad" in the marriage clause also means parent.
      const parentRole = marriedMatch[1]?.toLowerCase();
      if (parentRole && egoRef) {
        addRelationship(spouseRef, egoRef, "PARENT_OF", sentence, "medium");
      }
      sentenceRef = spouseRef;
      lastRef = spouseRef;
      lastName = spouseName;
    }

    // 5. Ambiguous relatives: person only, never a guessed edge.
    const vagueMatch = sentence.match(
      /\bmy\s+(uncle|aunt|cousin)\s+([A-Z][A-Za-z' -]+?)(?:[.,]|$)/i
    );
    if (vagueMatch && !sentenceRef) {
      const name = cleanName(vagueMatch[2]);
      const ref = getOrCreate(name, sentence, "low");
      sentenceRef = ref;
      lastRef = ref;
      lastName = name;
    }

    // 6. Standalone birth fact: "Minh, born 1960 in Hanoi"
    if (!sentenceRef) {
      const standalone = sentence.match(
        /^([A-Z][A-Za-z' -]+?),\s*born\s+\d{4}/i
      );
      if (standalone) {
        const name = cleanName(standalone[1]);
        const ref = getOrCreate(name, sentence, "medium");
        sentenceRef = ref;
        lastRef = ref;
        lastName = name;
      }
    }

    // Birth details attach to the person mentioned in this sentence,
    // or (for "He was born in 1960...") to the last-mentioned person.
    attachBirth(sentence, sentenceRef ?? lastRef);
    if (sentenceRef) lastRef = sentenceRef;
  }

  for (const sibling of siblingRefs) {
    if (dadRef) addRelationship(dadRef, sibling.ref, "PARENT_OF", sibling.sentence, "medium");
    if (momRef) addRelationship(momRef, sibling.ref, "PARENT_OF", sibling.sentence, "medium");
  }

  const personNames = proposals
    .filter((p) => p.kind === "person" && p.displayName)
    .map((p) => p.displayName as string);
  const vague = /\bmy\s+(uncle|aunt|cousin)\b/i.test(message);

  let reply: string;
  if (proposals.length === 0) {
    reply =
      "I couldn't pull a clear family fact from that. Could you try something like “My dad is Minh, born 1960 in Hanoi”? " +
      "Names, parents, spouses, and children work best — one fact at a time is fine.";
  } else {
    const names = [...new Set(personNames)];
    reply =
      `I think I heard about ${names.length > 0 ? names.join(", ") : "someone new"}. ` +
      "Please review the proposal cards below and accept the ones that are right — " +
      "nothing is added to the tree until you accept it.";
    if (vague) {
      reply +=
        " One note: “uncle”, “aunt”, and “cousin” are ambiguous, so I didn't guess which side of the family — " +
        "tell me whose sibling they are and I'll link them properly.";
    }
  }
  void lastName;

  return { reply, proposals, modelUsed: "fallback" };
}
