import { EMPTY_EXTRACTION, type Extraction } from "@/llm/extraction";
import type { LlmProvider } from "@/llm/provider";

/**
 * A stub at the provider interface. `npm test` needs nothing running (AGENTS.md), and a
 * test that needs a model reachable is not a test — the real endpoint is exercised by
 * `npm run verify:llm`.
 */
export type StubLlm = LlmProvider & {
  calls: { rawText: string; capturedOn: string }[];
};

export function stubLlm(
  respond: (input: {
    rawText: string;
    capturedOn: string;
  }) => Extraction | Promise<Extraction> = () => EMPTY_EXTRACTION,
): StubLlm {
  const calls: StubLlm["calls"] = [];
  return {
    calls,
    async extract(input) {
      calls.push(input);
      return respond(input);
    },
  };
}

/** A provider that always fails, for the "a failed extraction is never silent" behaviours. */
export function failingLlm(message = "endpoint refused the connection"): StubLlm {
  return stubLlm(() => {
    throw new Error(message);
  });
}

/** Extraction with the given records; everything unnamed is empty. */
export function extraction(parts: Partial<Extraction>): Extraction {
  return { ...EMPTY_EXTRACTION, ...parts };
}
