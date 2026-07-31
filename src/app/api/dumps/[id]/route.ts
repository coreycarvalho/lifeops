import { eq } from "drizzle-orm";
import { getMaxExtractionAttempts } from "@/config";
import { getDb } from "@/db/client";
import { dumps } from "@/db/schema";
import { echoFor, willRetry } from "@/extraction/echo";

/**
 * The echo, pulled.
 *
 * SPEC hard requirement 3 says the echo is pushed via the notifier for API captures, but
 * `Notifier` is M3. Issue #5 ships this endpoint instead and M3 adds the push — an agreed
 * deviation, recorded in docs/DECISIONS.md. The web box polls the same endpoint, so both
 * capture paths get their echo from one place.
 */
export async function GET(
  _request: Request,
  // Spelled out rather than using Next's generated `RouteContext` helper: those types only
  // exist after a build, and `npm run typecheck` has to pass without one.
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  const [dump] = getDb()
    .select({
      id: dumps.id,
      createdAt: dumps.createdAt,
      extractionStatus: dumps.extractionStatus,
      extractionAttempts: dumps.extractionAttempts,
      echo: dumps.echo,
      extractionError: dumps.extractionError,
      flaggedWrongAt: dumps.flaggedWrongAt,
    })
    .from(dumps)
    .where(eq(dumps.id, id))
    .all();

  if (!dump) return Response.json({ error: "No such dump" }, { status: 404 });

  const maxAttempts = getMaxExtractionAttempts();

  return Response.json({
    id: dump.id,
    capturedAt: dump.createdAt,
    status: dump.extractionStatus,
    echo: echoFor(dump, maxAttempts),
    flaggedWrong: dump.flaggedWrongAt !== null,
    // A failure is not the end of the story while attempts remain, and the caller has no
    // way to know that on its own.
    retrying: willRetry(dump, maxAttempts),
  });
}
