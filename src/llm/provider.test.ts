import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "@/config";
import { createLlmProvider } from "./provider";

/**
 * These tests never reach a model. They watch what the provider *sends*, because the two
 * things that matter here are where the request goes (invariant 4 — nothing captured leaves
 * the operator's network) and that swapping endpoint or model is configuration.
 */

const LOCAL: Config["llm"] = {
  baseUrl: "http://192.168.1.50:11434/v1",
  model: "qwen3.5:2b-q4_K_M",
};

const EXTRACTED = {
  entities: [],
  events: [],
  commitments: [],
  decisions: [],
};

let requests: {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}[] = [];

beforeEach(() => {
  requests = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return new Response(
      JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: JSON.stringify(EXTRACTED) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("where extraction sends captured text", () => {
  it("sends it only to the configured endpoint", async () => {
    // Invariant 4. The dump text is in this request body; if any request went anywhere
    // other than the operator's own endpoint, that is the invariant broken.
    await createLlmProvider(LOCAL).extract({
      rawText: "furnace guy is sending a quote by friday",
      capturedOn: "2026-06-01",
    });

    expect(requests).toHaveLength(1);
    for (const request of requests) {
      expect(request.url.startsWith(LOCAL.baseUrl)).toBe(true);
    }
    expect(requests[0].url).toBe(
      "http://192.168.1.50:11434/v1/chat/completions",
    );
  });

  it("follows the configured endpoint and model, with no code change", async () => {
    // Behaviour 10 of issue #5.
    await createLlmProvider({
      baseUrl: "http://10.0.0.9:8080/v1",
      model: "gemma4:e2b-it-qat",
    }).extract({ rawText: "x", capturedOn: "2026-06-01" });

    expect(requests[0].url).toBe("http://10.0.0.9:8080/v1/chat/completions");
    expect(requests[0].body.model).toBe("gemma4:e2b-it-qat");
  });

  it("carries the dump text and its capture date", async () => {
    await createLlmProvider(LOCAL).extract({
      rawText: "furnace quote by friday",
      capturedOn: "2026-06-01",
    });

    const messages = JSON.stringify(requests[0].body.messages);
    expect(messages).toContain("furnace quote by friday");
    expect(messages).toContain("2026-06-01");
  });

  it("asks the endpoint to constrain decoding to the schema", async () => {
    await createLlmProvider(LOCAL).extract({ rawText: "x", capturedOn: "2026-06-01" });

    const format = requests[0].body.response_format as { type: string };
    expect(format.type).toBe("json_schema");
    // A `pattern` anywhere in the schema makes Ollama refuse the request outright with
    // "failed to parse grammar", so date shapes are checked when they are stored instead.
    expect(JSON.stringify(requests[0].body.response_format)).not.toContain("pattern");
  });
});

describe("how hard the model is asked to reason", () => {
  it("forces nothing when the operator has not configured it", async () => {
    // Behaviour 13. Absent from the body entirely, so the endpoint's own default applies.
    await createLlmProvider(LOCAL).extract({ rawText: "x", capturedOn: "2026-06-01" });
    expect(requests[0].body.reasoning_effort).toBeUndefined();
  });

  it("passes through whatever the operator did configure", async () => {
    await createLlmProvider({ ...LOCAL, reasoningEffort: "none" }).extract({
      rawText: "x",
      capturedOn: "2026-06-01",
    });
    expect(requests[0].body.reasoning_effort).toBe("none");
  });
});

describe("credentials", () => {
  it("sends none when there are none — a local endpoint has no secret", async () => {
    await createLlmProvider(LOCAL).extract({ rawText: "x", capturedOn: "2026-06-01" });
    expect(requests[0].headers.authorization).toBeUndefined();
  });

  it("sends one when the endpoint sits behind a proxy that wants it", async () => {
    await createLlmProvider({ ...LOCAL, apiKey: "proxy-token" }).extract({
      rawText: "x",
      capturedOn: "2026-06-01",
    });
    expect(requests[0].headers.authorization).toBe("Bearer proxy-token");
  });
});
