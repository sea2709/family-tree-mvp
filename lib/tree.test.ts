import { describe, expect, it } from "vitest";
import { ids, people, person, rel, relationships } from "@/test/family";
import {
  childrenOf,
  DEFAULT_LAYOUT,
  familyConnectors,
  getChildren,
  getParents,
  getSiblings,
  getSpouses,
  layoutTree,
  relationLabel,
  type LayoutSize,
  type PositionedPerson,
} from "./tree";

describe("derived relatives", () => {
  it("finds parents and children from PARENT_OF edges", () => {
    expect(ids(getParents("lan", people, relationships))).toEqual(["hoa", "minh"]);
    expect(ids(getChildren("minh", people, relationships))).toEqual(["lan", "thuc"]);
    expect(getParents("ong", people, relationships)).toEqual([]);
  });

  it("finds spouses and partners in either edge direction", () => {
    expect(ids(getSpouses("nam", people, relationships))).toEqual(["lan"]);
    expect(ids(getSpouses("lan", people, relationships))).toEqual(["nam"]);
    const partners = [rel("a", "PARTNER_OF", "b")];
    expect(ids(getSpouses("b", [person("a", "A"), person("b", "B")], partners))).toEqual(["a"]);
  });

  it("derives siblings from shared parents, excluding the person", () => {
    expect(ids(getSiblings("lan", people, relationships))).toEqual(["thuc"]);
    expect(ids(getSiblings("minh", people, relationships))).toEqual(["tuan"]);
  });

  it("includes explicit SIBLING_OF edges when parents are unknown", () => {
    const list = [person("a", "A"), person("b", "B"), person("c", "C")];
    expect(ids(getSiblings("b", list, [rel("a", "SIBLING_OF", "b")]))).toEqual(["a"]);
    expect(getSiblings("c", list, [rel("a", "SIBLING_OF", "b")])).toEqual([]);
  });

  it("childrenOf is a placeholder that always returns nothing", () => {
    expect(childrenOf("minh", relationships)).toEqual([]);
  });
});

describe("relationLabel", () => {
  const label = (id: string, ego: string | null = "lan") => relationLabel(ego, id, people, relationships);

  it("returns null without a speaker and 'You' for the speaker", () => {
    expect(label("minh", null)).toBeNull();
    expect(label("lan")).toBe("You");
  });

  it.each([
    ["minh", "Father"],
    ["hoa", "Mother"],
    ["an", "Child"],
    ["nam", "Husband"],
    ["thuc", "Brother"],
    ["ong", "Grandfather"],
    ["ba", "Grandmother"],
    ["tuan", "Uncle"],
    ["ha", "Niece"],
    ["binh", "Father-in-law"],
    ["thu", "Sister-in-law"],
    ["khoi", "Cousin"],
  ])("labels %s as %s", (id, expected) => {
    expect(label(id)).toBe(expected);
  });

  it("labels relatives seen from other speakers", () => {
    expect(label("an", "minh")).toBe("Grandchild");
    expect(label("ha", "minh")).toBe("Granddaughter");
    expect(label("nam", "minh")).toBe("Son-in-law");
    expect(label("lan", "binh")).toBe("Daughter-in-law");
    expect(label("lan", "thu")).toBe("Sister-in-law");
  });

  it("labels a parent's other spouse as a step-parent", () => {
    const list = [...people, person("van", "Van", { gender: "female" })];
    const rels = [...relationships, rel("minh", "SPOUSE_OF", "van")];
    expect(relationLabel("lan", "van", list, rels)).toBe("Stepmother");
  });

  it("returns null for relatives further than one step away", () => {
    expect(label("mai")).toBeNull();
  });
});

