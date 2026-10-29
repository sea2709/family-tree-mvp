import type {
  ChatHistoryItem,
  Proposal,
  RosterPerson,
  RosterRelationship,
} from "./types";

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
// full name, the short name is the preferred name. A bare name
// ("Hoa", "Tran Hieu Hoa") has no preferred name.
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
  egoId: string | null,
  relationships: RosterRelationship[] = [],
  history: ChatHistoryItem[] = []
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
  // "Hoa (Tran Hieu Hoa)" is stored as display Tran Hieu Hoa,
  // preferred Hoa; a later bare "Hoa" reuses the same person, and a
  // later full name upgrades a short-name-only proposal in place.
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
        // Upgrade a short-name proposal to its full name, if given.
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

  // Graph helpers over the edges already in the tree (the second
  // prompt's context). The roster alone cannot answer "my dad's
  // brother" — it says Hoa exists, not that Hoa is Dang's dad.
  const parentsOf = (id: string | null): string[] =>
    id == null
      ? []
      : relationships
          .filter((r) => r.type === "PARENT_OF" && r.toPersonId === id)
          .map((r) => r.fromPersonId);
  const siblingsOf = (id: string | null): string[] => {
    if (id == null) return [];
    const explicit = relationships
      .filter(
        (r) =>
          r.type === "SIBLING_OF" &&
          (r.fromPersonId === id || r.toPersonId === id)
      )
      .map((r) => (r.fromPersonId === id ? r.toPersonId : r.fromPersonId));
    const parents = parentsOf(id);
    const shared =
      parents.length === 0
        ? []
        : relationships
            .filter(
              (r) =>
                r.type === "PARENT_OF" &&
                parents.includes(r.fromPersonId) &&
                r.toPersonId !== id
            )
            .map((r) => r.toPersonId);
    return [...new Set([...explicit, ...shared])];
  };

  // "My dad" vs "my mom" cannot be told apart from the graph alone
  // (both are just parents, with no gender stored), so scan earlier
  // user turns for "my dad name is Hoa" / "my mom name is Luan".
  // This is what lets a second prompt's "my dad's brother" resolve.
  const dadMomFromHistory = (): {
    dad: string | null;
    mom: string | null;
  } => {
    let dad: string | null = null;
    let mom: string | null = null;
    for (const h of history) {
      if (h.role !== "user") continue;
      const dadRe =
        /\bmy\s+(?:dad|father)\s+(?:'s\s+)?(?:(?:name|nam)\s+)?is\s+([^.,;]+?)(?:,|\.|$|\s+and\s+my\s)/gi;
      const momRe =
        /\bmy\s+(?:mom|mother)\s+(?:'s\s+)?(?:(?:name|nam)\s+)?is\s+([^.,;]+?)(?:,|\.|$|\s+and\s+my\s)/gi;
      for (const m of h.text.matchAll(dadRe)) {
        const found = findRoster(cleanName(m[1]));
        if (found) dad = found.id;
      }
      for (const m of h.text.matchAll(momRe)) {
        const found = findRoster(cleanName(m[1]));
        if (found) mom = found.id;
      }
    }
    return { dad, mom };
  };

  let clarifyNote: string | null = null;

  const addRelationship = (
    fromRef: string,
    toRef: string,
    type: "PARENT_OF" | "SPOUSE_OF" | "PARTNER_OF" | "SIBLING_OF",
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

  // Seed dad/mom from earlier turns so a second prompt can resolve
  // "my dad's brother" even though the graph stores no gender.
  // A parent named in this message still overwrites the seed below.
  const historyParents = dadMomFromHistory();
  if (!dadRef) dadRef = historyParents.dad;
  if (!momRef) momRef = historyParents.mom;

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

  // Split into sentences, then into clauses, so one sentence can
  // carry two facts: "My dad name is Hoa (...), and my mom nam is
  // Luan (...)" and "I have a brother, his name is Thuc (...)".
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
      // "My name is Dang, full name is Tran Hai Dang": upgrade the
      // ego proposal to the full name, keeping Dang as preferred.
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

    // 1b. "I have a brother/sister" (name comes in the next clause).
    const haveSiblingMatch = sentence.match(
      /\bi have a (brother|sister)\b/i
    );
    if (haveSiblingMatch && !/\bname\s+is\b/i.test(sentence)) {
      pendingSiblingRole = haveSiblingMatch[1].toLowerCase() as
        | "brother"
        | "sister";
    }
    // "..., his/her name is Thuc (...)" after "I have a brother".
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

    // 1c. "My dad's brother/sister/mom/dad/wife/husband is X" — the
    // second-prompt case. Dad/mom come from the history seed above,
    // not from this sentence alone.
    const myParentRelMatch = sentence.match(
      /\bmy\s+(dad|father|mom|mother)'s\s+(brother|sister|mom|mother|dad|father|wife|husband)\s+is\s+(.+?)(?:[.,]|$)/i
    );
    if (myParentRelMatch) {
      const parentRole = myParentRelMatch[1].toLowerCase();
      const role2 = myParentRelMatch[2].toLowerCase();
      const parentRef =
        parentRole === "dad" || parentRole === "father" ? dadRef : momRef;
      const name = cleanName(myParentRelMatch[3]);
      const ref = getOrCreate(name, sentence, "high");
      sentenceRef = ref;
      lastRef = ref;
      lastName = name;
      if (parentRef) {
        if (role2 === "brother" || role2 === "sister") {
          addRelationship(parentRef, ref, "SIBLING_OF", sentence, "high");
        } else if (
          role2 === "mom" ||
          role2 === "mother" ||
          role2 === "dad" ||
          role2 === "father"
        ) {
          addRelationship(ref, parentRef, "PARENT_OF", sentence, "high");
        } else {
          addRelationship(parentRef, ref, "SPOUSE_OF", sentence, "high");
        }
      } else {
        clarifyNote = `I created ${name} but didn't link them yet, because I couldn't tell which of your parents is your ${parentRole} from the tree so far — tell me their name and I'll link them.`;
        const person = proposals.find(
          (p) => p.kind === "person" && p.tempId === ref
        );
        if (person) person.confidence = "medium";
      }
    }

    // 1d. "My brother's wife/husband/son/daughter is X". The sibling
    // is unambiguous only if the speaker has exactly one sibling
    // in the graph; otherwise ask which one.
    const mySiblingRelMatch = sentence.match(
      /\bmy\s+(brother|sister)'s\s+(wife|husband|son|daughter)\s+is\s+(.+?)(?:[.,]|$)/i
    );
    if (mySiblingRelMatch && egoRef) {
      const siblings = siblingsOf(egoRef);
      const role2 = mySiblingRelMatch[2].toLowerCase();
      const name = cleanName(mySiblingRelMatch[3]);
      const ref = getOrCreate(name, sentence, "high");
      sentenceRef = ref;
      lastRef = ref;
      lastName = name;
      if (siblings.length === 1) {
        const sib = siblings[0];
        if (role2 === "wife" || role2 === "husband") {
          addRelationship(sib, ref, "SPOUSE_OF", sentence, "high");
        } else {
          addRelationship(sib, ref, "PARENT_OF", sentence, "high");
        }
      } else {
        clarifyNote = `I created ${name} but didn't link them yet, because I couldn't tell which sibling you mean — tell me their name and I'll link them.`;
        const person = proposals.find(
          (p) => p.kind === "person" && p.tempId === ref
        );
        if (person) person.confidence = "medium";
      }
    }

    // 1e. "<Name>'s dad/mom/brother/sister/wife/husband/son/daughter is X"
    const namedPossMatch = sentence.match(
      /^([A-Z][A-Za-z' -]+?(?:\s*\([^)]+\))?)\s*'s\s+(dad|father|mom|mother|brother|sister|wife|husband|son|daughter)\s+is\s+(.+?)(?:[.,]|$)/i
    );
    // Guard: "My dad's brother ..." and "My brother's wife ..."
    // are already handled above; without this guard the named
    // pattern would create a bogus person called "My dad".
    if (namedPossMatch && !/^\s*my\s/i.test(sentence)) {
      const baseName = cleanName(namedPossMatch[1]);
      const role = namedPossMatch[2].toLowerCase();
      const name = cleanName(namedPossMatch[3]);
      const baseRef = getOrCreate(baseName, sentence, "high");
      const ref = getOrCreate(name, sentence, "high");
      sentenceRef = ref;
      lastRef = ref;
      lastName = name;
      if (role === "brother" || role === "sister") {
        addRelationship(baseRef, ref, "SIBLING_OF", sentence, "high");
      } else if (role === "wife" || role === "husband") {
        addRelationship(baseRef, ref, "SPOUSE_OF", sentence, "high");
      } else if (
        role === "mom" ||
        role === "mother" ||
        role === "dad" ||
        role === "father"
      ) {
        addRelationship(ref, baseRef, "PARENT_OF", sentence, "high");
      } else {
        addRelationship(baseRef, ref, "PARENT_OF", sentence, "high");
      }
    }

    // 2. "My dad/father/mom/mother/brother/sister/son/daughter is X"
    //    and "My dad/mom name is X" (also "dad's name is", "mom nam is").
    const relMatch = sentence.match(
      /\bmy\s+(dad|father|mom|mother|brother|sister|son|daughter|child)\s+(?:'s\s+)?(?:(?:name|nam)\s+)?is\s+([A-Z][A-Za-z' -]+?(?:\s*\([^)]+\))?)(?:,|\.|$|\s+born\b|\s+and\s+my\s)/i
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
        // brother/sister: no direct edge type exists. Record the
        // sibling and link it to the known parents at the end of
        // the message, so siblings are derived from shared parents.
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

  // Link every sibling mentioned in this message to the parents
  // mentioned in the same message — or, on a second prompt, to
  // the speaker's parents already in the graph. Without this, a
  // later "I have a brother" floats unlinked even though the
  // parents are already known.
  const siblingParentRefs = [...new Set([
    ...(dadRef ? [dadRef] : []),
    ...(momRef ? [momRef] : []),
    ...parentsOf(egoRef),
  ])];
  for (const sibling of siblingRefs) {
    for (const parentRef of siblingParentRefs) {
      addRelationship(parentRef, sibling.ref, "PARENT_OF", sibling.sentence, "medium");
    }
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
    if (clarifyNote) reply += ` ${clarifyNote}`;
  }
  void lastName;

  return { reply, proposals, modelUsed: "fallback" };
}
