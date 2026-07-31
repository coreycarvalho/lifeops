import { isOperatorNetworkHost } from "@/llm/endpoint";
import { isTimeZone, systemTimeZone } from "@/time";

/**
 * All runtime configuration, read from the environment in one place.
 *
 * M1 is env-only. SPEC's config *file* (ntfy URL/topic, trigger thresholds, timezone)
 * arrives with M3, which is the first milestone that has thresholds to configure.
 *
 * Required values throw on read rather than defaulting, so a misconfigured deployment
 * fails at startup instead of silently capturing dumps nothing will ever extract.
 */

/**
 * A plain environment map. Deliberately not `NodeJS.ProcessEnv`: Next augments that type
 * with a required `NODE_ENV`, which would force every test to supply one.
 */
export type Env = Record<string, string | undefined>;

export type Config = {
  /** SQLite file path. Lives on the single mounted volume in the deployed setup. */
  dbPath: string;
  /**
   * IANA zone the operator lives in. Every calendar date the system derives from a stored
   * instant is computed in it — see src/time.ts for why that matters.
   *
   * SPEC puts the timezone in the config *file* alongside M3's thresholds; it arrives early,
   * as an environment variable, because M1 already has to tell the model what day a note was
   * written on and getting that wrong shifts every relative date in the note.
   */
  timeZone: string;
  llm: {
    /**
     * An OpenAI-compatible endpoint on the operator's own network — nothing captured
     * leaves it. Ollama is what's verified; see docs/DECISIONS.md.
     */
    baseUrl: string;
    /** The model name as the endpoint knows it, e.g. what `ollama list` reports. */
    model: string;
    /**
     * Only needed when the endpoint sits behind a proxy that wants one. Ollama ignores
     * it, so a local setup has no secret at all.
     */
    apiKey?: string;
    /**
     * Passed straight through to the endpoint as `reasoning_effort` when set, and omitted
     * from the request entirely when not. There is deliberately no default: every model
     * tested extracts worse with reasoning suppressed, and M2 is the first point we have
     * real captures to tune against. See docs/DECISIONS.md.
     */
    reasoningEffort?: string;
    /**
     * How long one extraction may take before it is abandoned.
     *
     * A wedged endpoint accepts the connection and then says nothing (README: "a wedged
     * Ollama is indistinguishable from a slow model"), and without a bound that dump sits in
     * `processing` forever and the single worker never reaches the ones behind it. The
     * default is deliberately generous — reasoning-on extraction runs into the minutes — so
     * this is a stall detector, not a latency budget.
     */
    timeoutMs: number;
  };
  worker: {
    /** How long the worker sleeps when it finds no pending dumps. */
    pollIntervalMs: number;
    /** Attempts before a dump is marked terminally failed. */
    maxExtractionAttempts: number;
  };
};

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function required(name: string, env: Env): string {
  const value = env[name];
  if (!value || value.trim() === "") {
    throw new ConfigError(`Missing required environment variable ${name}`);
  }
  return value;
}

function requireUrl(name: string, env: Env): string {
  const value = required(name, env);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(
      `Environment variable ${name} must be an absolute URL, got "${value}". ` +
        `Include the scheme, e.g. http://192.168.1.50:11434/v1`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(
      `Environment variable ${name} must be http or https, got "${parsed.protocol}"`,
    );
  }
  return value;
}

/**
 * The LLM endpoint, held to invariant 4: nothing captured leaves the operator's network.
 *
 * A valid URL is not enough — `https://api.openai.com/v1` parses fine and would send every
 * dump to a hosted provider. The host has to be somewhere the operator could own.
 */
function requireLocalUrl(name: string, env: Env): string {
  const value = requireUrl(name, env);
  const { hostname } = new URL(value);
  if (!isOperatorNetworkHost(hostname)) {
    throw new ConfigError(
      `Environment variable ${name} points at "${hostname}", which is not on your own ` +
        `network. Nothing captured is allowed to leave it (see invariant 4 in AGENTS.md), ` +
        `so extraction only talks to loopback, a private or link-local address, or a name ` +
        `only a local resolver can answer. Reaching a hosted provider is a code change ` +
        `with a decision-log entry, not a configuration change.`,
    );
  }
  return value;
}

function optionalInt(
  name: string,
  fallback: number,
  env: Env,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(
      `Environment variable ${name} must be a positive integer, got "${raw}"`,
    );
  }
  return value;
}

/**
 * The database path on its own. The db layer needs only this — making it call
 * `loadConfig()` would mean opening SQLite requires an LLM endpoint, which is false
 * and would break `next build` and db-only tests.
 */
export function getDbPath(env: Env = process.env): string {
  return required("LIFEOPS_DB_PATH", env);
}

/**
 * The attempt limit on its own, for the same reason as `getDbPath`: the web process has to
 * know whether a failed dump is still going to be retried, and asking it for an LLM endpoint
 * it never calls would be a lie about what it needs to boot.
 */
export function getMaxExtractionAttempts(env: Env = process.env): number {
  return optionalInt("EXTRACTION_MAX_ATTEMPTS", 3, env);
}

function optionalTimeZone(name: string, env: Env): string {
  const raw = env[name]?.trim();
  if (!raw) return systemTimeZone();
  if (!isTimeZone(raw)) {
    throw new ConfigError(
      `Environment variable ${name} must be an IANA timezone, got "${raw}". ` +
        `For example: America/New_York`,
    );
  }
  return raw;
}

export function loadConfig(env: Env = process.env): Config {
  return {
    dbPath: getDbPath(env),
    timeZone: optionalTimeZone("LIFEOPS_TIMEZONE", env),
    llm: {
      // No default: a wrong guess here fails at extraction time, long after startup,
      // and the operator is the only one who knows what their endpoint serves.
      baseUrl: requireLocalUrl("LLM_BASE_URL", env),
      model: required("LLM_MODEL", env),
      apiKey: env.LLM_API_KEY?.trim() || undefined,
      reasoningEffort: env.LLM_REASONING_EFFORT?.trim() || undefined,
      // Ten minutes: comfortably past the ~6 minutes a reasoning-on extraction takes on the
      // verified models, and far short of forever.
      timeoutMs: optionalInt("LLM_TIMEOUT_MS", 600_000, env),
    },
    worker: {
      pollIntervalMs: optionalInt("WORKER_POLL_MS", 2000, env),
      maxExtractionAttempts: getMaxExtractionAttempts(env),
    },
  };
}

let cached: Config | undefined;

/** Process-wide config, parsed once. */
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}
