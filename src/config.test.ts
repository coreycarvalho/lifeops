import { describe, expect, it } from "vitest";
import { getDbPath, loadConfig, type Env } from "./config";

const validEnv: Env = {
  LIFEOPS_DB_PATH: "/data/lifeops.db",
  LLM_API_KEY: "sk-test",
};

describe("loadConfig", () => {
  it("fails loudly when a required variable is missing", () => {
    // A deployment missing its API key must not boot and quietly accept dumps that will
    // never be extracted.
    expect(() => loadConfig({ LIFEOPS_DB_PATH: "/data/lifeops.db" })).toThrow(
      /LLM_API_KEY/,
    );
    expect(() => loadConfig({ LLM_API_KEY: "sk-test" })).toThrow(
      /LIFEOPS_DB_PATH/,
    );
  });

  it("treats a blank variable as missing", () => {
    expect(() => loadConfig({ ...validEnv, LLM_API_KEY: "   " })).toThrow(
      /LLM_API_KEY/,
    );
  });

  it("applies worker defaults when unset", () => {
    const config = loadConfig(validEnv);
    expect(config.worker.pollIntervalMs).toBe(2000);
    expect(config.worker.maxExtractionAttempts).toBe(3);
    expect(config.llm.model).toBe("claude-sonnet-5");
  });

  it("takes worker overrides from the environment", () => {
    const config = loadConfig({
      ...validEnv,
      WORKER_POLL_MS: "500",
      EXTRACTION_MAX_ATTEMPTS: "5",
      LLM_MODEL: "claude-opus-5",
    });
    expect(config.worker.pollIntervalMs).toBe(500);
    expect(config.worker.maxExtractionAttempts).toBe(5);
    expect(config.llm.model).toBe("claude-opus-5");
  });

  it("rejects a non-positive or non-integer interval", () => {
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      expect(() => loadConfig({ ...validEnv, WORKER_POLL_MS: bad })).toThrow(
        /positive integer/,
      );
    }
  });

  it("rejects an LLM provider that is not wired up", () => {
    expect(() => loadConfig({ ...validEnv, LLM_PROVIDER: "ollama" })).toThrow(
      /Unsupported LLM_PROVIDER/,
    );
  });
});

describe("getDbPath", () => {
  it("does not require LLM configuration", () => {
    // The db layer must be usable without an API key — `next build` and the schema tests
    // both open a database with no LLM configured at all.
    expect(getDbPath({ LIFEOPS_DB_PATH: "/data/lifeops.db" })).toBe(
      "/data/lifeops.db",
    );
  });
});
