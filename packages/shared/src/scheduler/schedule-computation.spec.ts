import { InvalidCronExpressionError, InvalidScheduleTimezoneError, computeNextOccurrence, computeNextOccurrences, validateCronExpression, validateTimezone } from "./schedule-computation";

describe("validateCronExpression", () => {
  it("accepts a standard 5-field expression", () => {
    expect(() => validateCronExpression("0 9 * * 1-5")).not.toThrow();
  });

  it("rejects a malformed expression", () => {
    expect(() => validateCronExpression("not a cron")).toThrow(InvalidCronExpressionError);
  });

  it("rejects an empty string", () => {
    expect(() => validateCronExpression("")).toThrow(InvalidCronExpressionError);
  });
});

describe("validateTimezone", () => {
  it("accepts UTC explicitly, even though it is not itself an IANA zone name", () => {
    expect(() => validateTimezone("UTC")).not.toThrow();
  });

  it("accepts a recognized IANA zone", () => {
    expect(() => validateTimezone("America/New_York")).not.toThrow();
  });

  it("rejects a bare abbreviation", () => {
    expect(() => validateTimezone("EST")).toThrow(InvalidScheduleTimezoneError);
    expect(() => validateTimezone("PST")).toThrow(InvalidScheduleTimezoneError);
  });

  it("rejects a malformed/unrecognized string", () => {
    expect(() => validateTimezone("Not/A_Zone")).toThrow(InvalidScheduleTimezoneError);
  });
});

describe("computeNextOccurrence", () => {
  it("computes the correct UTC instant for a timezone-aware cron rule (winter, EST)", () => {
    const next = computeNextOccurrence("0 9 * * *", "America/New_York", new Date("2026-01-15T00:00:00Z"));
    expect(next.toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  it("computes the correct UTC instant for a timezone-aware cron rule (summer, EDT)", () => {
    const next = computeNextOccurrence("0 9 * * *", "America/New_York", new Date("2026-07-15T00:00:00Z"));
    expect(next.toISOString()).toBe("2026-07-15T13:00:00.000Z");
  });

  it("is strictly after the reference instant, even when the reference instant is itself a valid tick", () => {
    const next = computeNextOccurrence("0 9 * * *", "UTC", new Date("2026-01-15T09:00:00.000Z"));
    expect(next.toISOString()).toBe("2026-01-16T09:00:00.000Z");
  });

  it("never derives from a stale prior value — recomputing from a far-past reference still lands on the correct future occurrence, not a backfill", () => {
    const next = computeNextOccurrence("0 9 * * *", "UTC", new Date("2020-01-01T00:00:00Z"));
    expect(next.toISOString()).toBe("2020-01-01T09:00:00.000Z");
  });

  describe("DST", () => {
    it("spring-forward: a wall-clock instant that does not exist resolves to a valid instant, not an error", () => {
      // America/New_York springs forward on 2026-03-08 at 02:00 -> 03:00.
      const next = computeNextOccurrence("30 2 * * *", "America/New_York", new Date("2026-03-07T12:00:00Z"));
      expect(next.toISOString()).toBe("2026-03-08T07:30:00.000Z");
      const following = computeNextOccurrence("30 2 * * *", "America/New_York", next);
      // The next day is a normal EDT day — offset shifts from -5 to -4.
      expect(following.toISOString()).toBe("2026-03-09T06:30:00.000Z");
    });

    it("fall-back: an ambiguous wall-clock instant resolves deterministically, never double-fires", () => {
      // America/New_York falls back on 2026-11-01 at 02:00 -> 01:00.
      const before = computeNextOccurrence("30 1 * * *", "America/New_York", new Date("2026-10-31T12:00:00Z"));
      const after = computeNextOccurrence("30 1 * * *", "America/New_York", before);
      // Exactly one occurrence per calendar day, regardless of the repeated
      // local hour — never two firings for the same fall-back day.
      expect(after.getTime()).toBeGreaterThan(before.getTime());
      expect(after.getTime() - before.getTime()).toBeGreaterThanOrEqual(23 * 60 * 60 * 1000);
    });
  });
});

describe("computeNextOccurrences", () => {
  it("returns exactly N occurrences, strictly increasing", () => {
    const occurrences = computeNextOccurrences("0 9 * * *", "UTC", new Date("2026-01-15T00:00:00Z"), 5);
    expect(occurrences).toHaveLength(5);
    for (let i = 1; i < occurrences.length; i++) {
      expect(occurrences[i].getTime()).toBeGreaterThan(occurrences[i - 1].getTime());
    }
    expect(occurrences[0].toISOString()).toBe("2026-01-15T09:00:00.000Z");
    expect(occurrences[4].toISOString()).toBe("2026-01-19T09:00:00.000Z");
  });
});
