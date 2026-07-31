import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDump } from "@/capture";
import {
  commitments,
  decisions,
  dumps,
  entities,
  events,
} from "@/db/schema";
import type { LlmProvider } from "@/llm/provider";
import { createTestDb, type TestDb } from "@/test/db";
import { extraction, failingLlm, stubLlm } from "@/test/llm";
import {
  claimNextDump,
  EXTRACTION_VERSION,
  extractDump,
  releaseDump,
  requeueStuckDumps,
  toIsoDate,
} from "./run";

let ctx: TestDb;

beforeEach(() => {
  ctx = createTestDb();
});

afterEach(() => {
  ctx.close();
});

const CAPTURED_AT = new Date("2026-06-01T09:00:00.000Z");

/** Fixed so tests do not read differently depending on where they run. */
const TZ = "America/Toronto";

function capture(rawText = "furnace guy is sending a quote by friday") {
  return createDump(ctx.db, { rawText, source: "web", now: CAPTURED_AT });
}

function extract(provider: LlmProvider, dumpId: string, timeZone = TZ) {
  return extractDump(ctx.db, provider, dumpId, timeZone);
}

/** What the model returns for the SPEC-style note used throughout these tests. */
const FURNACE = extraction({
  entities: [
    { name: "Ray", type: "provider", aliases: ["the furnace guy"], notes: null },
  ],
  events: [
    {
      title: "tilt table test",
      occursOn: "2026-06-22",
      occursAtTime: "09:00",
      location: "St Mary's",
      entityNames: ["Ray"],
    },
  ],
  commitments: [
    {
      description: "send the furnace quote",
      direction: "owed_to_me",
      counterpartyName: "the furnace guy",
      dueDate: "2026-06-05",
    },
  ],
  decisions: [
    { decision: "go with a heat pump", reasoning: "rebate expires", decidedOn: null },
  ],
});

function rowsFor(dumpId: string) {
  return {
    entities: ctx.db.select().from(entities).where(eq(entities.dumpId, dumpId)).all(),
    events: ctx.db.select().from(events).where(eq(events.dumpId, dumpId)).all(),
    commitments: ctx.db
      .select()
      .from(commitments)
      .where(eq(commitments.dumpId, dumpId))
      .all(),
    decisions: ctx.db.select().from(decisions).where(eq(decisions.dumpId, dumpId)).all(),
  };
}

function dumpRow(id: string) {
  return ctx.db.select().from(dumps).where(eq(dumps.id, id)).all()[0];
}

