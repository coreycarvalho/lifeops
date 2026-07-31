import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDump } from "@/capture";
import { openDb, type Db } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { dumps } from "@/db/schema";

/**
 * What the worker does before it will touch a dump.
 *
 * Compose's `depends_on` only orders a `docker compose up`; after a reboot the daemon
 * restarts this process on its own and the one-shot gate never runs. The worker checking the
 * endpoint itself is what stops it coming back on an unreachable endpoint and spending every
 * waiting dump's attempts discovering that.
 *
 * Tested against the real process rather than a refactored-out function: the thing that would
 * break is the *ordering* of the calls in `main`, and a unit test of a helper would stay
 * green while someone moved the check below the claim loop.
 *
 * The stub endpoint here is an HTTP server, not a model — `npm test` still needs nothing
 * running, and nothing in these tests can reach one.
 */

const root = path.join(import.meta.dirname, "../..");
const tsx = path.join(root, "node_modules/.bin/tsx");
const worker = path.join(root, "src/worker/index.ts");

const MODEL = "test-model:1b";

type StubEndpoint = {
  baseUrl: string;
  /** Every path the worker asked for, in order. */
  requests: string[];
  close: () => Promise<void>;
};

/** An OpenAI-compatible `/models` and nothing else. */
async function stubEndpoint(models: string[]): Promise<StubEndpoint> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id })) }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type Run = {
  process: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
};

function runWorker(env: Record<string, string>): Run {
  const child = spawn(tsx, [worker], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));

  return {
    process: child,
    output: () => output,
    exited: new Promise((resolve) => child.on("exit", (code) => resolve(code))),
  };
}

/** Waits for `output()` to contain `text`, or gives up. */
async function waitForOutput(run: Run, text: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (run.output().includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`worker never printed "${text}". Output was:\n${run.output()}`);
}

let dir: string;
let dbPath: string;
let db: Db;
let endpoint: StubEndpoint;
let running: Run | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifeops-worker-"));
  dbPath = path.join(dir, "lifeops.db");
  db = openDb(dbPath);
  runMigrations(db);
});

afterEach(async () => {
  running?.process.kill("SIGKILL");
  running = undefined;
  await endpoint.close();
  db.$client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function env() {
  return {
    LIFEOPS_DB_PATH: dbPath,
    LLM_BASE_URL: endpoint.baseUrl,
    LLM_MODEL: MODEL,
    WORKER_POLL_MS: "100",
  };
}

describe("the worker at startup", () => {
  it("refuses to run against an endpoint that cannot serve it", async () => {
    endpoint = await stubEndpoint(["some-other-model:8b"]);
    createDump(db, { rawText: "a note", source: "web" });

    running = runWorker(env());
    const code = await running.exited;

    expect(code).not.toBe(0);
    expect(running.output()).toContain("does not serve a model named");
  }, 30_000);

  it("leaves a waiting dump untouched rather than spending its attempts", async () => {
    // The regression this exists for: a worker that started anyway would claim this dump,
    // fail against the endpoint, and burn every attempt it had — permanently failing a
    // capture the user was told had landed, with the endpoint the only thing wrong.
    endpoint = await stubEndpoint(["some-other-model:8b"]);
    const waiting = createDump(db, { rawText: "a note", source: "web" });

    running = runWorker(env());
    await running.exited;

    const [row] = db.select().from(dumps).where(eq(dumps.id, waiting.id)).all();
    expect(row.extractionStatus).toBe("pending");
    expect(row.extractionAttempts).toBe(0);
    // It never got as far as asking the model to do anything.
    expect(endpoint.requests).toEqual(["/v1/models"]);
  }, 30_000);

  it("starts once the endpoint answers for the configured model", async () => {
    endpoint = await stubEndpoint(["some-other-model:8b", MODEL]);

    running = runWorker(env());
    await waitForOutput(running, "worker up");

    expect(endpoint.requests[0]).toBe("/v1/models");
    expect(running.process.exitCode).toBeNull();
  }, 30_000);
});
