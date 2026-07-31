import { describe, expect, it, vi } from "vitest";
import { checkEndpoint } from "./preflight";

const llm = { baseUrl: "http://192.168.1.50:11434/v1", model: "qwen3:8b" };

/** A `/models` response with the given model ids. */
function serves(...ids: string[]): Response {
  return Response.json({ object: "list", data: ids.map((id) => ({ id })) });
}

function refuses(message = "connect ECONNREFUSED 192.168.1.50:11434") {
  return () => Promise.reject(new Error(message));
}

/** The error the check threw — and an assertion that it threw at all. */
async function failure(check: Promise<unknown>): Promise<Error> {
  try {
    await check;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the endpoint check to fail, and it did not");
}

/** No real waiting, and a record of how long it would have waited. */
function fakeSleep() {
  const waits: number[] = [];
  return Object.assign(
    (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    },
    { waits },
  );
}

describe("checkEndpoint", () => {
  it("passes when the endpoint serves the configured model", async () => {
    const fetch = vi.fn().mockResolvedValue(serves("llama3:8b", "qwen3:8b"));

    await expect(checkEndpoint(llm, { fetch })).resolves.toEqual([
      "llama3:8b",
      "qwen3:8b",
    ]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("asks the endpoint for its model list at the configured base URL", async () => {
    const fetch = vi.fn().mockResolvedValue(serves("qwen3:8b"));

    // A trailing slash on LLM_BASE_URL must not produce "/v1//models".
    await checkEndpoint({ ...llm, baseUrl: "http://192.168.1.50:11434/v1/" }, { fetch });

    expect(fetch.mock.calls[0][0]).toBe("http://192.168.1.50:11434/v1/models");
  });

  it("sends no credential when there is none, because a local endpoint has no secret", async () => {
    const fetch = vi.fn().mockResolvedValue(serves("qwen3:8b"));
    await checkEndpoint(llm, { fetch });
    expect(fetch.mock.calls[0][1].headers).toEqual({});
  });

  it("sends the key when the endpoint sits behind a proxy that wants one", async () => {
    const fetch = vi.fn().mockResolvedValue(serves("qwen3:8b"));
    await checkEndpoint({ ...llm, apiKey: "proxy-token" }, { fetch });
    expect(fetch.mock.calls[0][1].headers).toEqual({
      authorization: "Bearer proxy-token",
    });
  });

  it("tells an operator who pointed a container at localhost what is actually wrong", async () => {
    // The mistake everyone makes once: inside a container `localhost` is the container.
    // A bare "connection refused" sends them looking at the model server, which is fine.
    const error = await failure(
      checkEndpoint(
        { ...llm, baseUrl: "http://localhost:11434/v1" },
        { fetch: refuses(), sleep: fakeSleep() },
      ),
    );

    expect(error.message).toContain("http://localhost:11434/v1");
    expect(error.message).toContain("host.docker.internal");
    expect(error.message).toMatch(/inside a container/i);
  });

  it("retries a connection failure, because the model box may still be booting", async () => {
    const sleep = fakeSleep();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockResolvedValue(serves("qwen3:8b"));

    await expect(checkEndpoint(llm, { fetch, sleep })).resolves.toContain("qwen3:8b");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.waits).toHaveLength(2);
  });

  it("gives up on an unreachable endpoint, naming it and the underlying error", async () => {
    const sleep = fakeSleep();
    const fetch = vi.fn(refuses("connect EHOSTUNREACH 192.168.1.50:11434"));

    const error = await failure(
      checkEndpoint(llm, { fetch, sleep, attempts: 4 }),
    );

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(error.message).toContain("http://192.168.1.50:11434/v1");
    expect(error.message).toContain("EHOSTUNREACH");
  });

  it("reports what actually went wrong, not fetch's word for it", async () => {
    // `fetch` reports every connection problem as "fetch failed" and hides the real one in
    // `cause`. "fetch failed" tells an operator nothing they did not already know.
    const wrapped = new Error("fetch failed", {
      cause: new Error("connect ECONNREFUSED 127.0.0.1:11434"),
    });
    const fetch = vi.fn().mockRejectedValue(wrapped);

    const error = await failure(
      checkEndpoint(llm, { fetch, sleep: fakeSleep(), attempts: 1 }),
    );

    expect(error.message).toContain("ECONNREFUSED 127.0.0.1:11434");
  });

  it("does not retry an endpoint that answered, because an answer is not a hiccup", async () => {
    // A 404 means LLM_BASE_URL is wrong, not that anything is warming up. Thirty seconds
    // of retries would only delay telling the operator so.
    const sleep = fakeSleep();
    const fetch = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }));

    const error = await failure(checkEndpoint(llm, { fetch, sleep }));

    expect(fetch).toHaveBeenCalledOnce();
    expect(sleep.waits).toHaveLength(0);
    expect(error.message).toContain("404");
    expect(error.message).toContain("LLM_BASE_URL");
    // The usual cause is a base URL missing the API path.
    expect(error.message).toContain("/v1");
  });

  it("rejects something that answers but is not an OpenAI-compatible endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ollama: "is running" }));

    const error = await failure(checkEndpoint(llm, { fetch }));

    expect(error.message).toContain("LLM_BASE_URL");
    expect(error.message).toContain("/v1");
  });

  it("refuses to start when the endpoint does not serve the configured model", async () => {
    // Ollama answers a request for a model it has not pulled with a 404 at extraction
    // time — one dump at a time, hours later. Better to say so at startup.
    const fetch = vi.fn().mockResolvedValue(serves("llama3:8b", "gemma4:e2b-it-qat"));

    const error = await failure(checkEndpoint(llm, { fetch }));

    expect(error.message).toContain("qwen3:8b");
    expect(error.message).toContain("LLM_MODEL");
    // What it does serve, so the fix does not need a second command.
    expect(error.message).toContain("llama3:8b");
    expect(error.message).toContain("gemma4:e2b-it-qat");
  });

  it("says so plainly when the endpoint serves nothing at all", async () => {
    const fetch = vi.fn().mockResolvedValue(serves());

    const error = await failure(checkEndpoint(llm, { fetch }));

    expect(error.message).toMatch(/no models/i);
  });

  it("reads the model list whether the endpoint calls it `id` or `name`", async () => {
    // Ollama returns `id`; some servers return `name`. Neither is worth a false failure.
    const byName = vi
      .fn()
      .mockResolvedValue(Response.json({ data: [{ name: "qwen3:8b" }] }));

    await expect(checkEndpoint(llm, { fetch: byName })).resolves.toEqual(["qwen3:8b"]);
  });

  it("holds the model name to the exact string the endpoint reports", async () => {
    // A model id is an opaque string that goes back to the endpoint verbatim. Accepting a
    // near-miss here would pass the check and fail at the first extraction instead — the
    // exact failure this exists to move forward in time.
    const fetch = vi.fn().mockResolvedValue(serves("Qwen3:8B"));

    const error = await failure(checkEndpoint(llm, { fetch }));

    expect(error.message).toContain("Qwen3:8B");
    expect(error.message).toContain("LLM_MODEL");
  });
});

