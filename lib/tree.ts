import type { Person, Relationship } from "./types";

export function childrenOf(personId: string, rels: Relationship[]): Person[] {
  // Filled in by the page from the people list; see derived helpers below.
  void personId;
  void rels;
  return [];
}

// Derived relationships: never stored, always computed from
// PARENT_OF + SPOUSE_OF edges. See the sketch for why.
export function getParents(
  personId: string,
  people: Person[],
  rels: Relationship[]
): Person[] {
  const parentIds = rels
    .filter((r) => r.type === "PARENT_OF" && r.toPersonId === personId)
    .map((r) => r.fromPersonId);
  return people.filter((p) => parentIds.includes(p.id));
}

export function getChildren(
  personId: string,
  people: Person[],
  rels: Relationship[]
): Person[] {
  const childIds = rels
    .filter((r) => r.type === "PARENT_OF" && r.fromPersonId === personId)
    .map((r) => r.toPersonId);
  return people.filter((p) => childIds.includes(p.id));
}

export function getSpouses(
  personId: string,
  people: Person[],
  rels: Relationship[]
): Person[] {
  const ids = rels
    .filter(
      (r) =>
        (r.type === "SPOUSE_OF" || r.type === "PARTNER_OF") &&
        (r.fromPersonId === personId || r.toPersonId === personId)
    )
    .map((r) => (r.fromPersonId === personId ? r.toPersonId : r.fromPersonId));
  return people.filter((p) => ids.includes(p.id));
}

export function getSiblings(
  personId: string,
  people: Person[],
  rels: Relationship[]
): Person[] {
  const explicitIds = rels
    .filter(
      (r) =>
        r.type === "SIBLING_OF" &&
        (r.fromPersonId === personId || r.toPersonId === personId)
    )
    .map((r) => (r.fromPersonId === personId ? r.toPersonId : r.fromPersonId));
  const parents = getParents(personId, people, rels).map((p) => p.id);
  const sharedParentIds =
    parents.length === 0
      ? []
      : people
          .filter(
            (p) =>
              p.id !== personId &&
              rels.some(
                (r) =>
                  r.type === "PARENT_OF" &&
                  r.toPersonId === p.id &&
                  parents.includes(r.fromPersonId)
              )
          )
          .map((p) => p.id);
  const ids = new Set([...explicitIds, ...sharedParentIds]);
  return people.filter((p) => ids.has(p.id));
}

export type PositionedPerson = Person & { x: number; y: number; generation: number };

// Simple generation layout: roots (no parents) at the top, children
// one row below, spouses on the same row as their partner.
export function layoutTree(people: Person[], rels: Relationship[]): PositionedPerson[] {
  const generation = new Map<string, number>();
  const queue: string[] = [];

  for (const p of people) {
    if (getParents(p.id, people, rels).length === 0) {
      generation.set(p.id, 0);
      queue.push(p.id);
    }
  }
  // Spouses of roots share the root generation before children are placed.
  for (const r of rels) {
    if (r.type === "SPOUSE_OF" || r.type === "PARTNER_OF") {
      const a = generation.get(r.fromPersonId);
      const b = generation.get(r.toPersonId);
      if (a !== undefined && b === undefined) {
        generation.set(r.toPersonId, a);
        queue.push(r.toPersonId);
      } else if (b !== undefined && a === undefined) {
        generation.set(r.fromPersonId, b);
        queue.push(r.fromPersonId);
      }
    }
  }
  // Explicit siblings share a generation too (e.g. a dad's brother
  // linked with SIBLING_OF when the grandparents are unknown).
  for (const r of rels) {
    if (r.type === "SIBLING_OF") {
      const a = generation.get(r.fromPersonId);
      const b = generation.get(r.toPersonId);
      if (a !== undefined && b === undefined) {
        generation.set(r.toPersonId, a);
        queue.push(r.toPersonId);
      } else if (b !== undefined && a === undefined) {
        generation.set(r.fromPersonId, b);
        queue.push(r.fromPersonId);
      }
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    const gen = generation.get(id) ?? 0;
    for (const child of getChildren(id, people, rels)) {
      if (!generation.has(child.id)) {
        generation.set(child.id, gen + 1);
        queue.push(child.id);
      }
    }
    for (const spouse of getSpouses(id, people, rels)) {
      if (!generation.has(spouse.id)) {
        generation.set(spouse.id, gen);
        queue.push(spouse.id);
      }
    }
    for (const sibling of getSiblings(id, people, rels)) {
      if (!generation.has(sibling.id)) {
        generation.set(sibling.id, gen);
        queue.push(sibling.id);
      }
    }
  }
  // Anything unreachable (e.g. a disconnected person) goes at the top.
  for (const p of people) {
    if (!generation.has(p.id)) generation.set(p.id, 0);
  }

  const byGen = new Map<number, Person[]>();
  for (const p of people) {
    const gen = generation.get(p.id) ?? 0;
    const list = byGen.get(gen) ?? [];
    list.push(p);
    byGen.set(gen, list);
  }

  const NODE_W = 190;
  const NODE_H = 104;
  const H_GAP = 28;
  const V_GAP = 72;
  const out: PositionedPerson[] = [];
  for (const [gen, list] of [...byGen.entries()].sort((a, b) => a[0] - b[0])) {
    list.forEach((p, i) => {
      out.push({
        ...p,
        generation: gen,
        x: i * (NODE_W + H_GAP),
        y: gen * (NODE_H + V_GAP),
      });
    });
  }
  return out;
}
