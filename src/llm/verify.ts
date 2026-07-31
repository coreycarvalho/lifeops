/**
 * Extract one sample dump against the configured endpoint and print what came back.
 *
 * Not a test. `npm test` needs nothing running and the provider is stubbed there
 * (AGENTS.md); this is the deliberate opposite — the check that the real endpoint and the
 * real model produce schema-valid records and a readable echo. It is how M2 will judge a
 * model or prompt swap.
 *
 *   LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen3.5:2b-q4_K_M npm run verify:llm
 */
import { loadConfig } from "@/config";
import { renderSummary } from "@/extraction/echo";
import { createLlmProvider } from "./provider";

const SAMPLE = `talked to the furnace guy this morning - Ray from Halton Heating.
he's sending a quote by friday. also booked the tilt table test for jun 22 at 9am
at St Mary's, and I told Ray I'd text him the model number tonight.
decided to go with a heat pump rather than another gas furnace, mostly because of
the rebate expiring in the fall.`;

const capturedOn = new Date().toISOString().slice(0, 10);

async function main() {
  const config = loadConfig();
  console.log(`endpoint: ${config.llm.baseUrl}`);
  console.log(`model:    ${config.llm.model}`);
  console.log(`reasoning_effort: ${config.llm.reasoningEffort ?? "(endpoint default)"}`);
  console.log(`\n--- dump (captured ${capturedOn}) ---\n${SAMPLE}\n`);

  const started = Date.now();
  const extraction = await createLlmProvider(config.llm).extract({
    rawText: SAMPLE,
    capturedOn,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`--- records (${elapsed}s) ---`);
  console.log(JSON.stringify(extraction, null, 2));
  console.log(`\n--- echo ---\n${renderSummary(extraction)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
