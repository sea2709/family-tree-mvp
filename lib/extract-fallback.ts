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

// Keeps the leading run of capitalised words plus an optional
// "(Full Name)" alias, so "Tuan lives in Saigon" -> "Tuan". The
// capture regexes are case-insensitive, so without this a name runs
// on until the next comma. All-lowercase input ("my dad is minh")
// keeps just the first word.
function trimName(raw: string): string {
  const tokens = cleanName(raw).match(/\([^)]*\)|[^\s(]+/g) ?? [];
  const kept: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("(")) {
      if (kept.length === 0) break;
      kept.push(token);
      continue;
    }
    if (/^\p{Lu}/u.test(token)) {
      kept.push(token);
      continue;
    }
    if (kept.length === 0) kept.push(token);
    break;
  }
  return cleanName(kept.join(" "));
}

// "Thanh Ha, Tra My and Anh Khoi" -> ["Thanh Ha", "Tra My", "Anh Khoi"].
// Commas inside "(Full Name)" aliases are kept.
function splitNameList(text: string): string[] {
  return text
    .split(/\s*,\s*(?:and\s+)?(?![^(]*\))|\s+and\s+(?![^(]*\))|\s*&\s*/i)
    .map(trimName)
    .filter((n) => /^\p{Lu}/u.test(n));
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
    rawName: string,
    sentence: string,
    confidence: Proposal["confidence"]
  ): string => {
    const name = trimName(rawName);
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
  const spousesOf = (id: string | null): string[] =>
    id == null
      ? []
      : [
          ...relationships
            .filter(
              (r) =>
                (r.type === "SPOUSE_OF" || r.type === "PARTNER_OF") &&
                (r.fromPersonId === id || r.toPersonId === id)
            )
            .map((r) => (r.fromPersonId === id ? r.toPersonId : r.fromPersonId)),
          ...proposals
            .filter(
              (p) =>
                p.kind === "relationship" &&
                (p.relationshipType === "SPOUSE_OF" || p.relationshipType === "PARTNER_OF") &&
                (p.fromRef === id || p.toRef === id)
            )
            .map((p) => (p.fromRef === id ? p.toRef! : p.fromRef!)),
        ];

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
        const found = findRoster(trimName(m[1]));
        if (found) dad = found.id;
      }
      for (const m of h.text.matchAll(momRe)) {
        const found = findRoster(trimName(m[1]));
        if (found) mom = found.id;
      }
    }
    return { dad, mom };
  };

  let clarifyNote: string | null = null;
  // Most recent couple in this message, for "They have 3 kids: ...".
  let lastCouple: [string, string] | null = null;
  let alreadyKnown = 0;
  // "He is 2 years younger than me": birthYear(a) = birthYear(b) + years.
  // Resolved after the whole message, since the known year may come
  // later in the same sentence ("... and was born in 1990").
  const relativeAges: { a: string; b: string; years: number; sentence: string }[] = [];

  const addRelationship = (
    fromRef: string,
    toRef: string,
    type: "PARENT_OF" | "SPOUSE_OF" | "PARTNER_OF" | "SIBLING_OF",
    sentence: string,
    confidence: Proposal["confidence"]
  ) => {
    if (!fromRef || !toRef || fromRef === toRef) return;
    if (type === "SPOUSE_OF" || type === "PARTNER_OF") lastCouple = [fromRef, toRef];
    const alreadyInTree = relationships.some(
      (r) =>
        r.type === type &&
        ((r.fromPersonId === fromRef && r.toPersonId === toRef) ||
          (type !== "PARENT_OF" && r.fromPersonId === toRef && r.toPersonId === fromRef))
    );
    if (alreadyInTree) {
      alreadyKnown += 1;
      return;
    }
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

  // A person proposal whose tempId is an existing roster id is an
  // update to that person (same shape the Ollama path uses).
  const updateFor = (rosterId: string, sentence: string): Proposal => {
    const already = proposals.find(
      (p) => p.kind === "person" && p.tempId === rosterId
    );
    if (already) return already;
    const update: Proposal = {
      id: nextId("prop"),
      kind: "person",
      tempId: rosterId,
      displayName: roster.find((r) => r.id === rosterId)?.displayName,
      reason: `You said: "${sentence.trim()}"`,
      confidence: "high",
    };
    proposals.push(update);
    return update;
  };

  const attachBirth = (sentence: string, ref: string | null) => {
    if (!ref) return;
    const born = sentence.match(
      /\bborn\s+(?:around\s+|in\s+)?(\d{4})(?:\s+in\s+([A-Za-z][A-Za-z\s.'-]*?))?(?:[.,]|$)/iu
    );
    if (!born) return;
    const year = Number(born[1]);
    if (!Number.isFinite(year) || year < 1800 || year > 2100) return;
    const place = born[2] ? cleanName(born[2]) : null;
    const proposal =
      proposals.find((p) => p.kind === "person" && p.tempId === ref) ??
      (roster.some((r) => r.id === ref) ? updateFor(ref, sentence) : undefined);
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
    // "I am married to Mai" / "I'm 35" / "I am the eldest" are not names.
    const egoMatch = sentence.match(
      /\b(?:i am|i'm|my name is)\s+(?!(?:married|engaged|divorced|the|a|an|also|from|born|not|now|still|their|his|her|your|older|younger|single)\b)(\p{L}[\p{L}' -]+?)(?:[.,]|$)/iu
    );
    if (egoMatch) {
      const name = trimName(egoMatch[1]);
      const ref = getOrCreate(name, sentence, "high");
      if (!egoRef) {
        egoRef = ref;
        const speaker = proposals.find((p) => p.kind === "person" && p.tempId === ref);
        if (speaker) speaker.isSpeaker = true;
      }
      sentenceRef = ref;
      lastRef = ref;
      lastName = name;
      // "My name is Dang, full name is Tran Hai Dang": upgrade the
      // ego proposal to the full name, keeping Dang as preferred.
      const fullMatch = sentence.match(
        /\bfull name is\s+(\p{L}[\p{L}' -]+?)(?:[.,]|$)/iu
      );
      if (fullMatch) {
        const full = trimName(fullMatch[1]);
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
      /\b(?:his|her|their)\s+name\s+is\s+(.+?)(?:[.,]|$)/iu
    );
    if (hisNameMatch && pendingSiblingRole && egoRef) {
      const name = trimName(hisNameMatch[1]);
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
      /\bmy\s+(dad|father|mom|mother)'s\s+(brother|sister|mom|mother|dad|father|wife|husband)\s+is\s+(.+?)(?:[.,]|$)/iu
    );
    if (myParentRelMatch) {
      const parentRole = myParentRelMatch[1].toLowerCase();
      const role2 = myParentRelMatch[2].toLowerCase();
      const parentRef =
        parentRole === "dad" || parentRole === "father" ? dadRef : momRef;
      const name = trimName(myParentRelMatch[3]);
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
      /\bmy\s+(brother|sister)'s\s+(wife|husband|son|daughter)\s+is\s+(.+?)(?:[.,]|$)/iu
    );
    if (mySiblingRelMatch && egoRef) {
      const siblings = siblingsOf(egoRef);
      const role2 = mySiblingRelMatch[2].toLowerCase();
      const name = trimName(mySiblingRelMatch[3]);
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
      /^(\p{L}[\p{L}' -]+?(?:\s*\([^)]+\))?)\s*'s\s+(dad|father|mom|mother|brother|sister|wife|husband|son|daughter)\s+is\s+(.+?)(?:[.,]|$)/iu
    );
    // Guard: "My dad's brother ..." and "My brother's wife ..."
    // are already handled above; without this guard the named
    // pattern would create a bogus person called "My dad".
    if (namedPossMatch && !/^\s*my\s/i.test(sentence)) {
      const baseName = trimName(namedPossMatch[1]);
      const role = namedPossMatch[2].toLowerCase();
      const name = trimName(namedPossMatch[3]);
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
      /\bmy\s+(dad|father|mom|mother|brother|sister|son|daughter|child|wife|husband|partner)\s*(?:'s\s+)?(?:(?:name|nam)\s+)?is\s+(\p{L}[\p{L}' -]+?(?:\s*\([^)]+\))?)(?:,|\.|$|\s+born\b|\s+and\s+my\s)/iu
    );
    if (relMatch && egoRef) {
      const role = relMatch[1].toLowerCase();
      const name = trimName(relMatch[2]);
      const ref = getOrCreate(name, sentence, "high");
      sentenceRef = ref;
      lastRef = ref;
      lastName = name;
      if (role === "wife" || role === "husband" || role === "partner") {
        addRelationship(egoRef, ref, role === "partner" ? "PARTNER_OF" : "SPOUSE_OF", sentence, "high");
      } else if (role === "dad" || role === "father" || role === "mom" || role === "mother") {
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
        /^(\p{L}[\p{L}' -]+?)\s+is\s+my\s+(dad|father|mom|mother|brother|sister|son|daughter|child|wife|husband|partner)\b/iu
      );
      if (revMatch && egoRef) {
        const name = trimName(revMatch[1]);
        const role = revMatch[2].toLowerCase();
        const ref = getOrCreate(name, sentence, "high");
        sentenceRef = ref;
        lastRef = ref;
        lastName = name;
        if (role === "wife" || role === "husband" || role === "partner") {
          addRelationship(egoRef, ref, role === "partner" ? "PARTNER_OF" : "SPOUSE_OF", sentence, "high");
        } else if (role === "dad" || role === "father" || role === "mom" || role === "mother") {
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

    // 3b. "My parents are Minh and Hoa"
    const parentsMatch = sentence.match(/\bmy\s+parents\s+are\s+(.+?)(?:\.|$)/i);
    if (parentsMatch && egoRef) {
      for (const raw of splitNameList(parentsMatch[1])) {
        const ref = getOrCreate(raw, sentence, "high");
        addRelationship(ref, egoRef, "PARENT_OF", sentence, "high");
        sentenceRef = ref;
      }
    }

    // 3c. "My brother full name is Tran Dang Thuc" / "Thuc's full name
    // is ..." / "His full name is ...": rename someone already known,
    // keeping the old name as the preferred name. Skipped when the
    // ego clause above already handled "My name is X, full name is Y".
    const fullNameMatch = egoMatch
      ? null
      : sentence.match(
          /^(?:(my)(?:\s+(dad|father|mom|mother|brother|sister|wife|husband|partner|son|daughter))?|(he|she|his|her)|(\p{L}[\p{L}' -]+?))(?:'s)?\s+full\s+name\s+is\s+(.+?)(?:[.,]|$)/iu
        );
    if (fullNameMatch) {
      const [, my, role, pronoun, named, rawFull] = fullNameMatch;
      const r = role?.toLowerCase();
      let target: string | null = null;
      if (my && !r) target = egoRef;
      else if (r === "dad" || r === "father") target = dadRef;
      else if (r === "mom" || r === "mother") target = momRef;
      else if (r === "brother" || r === "sister") {
        const sibs = siblingsOf(egoRef);
        target = sibs.length === 1 ? sibs[0] : null;
      } else if (r === "wife" || r === "husband" || r === "partner") {
        const sp = spousesOf(egoRef);
        target = sp.length === 1 ? sp[0] : null;
      } else if (pronoun) target = lastRef;
      else if (named) target = findRoster(named)?.id ?? tempByName.get(trimName(named).toLowerCase()) ?? null;

      const full = trimName(rawFull);
      if (target && full) {
        const proposal =
          proposals.find((p) => p.kind === "person" && p.tempId === target) ??
          (roster.some((x) => x.id === target) ? updateFor(target, sentence) : undefined);
        const oldName =
          roster.find((x) => x.id === target)?.displayName ?? proposal?.displayName;
        if (proposal && oldName !== full) {
          proposal.displayName = full;
          proposal.preferredName = oldName ?? null;
          personByTemp.set(target, full);
        }
        sentenceRef = target;
      } else if (full) {
        clarifyNote = `I couldn't tell whose full name ${full} is — tell me their current name and I'll update them.`;
      }
    }

    // 3d. "They have 3 kids: Thanh Ha, Tra My and Anh Khoi" / "We have
    // two kids, An and Binh" / "Their children are ...".
    const kidsMatch =
      sentence.match(
        /^(they|we|he|she|i)\s+(?:have|had)\s+(?:\w+\s+)?(?:kids|children|sons|daughters|a\s+son|a\s+daughter|a\s+child)\b\s*(?:named|called)?\s*[:,]?\s*(.+?)\.?$/i
      ) ??
      sentence.match(/^(their|our|his|her|my)\s+(?:kids|children|sons|daughters)\s+(?:are|were)\s+(.+?)\.?$/i);
    if (kidsMatch) {
      const who = kidsMatch[1].toLowerCase();
      let parentRefs: string[] = [];
      if (who === "they" || who === "their") {
        parentRefs = lastCouple ?? (lastRef ? [lastRef, ...spousesOf(lastRef)] : []);
      } else if (who === "we" || who === "our") {
        parentRefs = egoRef ? [egoRef, ...spousesOf(egoRef)] : [];
      } else if (who === "i" || who === "my") {
        parentRefs = egoRef ? [egoRef] : [];
      } else if (lastRef) {
        parentRefs = [lastRef];
      }
      for (const raw of splitNameList(kidsMatch[2])) {
        const ref = getOrCreate(raw, sentence, "high");
        for (const parentRef of new Set(parentRefs)) {
          addRelationship(parentRef, ref, "PARENT_OF", sentence, parentRefs.length > 0 ? "high" : "medium");
        }
        sentenceRef = ref;
      }
    }

    // 4. Marriage: "He married my mom, Hoa" / "Minh married Hoa" /
    //    "She is married to Y"
    const marriedMatch = sentence.match(
      /\bmarried\s+(?:to\s+)?(?:my\s+(mom|mother|dad|father)\s*,\s*)?(\p{L}[\p{L}' -]+?)(?:[.,]|$)/iu
    );
    if (marriedMatch) {
      const spouseName = trimName(marriedMatch[2]);
      const spouseRef = getOrCreate(spouseName, sentence, "medium");
      const subjectAtStart = sentence.match(
        /^(\p{L}[\p{L}' -]+?)\s+(?:is\s+|am\s+|was\s+|got\s+)?married\b/iu
      );
      let subjectRef: string | null = lastRef;
      const subject = subjectAtStart?.[1].trim().toLowerCase() ?? "";
      if (/^(i|i'm|i am)$/.test(subject)) {
        subjectRef = egoRef;
      } else if (/^my\s+(dad|father)$/.test(subject)) {
        subjectRef = dadRef;
      } else if (/^my\s+(mom|mother)$/.test(subject)) {
        subjectRef = momRef;
      } else if (/^my\s/.test(subject)) {
        subjectRef = null;
      } else if (subjectAtStart && !/^(he|she|they)$/.test(subject)) {
        subjectRef = getOrCreate(subjectAtStart[1], sentence, "medium");
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
      /\bmy\s+(uncle|aunt|cousin)\s+(\p{L}[\p{L}' -]+?)(?:[.,]|$)/iu
    );
    if (vagueMatch && !sentenceRef) {
      const name = trimName(vagueMatch[2]);
      const ref = getOrCreate(name, sentence, "low");
      sentenceRef = ref;
      lastRef = ref;
      lastName = name;
    }

    // 6. Standalone birth fact: "Minh, born 1960 in Hanoi"
    if (!sentenceRef) {
      const standalone = sentence.match(
        /^(\p{L}[\p{L}' -]+?),\s*born\s+\d{4}/iu
      );
      if (standalone) {
        const name = trimName(standalone[1]);
        const ref = getOrCreate(name, sentence, "medium");
        sentenceRef = ref;
        lastRef = ref;
        lastName = name;
      }
    }

    // Birth details attach to the person mentioned in this sentence,
    // or (for "He was born in 1960...") to the last-mentioned person.
    // "My dad was born in 1960" with no name must not land on whoever
    // happened to be mentioned last.
    let birthRef = sentenceRef;
    if (!birthRef && /^(he|she)\b/i.test(sentence)) birthRef = lastRef;
    if (!birthRef && /^i\b/i.test(sentence)) birthRef = egoRef;
    attachBirth(sentence, birthRef);

    // "He is younger than me 2 years" / "Thuc is 2 years younger than
    // me" / "I am 3 years older than him".
    const ageMatch = sentence.match(
      /^(he|she|i|\p{L}[\p{L}' -]*?)\s+(?:is|am|was)\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+years?\s+(younger|older)\s+than\s+(me|him|her|\p{L}[\p{L}' -]*?)|(younger|older)\s+than\s+(me|him|her|\p{L}[\p{L}' -]*?)\s+(?:by\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+years?)\b/iu
    );
    if (ageMatch) {
      const resolve = (word: string, pronounRef: string | null): string | null => {
        const w = word.trim().toLowerCase();
        if (w === "i" || w === "me") return egoRef;
        if (w === "he" || w === "she" || w === "him" || w === "her") return pronounRef;
        return findRoster(word)?.id ?? tempByName.get(trimName(word).toLowerCase()) ?? null;
      };
      const subject = resolve(ageMatch[1], birthRef ?? lastRef);
      const other = resolve(ageMatch[4] ?? ageMatch[6], subject === egoRef ? lastRef : egoRef);
      const rawYears = (ageMatch[2] ?? ageMatch[7]).toLowerCase();
      const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
      const years = /^\d+$/.test(rawYears) ? Number(rawYears) : words.indexOf(rawYears);
      const direction = (ageMatch[3] ?? ageMatch[5]).toLowerCase();
      if (subject && other && subject !== other && years > 0 && years < 100) {
        relativeAges.push({
          a: subject,
          b: other,
          years: direction === "younger" ? years : -years,
          sentence,
        });
      }
    }
    if (sentenceRef) lastRef = sentenceRef;
  }

  // Work out the missing birth year from a relative age, as a
  // medium-confidence card that shows the arithmetic.
  const birthYearOf = (ref: string): number | null =>
    proposals.find((p) => p.kind === "person" && p.tempId === ref)?.birthYear ??
    roster.find((r) => r.id === ref)?.birthYear ??
    null;
  const nameOf = (ref: string): string =>
    proposals.find((p) => p.kind === "person" && p.tempId === ref)?.preferredName ??
    roster.find((r) => r.id === ref)?.preferredName ??
    personByTemp.get(ref) ??
    roster.find((r) => r.id === ref)?.displayName ??
    "them";
  const derivedNotes: string[] = [];
  for (const fact of relativeAges) {
    const ya = birthYearOf(fact.a);
    const yb = birthYearOf(fact.b);
    if ((ya == null) === (yb == null)) continue;
    const [target, known, year] =
      ya == null ? [fact.a, fact.b, yb! + fact.years] : [fact.b, fact.a, ya - fact.years];
    const proposal =
      proposals.find((p) => p.kind === "person" && p.tempId === target) ??
      (roster.some((r) => r.id === target) ? updateFor(target, fact.sentence) : undefined);
    if (!proposal) continue;
    const who = target === egoRef ? "your" : `${nameOf(target)}'s`;
    proposal.birthYear = year;
    proposal.confidence = "medium";
    proposal.reason = `Worked out from: ${nameOf(known)} born ${birthYearOf(known)}, and you said "${fact.sentence.trim()}"`;
    derivedNotes.push(`I worked out ${who} birth year as about ${year} — please check it.`);
  }

  // Drop update cards that would change nothing (e.g. repeating a
  // full name or birth year the tree already has).
  for (let i = proposals.length - 1; i >= 0; i--) {
    const p = proposals[i];
    const existing = p.kind === "person" ? roster.find((r) => r.id === p.tempId) : undefined;
    if (!existing) continue;
    const changes =
      (p.displayName && p.displayName !== existing.displayName) ||
      (p.birthYear != null && p.birthYear !== existing.birthYear) ||
      (p.birthPlace && p.birthPlace !== existing.birthPlace);
    if (!changes) {
      proposals.splice(i, 1);
      alreadyKnown += 1;
    }
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
    // No parents known yet: link the sibling to the speaker directly
    // rather than leaving them floating in the tree.
    if (siblingParentRefs.length === 0 && egoRef) {
      addRelationship(egoRef, sibling.ref, "SIBLING_OF", sibling.sentence, "medium");
    }
  }

  const personNames = proposals
    .filter((p) => p.kind === "person" && p.displayName)
    .map((p) => p.displayName as string);
  const vague = /\bmy\s+(uncle|aunt|cousin)\b/i.test(message);

  let reply: string;
  if (proposals.length === 0 && alreadyKnown > 0) {
    reply = "That's already in your tree, so there's nothing new to add. Tell me about someone else!";
  } else if (proposals.length === 0) {
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
    if (derivedNotes.length > 0) reply += ` ${derivedNotes.join(" ")}`;
    if (clarifyNote) reply += ` ${clarifyNote}`;
  }
  void lastName;

  return { reply, proposals, modelUsed: "fallback" };
}
