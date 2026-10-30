import { describe, expect, it } from "vitest";
import { rel } from "@/test/family";
import { extractFallback } from "./extract-fallback";
import type { ChatHistoryItem, Proposal, RosterPerson, RosterRelationship } from "./types";

type Context = {
  roster?: RosterPerson[];
  egoId?: string | null;
  relationships?: RosterRelationship[];
  history?: ChatHistoryItem[];
};

// Runs the parser and returns its proposals in a readable shape:
// new people by name, and edges as "Minh PARENT_OF Lan".
function extract(message: string, ctx: Context = {}) {
  const roster = ctx.roster ?? [];
  const result = extractFallback(message, roster, ctx.egoId ?? null, ctx.relationships ?? [], ctx.history ?? []);
  const nameOf = (ref?: string) =>
    result.proposals.find((p) => p.kind === "person" && p.tempId === ref)?.displayName ??
    roster.find((r) => r.id === ref)?.displayName ??
    ref;
  const people = result.proposals.filter((p) => p.kind === "person");
  return {
    ...result,
    people,
    person: (name: string): Proposal => {
      const found = people.find((p) => p.displayName === name);
      if (!found) throw new Error(`no person card for ${name}: ${people.map((p) => p.displayName).join(", ")}`);
      return found;
    },
    edges: result.proposals
      .filter((p) => p.kind === "relationship")
      .map((p) => `${nameOf(p.fromRef)} ${p.relationshipType} ${nameOf(p.toRef)}`),
  };
}

const lan: RosterPerson = { id: "lan", displayName: "Lan", gender: "female" };
const minh: RosterPerson = { id: "minh", displayName: "Minh", gender: "male" };
const hoa: RosterPerson = { id: "hoa", displayName: "Hoa", gender: "female" };
const thuc: RosterPerson = { id: "thuc", displayName: "Thuc", gender: "male" };
const withParents: Context = {
  roster: [lan, minh, hoa],
  egoId: "lan",
  relationships: [rel("minh", "PARENT_OF", "lan"), rel("hoa", "PARENT_OF", "lan")],
};

describe("the speaker", () => {
  it.each(["I'm Lan", "I am Lan.", "My name is Lan"])("recognises %j", (message) => {
    const r = extract(message);
    expect(r.people).toEqual([expect.objectContaining({ displayName: "Lan", isSpeaker: true, confidence: "high" })]);
    expect(r.modelUsed).toBe("fallback");
    expect(r.reply).toContain("Lan");
  });

  it("upgrades to the full name and keeps the short one as preferred", () => {
    const r = extract("My name is Dang, full name is Tran Hai Dang");
    expect(r.people).toEqual([expect.objectContaining({ displayName: "Tran Hai Dang", preferredName: "Dang" })]);
  });

  it("does not treat 'I am married to ...' as a name", () => {
    const r = extract("I am married to Nam", { roster: [lan], egoId: "lan" });
    expect(r.people.map((p) => p.displayName)).toEqual(["Nam"]);
    expect(r.edges).toEqual(["Lan SPOUSE_OF Nam"]);
  });

  it("asks who is speaking before adding relatives", () => {
    const r = extract("My dad is Minh");
    expect(r.proposals).toEqual([]);
    expect(r.reply).toMatch(/who are you/i);
  });
});

