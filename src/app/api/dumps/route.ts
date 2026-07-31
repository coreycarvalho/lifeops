import { createDump, EmptyCaptureError } from "@/capture";
import { getDb } from "@/db/client";
import { echoFor } from "@/extraction/echo";

/**
 * The capture endpoint — one box, one endpoint (invariant 1). Text in, id out.
 *
 * It stores the dump and returns. It does not call the model: extraction is the worker's
 * job, and a capture that waited on it would be a minute of spinner, which defeats the
 * point of the echo (docs/DECISIONS.md).
 *
 * Accepts `{"text": "..."}` or a raw `text/plain` body, so `curl --data-binary @note.txt`
 * works without wrapping anything in JSON.
 */
export async function POST(request: Request): Promise<Response> {
  let rawText: string;
  try {
    rawText = await readText(request);
  } catch {
    return Response.json(
      { error: "Expected {\"text\": \"...\"} or a text/plain body" },
      { status: 400 },
    );
  }

  try {
    const capture = createDump(getDb(), { rawText, source: sourceOf(request) });
    return Response.json(
      {
        id: capture.id,
        capturedAt: capture.createdAt,
        status: capture.extractionStatus,
        // The confirmation the user gets right now. The summary replaces it later.
        echo: echoFor({
          extractionStatus: capture.extractionStatus,
          echo: null,
          extractionError: null,
        }),
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof EmptyCaptureError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

async function readText(request: Request): Promise<string> {
  const body = await request.text();
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return body;
  }
  const parsed: unknown = JSON.parse(body);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { text?: unknown }).text !== "string"
  ) {
    throw new TypeError("no text field");
  }
  return (parsed as { text: string }).text;
}

/**
 * Provenance only — it records which door a dump came through, and nothing branches on it.
 * The user is never asked.
 */
function sourceOf(request: Request): "web" | "api" {
  return request.headers.get("x-lifeops-source") === "web" ? "web" : "api";
}