describe("extracting a dump", () => {
  it("leaves the captured text and its timestamp byte-identical", async () => {
    // Invariant 2. Awkward text on purpose: a CRLF, trailing spaces, and non-ASCII are what
    // a well-meaning "normalise the input" change would quietly eat.
    const rawText = "café ☕ quote\r\n  due friday   \n\n";
    const dump = capture(rawText);
    const before = dumpRow(dump.id);

    await extract(stubLlm(() => FURNACE), dump.id);

    const after = dumpRow(dump.id);
    expect(after.rawText).toBe(rawText);
    expect(after.rawText).toBe(before.rawText);
    expect(after.createdAt).toBe(before.createdAt);
  });

  it("gives the model the note's own capture date, not today's", async () => {
    // "by friday" means the friday after the note was written.
    const dump = capture();
    const llm = stubLlm(() => FURNACE);

    await extract(llm, dump.id);

    expect(llm.calls).toEqual([
      { rawText: "furnace guy is sending a quote by friday", capturedOn: "2026-06-01" },
    ]);
  });

  it("uses the operator's calendar date, not the UTC one", async () => {
    // A note written at 11pm on July 31 in New York is stored as 2026-08-01T03:00:00Z.
    // Handing the model August 1 shifts "tomorrow" and every weekday in the note by a day.
    const dump = createDump(ctx.db, {
      rawText: "call the contractor tomorrow",
      source: "web",
      now: new Date("2026-08-01T03:00:00.000Z"),
    });
    const llm = stubLlm(() => extraction({}));

    await extract(llm, dump.id, "America/New_York");

    expect(llm.calls[0].capturedOn).toBe("2026-07-31");
  });

  it("dates records by the operator's day too", async () => {
    const dump = createDump(ctx.db, {
      rawText: "decided to switch cardiologists",
      source: "web",
      now: new Date("2026-08-01T03:00:00.000Z"),
    });

    await extract(
      stubLlm(() =>
        extraction({
          decisions: [
            { decision: "switch cardiologists", reasoning: null, decidedOn: null },
          ],
        }),
      ),
      dump.id,
      "America/New_York",
    );

    expect(rowsFor(dump.id).decisions[0].decidedOn).toBe("2026-07-31");
  });

  it("names the dump on every record it writes", async () => {
    // Behaviour 4 — provenance is what makes any of this auditable later.
    const dump = capture();
    await extract(stubLlm(() => FURNACE), dump.id);

    const rows = rowsFor(dump.id);
    const written = [
      ...rows.entities,
      ...rows.events,
      ...rows.commitments,
      ...rows.decisions,
    ];
    expect(written).not.toHaveLength(0);
    for (const record of written) expect(record.dumpId).toBe(dump.id);
  });

  it("timestamps the extraction when it finished, not when it started", async () => {
    // Extraction runs into the minutes. A clock read before the model call would put that
    // whole latency between what `extracted_at` says and what happened — and M2 reads these
    // rows to judge a model.
    const dump = capture();
    let returnedAt = "";
    const slow = stubLlm(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      returnedAt = new Date().toISOString();
      return FURNACE;
    });

    const startedAt = new Date().toISOString();
    await extract(slow, dump.id);

    const row = dumpRow(dump.id);
    expect(row.extractedAt! >= returnedAt).toBe(true);
    expect(row.extractedAt! > startedAt).toBe(true);
    // The records it wrote are stamped with the same completion time.
    expect(rowsFor(dump.id).entities[0].createdAt).toBe(row.extractedAt);
  });

  it("timestamps a failure when it gave up", async () => {
    const dump = capture();
    let failedAt = "";
    const slow = stubLlm(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      failedAt = new Date().toISOString();
      throw new Error("endpoint refused the connection");
    });

    await extract(slow, dump.id);

    expect(dumpRow(dump.id).extractedAt! >= failedAt).toBe(true);
  });

  it("records the extraction version it used", async () => {
    const dump = capture();
    await extract(stubLlm(() => FURNACE), dump.id);
    expect(dumpRow(dump.id).extractionVersion).toBe(EXTRACTION_VERSION);
  });

  it("links a commitment to its counterparty through an alias", async () => {
    const dump = capture();
    await extract(stubLlm(() => FURNACE), dump.id);

    const rows = rowsFor(dump.id);
    expect(rows.commitments[0].counterpartyEntityId).toBe(rows.entities[0].id);
  });

  it("echoes what it stored", async () => {
    const dump = capture();
    await extract(stubLlm(() => FURNACE), dump.id);

    expect(dumpRow(dump.id).echo).toBe(
      "Got it: tilt table test → Jun 22; " +
        "waiting on Ray: send the furnace quote (due Jun 5); decided: go with a heat pump",
    );
  });
});

describe("re-running extraction over the same dump", () => {
  it("leaves the same records behind, not duplicates", async () => {
    // Behaviour 5. The worker retries and M2 will re-extract everything against a new
    // prompt, so this is the property that keeps the store from growing copies.
    const dump = capture();
    const llm = stubLlm(() => FURNACE);

    await extract(llm, dump.id);
    const first = rowsFor(dump.id);
    const firstEcho = dumpRow(dump.id).echo;

    await extract(llm, dump.id);
    const second = rowsFor(dump.id);

    expect(second.entities).toHaveLength(first.entities.length);
    expect(second.events).toHaveLength(first.events.length);
    expect(second.commitments).toHaveLength(first.commitments.length);
    expect(second.decisions).toHaveLength(first.decisions.length);
    expect(second.commitments[0].description).toBe(first.commitments[0].description);
    expect(dumpRow(dump.id).echo).toBe(firstEcho);
  });

  it("drops records the new extraction no longer finds", async () => {
    const dump = capture();
    await extract(stubLlm(() => FURNACE), dump.id);
    expect(rowsFor(dump.id).events).toHaveLength(1);

    await extract(stubLlm(() => extraction({})), dump.id);

    const rows = rowsFor(dump.id);
    expect(rows.events).toEqual([]);
    expect(rows.entities).toEqual([]);
    expect(dumpRow(dump.id).echo).toBe("Got it — nothing to file from that one.");
  });

  it("clears an earlier failure once it succeeds", async () => {
    const dump = capture();
    await extract(failingLlm(), dump.id);
    expect(dumpRow(dump.id).extractionStatus).toBe("failed");

    await extract(stubLlm(() => FURNACE), dump.id);

    const row = dumpRow(dump.id);
    expect(row.extractionStatus).toBe("done");
    expect(row.extractionError).toBeNull();
  });
});