describe("parents, children and partners", () => {
  it("handles 'My dad is Minh, born 1960 in Hanoi' in the same message as the speaker", () => {
    const r = extract("I'm Lan. My dad is Minh, born 1960 in Hanoi");
    expect(r.person("Minh")).toMatchObject({ birthYear: 1960, birthPlace: "Hanoi", gender: "male" });
    expect(r.person("Minh").birthDate).toBeUndefined();
    expect(r.edges).toEqual(["Minh PARENT_OF Lan"]);
  });

  it.each([
    ["Minh is my dad", "Minh PARENT_OF Lan"],
    ["My mom name is Hoa", "Hoa PARENT_OF Lan"],
    ["My son is An", "Lan PARENT_OF An"],
    ["My husband is Nam", "Lan SPOUSE_OF Nam"],
    ["My partner is Nam", "Lan PARTNER_OF Nam"],
    ["Nam is my husband", "Lan SPOUSE_OF Nam"],
    ["An is my daughter", "Lan PARENT_OF An"],
  ])("%j -> %s", (message, edge) => {
    expect(extract(message, { roster: [lan], egoId: "lan" }).edges).toEqual([edge]);
  });

  it("handles 'My parents are Minh and Hoa'", () => {
    const r = extract("My parents are Minh and Hoa", { roster: [lan], egoId: "lan" });
    expect(r.edges).toEqual(["Minh PARENT_OF Lan", "Hoa PARENT_OF Lan"]);
  });

  it("uses the full name in brackets as the display name", () => {
    const r = extract("My mom is Hoa (Tran Hieu Hoa)", { roster: [lan], egoId: "lan" });
    expect(r.people).toEqual([
      expect.objectContaining({ displayName: "Tran Hieu Hoa", preferredName: "Hoa", gender: "female" }),
    ]);
  });

  it("reuses a person already in the roster instead of duplicating them", () => {
    const r = extract("My dad is Minh", { roster: [lan, minh], egoId: "lan" });
    expect(r.people).toEqual([]);
    expect(r.edges).toEqual(["Minh PARENT_OF Lan"]);
  });

  it("says so when the fact is already in the tree", () => {
    const r = extract("My dad is Minh", withParents);
    expect(r.proposals).toEqual([]);
    expect(r.reply).toMatch(/already in your tree/);
  });

  it("creates a different person when a known name is used for a clashing role", () => {
    const r = extract("My son is Minh", withParents);
    expect(r.people).toEqual([
      expect.objectContaining({
        displayName: "Minh",
        confidence: "medium",
        reason: expect.stringContaining("a different person from the Minh already in your tree"),
      }),
    ]);
    expect(r.proposals.find((p) => p.kind === "relationship")).toMatchObject({ fromRef: "lan", toRef: r.people[0].tempId });
  });

  it("handles 'He married my mom, Hoa' after the dad was named", () => {
    const r = extract("My dad is Minh. He married my mom, Hoa", { roster: [lan], egoId: "lan" });
    expect(r.edges).toEqual(["Minh PARENT_OF Lan", "Minh SPOUSE_OF Hoa", "Hoa PARENT_OF Lan"]);
    expect(r.person("Hoa").gender).toBe("female");
  });
});

describe("siblings", () => {
  it("links a new sibling to parents already in the tree", () => {
    const r = extract("My brother is Thuc", withParents);
    expect(r.person("Thuc")).toMatchObject({ gender: "male", confidence: "medium" });
    expect(r.edges).toEqual(["Minh PARENT_OF Thuc", "Hoa PARENT_OF Thuc"]);
  });

  it("links straight to the speaker when no parents are known", () => {
    expect(extract("Thuc is my brother", { roster: [lan], egoId: "lan" }).edges).toEqual(["Lan SIBLING_OF Thuc"]);
  });

  it("handles 'I have a brother, his name is Thuc'", () => {
    const r = extract("I have a brother, his name is Thuc", withParents);
    expect(r.people.map((p) => p.displayName)).toEqual(["Thuc"]);
    expect(r.edges).toEqual(["Minh PARENT_OF Thuc", "Hoa PARENT_OF Thuc"]);
  });

  it("handles a list: 'I have two sisters, Mai and Ha'", () => {
    const r = extract("I have two sisters, Mai and Ha", { roster: [lan], egoId: "lan" });
    expect(r.people.map((p) => [p.displayName, p.gender])).toEqual([
      ["Mai", "female"],
      ["Ha", "female"],
    ]);
    expect(r.edges).toEqual(["Lan SIBLING_OF Mai", "Lan SIBLING_OF Ha"]);
  });
});

