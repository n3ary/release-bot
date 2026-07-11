// Unit tests for the CalVer arithmetic in src/bump.ts.
//
// We pin specific dates to make the tests deterministic. The bot
// uses the org's Europe/Bucharest timezone (UTC+3 in July 2026,
// no DST), so all "now" timestamps are passed as DateTime objects
// in that zone.

import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { formatCalVer, nextCalVer, parseCalVer } from "../src/bump.ts";
import { TZ } from "./helpers.ts";

describe("parseCalVer", () => {
  it("parses a valid CalVer string", () => {
    expect(parseCalVer("26.7.11-1")).toEqual({
      year: 26,
      month: 7,
      day: 11,
      counter: 1,
    });
  });

  it("parses a multi-digit counter", () => {
    expect(parseCalVer("26.7.11-42")).toEqual({
      year: 26,
      month: 7,
      day: 11,
      counter: 42,
    });
  });

  it("rejects semver", () => {
    expect(parseCalVer("1.5.20")).toBeNull();
  });

  it("rejects garbage", () => {
    expect(parseCalVer("hello")).toBeNull();
    expect(parseCalVer("")).toBeNull();
  });

  it("rejects out-of-range month/day", () => {
    expect(parseCalVer("26.13.1-1")).toBeNull();
    expect(parseCalVer("26.1.32-1")).toBeNull();
  });
});

describe("formatCalVer", () => {
  it("formats with two-digit year and un-padded month/day", () => {
    expect(formatCalVer({ year: 26, month: 7, day: 11, counter: 1 })).toBe(
      "26.7.11-1",
    );
  });

  it("round-trips through parseCalVer", () => {
    const s = "26.12.31-99";
    expect(formatCalVer(parseCalVer(s)!)).toBe(s);
  });
});

describe("nextCalVer", () => {
  it("starts fresh when current is not CalVer (cutover case)", () => {
    const now = DateTime.fromISO("2026-07-11T10:00:00", { zone: TZ });
    expect(nextCalVer("1.5.20", now, TZ)).toBe("26.7.11-1");
  });

  it("starts fresh when current is null/empty (first-ever case)", () => {
    const now = DateTime.fromISO("2026-07-11T10:00:00", { zone: TZ });
    expect(nextCalVer("", now, TZ)).toBe("26.7.11-1");
  });

  it("increments the counter on the same day", () => {
    const now = DateTime.fromISO("2026-07-11T10:00:00", { zone: TZ });
    expect(nextCalVer("26.7.11-1", now, TZ)).toBe("26.7.11-2");
    expect(nextCalVer("26.7.11-9", now, TZ)).toBe("26.7.11-10");
    expect(nextCalVer("26.7.11-99", now, TZ)).toBe("26.7.11-100");
  });

  it("resets the counter on a new day", () => {
    const sameDay = DateTime.fromISO("2026-07-11T23:59:00", { zone: TZ });
    const nextDay = DateTime.fromISO("2026-07-12T00:01:00", { zone: TZ });

    expect(nextCalVer("26.7.11-3", sameDay, TZ)).toBe("26.7.11-4");
    expect(nextCalVer("26.7.11-3", nextDay, TZ)).toBe("26.7.12-1");
  });

  it("handles month boundary", () => {
    const now = DateTime.fromISO("2026-08-01T00:01:00", { zone: TZ });
    expect(nextCalVer("26.7.31-5", now, TZ)).toBe("26.8.1-1");
  });

  it("handles year boundary", () => {
    const now = DateTime.fromISO("2027-01-01T00:01:00", { zone: TZ });
    expect(nextCalVer("26.12.31-2", now, TZ)).toBe("27.1.1-1");
  });

  it("treats a day with no current CalVer as fresh start", () => {
    const now = DateTime.fromISO("2026-07-11T10:00:00", { zone: TZ });
    expect(nextCalVer("26.7.10-3", now, TZ)).toBe("26.7.11-1");
  });

  it("uses the supplied timezone, not UTC", () => {
    // 23:30 in Bucharest on 11 July is 20:30 UTC the same day.
    // 00:30 in Bucharest on 12 July is 21:30 UTC the previous day.
    // The day boundary is in the org's local zone, not UTC.
    const lateNightBucharest = DateTime.fromISO("2026-07-11T23:30:00", { zone: TZ });
    const earlyMorningBucharest = DateTime.fromISO("2026-07-12T00:30:00", { zone: TZ });

    expect(nextCalVer("26.7.11-1", lateNightBucharest, TZ)).toBe("26.7.11-2");
    expect(nextCalVer("26.7.11-1", earlyMorningBucharest, TZ)).toBe("26.7.12-1");
  });
});
