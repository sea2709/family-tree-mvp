import { describe, expect, it } from "vitest";
import { birthLabel, formatDate, isIsoDate, monthNumber, toIsoDate, yearOf } from "./dates";

describe("isIsoDate", () => {
  it("accepts real calendar dates", () => {
    expect(isIsoDate("1960-03-05")).toBe(true);
    expect(isIsoDate("2024-02-29")).toBe(true);
  });

  it("rejects impossible dates and non-strings", () => {
    expect(isIsoDate("2023-02-29")).toBe(false);
    expect(isIsoDate("1960-13-01")).toBe(false);
    expect(isIsoDate("1960-3-5")).toBe(false);
    expect(isIsoDate(19600305)).toBe(false);
  });
});

describe("toIsoDate", () => {
  it("zero-pads valid parts", () => {
    expect(toIsoDate(1960, 3, 5)).toBe("1960-03-05");
  });

  it("returns null for invalid dates", () => {
    expect(toIsoDate(1960, 4, 31)).toBeNull();
  });
});

describe("formatDate / yearOf", () => {
  it("formats without timezone drift", () => {
    expect(formatDate("1960-03-05")).toBe("5 Mar 1960");
    expect(yearOf("1960-03-05")).toBe(1960);
  });

  it("passes through unparseable input", () => {
    expect(formatDate("sometime")).toBe("sometime");
    expect(yearOf("sometime")).toBeNull();
  });
});

describe("birthLabel", () => {
  it("prefers a full date over a year", () => {
    expect(birthLabel({ birthDate: "1960-03-05", birthYear: 1960 })).toBe("5 Mar 1960");
    expect(birthLabel({ birthYear: 1960 })).toBe("1960");
    expect(birthLabel({})).toBeNull();
  });
});

describe("monthNumber", () => {
  it("handles full names, abbreviations and trailing dots", () => {
    expect(monthNumber("March")).toBe(3);
    expect(monthNumber("sept.")).toBe(9);
    expect(monthNumber("foo")).toBeNull();
  });
});
