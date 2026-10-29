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

// Generation layout. Generations are relative: walking any edge from a
// person fixes the other side (parent -1, child +1, spouse/sibling 0),
// so someone who married in sits beside their partner instead of in
// the top row just because they have no parents in the tree.
export function layoutTree(people: Person[], rels: Relationship[]): PositionedPerson[] {
  const ids = new Set(people.map((p) => p.id));
  const neighbours = new Map<string, { id: string; delta: number }[]>();
  const link = (a: string, b: string, delta: number) => {
    neighbours.set(a, [...(neighbours.get(a) ?? []), { id: b, delta }]);
    neighbours.set(b, [...(neighbours.get(b) ?? []), { id: a, delta: -delta }]);
  };
  for (const r of rels) {
    if (!ids.has(r.fromPersonId) || !ids.has(r.toPersonId)) continue;
    link(r.fromPersonId, r.toPersonId, r.type === "PARENT_OF" ? 1 : 0);
  }

  const generation = new Map<string, number>();
  const discovery: string[] = [];
  for (const p of people) {
    if (generation.has(p.id)) continue;
    const component = [p.id];
    generation.set(p.id, 0);
    for (let i = 0; i < component.length; i++) {
      const id = component[i];
      for (const n of neighbours.get(id) ?? []) {
        if (generation.has(n.id)) continue;
        generation.set(n.id, generation.get(id)! + n.delta);
        component.push(n.id);
      }
    }
    // Each family's oldest generation starts at row 0.
    const min = Math.min(...component.map((id) => generation.get(id)!));
    for (const id of component) generation.set(id, generation.get(id)! - min);
    discovery.push(...component);
  }

  const byGen = new Map<number, Person[]>();
  for (const p of people) {
    const gen = generation.get(p.id) ?? 0;
    byGen.set(gen, [...(byGen.get(gen) ?? []), p]);
  }

  const NODE_W = 190;
  const NODE_H = 104;
  const H_GAP = 28;
  const V_GAP = 72;
  const out: PositionedPerson[] = [];
  const column = new Map<string, number>();
  const order = new Map(discovery.map((id, i) => [id, i]));
  for (const [gen, list] of [...byGen.entries()].sort((a, b) => a[0] - b[0])) {
    // Children follow their parents' left-to-right order; people
    // without parents in the tree keep discovery order.
    const parentKey = (p: Person): number | null => {
      const cols = getParents(p.id, people, rels)
        .map((x) => column.get(x.id))
        .filter((c): c is number => c !== undefined);
      return cols.length > 0 ? cols.reduce((a, b) => a + b, 0) / cols.length : null;
    };
    // Someone who married in sorts with their partner.
    const key = (p: Person) =>
      parentKey(p) ??
      getSpouses(p.id, people, rels)
        .map(parentKey)
        .find((k): k is number => k !== null) ??
      (order.get(p.id) ?? 0) / Math.max(discovery.length, 1);
    const sorted = [...list].sort((a, b) => key(a) - key(b));
    // Keep partners side by side so the spouse line doesn't cross nodes.
    const row: Person[] = [];
    for (const p of sorted) {
      if (row.includes(p)) continue;
      row.push(p);
      for (const s of getSpouses(p.id, people, rels)) {
        if (!row.includes(s) && list.includes(s)) row.push(s);
      }
    }
    row.forEach((p, i) => {
      column.set(p.id, i);
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
