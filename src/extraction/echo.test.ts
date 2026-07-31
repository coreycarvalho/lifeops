import { describe, expect, it } from "vitest";
import { echoFor, renderSummary, willRetry, type SummarySource } from "./echo";

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
  const MAX = 3;

  it("confirms capture before extraction has run", () => {
    // Behaviour 12: the user learns their dump landed now, not sixty seconds from now.
    for (const status of ["pending", "processing"] as const) {
      expect(
        echoFor(
          {
            extractionStatus: status,
            extractionAttempts: 0,
            echo: null,
            extractionError: null,
          },
          MAX,
        ),
      ).toBe("Captured. Working out what's in it…");
    }
  });

  it("shows the summary once extraction is done", () => {
    expect(
      echoFor(
        {
          extractionStatus: "done",
          extractionAttempts: 1,
          echo: "Got it: review → Dec 31",
          extractionError: null,
        },
        MAX,
      ),
    ).toBe("Got it: review → Dec 31");
  });

  it("says extraction failed, and why", () => {
    // Behaviour 6: a failed extraction is never silent.
    const line = echoFor(
      {
        extractionStatus: "failed",
        extractionAttempts: MAX,
        echo: null,
        extractionError: "endpoint refused the connection",
      },
      MAX,
    );
    expect(line).toContain("failed");
    expect(line).toContain("endpoint refused the connection");
  });

  it("distinguishes a failure that will be retried from one that is final", () => {
    // "It broke" and "it broke and that is the end of it" are different things to be told,
    // and only one of them means the user should go and do something about it.
    const failed = (extractionAttempts: number) =>
      echoFor(
        {
          extractionStatus: "failed",
          extractionAttempts,
          echo: null,
          extractionError: "endpoint refused the connection",
        },
        MAX,
      );

    expect(failed(1)).toMatch(/trying again/i);
    expect(failed(MAX)).not.toMatch(/trying again/i);
    expect(failed(MAX)).toMatch(/failed/i);
  });

  it("still says extraction failed when there is no error text", () => {
    expect(
      echoFor(
        {
          extractionStatus: "failed",
          extractionAttempts: MAX,
          echo: null,
          extractionError: null,
        },
        MAX,
      ),
    ).toMatch(/failed/);
  });
});

describe("whether a failure is the end of it", () => {
  const failed = (extractionAttempts: number) => ({
    extractionStatus: "failed" as const,
    extractionAttempts,
    echo: null,
    extractionError: "boom",
  });

  it("is not, while the worker still has attempts left", () => {
    // Has to agree with `claimNextDump`, or the capture box stops asking about a dump that
    // is still going to change.
    expect(willRetry(failed(0), 3)).toBe(true);
    expect(willRetry(failed(2), 3)).toBe(true);
  });

  it("is, once the attempts are gone", () => {
    expect(willRetry(failed(3), 3)).toBe(false);
    expect(willRetry(failed(4), 3)).toBe(false);
  });

  it("is never true for a dump that has not failed", () => {
    for (const extractionStatus of ["pending", "processing", "done"] as const) {
      expect(
        willRetry(
          { extractionStatus, extractionAttempts: 0, echo: null, extractionError: null },
          3,
        ),
      ).toBe(false);
    }
  });
});
