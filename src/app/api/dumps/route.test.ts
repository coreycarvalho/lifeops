import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dumps } from "@/db/schema";
import { extractDump } from "@/extraction/run";
import { createTestDb, type TestDb } from "@/test/db";
import { extraction, stubLlm } from "@/test/llm";
import { GET } from "./[id]/route";
import { POST as FLAG_WRONG } from "./[id]/wrong/route";
import { POST } from "./route";

/**
 * The HTTP capture path, end to end against a real database.
 *
 * The handlers resolve their database from `LIFEOPS_DB_PATH` on each call, so pointing that
 * at a temp file is all the wiring these need.
 */

let ctx: TestDb;
let outbound: string[];

beforeEach(() => {
  ctx = createTestDb();
  process.env.LIFEOPS_DB_PATH = ctx.path;

  // Anything that tried to reach a model would show up here.
  outbound = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    outbound.push(String(input));
    throw new Error("no request should leave a request handler");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LIFEOPS_DB_PATH;
  ctx.close();
});

const NOTE = "furnace guy is sending a quote by friday";

function capture(body: BodyInit, init: RequestInit = {}) {
  return POST(
    new Request("http://lifeops.local/api/dumps", {
      method: "POST",
      body,
      ...init,
    }),
  );
}

function json(body: unknown, init: RequestInit = {}) {
  return capture(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function fetchEcho(id: string) {
  return GET(new Request(`http://lifeops.local/api/dumps/${id}`), params(id));
}

function dumpRow(id: string) {
  return ctx.db.select().from(dumps).where(eq(dumps.id, id)).all()[0];
}

describe("POST /api/dumps", () => {
  it("returns an identifier without waiting for extraction", async () => {
    // Behaviour 2. The request never waits on a model, which on the local models is a
    // minute of nothing.
    const response = await json({ text: NOTE });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.id).toEqual(expect.any(String));
    expect(body.status).toBe("pending");
  });

  it("confirms the capture in the same breath", async () => {
    // Behaviour 12: the user learns their dump landed now, not when the model finishes.
    const body = await (await json({ text: NOTE })).json();
    expect(body.echo).toBe("Captured. Working out what's in it…");
  });

  it("asks nothing about how to file it", async () => {
    // Invariant 1. A capture that succeeds with text and nothing else is the proof: there
    // is no category, tag, or folder to supply, so none can be demanded.
    const response = await json({ text: NOTE });
    expect(response.status).toBe(201);
    expect(dumpRow((await response.json()).id).rawText).toBe(NOTE);
  });

  it("never runs extraction inside the request handler", async () => {
    // Behaviour 9, and SPEC's deployment constraint. The dump is left for the worker,
    // untouched and unattempted, and nothing reached out to the network.
    const body = await (await json({ text: NOTE })).json();

    const row = dumpRow(body.id);
    expect(row.extractionStatus).toBe("pending");
    expect(row.extractionAttempts).toBe(0);
    expect(row.echo).toBeNull();
    expect(outbound).toEqual([]);
  });

  it("stores the text exactly as it arrived", async () => {
    const awkward = "café ☕\r\n  trailing spaces   \n\n";
    const body = await (await json({ text: awkward })).json();
    expect(dumpRow(body.id).rawText).toBe(awkward);
  });

  it("accepts a plain-text body, so a shell one-liner works", async () => {
    const response = await capture(NOTE, {
      headers: { "content-type": "text/plain" },
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(dumpRow(body.id).rawText).toBe(NOTE);
  });

  it("refuses an empty dump instead of storing nothing", async () => {
    for (const empty of ["", "   \n "]) {
      expect((await json({ text: empty })).status).toBe(400);
    }
  });

  it("refuses a body with no text at all", async () => {
    expect((await json({ note: NOTE })).status).toBe(400);
    expect((await capture("{not json", {
      headers: { "content-type": "application/json" },
    })).status).toBe(400);
  });
});

describe("GET /api/dumps/[id] — the echo", () => {
  it("says the dump is captured while extraction is still pending", async () => {
    const { id } = await (await json({ text: NOTE })).json();

    const body = await (await fetchEcho(id)).json();
    expect(body.status).toBe("pending");
    expect(body.echo).toBe("Captured. Working out what's in it…");
    expect(body.flaggedWrong).toBe(false);
  });

  it("replaces the confirmation with the summary once extraction has run", async () => {
    // Behaviour 1 and 12: the echo the user ends up with is a summary of what was stored.
    const { id } = await (await json({ text: NOTE })).json();

    await extractDump(
      ctx.db,
      stubLlm(() =>
        extraction({
          commitments: [
            {
              description: "send the furnace quote",
              direction: "owed_to_me",
              counterpartyName: null,
              dueDate: null,
            },
          ],
        }),
      ),
      id,
    );

    const body = await (await fetchEcho(id)).json();
    expect(body.status).toBe("done");
    expect(body.echo).toBe("Got it: waiting on someone: send the furnace quote");
  });

  it("says extraction failed rather than saying nothing", async () => {
    // Behaviour 6 — the API capture path gets the failure too, not just the web box.
    const { id } = await (await json({ text: NOTE })).json();
    await extractDump(
      ctx.db,
      stubLlm(() => {
        throw new Error("endpoint refused the connection");
      }),
      id,
    );

    const body = await (await fetchEcho(id)).json();
    expect(body.status).toBe("failed");
    expect(body.echo).toContain("failed");
    expect(body.echo).toContain("endpoint refused the connection");
  });

  it("is a 404 for a dump that does not exist", async () => {
    expect((await fetchEcho("00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });
});

describe("POST /api/dumps/[id]/wrong", () => {
  function flag(id: string) {
    return FLAG_WRONG(
      new Request(`http://lifeops.local/api/dumps/${id}/wrong`, { method: "POST" }),
      params(id),
    );
  }

  it("records that the echo was wrong, and it survives a reload", async () => {
    // Behaviour 8. "Survives a reload" is the whole point — a flag held in the page is not
    // a record of anything.
    const { id } = await (await json({ text: NOTE })).json();
    expect((await (await fetchEcho(id)).json()).flaggedWrong).toBe(false);

    expect((await flag(id)).status).toBe(200);

    expect((await (await fetchEcho(id)).json()).flaggedWrong).toBe(true);
    expect(dumpRow(id).flaggedWrongAt).toEqual(expect.any(String));
  });

  it("keeps the first flag when tapped twice", async () => {
    const { id } = await (await json({ text: NOTE })).json();
    await flag(id);
    const first = dumpRow(id).flaggedWrongAt;

    await flag(id);

    expect(dumpRow(id).flaggedWrongAt).toBe(first);
  });

  it("leaves the dump and its records alone", async () => {
    // Flagging says the extraction was wrong; it does not delete anything. M2 records what
    // the correction actually was.
    const { id } = await (await json({ text: NOTE })).json();
    const before = dumpRow(id);

    await flag(id);

    const after = dumpRow(id);
    expect(after.rawText).toBe(before.rawText);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.extractionStatus).toBe(before.extractionStatus);
  });

  it("is a 404 for a dump that does not exist", async () => {
    expect((await flag("00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });
});
