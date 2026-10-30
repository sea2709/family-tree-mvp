import type { Gender, Person, Relationship, RelationshipType } from "@/lib/types";

export function person(id: string, displayName: string, extra: Partial<Person> = {}): Person {
  return { id, displayName, ...extra };
}

export function rel(fromPersonId: string, type: RelationshipType, toPersonId: string): Relationship {
  return { id: `${fromPersonId}-${type}-${toPersonId}`, fromPersonId, toPersonId, type };
}

const p = (id: string, name: string, gender?: Gender) => person(id, name, gender ? { gender } : {});

// Three generations around Lan (the speaker):
//
//   ong + ba                                  binh
//     ├── minh + hoa      tuan + mai            │
//     │     ├── lan + nam    └── khoi           nam
//     │     │     └── an
//     │     └── thuc + thu
//     │           └── ha
export const people: Person[] = [
  p("ong", "Ong", "male"),
  p("ba", "Ba", "female"),
  p("minh", "Minh", "male"),
  p("hoa", "Hoa", "female"),
  p("tuan", "Tuan", "male"),
  p("mai", "Mai", "female"),
  p("khoi", "Khoi", "male"),
  p("lan", "Lan", "female"),
  p("nam", "Nam", "male"),
  p("binh", "Binh", "male"),
  p("an", "An"),
  p("thuc", "Thuc", "male"),
  p("thu", "Thu", "female"),
  p("ha", "Ha", "female"),
];

export const relationships: Relationship[] = [
  rel("ong", "SPOUSE_OF", "ba"),
  rel("ong", "PARENT_OF", "minh"),
  rel("ba", "PARENT_OF", "minh"),
  rel("ong", "PARENT_OF", "tuan"),
  rel("ba", "PARENT_OF", "tuan"),
  rel("minh", "SPOUSE_OF", "hoa"),
  rel("tuan", "SPOUSE_OF", "mai"),
  rel("tuan", "PARENT_OF", "khoi"),
  rel("mai", "PARENT_OF", "khoi"),
  rel("minh", "PARENT_OF", "lan"),
  rel("hoa", "PARENT_OF", "lan"),
  rel("minh", "PARENT_OF", "thuc"),
  rel("hoa", "PARENT_OF", "thuc"),
  rel("lan", "SPOUSE_OF", "nam"),
  rel("binh", "PARENT_OF", "nam"),
  rel("lan", "PARENT_OF", "an"),
  rel("nam", "PARENT_OF", "an"),
  rel("thuc", "SPOUSE_OF", "thu"),
  rel("thuc", "PARENT_OF", "ha"),
  rel("thu", "PARENT_OF", "ha"),
];

export const ids = (list: { id: string }[]) => list.map((x) => x.id).sort();
