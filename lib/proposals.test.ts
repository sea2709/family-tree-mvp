import { describe, expect, it } from "vitest";
import { person, rel } from "@/test/family";
import type { Proposal } from "./types";
import {
  applyProposalBatch,
  batchOf,
  describeProposal,
  initials,
  isAncestor,
  rejectProposalBatch,
  sameNamePerson,
  scopeBatch,
  uid,
  type TreeState,
} from "./proposals";

const newPerson = (id: string, tempId: string, displayName: string, extra: Partial<Proposal> = {}): Proposal => ({
  id,
  kind: "person",
  tempId,
  displayName,
  reason: "test",
  confidence: "high",
  ...extra,
});

const link = (id: string, fromRef: string, type: Proposal["relationshipType"], toRef: string): Proposal => ({
  id,
  kind: "relationship",
  fromRef,
  toRef,
  relationshipType: type,
  reason: "test",
  confidence: "high",
});

const state = (partial: Partial<TreeState>): TreeState => ({
  people: [],
  relationships: [],
  proposals: [],
  resolvedRefs: {},
  egoId: null,
  ...partial,
});

describe("uid", () => {
  it("returns unique ids", () => {
    expect(uid()).not.toBe(uid());
  });
});

describe("initials", () => {
  it("takes the first letter of the first two words", () => {
    expect(initials("tran hai dang")).toBe("TH");
    expect(initials("  Lan  ")).toBe("L");
    expect(initials("")).toBe("");
  });
});

describe("scopeBatch / batchOf", () => {
  it("prefixes proposal ids and new tempIds but leaves existing ids alone", () => {
    const batch = [newPerson("p1", "temp-minh", "Minh"), link("p2", "temp-minh", "PARENT_OF", "lan")];
    const scoped = scopeBatch(batch, [person("lan", "Lan")], "abc");
    expect(scoped.map((p) => [p.id, p.tempId, p.fromRef, p.toRef])).toEqual([
      ["abc:p1", "abc:temp-minh", undefined, undefined],
      ["abc:p2", undefined, "abc:temp-minh", "lan"],
    ]);
    expect(batchOf(scoped[0])).toBe("abc");
  });

  it("does not rename an update card whose tempId is an existing person", () => {
    const [scoped] = scopeBatch([newPerson("p1", "lan", "Lan")], [person("lan", "Lan")], "abc");
    expect(scoped.tempId).toBe("lan");
  });
});

describe("sameNamePerson", () => {
  const people = [person("minh", "Minh"), person("hoa", "Tran Hieu Hoa", { preferredName: "Hoa" })];

  it("matches display or preferred names case-insensitively", () => {
    expect(sameNamePerson(newPerson("p", "t", "minh"), people)?.id).toBe("minh");
    expect(sameNamePerson(newPerson("p", "t", "HOA"), people)?.id).toBe("hoa");
    expect(sameNamePerson(newPerson("p", "t", "Hieu", { preferredName: "Tran Hieu Hoa" }), people)?.id).toBe("hoa");
  });

  it("ignores updates, relationships and new names", () => {
    expect(sameNamePerson(newPerson("p", "minh", "Minh"), people)).toBeUndefined();
    expect(sameNamePerson(link("r", "a", "PARENT_OF", "b"), people)).toBeUndefined();
    expect(sameNamePerson(newPerson("p", "t", "Tuan"), people)).toBeUndefined();
  });
});

describe("isAncestor", () => {
  const rels = [rel("gp", "PARENT_OF", "dad"), rel("dad", "PARENT_OF", "kid"), rel("dad", "SPOUSE_OF", "mom")];

  it("walks PARENT_OF edges upward", () => {
    expect(isAncestor("gp", "kid", rels)).toBe(true);
    expect(isAncestor("kid", "kid", rels)).toBe(true);
    expect(isAncestor("kid", "gp", rels)).toBe(false);
    expect(isAncestor("mom", "kid", rels)).toBe(false);
  });

  it("terminates on cyclic data", () => {
    const cyclic = [rel("a", "PARENT_OF", "b"), rel("b", "PARENT_OF", "a")];
    expect(isAncestor("z", "a", cyclic)).toBe(false);
  });
});

