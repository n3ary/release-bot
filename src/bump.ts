// CalVer arithmetic for the n3ary release bot.
//
// Format: YY.M.D-N where:
//   YY  = two-digit year
//   M   = month, 1-12 (no leading zero)
//   D   = day, 1-31 (no leading zero)
//   N   = release counter for the day, starts at 1
//
// Examples:
//   26.7.11-1  -- first release of 11 July 2026
//   26.7.11-2  -- second release of 11 July 2026
//   26.7.12-1  -- first release of 12 July 2026 (counter resets)
//
// The timezone is fixed at Europe/Bucharest (the org's local time).
// See n3ary/standards/standards/version-management.md for the spec.

import { DateTime } from "luxon";

export interface CalVer {
  year: number;    // 2-digit (e.g. 26)
  month: number;   // 1-12
  day: number;     // 1-31
  counter: number; // 1-N
}

const CALVER_RE = /^(\d{2})\.(\d{1,2})\.(\d{1,2})-(\d+)$/;

/**
 * Parse a CalVer string into its components, or return null if the
 * string is not a valid CalVer. Used to detect "this is a semver
 * version we're transitioning from" (returns null) vs "this is a
 * real CalVer version" (returns the parsed components).
 */
export function parseCalVer(s: string): CalVer | null {
  const m = s.match(CALVER_RE);
  if (!m) return null;
  const [, yearStr, monthStr, dayStr, counterStr] = m;
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);
  const counter = parseInt(counterStr, 10);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (counter < 1) return null;
  return { year, month, day, counter };
}

/**
 * Format a CalVer value as the canonical string.
 */
export function formatCalVer(v: CalVer): string {
  return `${pad2(v.year)}.${v.month}.${v.day}-${v.counter}`;
}

/**
 * Compute the next CalVer version given the current version and a
 * "now" timestamp. The day boundary is midnight in the supplied
 * timezone.
 *
 * Cases:
 *   - current is unparseable (e.g. "1.5.20" semver): start fresh at
 *     today-1. This is the cutover case.
 *   - current's date == today's date: increment counter.
 *   - current's date != today's date: reset counter to 1.
 */
export function nextCalVer(
  current: string,
  now: DateTime,
  tz: string,
): string {
  const today = now.setZone(tz);
  const todayKey = makeKey(today.year % 100, today.month, today.day);

  const parsed = parseCalVer(current);
  if (!parsed) {
    return `${todayKey}-1`;
  }

  const currentKey = makeKey(parsed.year, parsed.month, parsed.day);
  if (currentKey === todayKey) {
    return `${todayKey}-${parsed.counter + 1}`;
  }

  return `${todayKey}-1`;
}

function makeKey(year: number, month: number, day: number): string {
  return `${pad2(year)}.${month}.${day}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
