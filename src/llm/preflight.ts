import type { Config } from "@/config";

/**
 * Does the configured endpoint actually exist, speak OpenAI, and serve the configured model?
 *
 * `loadConfig` already refuses a URL that is malformed or off the operator's network, but
 * `http://localhost:11434/v1` passes both checks and is wrong inside a container — localhost
 * is the container. Nothing catches that until the worker's first extraction, by which point
 * the web process has been accepting captures for however long the operator has been using it.
 *
 * So this runs once, before anything else starts, and the stack does not come up if it fails
 * (see the `init` service in docker-compose.yml). Accepting a capture that can never be
 * extracted is the failure this exists to prevent; refusing to start is the cheaper one.
 */

export class EndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointError";
  }
}

/**
 * Narrower than `globalThis.fetch` — the two things this probe sends, and nothing else.
 * `globalThis.fetch` satisfies it, and a test can assert on the call without a cast.
 */
export type ProbeFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

export type ProbeOptions = {
  fetch?: ProbeFetch;
  sleep?: (ms: number) => Promise<void>;
  /** Tries at a connection level, not at the model level. */
  attempts?: number;
  retryDelayMs?: number;
  /** Per attempt. A liveness probe, so seconds — not `LLM_TIMEOUT_MS`, which bounds generation. */
  timeoutMs?: number;
};

/**
 * Five tries six seconds apart — half a minute, which covers a model box that started at the
 * same moment as this one and lost the race. Constants rather than configuration: this is a
 * boot-ordering allowance, and an operator who needs longer has a problem no number fixes.
 */
const ATTEMPTS = 5;
const RETRY_DELAY_MS = 6_000;
const TIMEOUT_MS = 5_000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isLoopback(baseUrl: string): boolean {
  const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/** `{ data: [{ id }] }` — the OpenAI shape, which Ollama serves at `/v1/models`. */
function modelNames(body: unknown): string[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { data } = body as { data?: unknown };
  if (!Array.isArray(data)) return undefined;

  const names: string[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { id, name } = entry as { id?: unknown; name?: unknown };
    const reported = typeof id === "string" ? id : typeof name === "string" ? name : undefined;
    if (reported === undefined) return undefined;
    names.push(reported);
  }
  return names;
}

/**
 * Throws `EndpointError` with a message that names the fix, or resolves with the models the
 * endpoint reports. Every failure here is a configuration mistake, so every message says
 * which variable to change.
 */
export async function checkEndpoint(
  llm: Pick<Config["llm"], "baseUrl" | "model"> & { apiKey?: string },
  options: ProbeOptions = {},
): Promise<string[]> {
  const send = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? wait;
  const attempts = options.attempts ?? ATTEMPTS;
  const url = `${llm.baseUrl.replace(/\/+$/, "")}/models`;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response: Response;
    try {
      response = await send(url, {
        headers: llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {},
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (error) {
      // Nothing answered. That can be a box still booting, so it is the one failure worth
      // waiting on.
      lastError = error;
      if (attempt < attempts) await sleep(options.retryDelayMs ?? RETRY_DELAY_MS);
      continue;
    }

    // Something answered. Everything past this point is a mistake in the configuration
    // rather than a timing problem, and waiting would only delay saying so.
    if (!response.ok) throw notCompatible(url, `answered with HTTP ${response.status}`);

    const body: unknown = await response.json().catch(() => undefined);
    const models = modelNames(body);
    if (!models) throw notCompatible(url, "answered with something that is not a model list");

    if (!models.some((name) => name.toLowerCase() === llm.model.toLowerCase())) {
      throw modelMissing(llm.baseUrl, llm.model, models);
    }
    return models;
  }

  throw unreachable(llm.baseUrl, attempts, lastError);
}

/**
 * `fetch` wraps everything as "fetch failed" and puts the useful part — ECONNREFUSED,
 * ENOTFOUND, a TLS complaint — in `cause`. Reporting the wrapper tells the operator only
 * that something went wrong, which they already know.
 */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const causes: string[] = [];
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (!causes.includes(current.message)) causes.push(current.message);
  }
  return causes.join(": ");
}

function unreachable(baseUrl: string, attempts: number, cause: unknown): EndpointError {
  const detail = describe(cause);
  const containerHint = isLoopback(baseUrl)
    ? `\n\nInside a container "localhost" is the container itself, not the machine running ` +
      `Docker. Set LLM_BASE_URL to http://host.docker.internal:11434/v1, or to the address ` +
      `the machine running the model has on your network.`
    : "";

  return new EndpointError(
    `Cannot reach the LLM endpoint at ${baseUrl} after ${attempts} attempts: ${detail}.` +
      containerHint +
      `\n\nLifeOps will not start without it: a capture it can never extract is worse than ` +
      `no capture at all.`,
  );
}

function notCompatible(url: string, what: string): EndpointError {
  return new EndpointError(
    `${url} ${what}, so LLM_BASE_URL is not an OpenAI-compatible endpoint. It has to ` +
      `include the API path — Ollama serves it at http://<host>:11434/v1, not ` +
      `http://<host>:11434.`,
  );
}

function modelMissing(
  baseUrl: string,
  model: string,
  available: string[],
): EndpointError {
  const serves =
    available.length === 0
      ? "It serves no models at all."
      : `It serves: ${available.join(", ")}.`;

  return new EndpointError(
    `The endpoint at ${baseUrl} does not serve a model named "${model}". ${serves} ` +
      `Set LLM_MODEL to one of those, or pull the model first — \`ollama list\` shows what ` +
      `an Ollama endpoint has.`,
  );
}