describe("dates the model got wrong", () => {
  it("normalises a single-digit month or day", () => {
    expect(toIsoDate("2026-6-2")).toBe("2026-06-02");
    expect(toIsoDate("2026-06-02")).toBe("2026-06-02");
  });

  it("rejects a day that does not exist", () => {
    expect(toIsoDate("2026-02-31")).toBeNull();
    expect(toIsoDate("Jun 22")).toBeNull();
    expect(toIsoDate(null)).toBeNull();
  });

  it("keeps the good records when one date is garbage", async () => {
    // A 2B model will put "Heat Pump" in a date field. Losing the four good records that
    // came with it is the wrong trade — the echo is what surfaces the bad one.
    const dump = capture();
    await extract(
      stubLlm(() =>
        extraction({
          ...FURNACE,
          events: [
            { ...FURNACE.events[0], occursOn: "sometime in june" },
            FURNACE.events[0],
          ],
        }),
      ),
      dump.id,
    );

    const rows = rowsFor(dump.id);
    expect(rows.events).toHaveLength(1);
    expect(rows.commitments).toHaveLength(1);
    expect(dumpRow(dump.id).extractionStatus).toBe("done");
  });

  it("dates an undated decision to the day the note was written", async () => {
    const dump = capture();
    await extract(stubLlm(() => FURNACE), dump.id);
    expect(rowsFor(dump.id).decisions[0].decidedOn).toBe("2026-06-01");
  });

  it("treats an unusable due date as no due date rather than dropping the commitment", async () => {
    const dump = capture();
    await extract(
      stubLlm(() =>
        extraction({
          commitments: [
            {
              description: "send the furnace quote",
              direction: "owed_to_me",
              counterpartyName: null,
              dueDate: "next friday",
            },
          ],
        }),
      ),
      dump.id,
    );

    const rows = rowsFor(dump.id);
    expect(rows.commitments).toHaveLength(1);
    expect(rows.commitments[0].dueDate).toBeNull();
  });
});

describe("when the model call fails", () => {
  it("says so on the dump rather than failing silently", async () => {
    // Behaviour 6.
    const dump = capture();
    await extract(failingLlm("endpoint refused the connection"), dump.id);

    const row = dumpRow(dump.id);
    expect(row.extractionStatus).toBe("failed");
    expect(row.extractionError).toContain("endpoint refused the connection");
  });

  it("lets a storage failure escape instead of blaming the model", async () => {
    // A broken migration or a bug in the echo is not an extraction failure. Dressing it up
    // as one would mark every dump as the model's fault, burn its attempts, and leave the
    // worker cheerfully carrying on — no silent exceptions (AGENTS.md).
    const dump = capture();
    ctx.db.run(sql`drop table event_entities`);
    ctx.db.run(sql`drop table events`);

    await expect(extract(stubLlm(() => FURNACE), dump.id)).rejects.toThrow();

    const row = dumpRow(dump.id);
    expect(row.extractionStatus).not.toBe("failed");
    expect(row.extractionError).toBeNull();
  });

  it("keeps the dump itself intact", async () => {
    const dump = capture();
    const before = dumpRow(dump.id);
    await extract(failingLlm(), dump.id);

    const after = dumpRow(dump.id);
    expect(after.rawText).toBe(before.rawText);
    expect(after.createdAt).toBe(before.createdAt);
  });
});