describe("layoutTree", () => {
  const size: LayoutSize = { nodeW: 100, nodeH: 50, hGap: 10, vGap: 50 };
  const byId = (list: PositionedPerson[]) => new Map(list.map((p) => [p.id, p]));

  it("assigns generations relative to each family's oldest row", () => {
    const placed = byId(layoutTree(people, relationships, size));
    const gen = (id: string) => placed.get(id)!.generation;
    expect([gen("ong"), gen("ba")]).toEqual([0, 0]);
    expect([gen("minh"), gen("hoa"), gen("tuan"), gen("mai"), gen("binh")]).toEqual([1, 1, 1, 1, 1]);
    expect([gen("lan"), gen("nam"), gen("thuc"), gen("thu"), gen("khoi")]).toEqual([2, 2, 2, 2, 2]);
    expect([gen("an"), gen("ha")]).toEqual([3, 3]);
  });

  it("places rows by generation and columns by node width plus gap", () => {
    const placed = layoutTree(people, relationships, size);
    for (const p of placed) {
      expect(p.y).toBe(p.generation * (size.nodeH + size.vGap));
      expect(p.x % (size.nodeW + size.hGap)).toBe(0);
    }
  });

  it("keeps spouses next to each other", () => {
    const placed = byId(layoutTree(people, relationships, size));
    const col = (id: string) => placed.get(id)!.x / (size.nodeW + size.hGap);
    expect(Math.abs(col("lan") - col("nam"))).toBe(1);
    expect(Math.abs(col("thuc") - col("thu"))).toBe(1);
    expect(Math.abs(col("minh") - col("hoa"))).toBe(1);
  });

  it("orders children like their parents", () => {
    const placed = byId(layoutTree(people, relationships, size));
    const lanFirst = placed.get("lan")!.x < placed.get("thuc")!.x;
    expect(placed.get("an")!.x < placed.get("ha")!.x).toBe(lanFirst);
  });

  it("starts every unconnected family at row 0", () => {
    const list = [person("a", "A"), person("b", "B"), person("loner", "Loner")];
    const placed = byId(layoutTree(list, [rel("a", "PARENT_OF", "b")]));
    expect(placed.get("a")!.generation).toBe(0);
    expect(placed.get("b")!.generation).toBe(1);
    expect(placed.get("loner")!.generation).toBe(0);
    expect(placed.get("b")!.y).toBe(DEFAULT_LAYOUT.nodeH + DEFAULT_LAYOUT.vGap);
  });

  it("ignores edges to people who are not in the list", () => {
    const placed = layoutTree([person("a", "A")], [rel("ghost", "PARENT_OF", "a")]);
    expect(placed).toEqual([expect.objectContaining({ id: "a", generation: 0, x: 0, y: 0 })]);
  });
});

describe("familyConnectors", () => {
  const size: LayoutSize = { nodeW: 100, nodeH: 50, hGap: 10, vGap: 50 };
  const at = (id: string, x: number, y: number): PositionedPerson => ({ ...person(id, id), x, y, generation: 0 });
  const positioned = [at("dad", 0, 0), at("mom", 110, 0), at("kid", 0, 100)];
  const rels = [rel("dad", "SPOUSE_OF", "mom"), rel("dad", "PARENT_OF", "kid"), rel("mom", "PARENT_OF", "kid")];

  it("draws one bus per set of parents and a straight spouse line", () => {
    expect(familyConnectors(positioned, rels, size)).toEqual([
      {
        key: "fam-dad+mom",
        d: "M50,75 H160 M50,50 V75 M160,50 V75 M50,75 V100",
        kind: "parent",
        pending: false,
      },
      { key: "dad-SPOUSE_OF-mom", d: "M100,25 L110,25", kind: "spouse", pending: false },
    ]);
  });

  it("splits pending edges into dashed connectors drawn last", () => {
    const pending = new Set(["dad-PARENT_OF-kid", "mom-PARENT_OF-kid"]);
    const out = familyConnectors(positioned, rels, size, pending);
    expect(out.map((c) => [c.key, c.pending])).toEqual([
      ["dad-SPOUSE_OF-mom", false],
      ["fam-dad+mom-pending", true],
    ]);
  });

  it("keeps the confirmed parent solid when only one parent edge is pending", () => {
    const out = familyConnectors(positioned, rels, size, new Set(["mom-PARENT_OF-kid"]));
    const solid = out.find((c) => c.key === "fam-dad+mom")!;
    const dashed = out.find((c) => c.key === "fam-dad+mom-pending")!;
    expect(solid.d).toBe("M50,75 H50 M50,50 V75 M50,75 V100");
    expect(dashed.d).toBe("M50,75 H160 M160,50 V75");
  });

  it("draws siblings as an arc and skips people who are not placed", () => {
    const out = familyConnectors(
      [at("a", 0, 0), at("b", 220, 0)],
      [rel("b", "SIBLING_OF", "a"), rel("a", "SPOUSE_OF", "ghost"), rel("ghost", "PARENT_OF", "a")],
      size
    );
    expect(out).toEqual([{ key: "b-SIBLING_OF-a", d: "M50,0 Q160,-28 270,0", kind: "sibling", pending: false }]);
  });

  it("puts the bus at vGap / 2 when parents and children are too close", () => {
    const tight = [at("dad", 0, 0), at("kid", 0, 60)];
    const [bus] = familyConnectors(tight, [rel("dad", "PARENT_OF", "kid")], size);
    expect(bus.d).toBe("M50,75 H50 M50,50 V75 M50,75 V60");
  });
});
