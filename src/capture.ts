import { randomUUID } from "node:crypto";
import { desc } from "drizzle-orm";
import type { Db } from "@/db/client";
import { dumps } from "@/db/schema";
import { echoFor, willRetry } from "@/extraction/echo";

/**
 * Capture: text in, id out. Nothing else.
 *
 * No category, no tag, no folder — invariant 1. No model call either: extraction is the
 * worker's job (invariant: never in a request handler), so capture is one INSERT and the
 * user is told their dump landed immediately rather than a minute later.
 */

export class EmptyCaptureError extends Error {
  constructor() {
    super("A dump needs some text");
    this.name = "EmptyCaptureError";
  }
}

export type Capture = {
  id: string;
  createdAt: string;
  extractionStatus: "pending";
};

export function createDump(
  db: Db,
  input: { rawText: string; source: "web" | "api"; now?: Date },
): Capture {
  // Only whitespace-only input is refused. The raw text itself is stored exactly as it
  // arrived — trimming it would make the dump not immutable before it was even written.
  if (input.rawText.trim() === "") throw new EmptyCaptureError();

  const row = {
    id: randomUUID(),
    createdAt: (input.now ?? new Date()).toISOString(),
    rawText: input.rawText,
    source: input.source,
  };
  db.insert(dumps).values(row).run();

  return {
    id: row.id,
    createdAt: row.createdAt,
    extractionStatus: "pending",
  };
}

/** One capture and the line the user is shown about it. */
export type CaptureEcho = {
  id: string;
  capturedAt: string;
  status: "pending" | "processing" | "done" | "failed";
  echo: string;
  flaggedWrong: boolean;
  /** True while the worker will pick this failure up again — see `willRetry`. */
  retrying: boolean;
};

/**
 * The most recent captures, newest first.
 *
 * The capture screen needs these because extraction takes minutes: an echo that lived only
 * in the page would almost never be seen, and invariant 3 would hold on paper only. This is
 * not the dashboard — no zones, no lens, no curation. That is M4.
 */
export function listRecentCaptures(
  db: Db,
  maxAttempts: number,
  limit = 10,
): CaptureEcho[] {
  return db
    .select({
      id: dumps.id,
      capturedAt: dumps.createdAt,
      extractionStatus: dumps.extractionStatus,
      extractionAttempts: dumps.extractionAttempts,
      echo: dumps.echo,
      extractionError: dumps.extractionError,
      flaggedWrongAt: dumps.flaggedWrongAt,
    })
    .from(dumps)
    .orderBy(desc(dumps.createdAt))
    .limit(limit)
    .all()
    .map((dump) => ({
      id: dump.id,
      capturedAt: dump.capturedAt,
      status: dump.extractionStatus,
      echo: echoFor(dump, maxAttempts),
      flaggedWrong: dump.flaggedWrongAt !== null,
      retrying: willRetry(dump, maxAttempts),
    }));
}
