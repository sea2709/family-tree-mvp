// Where the Ollama model runs, decided on the server from OLLAMA_HOST.
// Only this word and the model name reach the browser, never the host.
export type ModelLocation = "local" | "cloud" | "self-hosted";

export type ModelConfig = { where: ModelLocation; model: string };

export type ModelStatus = { label: string; title: string; tone: "on" | "cloud" | "off" };

export function modelLocation(host: string): ModelLocation {
  let hostname: string;
  try {
    hostname = new URL(host).hostname.toLowerCase();
  } catch {
    return "self-hosted";
  }
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    hostname === "0.0.0.0" ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname)
  ) {
    return "local";
  }
  if (hostname === "ollama.com" || hostname.endsWith(".ollama.com")) return "cloud";
  return "self-hosted";
}

export function isModelLocation(v: unknown): v is ModelLocation {
  return v === "local" || v === "cloud" || v === "self-hosted";
}

export const LOCATION_NAME: Record<ModelLocation, string> = {
  local: "Local AI",
  cloud: "Ollama Cloud",
  "self-hosted": "Self-hosted AI",
};

const LOCATION_TITLE: Record<ModelLocation, string> = {
  local: "Ollama runs on the same machine as the app server, so messages are not sent to any other service.",
  cloud: "Messages are sent to Ollama Cloud (ollama.com) to extract family facts. Ollama says it does not log or train on them.",
  "self-hosted": "Messages are sent to the Ollama server set up for this app, not to Ollama Cloud.",
};

// `modelUsed` is what the last chat reply came from ("ollama:<model>" or
// "fallback"), or null before the first message. `config` comes from
// GET /api/chat, so the pill shows where messages will go before the
// user sends anything.
export function modelStatus(modelUsed: string | null, config: ModelConfig | null): ModelStatus {
  if (modelUsed?.startsWith("ollama:")) {
    const model = modelUsed.slice("ollama:".length);
    if (!config) return { label: `Ollama · ${model}`, title: "Family facts are extracted by Ollama.", tone: "on" };
    return {
      label: `${LOCATION_NAME[config.where]} · ${model}`,
      title: LOCATION_TITLE[config.where],
      tone: config.where === "cloud" ? "cloud" : "on",
    };
  }
  if (modelUsed === "fallback") {
    const target = config ? `${LOCATION_NAME[config.where]} (${config.model})` : "Ollama";
    return {
      label: "Built-in parser",
      title: `${target} couldn't be used for the last message, so the rule-based parser on the app server read it.`,
      tone: "off",
    };
  }
  if (config) {
    return {
      label: `${LOCATION_NAME[config.where]} · ${config.model}`,
      title: `${LOCATION_TITLE[config.where]} If it can't be reached, the built-in rule-based parser is used instead.`,
      tone: "off",
    };
  }
  return {
    label: "AI or built-in parser",
    title: "Family facts are extracted by Ollama when it is available, otherwise by a rule-based parser on the app server.",
    tone: "off",
  };
}
