import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractionDebug, Proposal } from "@/lib/types";
import { GET, POST } from "./route";

type ChatResponse = {
  reply: string;
  proposals: Proposal[];
  modelUsed: string;
  where: string;
  model: string;
  debug?: ExtractionDebug;
};

async function chat(body: unknown): Promise<ChatResponse> {
  const req = new Request("http://localhost/api/chat", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await POST(req);
  expect(res.status).toBe(200);
  return res.json();
}

// What Ollama's /api/chat returns when the model answers with `content`.
const ollamaReply = (content: unknown) =>
  new Response(
    JSON.stringify({
      message: { content: typeof content === "string" ? content : JSON.stringify(content) },
      prompt_eval_count: 100,
      eval_count: 20,
      done_reason: "stop",
    })
  );

let fetchMock: ReturnType<typeof vi.fn>;
const sentPrompt = () => JSON.parse(fetchMock.mock.calls[0][1].body).messages[1].content as string;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("GET /api/chat", () => {
  it("returns only where the model runs and its name, not the host", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ where: "local", model: "gemma4:12b" });
  });
});

describe("POST /api/chat", () => {
  it("says where the model runs on every reply", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    const res = await chat({ message: "I'm Lan" });
    expect(res.modelUsed).toBe("fallback");
    expect(res).toMatchObject({ where: "local", model: "gemma4:12b" });
  });

  it("asks for a fact when the message is empty, without calling Ollama", async () => {
    const res = await chat({ message: "   " });
    expect(res.proposals).toEqual([]);
    expect(res.reply).toMatch(/Tell me a family fact/);
    expect(res.debug?.ollamaError).toBe("skipped: empty message");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a malformed body as an empty message", async () => {
    const res = await chat("{not json");
    expect(res.reply).toMatch(/Tell me a family fact/);
  });

  it("returns Ollama's proposals when the model answers", async () => {
    fetchMock.mockResolvedValue(
      ollamaReply({
        reply: "I heard about Minh.",
        proposals: [
          { id: "p1", kind: "person", tempId: "temp-minh", displayName: "Minh", reason: "You said: \"My dad is Minh\"", confidence: "high" },
          { id: "p2", kind: "relationship", fromRef: "temp-minh", toRef: "lan", relationshipType: "PARENT_OF", reason: "x", confidence: "high" },
        ],
      })
    );
    const res = await chat({ message: "My dad is Minh", roster: [{ id: "lan", displayName: "Lan" }], egoId: "lan" });
    expect(res.modelUsed).toMatch(/^ollama:/);
    expect(res.reply).toBe("I heard about Minh.");
    expect(res.proposals.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(res.debug).toMatchObject({ source: "ollama", kept: 2, returned: 2, promptTokens: 100, outputTokens: 20 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/chat$/);
    expect(JSON.parse(init.body)).toMatchObject({ format: "json", stream: false, think: false });
  });

  it("sends the API key as a bearer token when set", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "secret");
    fetchMock.mockResolvedValue(ollamaReply({ reply: "ok", proposals: [] }));
    await chat({ message: "hi" });
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: "Bearer secret" });
  });

  it("normalises and filters the model's proposals", async () => {
    fetchMock.mockResolvedValue(
      ollamaReply({
        reply: "  ",
        proposals: [
          { kind: "person", displayName: "Lan", reason: "You said: \"I'm Lan\"", confidence: "sure", birthDate: "1990-02-30", birthYear: 1990, gender: "x" },
          { kind: "person", tempId: "minh", birthDate: "1960-03-05", birthYear: 1999, reason: 5 },
          { kind: "relationship", fromRef: "temp-0", toRef: "ghost", relationshipType: "PARENT_OF" },
          { kind: "relationship", fromRef: "temp-0", toRef: "temp-0", relationshipType: "SPOUSE_OF" },
          { kind: "relationship", fromRef: "temp-0", toRef: "minh", relationshipType: "COUSIN_OF" },
          { kind: "relationship", fromRef: "minh", toRef: "temp-0", relationshipType: "PARENT_OF" },
          { kind: "event" },
          null,
        ],
      })
    );
    const res = await chat({ message: "I'm Lan", roster: [{ id: "minh", displayName: "Minh" }] });
    expect(res.reply).toMatch(/Please review the proposal cards/);
    expect(res.proposals).toEqual([
      expect.objectContaining({
        id: "ollama-0",
        tempId: "temp-0",
        displayName: "Lan",
        confidence: "medium",
        birthDate: null,
        birthYear: 1990,
        gender: null,
        isSpeaker: true,
      }),
      expect.objectContaining({
        id: "ollama-1",
        tempId: "minh",
        displayName: "Minh",
        birthDate: "1960-03-05",
        birthYear: 1960,
        reason: "From your message",
        isSpeaker: false,
      }),
      expect.objectContaining({ id: "ollama-5", fromRef: "minh", toRef: "temp-0", relationshipType: "PARENT_OF" }),
    ]);
    expect(res.debug).toMatchObject({ returned: 8, kept: 3 });
  });

  it("does not mark a speaker once the tree already has one", async () => {
    fetchMock.mockResolvedValue(
      ollamaReply({ reply: "ok", proposals: [{ kind: "person", tempId: "t", displayName: "Hoa", isSpeaker: true }] })
    );
    const res = await chat({ message: "My mom is Hoa", roster: [{ id: "lan", displayName: "Lan" }], egoId: "lan" });
    expect(res.proposals[0].isSpeaker).toBe(false);
  });

  it("describes the tree to the model relative to the speaker", async () => {
    fetchMock.mockResolvedValue(ollamaReply({ reply: "ok", proposals: [] }));
    const roster = [
      { id: "lan", displayName: "Lan" },
      { id: "minh", displayName: "Minh", gender: "male", birthYear: 1960, birthPlace: "Hanoi" },
      { id: "hoa", displayName: "Tran Hieu Hoa", preferredName: "Hoa", gender: "female" },
      { id: "thuc", displayName: "Thuc" },
      { id: "nam", displayName: "Nam" },
      { id: "an", displayName: "An" },
      { id: "ong", displayName: "Ong" },
      { id: "tu", displayName: "Tu" },
    ];
    const relationships = [
      { fromPersonId: "minh", toPersonId: "lan", type: "PARENT_OF" },
      { fromPersonId: "hoa", toPersonId: "lan", type: "PARENT_OF" },
      { fromPersonId: "minh", toPersonId: "thuc", type: "PARENT_OF" },
      { fromPersonId: "lan", toPersonId: "nam", type: "PARTNER_OF" },
      { fromPersonId: "lan", toPersonId: "an", type: "PARENT_OF" },
      { fromPersonId: "ong", toPersonId: "minh", type: "PARENT_OF" },
      { fromPersonId: "tu", toPersonId: "lan", type: "SIBLING_OF" },
      { fromPersonId: "ghost", toPersonId: "lan", type: "PARENT_OF" },
      { fromPersonId: "lan", toPersonId: "nam", type: "COUSIN_OF" },
    ];
    const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `turn ${i}` }));
    await chat({ message: "My dad's brother is Tuan", roster, relationships, egoId: "lan", history: [...history, { text: 3 }] });

    const prompt = sentPrompt();
    expect(prompt).toContain("- lan: Lan — the speaker");
    expect(prompt).toContain("- minh: Minh, born 1960 in Hanoi, male — speaker's father");
    expect(prompt).toContain("- hoa: Tran Hieu Hoa (Hoa), female — speaker's mother");
    expect(prompt).toContain("- thuc: Thuc — speaker's sibling");
    expect(prompt).toContain("- nam: Nam — speaker's partner");
    expect(prompt).toContain("- an: An — speaker's child");
    expect(prompt).toContain("- ong: Ong — speaker's grandparent");
    expect(prompt).toContain("- tu: Tu — speaker's sibling");
    expect(prompt).toContain("- Minh (minh) PARENT_OF Lan (lan)");
    expect(prompt).not.toContain("ghost");
    expect(prompt).not.toContain("COUSIN_OF");
    expect(prompt).not.toContain("turn 1\n");
    expect(prompt).toContain("assistant: turn 9");
    expect(prompt).toContain("Speaker (ego) id: lan");
  });

  it("tells the model when the tree is empty", async () => {
    fetchMock.mockResolvedValue(ollamaReply({ reply: "ok", proposals: [] }));
    await chat({ message: "I'm Lan" });
    expect(sentPrompt()).toContain("- (none yet)");
    expect(sentPrompt()).toContain("Speaker (ego) id: (not set yet");
  });
});

