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

export function loadConfig(env: Env = process.env): Config {
  return {
    dbPath: getDbPath(env),
    llm: {
      // No default: a wrong guess here fails at extraction time, long after startup,
      // and the operator is the only one who knows what their endpoint serves.
      baseUrl: requireUrl("LLM_BASE_URL", env),
      model: required("LLM_MODEL", env),
      apiKey: env.LLM_API_KEY?.trim() || undefined,
    },
    worker: {
      pollIntervalMs: optionalInt("WORKER_POLL_MS", 2000, env),
      maxExtractionAttempts: optionalInt("EXTRACTION_MAX_ATTEMPTS", 3, env),
    },
  };
}

let cached: Config | undefined;

/** Process-wide config, parsed once. */
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}
