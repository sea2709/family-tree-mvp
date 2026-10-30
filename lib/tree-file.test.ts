import { describe, expect, it } from "vitest";
import { person, rel } from "@/test/family";
import { exportFileName, parseTreeFile, serializeTree, type TreeFile } from "./tree-file";

const file = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    app: "family-tree-mvp",
    version: 1,
    exportedAt: "2026-10-30T00:00:00.000Z",
    egoId: "lan",
    people: [{ id: "lan", displayName: "Lan" }, { id: "minh", displayName: "Minh" }],
    relationships: [{ id: "r1", fromPersonId: "minh", toPersonId: "lan", type: "PARENT_OF" }],
    layout: {},
    ...overrides,
  });

const parsed = (text: string): TreeFile => {
  const result = parseTreeFile(text);
  if (!result.ok) throw new Error(result.error);
  return result.data;
};

describe("serializeTree / parseTreeFile round trip", () => {
  it("restores what was exported and drops layout for deleted people", () => {
    const tree = {
      people: [
        person("lan", "Lan", { birthDate: "1990-03-05", birthYear: 1990, gender: "female" as const }),
        person("minh", "Minh", { birthYear: 1960, birthDatePrecision: "circa" as const }),
      ],
      relationships: [rel("minh", "PARENT_OF", "lan")],
      egoId: "lan",
      layout: { lan: { x: 10, y: 20 }, deleted: { x: 0, y: 0 } },
    };
    const data = parsed(serializeTree(tree));
    expect(data.egoId).toBe("lan");
    expect(data.relationships).toEqual(tree.relationships);
    expect(data.layout).toEqual({ lan: { x: 10, y: 20 } });
    expect(data.people[0]).toMatchObject({ id: "lan", birthDate: "1990-03-05", birthYear: 1990, gender: "female" });
    expect(data.people[1]).toMatchObject({ id: "minh", birthYear: 1960, birthDatePrecision: "circa" });
  });
});

describe("parseTreeFile rejects files it cannot use", () => {
  it.each([
    ["not json", "{", "This file isn't valid JSON."],
    ["another app", file({ app: "other" }), "This isn't a Family Tree export."],
    ["an array", "[]", "This isn't a Family Tree export."],
    ["a newer version", file({ version: 2 }), "This file was made by a newer version of the app."],
    ["a missing version", file({ version: "1" }), "This file was made by a newer version of the app."],
    ["no people array", file({ people: "lots" }), "No people found in this file."],
    ["no valid people", file({ people: [{ id: "", displayName: "X" }, { id: "x" }] }), "No people found in this file."],
  ])("rejects %s", (_, text, error) => {
    expect(parseTreeFile(text)).toEqual({ ok: false, error });
  });
});

describe("parseTreeFile sanitises what it keeps", () => {
  it("cleans people fields", () => {
    const data = parsed(
      file({
        people: [
          {
            id: "lan",
            displayName: "Lan",
            preferredName: "  ",
            birthDate: "1990-02-30",
            birthYear: 1990.5,
            deathYear: 2080,
            avatarUrl: "https://evil.example/track.png",
            gender: "other",
            birthDatePrecision: "sometime",
          },
          { id: "minh", displayName: "Minh", birthDate: "1960-03-05", birthYear: 1999, avatarUrl: "data:image/png;base64,AA" },
          { id: "lan", displayName: "Duplicate Lan" },
          "not a person",
        ],
      })
    );
    expect(data.people).toEqual([
      {
        id: "lan",
        displayName: "Lan",
        preferredName: null,
        birthYear: null,
        birthDate: null,
        birthPlace: null,
        deathYear: 2080,
        bio: null,
        avatarUrl: null,
        gender: null,
      },
      expect.objectContaining({ id: "minh", birthYear: 1960, birthDate: "1960-03-05", avatarUrl: "data:image/png;base64,AA" }),
    ]);
  });

  it("keeps only valid, unique relationships between known people", () => {
    const good = { id: "r1", fromPersonId: "minh", toPersonId: "lan", type: "PARENT_OF" };
    const data = parsed(
      file({
        relationships: [
          good,
          { ...good, toPersonId: "minh" },
          { ...good, id: "r2", type: "COUSIN_OF" },
          { ...good, id: "r3", fromPersonId: "ghost" },
          { ...good, id: "r4", fromPersonId: "lan", toPersonId: "lan" },
          { ...good, id: "", type: "SPOUSE_OF" },
          { ...good, id: "r5", toPersonId: 7 },
          null,
        ],
      })
    );
    expect(data.relationships).toEqual([good]);
  });

  it("treats a missing relationships list as empty", () => {
    expect(parsed(file({ relationships: undefined })).relationships).toEqual([]);
  });

  it("clamps layout to the canvas and drops unknown or broken positions", () => {
    const data = parsed(
      file({
        layout: {
          lan: { x: -50, y: 30 },
          minh: { x: "1", y: 2 },
          ghost: { x: 1, y: 1 },
        },
      })
    );
    expect(data.layout).toEqual({ lan: { x: 0, y: 30 } });
    expect(parsed(file({ layout: [] })).layout).toEqual({});
  });

  it("drops an egoId that is not one of the people", () => {
    expect(parsed(file({ egoId: "ghost" })).egoId).toBeNull();
    expect(parsed(file({ egoId: 3, exportedAt: 5 }))).toMatchObject({ egoId: null, exportedAt: "" });
  });
});

describe("exportFileName", () => {
  it("uses the local date, zero-padded", () => {
    expect(exportFileName(new Date(2026, 0, 5, 23, 59))).toBe("family-tree-2026-01-05.json");
  });
});
