import type { Person, Proposal, Relationship } from "./types";

export function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

// Models reuse ids like "p1" / "temp-minh" every turn, so cards left
// pending from an earlier turn would collide with the new batch.
// Existing person ids are left alone.
export function scopeBatch(batch: Proposal[], people: Person[], prefix = uid().slice(0, 8)): Proposal[] {
  const existing = new Set(people.map((p) => p.id));
  const rename = new Map<string, string>();
  for (const p of batch) {
    if (p.kind === "person" && p.tempId && !existing.has(p.tempId)) {
      rename.set(p.tempId, `${prefix}:${p.tempId}`);
    }
  }
  const scoped = (ref?: string) => (ref ? rename.get(ref) ?? ref : ref);
  return batch.map((p) => ({
    ...p,
    id: `${prefix}:${p.id}`,
    tempId: scoped(p.tempId),
    fromRef: scoped(p.fromRef),
    toRef: scoped(p.toRef),
  }));
}

export function batchOf(p: Proposal): string {
  return p.id.split(":")[0];
}

// A new-person card whose name matches someone already in the tree.
export function sameNamePerson(p: Proposal, people: Person[]): Person | undefined {
  if (p.kind !== "person" || !p.displayName) return undefined;
  if (p.tempId && people.some((x) => x.id === p.tempId)) return undefined;
  const names = [p.displayName, p.preferredName]
    .filter((n): n is string => !!n)
    .map((n) => n.toLowerCase());
  return people.find(
    (x) =>
      names.includes(x.displayName.toLowerCase()) ||
      (!!x.preferredName && names.includes(x.preferredName.toLowerCase()))
  );
}

// True when `ancestorId` is `personId` or one of their parents, grandparents…
export function isAncestor(ancestorId: string, personId: string, rels: Relationship[]): boolean {
  const seen = new Set<string>();
  const stack = [personId];
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === ancestorId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const r of rels) {
      if (r.type === "PARENT_OF" && r.toPersonId === id) stack.push(r.fromPersonId);
    }
  }
  return false;
}

export function describeProposal(
  p: Proposal,
  people: Person[],
  proposals: Proposal[],
  resolved: Record<string, string>
): string {
  if (p.kind === "person") {
    const existing = p.tempId ? people.find((x) => x.id === p.tempId) : undefined;
    const name = p.displayName ?? existing?.displayName ?? "Unnamed person";
    const bits: string[] = [];
    if (!existing || (p.displayName && p.displayName !== existing.displayName)) {
      bits.push(name);
    }
    if (p.preferredName && p.preferredName !== name) bits.push(`(${p.preferredName})`);
    if (p.birthYear) bits.push(`born ${p.birthYear}`);
    if (p.birthPlace) bits.push(`in ${p.birthPlace}`);
    if (existing) return `Update ${existing.displayName}: ${bits.join(" ")}`;
    return `Add person: ${bits.join(" ")}`;
  }
  const nameFor = (ref?: string): string => {
    if (!ref) return "someone";
    const existing = people.find((x) => x.id === (resolved[ref] ?? ref));
    if (existing) return existing.displayName;
    const pending = proposals.find((x) => x.kind === "person" && x.tempId === ref);
    return pending?.displayName ?? "someone";
  };
  const from = nameFor(p.fromRef);
  const to = nameFor(p.toRef);
  if (p.relationshipType === "PARENT_OF") return `${from} is a parent of ${to}`;
  if (p.relationshipType === "SPOUSE_OF") return `${from} is married to ${to}`;
  if (p.relationshipType === "PARTNER_OF") return `${from} is a partner of ${to}`;
  if (p.relationshipType === "SIBLING_OF") return `${from} is a sibling of ${to}`;
  return `${from} is related to ${to}`;
}

export type TreeState = {
  people: Person[];
  relationships: Relationship[];
  proposals: Proposal[];
  // tempId -> person id for person proposals already accepted, so a
  // relationship card accepted later still knows who it points at.
  resolvedRefs: Record<string, string>;
  egoId: string | null;
};

