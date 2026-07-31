import { z } from "zod";

/**
 * What the model is asked to pull out of one dump, and how it is asked.
 *
 * Pure: no network, no database. The provider (src/llm/provider.ts) sends this; the
 * pipeline (src/extraction/run.ts) stores what comes back.
 *
 * The shape is deliberately flat and small. A 2B model held to a deep, heavily-optional
 * schema fragments single facts into several junk records, and the endpoint constrains
 * decoding to whatever schema it is given — so a smaller schema is a better schema here.
 *
 * Threads are absent on purpose: thread assignment is M2 (issue #5, out of scope).
 * Every field is required-and-nullable rather than optional, because that is what
 * OpenAI-compatible structured output expects.
 *
 * Two things this schema deliberately does NOT do:
 *
 * - **No `pattern` / `.regex()`.** Ollama compiles the JSON Schema into a decoding grammar
 *   and cannot compile a regex: any `pattern` gets you
 *   `Failed to initialize samplers: failed to parse grammar` (400). Verified against
 *   Ollama 0.32.5.
 * - **No date validation at all.** Every date arrives as a plain string and is checked
 *   where it is written (src/extraction/run.ts). Rejecting the whole extraction because a
 *   2B model wrote "Heat Pump" into one `decidedOn` throws away the four good records that
 *   came with it, which is the wrong trade for a model SPEC already accepts as imperfect.
 */

export const extractionSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string().min(1).describe("How the dump names this person or thing"),
      type: z.enum([
        "person",
        "provider",
        "property",
        "company",
        "account",
        "other",
      ]),
      aliases: z
        .array(z.string().min(1))
        .describe("Other ways this same entity is referred to in this dump"),
      notes: z.string().nullable(),
    }),
  ),
  events: z.array(
    z.object({
      title: z.string().min(1),
      occursOn: z.string().describe("YYYY-MM-DD"),
      occursAtTime: z
        .string()
        .nullable()
        .describe("HH:MM in 24-hour time, or null if no time was stated"),
      location: z.string().nullable(),
      entityNames: z
        .array(z.string().min(1))
        .describe("Names from `entities` that this event involves"),
    }),
  ),
  commitments: z.array(
    z.object({
      description: z.string().min(1),
      direction: z
        .enum(["owed_to_me", "owed_by_me"])
        .describe(
          "owed_to_me when someone promised the writer something; owed_by_me when the writer promised someone else",
        ),
      counterpartyName: z
        .string()
        .nullable()
        .describe("A name from `entities`, or null"),
      dueDate: z.string().nullable().describe("YYYY-MM-DD or null"),
    }),
  ),
  decisions: z.array(
    z.object({
      decision: z.string().min(1),
      reasoning: z.string().nullable(),
      // Nullable: a note usually records the decision, not the day it was taken. When it
      // is absent the pipeline uses the capture date, which is the honest approximation.
      decidedOn: z.string().nullable().describe("YYYY-MM-DD, or null"),
    }),
  ),
});

export type Extraction = z.infer<typeof extractionSchema>;

/** An extraction that found nothing. Also the shape tests build on. */
export const EMPTY_EXTRACTION: Extraction = {
  entities: [],
  events: [],
  commitments: [],
  decisions: [],
};

/**
 * `capturedOn` is the dump's own capture date, so "Friday" and "next week" resolve against
 * when the note was written rather than when extraction happened to run.
 */
export function extractionSystemPrompt(capturedOn: string): string {
  return [
    "You extract structured records from one person's unstructured life-admin note.",
    "The note was written on " +
      capturedOn +
      ". Resolve every relative date against that date and emit absolute YYYY-MM-DD dates.",
    "",
    "Rules:",
    "- Extract only what the note states or plainly implies. Invent nothing.",
    "- If the note states no date for an event, do not emit that event.",
    "- Direction matters most: owed_to_me is someone else's promise to the writer.",
    "  Getting this backwards is the worst mistake you can make here.",
    "- Emit an entity for every person, provider, company, property, or account named,",
    "  and refer to them by exactly that name from events and commitments.",
    "- A note with nothing to extract yields empty arrays. That is a correct answer.",
  ].join("\n");
}