describe("deciding what to extract next", () => {
  it("takes the oldest waiting dump first", () => {
    const older = createDump(ctx.db, {
      rawText: "first",
      source: "api",
      now: new Date("2026-06-01T08:00:00.000Z"),
    });
    createDump(ctx.db, {
      rawText: "second",
      source: "api",
      now: new Date("2026-06-01T09:00:00.000Z"),
    });

    expect(claimNextDump(ctx.db, 3)?.id).toBe(older.id);
  });

  it("does not hand the same dump to a second caller", () => {
    capture();
    expect(claimNextDump(ctx.db, 3)).toBeDefined();
    expect(claimNextDump(ctx.db, 3)).toBeUndefined();
  });

  it("spends an attempt at claim time, so a crash still counts", () => {
    const dump = capture();
    claimNextDump(ctx.db, 3);

    const row = dumpRow(dump.id);
    expect(row.extractionAttempts).toBe(1);
    expect(row.extractionStatus).toBe("processing");
  });

  it("retries a failed dump while it has attempts left", async () => {
    const dump = capture();
    const claimed = claimNextDump(ctx.db, 3);
    await extract(failingLlm(), claimed!.id);

    // Visibly failed the whole time it is waiting for its next attempt.
    expect(dumpRow(dump.id).extractionStatus).toBe("failed");
    expect(claimNextDump(ctx.db, 3)?.id).toBe(dump.id);
  });

  it("stops retrying, and stays failed, once the attempts run out", async () => {
    // Behaviour 7 — a dump that keeps failing must not loop forever.
    const dump = capture();
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const claimed = claimNextDump(ctx.db, maxAttempts);
      expect(claimed).toBeDefined();
      await extract(failingLlm(), claimed!.id);
    }

    expect(claimNextDump(ctx.db, maxAttempts)).toBeUndefined();

    const row = dumpRow(dump.id);
    expect(row.extractionStatus).toBe("failed");
    expect(row.extractionAttempts).toBe(maxAttempts);
    expect(row.extractionError).not.toBeNull();
  });

  it("never re-claims a dump that succeeded", async () => {
    const dump = capture();
    const claimed = claimNextDump(ctx.db, 3);
    await extract(stubLlm(() => FURNACE), claimed!.id);

    expect(dumpRow(dump.id).extractionStatus).toBe("done");
    expect(claimNextDump(ctx.db, 3)).toBeUndefined();
  });

  it("puts a dump left mid-extraction back in the queue", () => {
    // A worker killed between claiming and finishing would otherwise strand it in
    // `processing`, which nothing retries.
    const dump = capture();
    claimNextDump(ctx.db, 3);
    expect(dumpRow(dump.id).extractionStatus).toBe("processing");

    expect(requeueStuckDumps(ctx.db, 3)).toEqual({ requeued: 1, abandoned: 0 });
    expect(dumpRow(dump.id).extractionStatus).toBe("pending");
    // The attempt it already spent is not refunded, so a crash loop still ends.
    expect(dumpRow(dump.id).extractionAttempts).toBe(1);
  });

  it("stops a worker that keeps crashing from exceeding the attempt limit", () => {
    // A crash on the last allowed attempt leaves a `processing` row that gets requeued to
    // `pending`. If the limit only applied to `failed`, that dump would be handed out
    // forever — one crash loop starving every dump behind it.
    const dump = capture();
    const maxAttempts = 2;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      expect(claimNextDump(ctx.db, maxAttempts)).toBeDefined();
      requeueStuckDumps(ctx.db, maxAttempts); // stands in for the worker dying
    }

    expect(dumpRow(dump.id).extractionAttempts).toBe(maxAttempts);
    expect(claimNextDump(ctx.db, maxAttempts)).toBeUndefined();
  });

  it("hands a claimed dump back unspent when the worker is asked to stop", () => {
    // `docker compose down` is the first step of both a documented backup and an upgrade.
    // It must not be able to spend an attempt, or routine maintenance eventually fails a
    // capture that was never going to fail on its own.
    const dump = capture();
    claimNextDump(ctx.db, 3);
    expect(dumpRow(dump.id).extractionAttempts).toBe(1);

    expect(releaseDump(ctx.db, dump.id)).toBe(true);

    const row = dumpRow(dump.id);
    expect(row.extractionStatus).toBe("pending");
    expect(row.extractionAttempts).toBe(0);
  });

  it("leaves an extraction that finished in the meantime alone", async () => {
    // The signal can arrive in the gap between `store()` committing and the loop coming
    // back around. Undoing a completed extraction there would throw away a good result.
    const dump = capture();
    claimNextDump(ctx.db, 3);
    await extract(stubLlm(() => FURNACE), dump.id);

    expect(releaseDump(ctx.db, dump.id)).toBe(false);
    expect(dumpRow(dump.id).extractionStatus).toBe("done");
  });

  it("marks an out-of-attempts dump failed rather than parking it in pending", () => {
    // `pending` reads to the user as "still working on it". A dump nothing will ever pick
    // up again must not look like that — behaviour 6, a failed extraction is never silent.
    const dump = capture();
    claimNextDump(ctx.db, 1);

    expect(requeueStuckDumps(ctx.db, 1)).toEqual({ requeued: 0, abandoned: 1 });

    const row = dumpRow(dump.id);
    expect(row.extractionStatus).toBe("failed");
    expect(row.extractionError).toMatch(/worker stopped/i);
  });
});
