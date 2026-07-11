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

// ---------------------------------------------------------------------------
// SemVer arithmetic for library packages.
//
// Format: MAJOR.MINOR.PATCH[-PRERELEASE][+BUILDMETA] per semver.org.
// The bot uses the standard "next patch" rule: increment PATCH for
// a normal release, drop a prerelease if one is present. Major and
// minor bumps are explicit decisions and never automated.
//
// Libraries are identified by `package.json#private !== true` in
// commit.ts; see isPrivatePackage. Apps stay on CalVer above.
// ---------------------------------------------------------------------------

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null; // null = no prerelease
  build: string | null;      // null = no build metadata
}

// Loose semver regex: numeric MAJOR.MINOR.PATCH, optional `-prerelease`
// (alphanumeric + dot + hyphen, no leading dot/hyphen), optional
// `+build` (same charset).
const SEMVER_RE =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/**
 * Parse a SemVer string into its components, or return null if the
 * string is not a valid SemVer. Used to detect "this is a calver
 * version we're transitioning from" (parsed by parseCalVer but
 * returns here as a real SemVer with an unusual MAJOR) vs "this is
 * a normal semver" (parsed cleanly with a small MAJOR).
 */
export function parseSemVer(s: string): SemVer | null {
  const m = s.match(SEMVER_RE);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
    prerelease: m[4] ?? null,
    build: m[5] ?? null,
  };
}

/**
 * Format a SemVer value as the canonical string. Drops a null
 * prerelease/build; preserves non-null values verbatim.
 */
export function formatSemVer(v: SemVer): string {
  let s = `${v.major}.${v.minor}.${v.patch}`;
  if (v.prerelease) s += `-${v.prerelease}`;
  if (v.build) s += `+${v.build}`;
  return s;
}

// `26.7.11-2` is a calver value. `26.7.11` (no counter) is
// what the bot used to produce as a "weird" semver when
// dropping the prerelease. Both are calver-shaped and must
// not be bumped by `nextSemVer` -- the library needs a human
// to do the one-time cutover to a clean `MAJOR.MINOR.PATCH`.
// This pattern matches both: `YY.M.D` (no counter) and
// `YY.M.D-N` (with counter).
const CALVER_LIKE_RE = /^(\d{2})\.(\d{1,2})\.(\d{1,2})(?:-(\d+))?$/;

/**
 * Compute the next SemVer version. Default bump: patch (most
 * conservative, least likely to break consumers using `^X.Y.Z`).
 *
 * Returns `null` when the current version is a calver-shaped
 * value (e.g. `26.7.11-2` or `26.7.11`). The bot's
 * commit.ts interprets `null` as "skip this file" and emits
 * a log line saying the library needs a one-time manual
 * cutover to semver. This is the safe path: the bot never
 * produces the hybrid "calver-as-semver" version that a
 * naive drop-prerelease would yield.
 *
 * Rules:
 *   - If current is calver-shaped (`26.7.11` or `26.7.11-2`),
 *     return `null` (skip + manual cutover required).
 *   - If current is unparseable as semver, start at `0.1.0`.
 *   - If current is a prerelease (e.g. `0.3.7-rc.1`), drop
 *     the prerelease. The base version is the next "real"
 *     release.
 *   - If current is a normal version (e.g. `0.3.7`),
 *     increment patch.
 *   - Build metadata is dropped on the automated bump (we
 *     don't carry it forward; consumers that care about build
 *     metadata should not rely on a bot-bump preserving it).
 */
export function nextSemVer(current: string): string | null {
  // If current is a calver-shaped value, the bot must not
  // touch it. The library was previously on calver; the
  // cutover to semver requires a human to set a clean
  // MAJOR.MINOR.PATCH. Returning null signals commit.ts to
  // skip this file with a clear log line.
  if (parseCalVer(current) !== null) {
    return null;
  }
  // Also catch the no-counter intermediate (`26.7.11`) that
  // a previous bot version produced by dropping the
  // prerelease. Same shape, same fix: skip and require a
  // manual cutover.
  if (CALVER_LIKE_RE.test(current)) {
    return null;
  }
  const parsed = parseSemVer(current);
  if (!parsed) return "0.1.0";
  if (parsed.prerelease) {
    return formatSemVer({
      major: parsed.major,
      minor: parsed.minor,
      patch: parsed.patch,
      prerelease: null,
      build: null,
    });
  }
  return formatSemVer({
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch + 1,
    prerelease: null,
    build: null,
  });
}
