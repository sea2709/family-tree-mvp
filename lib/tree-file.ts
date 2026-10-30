import { isIsoDate, yearOf } from "@/lib/dates";
import type { Gender, Person, Relationship, RelationshipType } from "@/lib/types";

const APP = "family-tree-mvp";
const VERSION = 1;
const REL_TYPES: RelationshipType[] = ["PARENT_OF", "SPOUSE_OF", "PARTNER_OF", "SIBLING_OF"];
const PRECISIONS: NonNullable<Person["birthDatePrecision"]>[] = ["exact", "year_only", "circa", "unknown"];

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export type Layout = Record<string, { x: number; y: number }>;

export type TreeFile = {
  app: typeof APP;
  version: number;
  exportedAt: string;
  egoId: string | null;
  people: Person[];
  relationships: Relationship[];
  layout: Layout;
};

export type ParseResult = { ok: true; data: TreeFile } | { ok: false; error: string };

export function serializeTree(tree: {
  people: Person[];
  relationships: Relationship[];
  egoId: string | null;
  layout: Layout;
}): string {
  const live = new Set(tree.people.map((p) => p.id));
  const file: TreeFile = {
    app: APP,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    egoId: tree.egoId,
    people: tree.people,
    relationships: tree.relationships,
    layout: Object.fromEntries(Object.entries(tree.layout).filter(([id]) => live.has(id))),
  };
  return JSON.stringify(file, null, 2);
}

export function exportFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `family-tree-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const optString = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const optYear = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);

function readPerson(raw: unknown): Person | null {
  if (!isObject(raw) || !nonEmpty(raw.id) || !nonEmpty(raw.displayName)) return null;
  const birthDate = isIsoDate(raw.birthDate) ? raw.birthDate : null;
  const person: Person = {
    id: raw.id,
    displayName: raw.displayName,
    preferredName: optString(raw.preferredName),
    birthYear: birthDate ? yearOf(birthDate) : optYear(raw.birthYear),
    birthDate,
    birthPlace: optString(raw.birthPlace),
    deathYear: optYear(raw.deathYear),
    bio: optString(raw.bio),
    // Anything other than an embedded image could make the page fetch
    // a remote URL the file's author chose.
    avatarUrl: typeof raw.avatarUrl === "string" && raw.avatarUrl.startsWith("data:image/") ? raw.avatarUrl : null,
    gender: raw.gender === "male" || raw.gender === "female" ? (raw.gender as Gender) : null,
  };
  if (PRECISIONS.includes(raw.birthDatePrecision as never)) {
    person.birthDatePrecision = raw.birthDatePrecision as Person["birthDatePrecision"];
  }
  return person;
}

export function parseTreeFile(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "This file isn't valid JSON." };
  }
  if (!isObject(raw) || raw.app !== APP) {
    return { ok: false, error: "This isn't a Family Tree export." };
  }
  if (typeof raw.version !== "number" || raw.version > VERSION) {
    return { ok: false, error: "This file was made by a newer version of the app." };
  }
  if (!Array.isArray(raw.people)) {
    return { ok: false, error: "No people found in this file." };
  }

  const people: Person[] = [];
  const ids = new Set<string>();
  for (const item of raw.people) {
    const p = readPerson(item);
    if (!p || ids.has(p.id)) continue;
    ids.add(p.id);
    people.push(p);
  }
  if (people.length === 0) return { ok: false, error: "No people found in this file." };

  const relationships: Relationship[] = [];
  const relIds = new Set<string>();
  for (const r of Array.isArray(raw.relationships) ? raw.relationships : []) {
    if (
      !isObject(r) ||
      !nonEmpty(r.id) ||
      relIds.has(r.id) ||
      !REL_TYPES.includes(r.type as RelationshipType) ||
      typeof r.fromPersonId !== "string" ||
      typeof r.toPersonId !== "string" ||
      r.fromPersonId === r.toPersonId ||
      !ids.has(r.fromPersonId) ||
      !ids.has(r.toPersonId)
    ) {
      continue;
    }
    relIds.add(r.id);
    relationships.push({
      id: r.id,
      fromPersonId: r.fromPersonId,
      toPersonId: r.toPersonId,
      type: r.type as RelationshipType,
    });
  }

  const layout: Layout = {};
  if (isObject(raw.layout)) {
    for (const [id, pos] of Object.entries(raw.layout)) {
      if (!ids.has(id) || !isObject(pos)) continue;
      const { x, y } = pos;
      if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
        layout[id] = { x: Math.max(0, x), y: Math.max(0, y) };
      }
    }
  }

  return {
    ok: true,
    data: {
      app: APP,
      version: VERSION,
      exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : "",
      egoId: typeof raw.egoId === "string" && ids.has(raw.egoId) ? raw.egoId : null,
      people,
      relationships,
      layout,
    },
  };
}
