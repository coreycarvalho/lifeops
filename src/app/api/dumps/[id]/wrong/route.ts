import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { dumps } from "@/db/schema";

/**
 * The "wrong" affordance — the other half of the trust mechanism (invariant 3). One tap,
 * no form: the user says the echo is wrong and moves on.
 *
 * M1 records only *that* it was wrong; M2 records what the correction was, and the ratio of
 * flags to extractions is the extraction-precision metric (SPEC instrumentation).
 *
 * Idempotent, and it keeps the first flag's timestamp — a double tap is a double tap, not a
 * second opinion.
 *
 * Only a dump whose extraction is `done` can be flagged. There is no summary to be wrong
 * about before that: "Captured. Working out what's in it…" and "extraction failed" are the
 * system reporting on itself, and a flag against either would count as a bad extraction in
 * the precision metric and then quietly hide the affordance when the real summary landed.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const db = getDb();

  const [dump] = db
    .select({ id: dumps.id, extractionStatus: dumps.extractionStatus })
    .from(dumps)
    .where(eq(dumps.id, id))
    .all();
  if (!dump) return Response.json({ error: "No such dump" }, { status: 404 });

  if (dump.extractionStatus !== "done") {
    return Response.json(
      {
        error: "That capture has no summary to be wrong about yet",
        status: dump.extractionStatus,
      },
      { status: 409 },
    );
  }

  db.update(dumps)
    .set({ flaggedWrongAt: new Date().toISOString() })
    .where(and(eq(dumps.id, id), isNull(dumps.flaggedWrongAt)))
    .run();

  return Response.json({ id, flaggedWrong: true });
}
