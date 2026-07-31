import { getConfig } from "@/config";
import { getDb } from "@/db/client";
import {
  claimNextDump,
  extractDump,
  requeueStuckDumps,
} from "@/extraction/run";
import { createLlmProvider } from "@/llm/provider";

/**
 * The extraction worker. A dump takes 15–70 seconds to extract because the local models
 * reason before answering, which is throughput nobody is waiting on — capture already
 * confirmed, and this only decides when the echo fills in. It is also the reason this is a
 * separate process: a request handler must never wait on the model.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const config = getConfig();
  const db = getDb();
  const provider = createLlmProvider(config.llm);

  const requeued = requeueStuckDumps(db);
  if (requeued > 0) {
    console.log(`requeued ${requeued} dump(s) left mid-extraction`);
  }
  console.log(
    `worker up: ${config.llm.model} at ${config.llm.baseUrl}, ` +
      `polling every ${config.worker.pollIntervalMs}ms`,
  );

  let running = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`${signal} — finishing the current dump, then stopping`);
      running = false;
    });
  }

  while (running) {
    const dump = claimNextDump(db, config.worker.maxExtractionAttempts);
    if (!dump) {
      await sleep(config.worker.pollIntervalMs);
      continue;
    }
    console.log(`extracting ${dump.id}`);
    // extractDump records its own failures on the dump; anything thrown past it is a bug
    // in the pipeline itself and should stop the worker loudly rather than spin.
    await extractDump(db, provider, dump.id);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
