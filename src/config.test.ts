import { describe, expect, it } from "vitest";
import { getDbPath, loadConfig, type Env } from "./config";

const validEnv: Env = {
  LIFEOPS_DB_PATH: "/data/lifeops.db",
  LLM_BASE_URL: "http://192.168.1.50:11434/v1",
  LLM_MODEL: "qwen3:8b",
};

describe("loadConfig", () => {
  it("fails loudly when a required variable is missing", () => {
    // A deployment missing its endpoint must not boot and quietly accept dumps that will
    // never be extracted.
    for (const missing of [
      "LIFEOPS_DB_PATH",
      "LLM_BASE_URL",
      "LLM_MODEL",
    ] as const) {
      const env = { ...validEnv };
      delete env[missing];
      expect(() => loadConfig(env)).toThrow(new RegExp(missing));
    }
  });

  it("treats a blank variable as missing", () => {
    expect(() => loadConfig({ ...validEnv, LLM_MODEL: "   " })).toThrow(
      /LLM_MODEL/,
    );
  });

  it("needs no API key, because a local endpoint has no secret", () => {
    const config = loadConfig(validEnv);
    expect(config.llm.apiKey).toBeUndefined();
    expect(config.llm.baseUrl).toBe("http://192.168.1.50:11434/v1");
    expect(config.llm.model).toBe("qwen3:8b");
  });

  it("passes an API key through when the endpoint sits behind a proxy", () => {
    const config = loadConfig({ ...validEnv, LLM_API_KEY: "proxy-token" });
    expect(config.llm.apiKey).toBe("proxy-token");
  });

  it("ignores a blank API key rather than sending an empty credential", () => {
    const config = loadConfig({ ...validEnv, LLM_API_KEY: "   " });
    expect(config.llm.apiKey).toBeUndefined();
  });

  it("forces no reasoning effort of its own", () => {
    // Behaviour 13 of issue #5: how hard the model reasons is configuration. Leaving it
    // unset means the endpoint's own default applies, which is what M2 will tune against.
    expect(loadConfig(validEnv).llm.reasoningEffort).toBeUndefined();
    expect(loadConfig({ ...validEnv, LLM_REASONING_EFFORT: "  " }).llm.reasoningEffort)
      .toBeUndefined();
  });

  it("takes reasoning effort from the environment when the operator sets one", () => {
    const config = loadConfig({ ...validEnv, LLM_REASONING_EFFORT: "none" });
    expect(config.llm.reasoningEffort).toBe("none");
  });

  it("rejects an endpoint that is not an absolute http(s) URL", () => {
    // "localhost:11434" without a scheme is the classic version of this mistake, and it
    // parses as a URL with protocol "localhost:" rather than failing outright.
    for (const bad of ["localhost:11434", "not a url", "/v1"]) {
      expect(() => loadConfig({ ...validEnv, LLM_BASE_URL: bad })).toThrow(
        /LLM_BASE_URL/,
      );
    }
    expect(() =>
      loadConfig({ ...validEnv, LLM_BASE_URL: "ftp://example.com" }),
    ).toThrow(/http or https/);
  });

  it("bounds an extraction generously by default, and takes an override", () => {
    // The default is a stall detector, not a latency budget: reasoning-on extraction runs
    // into the minutes on the verified models.
    expect(loadConfig(validEnv).llm.timeoutMs).toBe(600_000);
    expect(loadConfig({ ...validEnv, LLM_TIMEOUT_MS: "30000" }).llm.timeoutMs).toBe(30_000);
  });

  it("falls back to the host's timezone, and takes an override", () => {
    // Calendar dates the system derives — including the day it tells the model a note was
    // written — are computed in this zone, not UTC.
    expect(loadConfig(validEnv).timeZone).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    expect(loadConfig({ ...validEnv, LIFEOPS_TIMEZONE: "America/New_York" }).timeZone).toBe(
      "America/New_York",
    );
  });

  it("rejects a timezone that is not a real IANA zone", () => {
    // Silently falling back would shift every relative date the model resolves.
    for (const bad of ["EST5", "Mars/Olympus", "GMT+5"]) {
      expect(() => loadConfig({ ...validEnv, LIFEOPS_TIMEZONE: bad })).toThrow(
        /LIFEOPS_TIMEZONE/,
      );
    }
  });

  it("applies worker defaults when unset", () => {
    const config = loadConfig(validEnv);
    expect(config.worker.pollIntervalMs).toBe(2000);
    expect(config.worker.maxExtractionAttempts).toBe(3);
  });

  it("takes worker overrides from the environment", () => {
    const config = loadConfig({
      ...validEnv,
      WORKER_POLL_MS: "500",
      EXTRACTION_MAX_ATTEMPTS: "5",
    });
    expect(config.worker.pollIntervalMs).toBe(500);
    expect(config.worker.maxExtractionAttempts).toBe(5);
  });

  it("rejects a non-positive or non-integer interval", () => {
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      expect(() => loadConfig({ ...validEnv, WORKER_POLL_MS: bad })).toThrow(
        /positive integer/,
      );
    }
  });
});

describe("getDbPath", () => {
  it("does not require LLM configuration", () => {
    // The db layer must be usable without an endpoint — `next build` and the schema tests
    // both open a database with no LLM configured at all.
    expect(getDbPath({ LIFEOPS_DB_PATH: "/data/lifeops.db" })).toBe(
      "/data/lifeops.db",
    );
  });
});
