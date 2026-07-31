import { describe, expect, it } from "vitest";
import { isTimeZone, localDate, systemTimeZone } from "./time";

describe("the calendar date an instant fell on", () => {
  it("is the operator's date, not the UTC one", () => {
    // 11pm on July 31 in New York is already August 1 in UTC. Slicing the stored ISO string
    // would tell the model the note was written on the 1st, shifting every "tomorrow".
    const lateEvening = "2026-08-01T03:00:00.000Z";

    expect(localDate(lateEvening, "America/New_York")).toBe("2026-07-31");
    expect(localDate(lateEvening, "UTC")).toBe("2026-08-01");
  });

  it("works the other way for zones ahead of UTC", () => {
    // 8am on August 1 in Sydney is still July 31 in UTC.
    const morning = "2026-07-31T22:00:00.000Z";

    expect(localDate(morning, "Australia/Sydney")).toBe("2026-08-01");
    expect(localDate(morning, "UTC")).toBe("2026-07-31");
  });

  it("pads to a sortable YYYY-MM-DD", () => {
    // The whole store depends on lexicographic order being chronological order.
    expect(localDate("2026-01-02T12:00:00.000Z", "UTC")).toBe("2026-01-02");
  });

  it("takes a Date as readily as a stored timestamp", () => {
    expect(localDate(new Date("2026-08-01T03:00:00.000Z"), "America/New_York")).toBe(
      "2026-07-31",
    );
  });
});

describe("recognising a timezone", () => {
  it("accepts real IANA zones", () => {
    for (const zone of ["UTC", "America/New_York", "Europe/London", "Australia/Sydney"]) {
      expect(isTimeZone(zone)).toBe(true);
    }
  });

  it("rejects the things people write instead", () => {
    for (const zone of ["EST5", "Mars/Olympus", "GMT+5", ""]) {
      expect(isTimeZone(zone)).toBe(false);
    }
  });

  it("reports a zone the host actually has", () => {
    expect(isTimeZone(systemTimeZone())).toBe(true);
  });
});
