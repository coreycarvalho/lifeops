import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDump, listRecentCaptures } from "@/capture";
import { openDb, type Db } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { extractDump } from "@/extraction/run";
import { commitments, dumps, entityMentions, events } from "@/db/schema";
import { extraction, stubLlm } from "@/test/llm";

/**
 * What survives a restart, and what a backup is.
 *
 * The deployed shape is three containers sharing one mounted volume, so "the process that
 * wrote it is gone" is a normal Tuesday — `docker compose down` on an upgrade, a host
 * reboot, the worker's restart policy. A dump that does not come back is a dump the user
 * trusted the system to remember (invariant 3, and the whole point of the thing).
 *
 * These reopen the same file, and copy the directory, rather than asserting on SQL: the
 * durability claim is about the volume, not about a table.
 */

const CAPTURED_AT = new Date("2026-06-01T09:00:00.000Z");
const TZ = "America/Toronto";
const MAX_ATTEMPTS = 3;

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
  decisions: [],
});

/** The single mounted volume, as far as a test is concerned. */
let volume: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  volume = fs.mkdtempSync(path.join(os.tmpdir(), "lifeops-volume-"));
  dbPath = path.join(volume, "lifeops.db");
  db = openDb(dbPath);
  runMigrations(db);
});

afterEach(() => {
  db.$client.close();
  fs.rmSync(volume, { recursive: true, force: true });
});

/** Everything stops, everything starts again, pointed at the same volume. */
function restart(): Db {
  db.$client.close();
  db = openDb(dbPath);
  // The init container runs on every start, not just the first one.
  runMigrations(db);
  return db;
}

describe("a full stack restart", () => {
  it("gives back the dumps captured before it, byte for byte", async () => {
    const rawText = "café ☕ quote\r\n  due friday   \n";
    const captured = createDump(db, { rawText, source: "web", now: CAPTURED_AT });

    restart();

    const [row] = db.select().from(dumps).where(eq(dumps.id, captured.id)).all();
    expect(row.rawText).toBe(rawText);
    expect(row.createdAt).toBe(captured.createdAt);
    expect(row.source).toBe("web");
  });

  it("gives back the extracted records and the echo with them", async () => {
    // Losing the records but keeping the dump would be silently worse than losing both:
    // the capture list would read "Got it: …" for records that are no longer there.
    const captured = createDump(db, {
      rawText: "furnace guy is sending a quote by friday",
      source: "web",
      now: CAPTURED_AT,
    });
    await extractDump(db, stubLlm(() => FURNACE), captured.id, TZ);
    const echoBefore = listRecentCaptures(db, MAX_ATTEMPTS)[0].echo;

    restart();

    const [row] = db.select().from(dumps).where(eq(dumps.id, captured.id)).all();
    expect(row.extractionStatus).toBe("done");
    expect(listRecentCaptures(db, MAX_ATTEMPTS)[0].echo).toBe(echoBefore);
    // Entities are reached through their mentions now — they are not owned by a dump.
    expect(
      db.select().from(entityMentions).where(eq(entityMentions.dumpId, captured.id)).all(),
    ).not.toHaveLength(0);
    expect(db.select().from(events).where(eq(events.dumpId, captured.id)).all())
      .toHaveLength(1);
    expect(db.select().from(commitments).where(eq(commitments.dumpId, captured.id)).all())
      .toHaveLength(1);
  });

  it("leaves a dump the worker never got to still waiting for it", async () => {
    // Restarting between capture and extraction must not lose the dump or quietly mark it
    // done — the worker has to find it again on the next start.
    const captured = createDump(db, {
      rawText: "book the tilt table test",
      source: "api",
      now: CAPTURED_AT,
    });

    restart();

    const [row] = db.select().from(dumps).where(eq(dumps.id, captured.id)).all();
    expect(row.extractionStatus).toBe("pending");
    expect(row.extractionAttempts).toBe(0);
  });
});

describe("the state volume", () => {
  it("holds every file the system writes, so a backup is a copy of it", async () => {
    // Issue #1 leaves the backup *strategy* open; this is the constraint that keeps every
    // later choice viable. If anything durable ever lands outside this directory, copying
    // it stops being a backup and this test is where that shows up.
    const captured = createDump(db, {
      rawText: "furnace guy is sending a quote by friday",
      source: "web",
      now: CAPTURED_AT,
    });
    await extractDump(db, stubLlm(() => FURNACE), captured.id, TZ);

    // Stopped, as it would be for a cold copy.
    db.$client.close();
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "lifeops-restore-"));
    fs.cpSync(volume, copy, { recursive: true });

    // The copy is opened as its own deployment, with nothing from the original.
    const restored = openDb(path.join(copy, "lifeops.db"));
    try {
      const [row] = restored.select().from(dumps).where(eq(dumps.id, captured.id)).all();
      expect(row.rawText).toBe("furnace guy is sending a quote by friday");
      expect(row.extractionStatus).toBe("done");
      expect(
        restored
          .select()
          .from(entityMentions)
          .where(eq(entityMentions.dumpId, captured.id))
          .all(),
      ).not.toHaveLength(0);
    } finally {
      restored.$client.close();
      fs.rmSync(copy, { recursive: true, force: true });
    }

    // Reopened for afterEach, which closes it.
    db = openDb(dbPath);
  });

  it("keeps its sidecar files beside the database, not somewhere else", () => {
    // WAL is on (src/db/client.ts), which means -wal and -shm are part of the state. They
    // sit next to the database file, so the volume mount covers them.
    createDump(db, { rawText: "a note", source: "web", now: CAPTURED_AT });

    const stray = fs
      .readdirSync(volume)
      .filter((file) => !file.startsWith(path.basename(dbPath)));
    expect(stray).toEqual([]);
  });
});
