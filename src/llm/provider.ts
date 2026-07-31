import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateObject } from "ai";
import type { Config } from "@/config";
import {
  extractionSchema,
  extractionSystemPrompt,
  type Extraction,
} from "./extraction";

/**
 * The LLM provider — one of the two blessed interfaces (AGENTS.md).
 *
 * One method, because M1 asks the model exactly one thing. Everything about *which* model
 * answers is `LLM_BASE_URL` / `LLM_MODEL` / `LLM_REASONING_EFFORT`, so pointing LifeOps at
 * a different endpoint is a config change (issue #5, behaviour 10).
 */
export type LlmProvider = {
  extract(input: {
    rawText: string;
    /** The dump's capture date, "YYYY-MM-DD". Relative dates resolve against it. */
    capturedOn: string;
  }): Promise<Extraction>;
};

export function createLlmProvider(llm: Config["llm"]): LlmProvider {
  // The name doubles as the `providerOptions` key, so it is not cosmetic.
  const provider = createOpenAICompatible({
    name: "openaiCompatible",
    baseURL: llm.baseUrl,
    apiKey: llm.apiKey,
    // Sends `response_format: json_schema`, which is what makes the endpoint constrain
    // decoding to the schema instead of hoping the model emits valid JSON.
    supportsStructuredOutputs: true,
  });

  const model = provider.chatModel(llm.model);

  return {
    async extract({ rawText, capturedOn }) {
      const { object } = await generateObject({
        model,
        schema: extractionSchema,
        system: extractionSystemPrompt(capturedOn),
        prompt: rawText,
        // A wedged endpoint accepts the connection and then never answers, which without
        // this leaves the dump `processing` forever and stalls every dump behind it. The
        // signal covers the whole call including the SDK's own retries, so one extraction
        // gets one bound. Aborting surfaces as a normal failure and takes the retry path.
        abortSignal: AbortSignal.timeout(llm.timeoutMs),
        // Absent from the request body unless the operator set one — see config.ts.
        ...(llm.reasoningEffort
          ? {
              providerOptions: {
                openaiCompatible: { reasoningEffort: llm.reasoningEffort },
              },
            }
          : {}),
      });
      return object;
    },
  };
}
