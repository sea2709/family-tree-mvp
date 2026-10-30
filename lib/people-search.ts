import type { Person, Relationship } from "./types";
import { getChildren, getParents, getSiblings, getSpouses } from "./tree";
import { isAncestor } from "./proposals";

export type RelativeKind = "parent" | "partner" | "child" | "sibling";

// Lowercase without accents, so "nguyen" matches "Nguyễn". "đ" is its own
// letter rather than "d" plus a mark, so NFD leaves it alone.
export function foldName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

// People who can be linked to `personId` as `kind` without making anyone
// their own ancestor or giving a child more than two parents.
export function relativeCandidates(
  kind: RelativeKind,
  personId: string,
  people: Person[],
  rels: Relationship[],
  coParentId: string | null
): Person[] {
  const parents = getParents(personId, people, rels);
  const related = new Set(
    [
      ...parents,
      ...getSpouses(personId, people, rels),
      ...getChildren(personId, people, rels),
      ...getSiblings(personId, people, rels),
    ].map((p) => p.id)
  );
  const parentCount = (id: string) => rels.filter((r) => r.type === "PARENT_OF" && r.toPersonId === id).length;
  const isAncestorOf = (c: Person) => isAncestor(c.id, personId, rels);
  const isDescendantOf = (c: Person) => isAncestor(personId, c.id, rels);

  if (kind === "parent" && parents.length >= 2) return [];

  return people.filter((c) => {
    if (c.id === personId || related.has(c.id)) return false;
    if (kind === "parent") return !isDescendantOf(c);
    if (kind === "child") {
      const added = coParentId && coParentId !== c.id ? 2 : 1;
      return !isAncestorOf(c) && parentCount(c.id) + added <= 2;
    }
    if (isAncestorOf(c) || isDescendantOf(c)) return false;
    if (kind === "sibling" && parents.length > 0) return parentCount(c.id) === 0;
    return true;
  });
}

// Full-name prefix, then word prefix (Vietnamese given names come last),
// then substring. Ties: people already in the tree first, then by name.
export function matchPeople(
  query: string,
  candidates: Person[],
  rels: Relationship[],
  limit = 6
): Person[] {
  const q = foldName(query);
  if (!q) return [];
  const linked = new Set(rels.flatMap((r) => [r.fromPersonId, r.toPersonId]));
  const tierOf = (p: Person) => {
    const names = [p.displayName, p.preferredName].filter((n): n is string => !!n).map(foldName);
    if (names.some((n) => n.startsWith(q))) return 0;
    if (names.some((n) => n.split(/\s+/).some((w) => w.startsWith(q)))) return 1;
    if (names.some((n) => n.includes(q))) return 2;
    return -1;
  };
  return candidates
    .map((p) => ({ p, tier: tierOf(p) }))
    .filter((x) => x.tier >= 0)
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        Number(linked.has(b.p.id)) - Number(linked.has(a.p.id)) ||
        a.p.displayName.localeCompare(b.p.displayName)
    )
    .slice(0, limit)
    .map((x) => x.p);
}
