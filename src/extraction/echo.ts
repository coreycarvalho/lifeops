/**
 * The capture echo — SPEC hard requirement 3, and the reason issue #5 exists.
 *
 * Two pure functions, no database and no model:
 *
 * - `renderSummary` turns the records that were *stored* into one line. The model does not
 *   write this. An echo the model writes can describe things it never emitted, and then the
 *   trust mechanism is one more thing to distrust — see docs/DECISIONS.md.
 * - `echoFor` turns a dump row into the line the user sees, whatever state it is in. One
 *   function, so the API and the capture box cannot disagree about what the user is told.
 *
 * The known failure mode of a small local model is confident wrongness — a flipped
 * `direction`, a date read as a person — so the echo spells out direction and dates rather
 * than summarising them away.
 */

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * "2026-06-22" -> "Jun 22", or "Jun 22 2027" when the year differs from `asOf`. Parsed as
 * text on purpose: `new Date("2026-06-22")` is UTC midnight and renders as the 21st for
 * anyone west of Greenwich.
 */
function formatDate(date: string, asOf: string): string {
  const [year, month, day] = date.split("-");
  const name = MONTHS[Number(month) - 1] ?? month;
  const short = `${name} ${Number(day)}`;
  return year === asOf.slice(0, 4) ? short : `${short} ${year}`;
}

/**
 * Structural, so both the stored rows and a fresh extraction satisfy it. Only the fields
 * the echo actually reads are named.
 */
export type SummarySource = {
  entities: readonly { name: string }[];
  events: readonly { title: string; occursOn: string }[];
  commitments: readonly {
    description: string;
    direction: "owed_to_me" | "owed_by_me";
    dueDate: string | null;
    counterpartyName: string | null;
  }[];
  decisions: readonly { decision: string }[];
};

/**
 * `asOf` is the date the echo is written *about* — the day the note was captured, in the
 * operator's timezone. Required rather than defaulted, because the obvious default
 * (`new Date().toISOString()`) is UTC and would silently print the wrong year on a
 * date-boundary capture.
 */
export function renderSummary(records: SummarySource, asOf: string): string {
  const parts: string[] = [];

  for (const event of records.events) {
    parts.push(`${event.title} → ${formatDate(event.occursOn, asOf)}`);
  }

  for (const commitment of records.commitments) {
    const who = commitment.counterpartyName;
    // Direction is stated, never implied. Getting it backwards is the mistake the user
    // most needs to be able to catch at a glance.
    const lead =
      commitment.direction === "owed_to_me"
        ? `waiting on ${who ?? "someone"}`
        : who
          ? `you owe ${who}`
          : "you owe";
    const due = commitment.dueDate
      ? ` (due ${formatDate(commitment.dueDate, asOf)})`
      : "";
    parts.push(`${lead}: ${commitment.description}${due}`);
  }

  for (const decision of records.decisions) {
    parts.push(`decided: ${decision.decision}`);
  }

  if (parts.length > 0) return `Got it: ${parts.join("; ")}`;

  // A dump can name people without committing anyone to anything. Saying so beats an echo
  // that reads as if the dump vanished.
  if (records.entities.length > 0) {
    return `Got it: noted ${records.entities.map((e) => e.name).join(", ")}`;
  }
  return "Got it — nothing to file from that one.";
}

/** The fields of a dump row the echo depends on. */
export type EchoSource = {
  extractionStatus: "pending" | "processing" | "done" | "failed";
  echo: string | null;
  extractionError: string | null;
};

export function echoFor(dump: EchoSource): string {
  switch (dump.extractionStatus) {
    case "pending":
    case "processing":
      // Capture is confirmed the moment the text is stored. The user is told their dump
      // landed here, not sixty seconds later when the model finishes.
      return "Captured. Working out what's in it…";
    case "done":
      return dump.echo ?? "Got it — nothing to file from that one.";
    case "failed":
      // Never silent (SPEC M1, issue #5 behaviour 6).
      return dump.extractionError
        ? `Captured, but extraction failed: ${dump.extractionError}`
        : "Captured, but extraction failed.";
  }
}