describe("falling back to the built-in parser", () => {
  const expectFallback = async (error: RegExp) => {
    const res = await chat({ message: "I'm Lan" });
    expect(res.modelUsed).toBe("fallback");
    expect(res.proposals).toEqual([expect.objectContaining({ displayName: "Lan", isSpeaker: true })]);
    expect(res.debug?.source).toBe("fallback");
    expect(res.debug?.ollamaError).toMatch(error);
    return res;
  };

  it("when Ollama returns an HTTP error", async () => {
    fetchMock.mockResolvedValue(new Response("model not found", { status: 404 }));
    await expectFallback(/^HTTP 404 .*model not found/);
  });

  it("with a hint when authentication fails", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "");
    fetchMock.mockResolvedValue(new Response("", { status: 401 }));
    await expectFallback(/OLLAMA_API_KEY is not set/);

    vi.stubEnv("OLLAMA_API_KEY", "wrong");
    fetchMock.mockResolvedValue(new Response("", { status: 403 }));
    await expectFallback(/check OLLAMA_API_KEY/);
  });

  it("when the model returns no content", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: { content: "", thinking: "hmm" } })));
    await expectFallback(/empty message content \(thinking 3 chars/);
  });

  it("when the model returns invalid JSON", async () => {
    fetchMock.mockResolvedValue(ollamaReply("not json at all"));
    await expectFallback(/^invalid JSON/);
  });

  it("when Ollama is not running", async () => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    await expectFallback(/^ECONNREFUSED .*is Ollama running/);
  });

  it("when Ollama times out", async () => {
    vi.stubEnv("OLLAMA_TIMEOUT_MS", "5");
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))
    );
    await expectFallback(/^timed out after \d+ms \(OLLAMA_TIMEOUT_MS=5\)/);
  });
});
