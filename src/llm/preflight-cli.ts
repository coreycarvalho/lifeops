/**
 * Entrypoint for the startup gate — the first half of the one-shot `init` container, which
 * every other service waits on. Kept separate from `preflight.ts` so importing the check
 * does not execute it, the same split as `src/db/migrate-cli.ts`.
 *
 * Exits non-zero on anything wrong, which is what stops web and worker from starting.
 */
import { loadConfig } from "@/config";
import { checkEndpoint } from "./preflight";

async function main() {
  // Throws first on anything malformed, missing, or off the operator's network.
  const config = loadConfig();

  console.log(`Checking ${config.llm.baseUrl} for ${config.llm.model}`);
  const models = await checkEndpoint(config.llm);
  console.log(
    `Endpoint is reachable and serves ${config.llm.model} ` +
      `(${models.length} model${models.length === 1 ? "" : "s"} available).`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nLifeOps is not starting.\n\n${message}\n`);
  process.exit(1);
});
