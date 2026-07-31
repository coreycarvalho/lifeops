import { describe, expect, it } from "vitest";
import { echoFor, renderSummary, type SummarySource } from "./echo";

const NOTHING: SummarySource = {
  entities: [],
  events: [],
  commitments: [],
  decisions: [],
};

const ASOF = "2026-06-01";

describe("the summary line", () => {
  it("reads like the SPEC example", () => {
    const line = renderSummary(
      {
        entities: [{ name: "Ray" }],
        events: [{ title: "tilt table test", occursOn: "2026-06-22" }],
        commitments: [
          {
            description: "send the furnace quote",
            direction: "owed_to_me",
            dueDate: "2026-06-05",
            counterpartyName: "Ray",
          },
        ],
        decisions: [],
      },
      ASOF,
    );

    expect(line).toBe(
      "Got it: tilt table test → Jun 22; waiting on Ray: send the furnace quote (due Jun 5)",
    );
  });

  it("states which way a commitment points", () => {
    // A flipped direction is the failure mode of a small local model, and an echo that
    // hides it is an echo the user cannot check.
    const owed = (direction: "owed_to_me" | "owed_by_me") =>
      renderSummary(
        {
          ...NOTHING,
          commitments: [
            {
              description: "text the model number",
              direction,
              dueDate: null,
              counterpartyName: "Ray",
            },
          ],
        },
        ASOF,
      );

    expect(owed("owed_to_me")).toBe("Got it: waiting on Ray: text the model number");
    expect(owed("owed_by_me")).toBe("Got it: you owe Ray: text the model number");
  });

  it("names a commitment with no counterparty without inventing one", () => {
    expect(
      renderSummary(
        {
          ...NOTHING,
          commitments: [
            {
              description: "renew the licence",
              direction: "owed_by_me",
              dueDate: null,
              counterpartyName: null,
            },
          ],
        },
        ASOF,
      ),
    ).toBe("Got it: you owe: renew the licence");
  });

  it("shows the year only when it is not the year of the dump", () => {
    const withDate = (occursOn: string) =>
      renderSummary({ ...NOTHING, events: [{ title: "review", occursOn }] }, ASOF);

    expect(withDate("2026-12-31")).toBe("Got it: review → Dec 31");
    expect(withDate("2027-01-04")).toBe("Got it: review → Jan 4 2027");
  });

  it("renders a date without shifting it into the previous day", () => {
    // `new Date("2026-06-22")` is UTC midnight and formats as the 21st west of Greenwich.
    // The date is parsed as text precisely so this cannot happen.
    expect(
      renderSummary({ ...NOTHING, events: [{ title: "x", occursOn: "2026-06-22" }] }, ASOF),
    ).toContain("Jun 22");
  });

  it("says so when a dump only named people", () => {
    expect(
      renderSummary({ ...NOTHING, entities: [{ name: "Ray" }, { name: "Dr. Alvarez" }] }, ASOF),
    ).toBe("Got it: noted Ray, Dr. Alvarez");
  });

  it("says so when there was nothing to file", () => {
    expect(renderSummary(NOTHING, ASOF)).toBe("Got it — nothing to file from that one.");
  });
});

describe("the echo a user sees", () => {
  it("confirms capture before extraction has run", () => {
    // Behaviour 12: the user learns their dump landed now, not sixty seconds from now.
    for (const status of ["pending", "processing"] as const) {
      expect(
        echoFor({ extractionStatus: status, echo: null, extractionError: null }),
      ).toBe("Captured. Working out what's in it…");
    }
  });

  it("shows the summary once extraction is done", () => {
    expect(
      echoFor({
        extractionStatus: "done",
        echo: "Got it: review → Dec 31",
        extractionError: null,
      }),
    ).toBe("Got it: review → Dec 31");
  });

  it("says extraction failed, and why", () => {
    // Behaviour 6: a failed extraction is never silent.
    const line = echoFor({
      extractionStatus: "failed",
      echo: null,
      extractionError: "endpoint refused the connection",
    });
    expect(line).toContain("failed");
    expect(line).toContain("endpoint refused the connection");
  });

  it("still says extraction failed when there is no error text", () => {
    expect(
      echoFor({ extractionStatus: "failed", echo: null, extractionError: null }),
    ).toMatch(/failed/);
  });
});