describe("describeProposal", () => {
  const people = [person("lan", "Lan"), person("minh", "Minh")];

  it("describes a new person with name, preferred name, birth and place", () => {
    const p = newPerson("p", "t", "Tran Van Minh", {
      preferredName: "Minh",
      birthDate: "1960-03-05",
      birthPlace: "Hanoi",
    });
    expect(describeProposal(p, people, [], {})).toBe("Add person: Tran Van Minh (Minh) born 5 Mar 1960 in Hanoi");
  });

  it("describes an update to an existing person", () => {
    const update: Proposal = { id: "p", kind: "person", tempId: "minh", birthYear: 1960, reason: "", confidence: "high" };
    expect(describeProposal(update, people, [], {})).toBe("Update Minh: born 1960");
    expect(describeProposal({ ...update, displayName: "Tran Van Minh" }, people, [], {})).toBe(
      "Update Minh: Tran Van Minh born 1960"
    );
  });

  it("names both sides of a relationship from people, pending cards or resolved refs", () => {
    const pending = [newPerson("p1", "temp-hoa", "Hoa")];
    const resolved = { "temp-minh": "minh" };
    expect(describeProposal(link("r", "temp-minh", "PARENT_OF", "lan"), people, pending, resolved)).toBe(
      "Minh is a parent of Lan"
    );
    expect(describeProposal(link("r", "minh", "SPOUSE_OF", "temp-hoa"), people, pending, {})).toBe(
      "Minh is married to Hoa"
    );
    expect(describeProposal(link("r", "minh", "PARTNER_OF", "lan"), people, [], {})).toBe("Minh is a partner of Lan");
    expect(describeProposal(link("r", "minh", "SIBLING_OF", "nobody"), people, [], {})).toBe(
      "Minh is a sibling of someone"
    );
    expect(describeProposal(link("r", "", undefined, "lan"), people, [], {})).toBe("someone is related to Lan");
  });
});