describe("relatives of relatives", () => {
  it("resolves 'My dad's brother is Tuan' through the graph", () => {
    const r = extract("My dad's brother is Tuan", withParents);
    expect(r.edges).toEqual(["Minh SIBLING_OF Tuan"]);
    expect(r.person("Tuan").gender).toBe("male");
  });

  it("resolves 'my dad' from earlier turns when genders are unknown", () => {
    const ctx: Context = {
      ...withParents,
      roster: [lan, { id: "minh", displayName: "Minh" }, { id: "hoa", displayName: "Hoa" }],
      history: [{ role: "user", text: "My dad name is Minh, and my mom name is Hoa" }],
    };
    expect(extract("My mom's mother is Ba", ctx).edges).toEqual(["Ba PARENT_OF Hoa"]);
  });

  it("creates the person but asks when the parent cannot be identified", () => {
    const r = extract("My dad's wife is Van", { roster: [lan], egoId: "lan" });
    expect(r.edges).toEqual([]);
    expect(r.person("Van").confidence).toBe("medium");
    expect(r.reply).toMatch(/couldn't tell which of your parents/);
  });

  it("resolves 'My brother's wife is Thu' to the only brother", () => {
    const ctx: Context = { roster: [lan, thuc], egoId: "lan", relationships: [rel("lan", "SIBLING_OF", "thuc")] };
    expect(extract("My brother's wife is Thu", ctx).edges).toEqual(["Thuc SPOUSE_OF Thu"]);
    expect(extract("My brother's son is Khoi", ctx).edges).toEqual(["Thuc PARENT_OF Khoi"]);
  });

  it("asks which sibling when there are no siblings to pick from", () => {
    const r = extract("My sister's husband is Nam", { roster: [lan], egoId: "lan" });
    expect(r.edges).toEqual([]);
    expect(r.reply).toMatch(/couldn't tell which sibling/);
  });

  it.each([
    ["Thuc's wife is Hang", "Thuc SPOUSE_OF Hang"],
    ["Thuc's mom is Hoa", "Hoa PARENT_OF Thuc"],
    ["Thuc's son is Khoi", "Thuc PARENT_OF Khoi"],
    ["Thuc's sister is Mai", "Thuc SIBLING_OF Mai"],
  ])("handles %j", (message, edge) => {
    expect(extract(message, { roster: [lan, thuc], egoId: "lan" }).edges).toEqual([edge]);
  });

  it("does not guess which side an uncle is on", () => {
    const r = extract("My uncle is Tuan", { roster: [lan], egoId: "lan" });
    expect(r.people).toEqual([expect.objectContaining({ displayName: "Tuan", confidence: "low", gender: "male" })]);
    expect(r.edges).toEqual([]);
    expect(r.reply).toMatch(/ambiguous/);
  });
});

describe("children of a couple", () => {
  it("handles 'They have 3 kids: ...' after a couple in the previous turn", () => {
    const hang: RosterPerson = { id: "hang", displayName: "Hang" };
    const r = extract("They have 3 kids: Thanh Ha, Tra My and Anh Khoi", {
      roster: [lan, thuc, hang],
      egoId: "lan",
      relationships: [rel("thuc", "SPOUSE_OF", "hang")],
      history: [{ role: "user", text: "Thuc's wife is Hang" }],
    });
    expect(r.people.map((p) => p.displayName)).toEqual(["Thanh Ha", "Tra My", "Anh Khoi"]);
    expect(r.edges).toHaveLength(6);
    expect(r.edges).toContain("Hang PARENT_OF Tra My");
  });

  it("links 'We have two kids' to the speaker and their spouse", () => {
    const r = extract("We have two kids, An and Binh", {
      roster: [lan, { id: "nam", displayName: "Nam" }],
      egoId: "lan",
      relationships: [rel("lan", "SPOUSE_OF", "nam")],
    });
    expect(r.edges).toEqual(["Lan PARENT_OF An", "Nam PARENT_OF An", "Lan PARENT_OF Binh", "Nam PARENT_OF Binh"]);
  });

  it("asks whose children they are when no parents can be found", () => {
    const r = extract("They have two daughters, Mai and Ha", { roster: [lan], egoId: "lan" });
    expect(r.people.map((p) => p.gender)).toEqual(["female", "female"]);
    expect(r.edges).toEqual([]);
    expect(r.reply).toMatch(/couldn't tell whose children/);
  });
});

describe("birth details", () => {
  it.each([
    ["I was born on 5 March 1990", "1990-03-05"],
    ["I was born March 5th, 1990", "1990-03-05"],
    ["I was born 1990-03-05", "1990-03-05"],
  ])("parses a full date from %j", (message, date) => {
    const r = extract(message, { roster: [lan], egoId: "lan" });
    expect(r.people).toEqual([expect.objectContaining({ tempId: "lan", birthDate: date, birthYear: 1990 })]);
  });

  it("keeps only the year when the date is ambiguous or incomplete", () => {
    expect(extract("I was born in 1990", { roster: [lan], egoId: "lan" }).people[0]).toMatchObject({ birthYear: 1990 });
    expect(extract("I was born in 1990", { roster: [lan], egoId: "lan" }).people[0].birthDate).toBeUndefined();
  });

  it("marks approximate years as low confidence", () => {
    const r = extract("My dad is Minh, born around 1960", { roster: [lan], egoId: "lan" });
    expect(r.person("Minh")).toMatchObject({ birthYear: 1960, confidence: "low" });
  });

  it("ignores implausible years", () => {
    const r = extract("I was born in 1066", { roster: [lan], egoId: "lan" });
    expect(r.proposals).toEqual([]);
  });

  it("attaches 'He was born ...' to the person just mentioned", () => {
    const r = extract("My brother's full name is Tran Dang Thuc. He was born in 1990", {
      roster: [lan, thuc],
      egoId: "lan",
      relationships: [rel("lan", "SIBLING_OF", "thuc")],
    });
    expect(r.people).toEqual([
      expect.objectContaining({ tempId: "thuc", displayName: "Tran Dang Thuc", preferredName: "Thuc", birthYear: 1990 }),
    ]);
  });

  it("handles 'Minh, born 1960 in Hanoi' and 'Minh was born ...' for known names", () => {
    expect(extract("Minh, born 1960 in Hanoi", { roster: [lan], egoId: "lan" }).person("Minh")).toMatchObject({
      birthYear: 1960,
      birthPlace: "Hanoi",
    });
    expect(extract("Minh was born on 5 March 1960", { roster: [lan, minh], egoId: "lan" }).people).toEqual([
      expect.objectContaining({ tempId: "minh", birthDate: "1960-03-05" }),
    ]);
  });

  it("drops updates that repeat what the tree already has", () => {
    const r = extract("Minh was born in 1960", { roster: [lan, { ...minh, birthYear: 1960 }], egoId: "lan" });
    expect(r.proposals).toEqual([]);
    expect(r.reply).toMatch(/already in your tree/);
  });

  it("works out a birth year from a relative age", () => {
    const r = extract("I'm Dang. My brother is Thuc, born 1990. He is 2 years younger than me.");
    expect(r.person("Dang")).toMatchObject({ birthYear: 1988, confidence: "medium" });
    expect(r.person("Dang").reason).toContain("Worked out from: Thuc born 1990");
    expect(r.reply).toContain("I worked out your birth year as about 1988");
  });

  it("works out a relative's birth year from the speaker's", () => {
    const r = extract("I am three years older than Thuc", {
      roster: [{ ...lan, birthYear: 1990 }, thuc],
      egoId: "lan",
    });
    expect(r.people).toEqual([expect.objectContaining({ tempId: "thuc", birthYear: 1993 })]);
  });
});

describe("renaming", () => {
  it("asks whose full name it is when it can't tell", () => {
    const r = extract("My wife full name is Tran Thi Mai", { roster: [lan], egoId: "lan" });
    expect(r.proposals).toEqual([]);
    expect(r.reply).toBe("I couldn't tell whose full name Tran Thi Mai is — tell me their current name and I'll update them.");
  });

  it("renames a person by their current name", () => {
    const r = extract("Thuc's full name is Tran Dang Thuc", { roster: [lan, thuc], egoId: "lan" });
    expect(r.people).toEqual([expect.objectContaining({ tempId: "thuc", displayName: "Tran Dang Thuc" })]);
  });
});

describe("nothing to extract", () => {
  it("asks for a clearer fact", () => {
    const r = extract("hello there", { roster: [lan], egoId: "lan" });
    expect(r.proposals).toEqual([]);
    expect(r.reply).toMatch(/couldn't pull a clear family fact/);
  });
});