describe("checkEndpoint against a proxy", () => {
  it("waits out a gateway whose model upstream is still coming up", async () => {
    // A reverse proxy accepts the connection long before its upstream can answer, so 502
    // and 503 are the same "not yet" as a refused connection — and the stack staying down
    // for an endpoint that recovered inside the grace period would need a human to notice.
    const sleep = fakeSleep();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValue(serves("qwen3:8b"));

    await expect(checkEndpoint(llm, { fetch, sleep })).resolves.toContain("qwen3:8b");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.waits).toHaveLength(2);
  });

  it("gives up on a gateway that never recovers, and says what it said", async () => {
    const sleep = fakeSleep();
    const fetch = vi.fn().mockResolvedValue(new Response("bad gateway", { status: 502 }));

    const error = await failure(checkEndpoint(llm, { fetch, sleep, attempts: 3 }));

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(error.message).toContain("502");
  });

  it("names LLM_API_KEY when the endpoint asks for a credential", async () => {
    // Reporting this as "LLM_BASE_URL is not OpenAI-compatible, add /v1" sends the operator
    // to edit the one variable that is correct.
    for (const status of [401, 403]) {
      const fetch = vi.fn().mockResolvedValue(new Response("nope", { status }));

      const error = await failure(checkEndpoint(llm, { fetch, sleep: fakeSleep() }));

      expect(error.message).toContain("LLM_API_KEY");
      expect(error.message).not.toContain("LLM_BASE_URL must");
      expect(fetch).toHaveBeenCalledOnce();
    }
  });

  it("tells an operator with a key that theirs was rejected, not that they need one", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));

    const error = await failure(
      checkEndpoint({ ...llm, apiKey: "stale-token" }, { fetch }),
    );

    expect(error.message).toMatch(/expired|not satisfy|did not satisfy/i);
  });
});
