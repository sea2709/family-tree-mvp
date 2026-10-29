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
export type LayoutSize = { nodeW: number; nodeH: number; hGap: number; vGap: number };

export const DEFAULT_LAYOUT: LayoutSize = { nodeW: 190, nodeH: 104, hGap: 28, vGap: 72 };

export function layoutTree(
  people: Person[],
  rels: Relationship[],
  size: LayoutSize = DEFAULT_LAYOUT
): PositionedPerson[] {
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

  const { nodeW: NODE_W, nodeH: NODE_H, hGap: H_GAP, vGap: V_GAP } = size;
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

// How `personId` relates to the speaker, in plain words ("Mother",
// "Uncle", "Sister-in-law"). Null when the path is longer than one
// in-law or grand step.
export function relationLabel(
  egoId: string | null,
  personId: string,
  people: Person[],
  rels: Relationship[]
): string | null {
  if (!egoId) return null;
  if (egoId === personId) return "You";
  const person = people.find((p) => p.id === personId);
  const pick = (m: string, f: string, n: string) =>
    person?.gender === "male" ? m : person?.gender === "female" ? f : n;
  const ids = (list: Person[]) => list.map((p) => p.id);
  const parentsOf = (id: string) => ids(getParents(id, people, rels));
  const childrenOf = (id: string) => ids(getChildren(id, people, rels));
  const spousesOf = (id: string) => ids(getSpouses(id, people, rels));
  const siblingsOf = (id: string) => ids(getSiblings(id, people, rels));

  const parents = parentsOf(egoId);
  const children = childrenOf(egoId);
  const spouses = spousesOf(egoId);
  const siblings = siblingsOf(egoId);
  const has = (list: string[]) => list.includes(personId);

  if (has(parents)) return pick("Father", "Mother", "Parent");
  if (has(children)) return pick("Son", "Daughter", "Child");
  if (has(spouses)) return pick("Husband", "Wife", "Partner");
  if (has(siblings)) return pick("Brother", "Sister", "Sibling");
  if (has(parents.flatMap(parentsOf))) return pick("Grandfather", "Grandmother", "Grandparent");
  if (has(children.flatMap(childrenOf))) return pick("Grandson", "Granddaughter", "Grandchild");
  if (has(parents.flatMap(siblingsOf))) return pick("Uncle", "Aunt", "Parent's sibling");
  if (has(siblings.flatMap(childrenOf))) return pick("Nephew", "Niece", "Sibling's child");
  if (has(parents.flatMap(spousesOf))) return pick("Stepfather", "Stepmother", "Step-parent");
  if (has(spouses.flatMap(parentsOf))) return pick("Father-in-law", "Mother-in-law", "Parent-in-law");
  if (has(children.flatMap(spousesOf))) return pick("Son-in-law", "Daughter-in-law", "Child-in-law");
  if (has([...siblings.flatMap(spousesOf), ...spouses.flatMap(siblingsOf)])) {
    return pick("Brother-in-law", "Sister-in-law", "Sibling-in-law");
  }
  if (has(parents.flatMap(siblingsOf).flatMap(childrenOf))) return "Cousin";
  return null;
}

export type Connector = {
  key: string;
  d: string;
  kind: "parent" | "spouse" | "sibling";
  pending: boolean;
};

// Orthogonal "family bus" connectors: each set of parents drops to a
// shared bar, and each child hangs from that bar. Drawing one diagonal
// per PARENT_OF edge crosses lines as soon as two parents share kids.
// Edges whose id is in `pendingRelIds` come back as separate pending
// connectors so they can be drawn dashed on top of the real ones.
export function familyConnectors(
  positioned: PositionedPerson[],
  rels: Relationship[],
  size: LayoutSize,
  pendingRelIds: Set<string> = new Set()
): Connector[] {
  const pos = new Map(positioned.map((p) => [p.id, p]));
  const cx = (p: PositionedPerson) => p.x + size.nodeW / 2;
  const out: Connector[] = [];

  const edgesByChild = new Map<string, Relationship[]>();
  for (const r of rels) {
    if (r.type !== "PARENT_OF" || !pos.has(r.fromPersonId) || !pos.has(r.toPersonId)) continue;
    edgesByChild.set(r.toPersonId, [...(edgesByChild.get(r.toPersonId) ?? []), r]);
  }
  const families = new Map<
    string,
    { parents: string[]; children: string[]; pendingParents: Set<string>; pendingChildren: Set<string> }
  >();
  for (const [child, edges] of edgesByChild) {
    const parents = [...new Set(edges.map((e) => e.fromPersonId))].sort();
    const key = parents.join("+");
    const fam = families.get(key) ?? {
      parents,
      children: [],
      pendingParents: new Set(parents),
      pendingChildren: new Set<string>(),
    };
    fam.children.push(child);
    if (edges.every((e) => pendingRelIds.has(e.id))) fam.pendingChildren.add(child);
    for (const e of edges) if (!pendingRelIds.has(e.id)) fam.pendingParents.delete(e.fromPersonId);
    families.set(key, fam);
  }

  // Families whose parents sit on the same row get staggered bars so
  // two bars never merge into one line.
  const perRow = new Map<number, string[]>();
  for (const [key, fam] of families) {
    const row = Math.max(...fam.parents.map((id) => pos.get(id)!.y));
    perRow.set(row, [...(perRow.get(row) ?? []), key]);
  }

  for (const [key, fam] of families) {
    const parents = fam.parents.map((id) => pos.get(id)!);
    const children = fam.children.map((id) => pos.get(id)!);
    const parentBottom = Math.max(...parents.map((p) => p.y)) + size.nodeH;
    const siblingsOnRow = perRow.get(parentBottom - size.nodeH) ?? [key];
    const slot = siblingsOnRow.indexOf(key) - (siblingsOnRow.length - 1) / 2;
    // Halfway between parents and children, which matches vGap / 2 for
    // the auto layout but keeps working once cards are dragged around.
    const childTop = Math.min(...children.map((c) => c.y));
    const gap = childTop - parentBottom;
    const busY =
      gap > 24
        ? Math.min(Math.max(parentBottom + gap / 2 + slot * 8, parentBottom + 8), childTop - 8)
        : parentBottom + size.vGap / 2 + slot * 8;
    const bus = (pending: boolean) => {
      const ps = parents.filter((p) => pending || !fam.pendingParents.has(p.id));
      const cs = children.filter((c) => pending || !fam.pendingChildren.has(c.id));
      const drops = [
        ...ps.filter((p) => fam.pendingParents.has(p.id) === pending).map((p) => `M${cx(p)},${p.y + size.nodeH} V${busY}`),
        ...cs.filter((c) => fam.pendingChildren.has(c.id) === pending).map((c) => `M${cx(c)},${busY} V${c.y}`),
      ];
      if (drops.length === 0) return null;
      const xs = [...ps.map(cx), ...cs.map(cx)];
      return [`M${Math.min(...xs)},${busY} H${Math.max(...xs)}`, ...drops].join(" ");
    };
    const solid = bus(false);
    const dashed = bus(true);
    if (solid) out.push({ key: `fam-${key}`, d: solid, kind: "parent", pending: false });
    if (dashed) out.push({ key: `fam-${key}-pending`, d: dashed, kind: "parent", pending: true });
  }

  for (const r of rels) {
    if (r.type === "PARENT_OF") continue;
    const a = pos.get(r.fromPersonId);
    const b = pos.get(r.toPersonId);
    if (!a || !b) continue;
    const [left, right] = a.x <= b.x ? [a, b] : [b, a];
    const pending = pendingRelIds.has(r.id);
    if (r.type === "SIBLING_OF") {
      const top = Math.min(left.y, right.y);
      out.push({
        key: r.id,
        d: `M${cx(left)},${left.y} Q${(cx(left) + cx(right)) / 2},${top - 28} ${cx(right)},${right.y}`,
        kind: "sibling",
        pending,
      });
    } else {
      const midY = (y: number) => y + size.nodeH / 2;
      out.push({
        key: r.id,
        d: `M${left.x + size.nodeW},${midY(left.y)} L${right.x},${midY(right.y)}`,
        kind: "spouse",
        pending,
      });
    }
  }
  // Pending connectors last so they draw on top.
  return out.sort((a, b) => Number(a.pending) - Number(b.pending));
}