// Apply one or more proposals, resolving tempIds / existing ids.
export function applyProposalBatch(
  state: TreeState,
  toApply: Proposal[]
): { next: TreeState; lastCreatedId: string | null; skipped: string[] } {
  let nextPeople = [...state.people];
  let nextRels = [...state.relationships];
  let nextProps = [...state.proposals];
  const nextResolved = { ...state.resolvedRefs };
  let nextEgo = state.egoId;
  let lastCreatedId: string | null = null;
  const skipped: string[] = [];

  // Accepts one person proposal: an update when its tempId (or
  // existingPersonId) is an existing id, otherwise a new person.
  // Either way the tempId is remembered for later cards.
  // Same-name people are never merged silently ("my son Minh" is not
  // "my dad Minh"); the card's "Same as existing" button sets
  // existingPersonId when the user says they are one person.
  const acceptPerson = (p: Proposal): string | null => {
    nextProps = nextProps.filter((x) => x.id !== p.id);
    let id: string | null = null;
    const targetId = p.existingPersonId ?? p.tempId;
    const target = targetId ? nextPeople.find((x) => x.id === targetId) : undefined;
    if (target) {
      const displayName = p.existingPersonId ? target.displayName : p.displayName ?? target.displayName;
      const updated: Person = {
        ...target,
        displayName,
        preferredName:
          (p.existingPersonId ? null : p.preferredName) ??
          (target.preferredName || (target.displayName !== displayName ? target.displayName : null)),
        birthYear: p.birthYear ?? target.birthYear ?? null,
        birthPlace: p.birthPlace ?? target.birthPlace ?? null,
        bio: p.bio ?? target.bio ?? null,
        gender: target.gender ?? p.gender ?? null,
      };
      nextPeople = nextPeople.map((x) => (x.id === target.id ? updated : x));
      id = target.id;
    } else if (p.displayName) {
      const created: Person = {
        id: uid(),
        displayName: p.displayName,
        preferredName: p.preferredName ?? null,
        birthYear: p.birthYear ?? null,
        birthPlace: p.birthPlace ?? null,
        bio: p.bio ?? null,
        gender: p.gender ?? null,
      };
      nextPeople = [...nextPeople, created];
      lastCreatedId = created.id;
      id = created.id;
    }
    if (id && p.tempId) nextResolved[p.tempId] = id;
    // Only the speaker's own card sets the ego, and only once, so
    // accepting "Minh" before "Lan" does not make Minh the speaker.
    if (id && p.isSpeaker && !nextEgo) nextEgo = id;
    return id;
  };

  const ensurePerson = (ref?: string): string | null => {
    if (!ref) return null;
    const mapped = nextResolved[ref] ?? ref;
    if (nextPeople.some((x) => x.id === mapped)) return mapped;
    const pending = nextProps.find((x) => x.kind === "person" && x.tempId === ref);
    return pending ? acceptPerson(pending) : null;
  };

  for (const p of toApply) {
    if (!nextProps.some((x) => x.id === p.id)) continue;
    if (p.kind === "person") {
      acceptPerson(p);
    } else if (p.kind === "relationship") {
      const fromId = ensurePerson(p.fromRef);
      const toId = ensurePerson(p.toRef);
      if (fromId && toId && fromId !== toId) {
        const duplicate = nextRels.some(
          (r) =>
            r.type === p.relationshipType &&
            ((r.fromPersonId === fromId && r.toPersonId === toId) ||
              (p.relationshipType !== "PARENT_OF" &&
                r.fromPersonId === toId &&
                r.toPersonId === fromId))
        );
        const cycle =
          p.relationshipType === "PARENT_OF" && isAncestor(toId, fromId, nextRels);
        if (cycle) {
          const name = (id: string) => nextPeople.find((x) => x.id === id)?.displayName ?? "?";
          skipped.push(
            `I didn't add "${name(fromId)} is a parent of ${name(toId)}" because ${name(toId)} is already ${name(fromId)}'s parent or ancestor. If these are different people, add them separately.`
          );
        } else if (!duplicate && p.relationshipType) {
          nextRels = [
            ...nextRels,
            { id: uid(), fromPersonId: fromId, toPersonId: toId, type: p.relationshipType },
          ];
        }
      }
      nextProps = nextProps.filter((x) => x.id !== p.id);
    }
  }

  return {
    next: {
      people: nextPeople,
      relationships: nextRels,
      proposals: nextProps,
      resolvedRefs: nextResolved,
      egoId: nextEgo,
    },
    lastCreatedId,
    skipped,
  };
}

// Rejecting a person also drops the relationship cards that need
// them; otherwise those cards could only ever be accepted as no-ops.
export function rejectProposalBatch(state: TreeState, toReject: Proposal[]): Proposal[] {
  const rejected = new Set(toReject.map((p) => p.id));
  const droppedRefs = new Set(
    toReject
      .filter((p) => p.kind === "person" && p.tempId && !state.resolvedRefs[p.tempId])
      .filter((p) => !state.people.some((x) => x.id === p.tempId))
      .map((p) => p.tempId as string)
  );
  return state.proposals.filter(
    (x) =>
      !rejected.has(x.id) &&
      !(x.kind === "relationship" &&
        ((x.fromRef && droppedRefs.has(x.fromRef)) || (x.toRef && droppedRefs.has(x.toRef))))
  );
}
