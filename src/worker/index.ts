import { getConfig } from "@/config";
import { getDb } from "@/db/client";
import {
  claimNextDump,
  extractDump,
  releaseDump,
  requeueStuckDumps,
} from "@/extraction/run";
import { checkEndpoint } from "@/llm/preflight";
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

  // The same gate the `init` container runs, again, on this process's own terms.
  //
  // Compose's `depends_on` only orders a `docker compose up`. After a host or daemon
  // reboot, Docker restarts this container from its restart policy and never re-runs the
  // exited one-shot, so without this the worker would come back on an endpoint that is
  // unreachable and spend every dump's attempts finding out — one dump at a time,
  // permanently failing captures the user was told had landed.
  //
  // Failing here instead means the restart policy backs off and retries, dumps stay
  // `pending`, and extraction resumes on its own when the endpoint does.
  await checkEndpoint(config.llm);

  const db = getDb();
  const provider = createLlmProvider(config.llm);

  const { requeued, abandoned } = requeueStuckDumps(
    db,
    config.worker.maxExtractionAttempts,
  );
  if (requeued > 0) console.log(`requeued ${requeued} dump(s) left mid-extraction`);
  if (abandoned > 0) {
    console.log(`${abandoned} dump(s) had no attempts left and are marked failed`);
  }
  console.log(
    `worker up: ${config.llm.model} at ${config.llm.baseUrl}, ` +
      `polling every ${config.worker.pollIntervalMs}ms`,
  );

  let running = true;
  /** The dump currently in flight, if any — what shutdown has to hand back. */
  let claimed: string | undefined;

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      running = false;
      // Waiting for the current dump is not an option Docker leaves open: the default stop
      // grace period is ten seconds and a reasoning-on extraction runs to minutes, so the
      // wait would end in SIGKILL with the attempt already spent. Give the dump back
      // instead. Re-extraction is idempotent by design, so abandoning one costs nothing
      // but the time it had used.
      if (claimed !== undefined && releaseDump(db, claimed)) {
        console.log(`${signal} — handing ${claimed} back to the queue, unspent`);
      } else {
        console.log(`${signal} — stopping`);
      }
      // Safe here and only here: better-sqlite3 is synchronous, so a signal handler never
      // runs inside a half-finished transaction.
      process.exit(0);
    });
  }

  while (running) {
    const dump = claimNextDump(db, config.worker.maxExtractionAttempts);
    if (!dump) {
      await sleep(config.worker.pollIntervalMs);
      continue;
    }
    claimed = dump.id;
    console.log(`extracting ${dump.id}`);
    // extractDump records its own failures on the dump; anything thrown past it is a bug
    // in the pipeline itself and should stop the worker loudly rather than spin.
    await extractDump(db, provider, dump.id, config.timeZone);
    claimed = undefined;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