describe("applyProposalBatch", () => {
  it("adds a new person and remembers their tempId", () => {
    const card = newPerson("p1", "temp-minh", "Minh", { birthDate: "1960-03-05", gender: "male" });
    const { next, lastCreatedId } = applyProposalBatch(state({ proposals: [card] }), [card]);
    expect(next.people).toEqual([
      expect.objectContaining({ id: lastCreatedId, displayName: "Minh", birthYear: 1960, birthDate: "1960-03-05", gender: "male" }),
    ]);
    expect(next.resolvedRefs).toEqual({ "temp-minh": lastCreatedId });
    expect(next.proposals).toEqual([]);
  });

  it("accepting a relationship also accepts the pending people it needs", () => {
    const minh = newPerson("p1", "temp-minh", "Minh");
    const edge = link("p2", "temp-minh", "PARENT_OF", "lan");
    const before = state({ people: [person("lan", "Lan")], proposals: [minh, edge] });
    const { next } = applyProposalBatch(before, [edge]);
    const minhId = next.resolvedRefs["temp-minh"];
    expect(next.people.map((p) => p.displayName)).toEqual(["Lan", "Minh"]);
    expect(next.relationships).toEqual([expect.objectContaining({ fromPersonId: minhId, toPersonId: "lan", type: "PARENT_OF" })]);
    expect(next.proposals).toEqual([]);
  });

  it("resolves refs to people accepted in an earlier batch", () => {
    const edge = link("p2", "temp-minh", "PARENT_OF", "lan");
    const before = state({
      people: [person("lan", "Lan"), person("m1", "Minh")],
      proposals: [edge],
      resolvedRefs: { "temp-minh": "m1" },
    });
    const { next } = applyProposalBatch(before, [edge]);
    expect(next.relationships).toEqual([expect.objectContaining({ fromPersonId: "m1", toPersonId: "lan" })]);
  });

  it("sets the speaker only from the speaker's card, and only once", () => {
    const minh = newPerson("p1", "temp-minh", "Minh");
    const lan = newPerson("p2", "temp-lan", "Lan", { isSpeaker: true });
    const { next } = applyProposalBatch(state({ proposals: [minh, lan] }), [minh, lan]);
    expect(next.egoId).toBe(next.resolvedRefs["temp-lan"]);

    const other = newPerson("p3", "temp-x", "X", { isSpeaker: true });
    const again = applyProposalBatch({ ...next, proposals: [other] }, [other]);
    expect(again.next.egoId).toBe(next.egoId);
  });

  it("updates an existing person and keeps the old name as the preferred name", () => {
    const thuc = person("thuc", "Thuc", { gender: "male", birthYear: 1990, birthDate: "1990-04-01" });
    const card = newPerson("p1", "thuc", "Tran Dang Thuc", { gender: "female", birthPlace: "Hue" });
    const { next, lastCreatedId } = applyProposalBatch(state({ people: [thuc], proposals: [card] }), [card]);
    expect(lastCreatedId).toBeNull();
    expect(next.people).toEqual([
      {
        ...thuc,
        displayName: "Tran Dang Thuc",
        preferredName: "Thuc",
        birthPlace: "Hue",
        bio: null,
        gender: "male",
      },
    ]);
  });

  it("drops a stored birth date that contradicts a new birth year", () => {
    const thuc = person("thuc", "Thuc", { birthYear: 1990, birthDate: "1990-04-01" });
    const card: Proposal = { id: "p1", kind: "person", tempId: "thuc", birthYear: 1991, reason: "", confidence: "high" };
    const { next } = applyProposalBatch(state({ people: [thuc], proposals: [card] }), [card]);
    expect(next.people[0]).toMatchObject({ displayName: "Thuc", birthYear: 1991, birthDate: null });
  });

  it("merges into the chosen existing person without renaming them", () => {
    const minh = person("minh", "Minh");
    const card = newPerson("p1", "temp-minh", "Minh Nguyen", { existingPersonId: "minh", preferredName: "Ba Minh" });
    const { next } = applyProposalBatch(state({ people: [minh], proposals: [card] }), [card]);
    expect(next.people).toEqual([expect.objectContaining({ id: "minh", displayName: "Minh", preferredName: null })]);
    expect(next.resolvedRefs).toEqual({ "temp-minh": "minh" });
  });

  it("skips duplicate edges, including reversed symmetric ones", () => {
    const people = [person("a", "A"), person("b", "B")];
    const spouse = link("p1", "b", "SPOUSE_OF", "a");
    const parent = link("p2", "a", "PARENT_OF", "b");
    const before = state({
      people,
      relationships: [rel("a", "SPOUSE_OF", "b"), rel("a", "PARENT_OF", "b")],
      proposals: [spouse, parent],
    });
    const { next } = applyProposalBatch(before, [spouse, parent]);
    expect(next.relationships).toHaveLength(2);
    expect(next.proposals).toEqual([]);
  });

  it("refuses to make someone their own ancestor", () => {
    const people = [person("gp", "Ong"), person("kid", "Lan")];
    const card = link("p1", "kid", "PARENT_OF", "gp");
    const before = state({ people, relationships: [rel("gp", "PARENT_OF", "kid")], proposals: [card] });
    const { next, skipped } = applyProposalBatch(before, [card]);
    expect(next.relationships).toHaveLength(1);
    expect(skipped).toEqual([expect.stringContaining(`"Lan is a parent of Ong"`)]);
  });

  it("ignores cards that are no longer pending and self-links", () => {
    const people = [person("a", "A")];
    const self = link("p1", "a", "SPOUSE_OF", "a");
    const stale = newPerson("gone", "temp-x", "X");
    const { next } = applyProposalBatch(state({ people, proposals: [self] }), [stale, self]);
    expect(next.people).toEqual(people);
    expect(next.relationships).toEqual([]);
    expect(next.proposals).toEqual([]);
  });
});

describe("rejectProposalBatch", () => {
  it("drops relationship cards that depend on a rejected new person", () => {
    const minh = newPerson("p1", "temp-minh", "Minh");
    const keep = link("p3", "lan", "SPOUSE_OF", "nam");
    const proposals = [minh, link("p2", "temp-minh", "PARENT_OF", "lan"), keep];
    expect(rejectProposalBatch(state({ proposals }), [minh])).toEqual([keep]);
  });

  it("keeps relationship cards when the rejected card was an update or already accepted", () => {
    const update = newPerson("p1", "lan", "Lan Tran");
    const edge = link("p2", "lan", "SPOUSE_OF", "nam");
    expect(
      rejectProposalBatch(state({ people: [person("lan", "Lan")], proposals: [update, edge] }), [update])
    ).toEqual([edge]);

    const accepted = newPerson("p3", "temp-minh", "Minh");
    const edge2 = link("p4", "temp-minh", "PARENT_OF", "lan");
    expect(
      rejectProposalBatch(state({ proposals: [accepted, edge2], resolvedRefs: { "temp-minh": "m1" } }), [accepted])
    ).toEqual([edge2]);
  });
});
