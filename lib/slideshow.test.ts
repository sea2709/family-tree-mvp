import { describe, expect, it } from "vitest";
import { slideCaption, stepIndex } from "./slideshow";
import type { Person, Photo } from "./types";

describe("stepIndex", () => {
  it("wraps at both ends", () => {
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(1, 3, 1)).toBe(2);
  });

  it("stays put with a single photo or none", () => {
    expect(stepIndex(0, 1, 1)).toBe(0);
    expect(stepIndex(0, 1, -1)).toBe(0);
    expect(stepIndex(0, 0, 1)).toBe(0);
  });
});

describe("slideCaption", () => {
  const people: Person[] = [
    { id: "a", displayName: "Minh" },
    { id: "b", displayName: "Hoa" },
  ];
  const photo = (extra: Partial<Photo>): Photo => ({
    id: "p",
    personIds: [],
    width: 10,
    height: 10,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  });

  it("joins year and tagged names", () => {
    expect(slideCaption(photo({ caption: " Tet 1995 ", takenYear: 1995, personIds: ["a", "b"] }), people)).toEqual({
      caption: "Tet 1995",
      meta: "1995 · Minh, Hoa",
    });
  });

  it("returns nulls when there is nothing to show", () => {
    expect(slideCaption(photo({ caption: "  " }), people)).toEqual({ caption: null, meta: null });
  });

  it("ignores tags of deleted people", () => {
    expect(slideCaption(photo({ personIds: ["gone", "b"] }), people)).toEqual({ caption: null, meta: "Hoa" });
  });
});
