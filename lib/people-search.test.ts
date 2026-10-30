import { describe, expect, it } from "vitest";
import { ids, person, rel } from "@/test/family";
import { foldName, matchPeople, relativeCandidates } from "./people-search";

describe("foldName", () => {
  it("strips accents, maps đ to d, lowercases and trims", () => {
    expect(foldName("  Nguyễn Văn Đức ")).toBe("nguyen van duc");
    expect(foldName("đặng")).toBe("dang");
  });
});

describe("matchPeople", () => {
  const people = [
    person("a", "Nguyễn Văn Minh"),
    person("b", "Minh Tran"),
    person("c", "Tran Minh Anh"),
    person("d", "Thanhminh"),
    person("e", "Lan", { preferredName: "Minh Lan" }),
    person("f", "Hoa"),
  ];

  it("ranks full-name prefix, then word prefix, then substring, then alphabetically", () => {
    // e matches through its preferred name "Minh Lan".
    expect(matchPeople("minh", people, [], 10).map((p) => p.id)).toEqual(["e", "b", "a", "c", "d"]);
  });

  it("puts people already linked in the tree first within a tier", () => {
    const names = matchPeople("minh", people, [rel("c", "SPOUSE_OF", "f")], 10).map((p) => p.id);
    expect(names).toEqual(["e", "b", "c", "a", "d"]);
  });

  it("matches without accents and respects the limit", () => {
    expect(matchPeople("nguyen", people, []).map((p) => p.id)).toEqual(["a"]);
    expect(matchPeople("minh", people, [], 2)).toHaveLength(2);
    expect(matchPeople("   ", people, [])).toEqual([]);
  });
});

describe("relativeCandidates", () => {
  // gp -> dad -> kid -> gk, and other -> half
  const people = ["gp", "dad", "kid", "gk", "other", "half"].map((id) => person(id, id));
  const rels = [
    rel("gp", "PARENT_OF", "dad"),
    rel("dad", "PARENT_OF", "kid"),
    rel("kid", "PARENT_OF", "gk"),
    rel("other", "PARENT_OF", "half"),
  ];
  const candidates = (kind: Parameters<typeof relativeCandidates>[0], id: string, coParent: string | null = null) =>
    ids(relativeCandidates(kind, id, people, rels, coParent));

  it("never offers a descendant as a parent", () => {
    expect(candidates("parent", "dad")).toEqual(["half", "other"]);
  });

  it("offers no parents once someone already has two", () => {
    const withMom = [...rels, rel("mom", "PARENT_OF", "kid")];
    expect(relativeCandidates("parent", "kid", [...people, person("mom", "mom")], withMom, null)).toEqual([]);
  });

  it("never offers an ancestor as a child or gives a child three parents", () => {
    expect(candidates("child", "kid")).toEqual(["half", "other"]);
    expect(candidates("child", "kid", "other")).toEqual(["other"]);
  });

  it("only offers parentless people as siblings when parents are known", () => {
    expect(candidates("sibling", "kid")).toEqual(["other"]);
    expect(candidates("sibling", "gp")).toEqual(["half", "other"]);
  });

  it("excludes direct-line relatives as partners", () => {
    expect(candidates("partner", "kid")).toEqual(["half", "other"]);
  });
});
