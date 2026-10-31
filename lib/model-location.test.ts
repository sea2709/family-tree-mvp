import { describe, expect, it } from "vitest";
import { isModelLocation, modelLocation, modelStatus } from "./model-location";

describe("modelLocation", () => {
  it.each([
    "http://localhost:11434",
    "http://LOCALHOST:11434/",
    "http://ollama.localhost:11434",
    "http://127.0.0.1:11434",
    "http://127.1.2.3:11434",
    "http://[::1]:11434",
    "http://0.0.0.0:11434",
  ])("treats %s as local", (host) => {
    expect(modelLocation(host)).toBe("local");
  });

  it.each(["https://ollama.com", "https://ollama.com/", "https://api.ollama.com"])("treats %s as cloud", (host) => {
    expect(modelLocation(host)).toBe("cloud");
  });

  it.each([
    "http://192.168.1.20:11434",
    "http://gpu-box.lan:11434",
    "https://notollama.com",
    "https://ollama.com.evil.example",
    "not a url",
    "",
  ])("treats %s as self-hosted", (host) => {
    expect(modelLocation(host)).toBe("self-hosted");
  });
});

describe("isModelLocation", () => {
  it("accepts only the three locations", () => {
    expect(["local", "cloud", "self-hosted"].every(isModelLocation)).toBe(true);
    expect(isModelLocation("remote")).toBe(false);
    expect(isModelLocation(undefined)).toBe(false);
  });
});

describe("modelStatus", () => {
  const cloud = { where: "cloud" as const, model: "gemma4:31b" };
  const local = { where: "local" as const, model: "gemma4:12b" };

  it("names Ollama Cloud with its own tone after a cloud reply", () => {
    const s = modelStatus("ollama:gemma4:31b", cloud);
    expect(s).toMatchObject({ label: "Ollama Cloud · gemma4:31b", tone: "cloud" });
    expect(s.title).toMatch(/sent to Ollama Cloud/);
  });

  it("says local after a local reply", () => {
    expect(modelStatus("ollama:gemma4:12b", local)).toMatchObject({ label: "Local AI · gemma4:12b", tone: "on" });
    expect(modelStatus("ollama:gemma4:12b", { where: "self-hosted", model: "gemma4:12b" })).toMatchObject({
      label: "Self-hosted AI · gemma4:12b",
      tone: "on",
    });
  });

  it("does not claim local when the location is unknown", () => {
    expect(modelStatus("ollama:gemma4:12b", null).label).toBe("Ollama · gemma4:12b");
  });

  it("shows the configured location before the first message", () => {
    const s = modelStatus(null, cloud);
    expect(s).toMatchObject({ label: "Ollama Cloud · gemma4:31b", tone: "off" });
    expect(s.title).toMatch(/built-in rule-based parser/);
  });

  it("names the built-in parser after a fallback reply", () => {
    const s = modelStatus("fallback", cloud);
    expect(s).toMatchObject({ label: "Built-in parser", tone: "off" });
    expect(s.title).toMatch(/^Ollama Cloud \(gemma4:31b\) couldn't be used/);
    expect(modelStatus("fallback", null).title).toMatch(/^Ollama couldn't be used/);
  });

  it("stays generic when nothing is known yet", () => {
    expect(modelStatus(null, null).label).toBe("AI or built-in parser");
  });
});
