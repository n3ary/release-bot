// Test the "is package touched by merge" logic.
//
// The release bot only bumps a package.json if the merge commit
// actually changed something in that package's directory. This is
// the "no library changes -> no bump" rule that keeps workflow-only
// and docs-only PRs from triggering version bumps in every package
// of a monorepo.
//
// Two layers:
//   - `isPackageTouched` -- sub-package rule: a sub-package's
//     directory was touched by the merge. No opinion on the root.
//   - `shouldBumpPackage` -- caller-level policy: combines the
//     sub-package rule with the root-bypass (the bot's contract
//     per org-automation.md is to bump the root on every merge
//     that didn't already touch the version).

import { describe, expect, it } from "vitest";
import {
  bumpSchemeFor,
  decodeBase64Utf8,
  isPackageTouched,
  isPrivatePackage,
  shouldBumpPackage,
  withSkipMarker,
} from "../src/commit.ts";

describe("isPackageTouched", () => {
  describe("sub-packages", () => {
    it("returns true when a file in the package's directory changed", () => {
      expect(
        isPackageTouched("apps/gtfs-rt/package.json", [
          "apps/gtfs-rt/src/main.ts",
        ]),
      ).toBe(true);
    });

    it("returns true when the package.json itself changed", () => {
      expect(
        isPackageTouched("apps/gtfs-rt/package.json", [
          "apps/gtfs-rt/package.json",
        ]),
      ).toBe(true);
    });

    it("returns true when a file in a nested subdirectory changed", () => {
      expect(
        isPackageTouched("apps/gtfs-rt/package.json", [
          "apps/gtfs-rt/src/deep/nested/file.ts",
        ]),
      ).toBe(true);
    });

    it("returns true when multiple files in the package changed", () => {
      expect(
        isPackageTouched("libs/spec/package.json", [
          "README.md",
          "libs/spec/src/foo.ts",
          "libs/spec/test/foo.test.ts",
        ]),
      ).toBe(true);
    });

    it("returns false when no file in the package's directory changed", () => {
      expect(
        isPackageTouched("apps/gtfs-rt/package.json", [
          ".github/workflows/build-gtfs-rt.yml",
          "README.md",
          "apps/gtfs-static/src/main.ts",
        ]),
      ).toBe(false);
    });

    it("returns false when a sibling package's directory was renamed similarly", () => {
      // apps/gtfs-rt vs apps/gtfs-rt-old - the latter must NOT match
      // the former.
      expect(
        isPackageTouched("apps/gtfs-rt/package.json", [
          "apps/gtfs-rt-old/src/main.ts",
        ]),
      ).toBe(false);
    });
  });

  // The function intentionally has no special case for the root
  // `package.json` (it only makes sense for sub-packages with a
  // directory prefix). Caller-level root handling is in
  // shouldBumpPackage below.
  describe("root package.json (function has no opinion)", () => {
    it("returns false when the root package.json itself changed", () => {
      // Defensive: callers should route root via shouldBumpPackage.
      // isPackageTouched has no "root" branch on purpose.
      expect(isPackageTouched("package.json", ["package.json"])).toBe(false);
    });

    it("returns false for a workflow change", () => {
      expect(
        isPackageTouched("package.json", [
          ".github/workflows/build-gtfs-rt.yml",
        ]),
      ).toBe(false);
    });

    it("returns false for an empty changed-files list", () => {
      expect(isPackageTouched("package.json", [])).toBe(false);
    });
  });
});

describe("shouldBumpPackage (caller policy)", () => {
  describe("root package.json", () => {
    it("is always bumped, even when the merge did not touch package.json", () => {
      // Regression: prior to the fix, the bot special-cased the root
      // in isPackageTouched and skipped it on workflow / docs /
      // config-only PRs. The bot's contract is to bump the root on
      // every merge that did not already touch the version (per
      // docs/standards/org-automation.md). This test pins that
      // behaviour.
      expect(shouldBumpPackage("package.json", ["README.md"])).toBe(true);
      expect(
        shouldBumpPackage("package.json", [
          ".github/workflows/build-gtfs-rt.yml",
        ]),
      ).toBe(true);
      expect(
        shouldBumpPackage("package.json", ["apps/gtfs-rt/src/main.ts"]),
      ).toBe(true);
    });

    it("is always bumped, even when no files changed", () => {
      expect(shouldBumpPackage("package.json", [])).toBe(true);
    });

    it("is always bumped when only the root package.json itself changed", () => {
      expect(shouldBumpPackage("package.json", ["package.json"])).toBe(true);
    });
  });

  describe("sub-packages", () => {
    it("is bumped when a file in its directory changed", () => {
      expect(
        shouldBumpPackage("apps/gtfs-rt/package.json", [
          "apps/gtfs-rt/src/main.ts",
        ]),
      ).toBe(true);
    });

    it("is NOT bumped when no file in its directory changed", () => {
      expect(
        shouldBumpPackage("apps/gtfs-rt/package.json", ["README.md"]),
      ).toBe(false);
    });
  });
});

describe("end-to-end monorepo scenario", () => {
  // Mimics the gtfs-publisher layout: 1 root + 3 sub-packages.
  const packages = [
    "package.json",
    "apps/gtfs-rt/package.json",
    "apps/gtfs-static/package.json",
    "libs/spec/package.json",
  ];

  // Uses the caller-level policy so the root-bypass is exercised.
  function bumpedBy(changed: string[]): string[] {
    return packages.filter((p) => shouldBumpPackage(p, changed));
  }

  it("workflow-only change: only the root is bumped", () => {
    // Regression: prior to the fix, this returned [] (root skipped).
    // Per org-automation.md, a workflow change is a user-facing
    // production change and warrants a root version bump.
    expect(bumpedBy([".github/workflows/build-gtfs-rt.yml"])).toEqual([
      "package.json",
    ]);
  });

  it("docs-only change: only the root is bumped", () => {
    expect(bumpedBy(["README.md", "docs/specs/x.md"])).toEqual([
      "package.json",
    ]);
  });

  it("gtfs-rt code change: root + that package bumped", () => {
    expect(bumpedBy(["apps/gtfs-rt/src/main.ts"])).toEqual([
      "package.json",
      "apps/gtfs-rt/package.json",
    ]);
  });

  it("libs/spec change: root + that package bumped", () => {
    expect(
      bumpedBy(["libs/spec/src/index.ts", "libs/spec/package.json"]),
    ).toEqual(["package.json", "libs/spec/package.json"]);
  });

  it("multi-package change: root + all touched packages bumped", () => {
    expect(
      bumpedBy([
        "apps/gtfs-rt/src/main.ts",
        "libs/spec/src/index.ts",
      ]),
    ).toEqual([
      "package.json",
      "apps/gtfs-rt/package.json",
      "libs/spec/package.json",
    ]);
  });

  it("root package.json change: only root bumped", () => {
    expect(
      bumpedBy(["package.json", "pnpm-workspace.yaml"]),
    ).toEqual(["package.json"]);
  });
});

// Test the "private vs library" scheme picker.
//
// Apps (private: true) get CalVer bumps; libraries (private
// missing or false) get semver bumps. This is the signal the bot
// uses to pick the right arithmetic for the package.

describe("isPrivatePackage", () => {
  it("returns true when private is true", () => {
    expect(isPrivatePackage('{"name": "x", "private": true}')).toBe(true);
  });

  it("returns false when private is false", () => {
    expect(isPrivatePackage('{"name": "x", "private": false}')).toBe(false);
  });

  it("returns false when private is missing (npm default: publishable)", () => {
    expect(isPrivatePackage('{"name": "@scope/x", "version": "0.3.7"}'))
      .toBe(false);
  });

  it("returns false for an unparseable string (library is safer default)", () => {
    expect(isPrivatePackage("not-json")).toBe(false);
    expect(isPrivatePackage("")).toBe(false);
  });

  it("only treats boolean true as private (string true is not)", () => {
    // The field is JSON-parsed; a string "true" is not boolean true.
    // This matches the npm behaviour where only boolean true matters.
    expect(isPrivatePackage('{"private": "true"}')).toBe(false);
  });
});

describe("bumpSchemeFor", () => {
  it("returns calver for private packages (no version field)", () => {
    // No `version` field, so the version-shape heuristic is
    // a no-op and we fall back to the `private` heuristic.
    expect(bumpSchemeFor('{"private": true, "name": "x"}')).toBe("calver");
  });

  it("returns semver for libraries", () => {
    expect(bumpSchemeFor('{"name": "@scope/x", "version": "0.3.7"}'))
      .toBe("semver");
    expect(bumpSchemeFor('{"private": false, "name": "x"}'))
      .toBe("semver");
  });

  // The version-shape heuristic: the current `version` is the
  // source of truth. The `private` field is only a publish
  // signal, not a versioning signal -- the release-bot is
  // `private: true` (internal tool, not on npm) but on semver
  // (`0.3.0`), and the 7 downstream apps are `private: true`
  // but on CalVer (`26.7.24-1`).
  it("returns semver when private but version is semver-shaped (release-bot)", () => {
    expect(
      bumpSchemeFor(
        '{"name": "n3ary-release-bot", "private": true, "version": "0.3.0"}',
      ),
    ).toBe("semver");
    expect(
      bumpSchemeFor(
        '{"name": "n3ary-release-bot", "private": true, "version": "1.2.3-rc.1"}',
      ),
    ).toBe("semver");
  });

  it("returns calver when private and version is calver-shaped (downstream apps)", () => {
    expect(
      bumpSchemeFor(
        '{"name": "neary-app", "private": true, "version": "26.7.24-1"}',
      ),
    ).toBe("calver");
  });

  it("returns calver for private libraries whose version is calver-shaped", () => {
    // Once a library transitions from calver to semver, the
    // version-shape heuristic picks it up automatically. Until
    // then, even an "internal" package on calver stays on calver.
    expect(
      bumpSchemeFor(
        '{"name": "neary-gtfs", "private": true, "version": "26.7.18-3"}',
      ),
    ).toBe("calver");
  });

  it("returns semver for non-private libraries on semver", () => {
    expect(
      bumpSchemeFor(
        '{"name": "@n3ary/gtfs-spec", "private": false, "version": "0.7.0"}',
      ),
    ).toBe("semver");
  });

  it("falls back to the private heuristic when the version is unparseable", () => {
    // Garbage version: version-shape heuristic can't decide.
    // Falls back to the `private` field.
    expect(
      bumpSchemeFor('{"private": true, "name": "x", "version": "garbage"}'),
    ).toBe("calver");
    expect(
      bumpSchemeFor('{"private": false, "name": "x", "version": "garbage"}'),
    ).toBe("semver");
  });
});

// Test the UTF-8 base64 decoder used by readPackageJsonAt.
//
// GitHub's getContent API returns file bodies as base64. To get
// back the original string, we have to base64-decode the
// bytes AND interpret them as UTF-8 -- `atob()` alone gives a
// "binary string" whose code points are raw byte values, not
// valid UTF-8 code points, and passing that to JSON.parse
// would mangle non-ASCII characters on the round-trip.




function utf8ToBase64(s: string): string {
  // Real btoa() of UTF-8 bytes for the test fixture.
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

describe("decodeBase64Utf8", () => {
  it("decodes ASCII correctly", () => {
    const s = "hello world\n";
    expect(decodeBase64Utf8(utf8ToBase64(s))).toBe(s);
  });

  it("decodes a single em-dash without mojibake", () => {
    // The original symptom: the bot's `atob()` produced the
    // bytes 0xE2 0x80 0x94 as the code points U+00E2 U+0080
    // U+0094 ("Ã" "Â" control). `JSON.parse` preserved those
    // code points and re-stringifying + UTF-8-encoding the
    // result produced "Ã¢ÂÂ" (6 bytes) for a single em-dash.
    // The fix decodes the base64 bytes correctly as UTF-8 so
    // the em-dash (U+2014) round-trips as the em-dash.
    const s = "Live GTFS-RT adapter — polls upstream feeds";
    expect(decodeBase64Utf8(utf8ToBase64(s))).toBe(s);
  });

  it("decodes a package.json with multi-byte UTF-8 in description", () => {
    // Real-world: apps/gtfs-rt/package.json has an em-dash
    // in the description. The bot's read step used to corrupt
    // it to mojibake. After this fix, the round-trip is clean.
    const s = JSON.stringify(
      {
        name: "@gtfs/rt",
        version: "26.7.11-1",
        description: "Live GTFS-RT adapter — polls upstream feeds, applies per-feed quirks, publishes a clean FeedMessage. Issue #34 step 7.",
      },
      null,
      2,
    );
    expect(decodeBase64Utf8(utf8ToBase64(s))).toBe(s);
  });

  it("decodes accented Latin-1 characters", () => {
    const s = "Compañía de Transporte Público Cluj-Napoca";
    expect(decodeBase64Utf8(utf8ToBase64(s))).toBe(s);
  });

  it("decodes CJK characters", () => {
    const s = "公交车实时位置";
    expect(decodeBase64Utf8(utf8ToBase64(s))).toBe(s);
  });

  it("strips newlines in the base64 input (GitHub's padding)", () => {
    // GitHub's getContent sometimes returns base64 with
    // embedded newlines for line wrapping. The decoder
    // strips them before decoding.
    const s = "with newlines";
    const b64 = utf8ToBase64(s);
    const b64WithNewlines =
      b64.slice(0, 40) + "\n" + b64.slice(40, 80) + "\n" + b64.slice(80);
    expect(decodeBase64Utf8(b64WithNewlines)).toBe(s);
  });
});

// Test the "skip marker" touch used to force the publish workflow
// to fire on a merge where the dev already bumped the version.
//
// Background: the bot's `skip-if-already-touched` rule no-ops
// on a file when the merge commit already changed its version
// (the dev's edit wins). But the bot still needs the file in
// the release commit so the consumer's publish workflow's
// paths filter matches -- otherwise the dev's manual version
// bump lands on main but never gets published to GH Packages.
// `withSkipMarker` produces a content-changing touch (a new
// top-level `_n3ary_release_bot_skip` field) that makes the
// file a real diff in the bot's release commit.

describe("withSkipMarker", () => {
  const baseInput = JSON.stringify(
    {
      name: "@n3ary/gtfs-adapter-cluj-napoca",
      version: "0.3.13",
      type: "module",
    },
    null,
    2,
  );

  it("preserves the dev's version field (does not bump)", () => {
    // The touch is metadata only -- the dev's "0.3.13" stays as
    // "0.3.13". The bot does not increment on top of the dev's
    // bump; that would race with the dev's intent and could
    // double-bump a release.
    const out = withSkipMarker(baseInput, "0.3.12", "0.3.13", "44b9241", "2026-07-12T21:11:05.000Z");
    const parsed = JSON.parse(out);
    expect(parsed.version).toBe("0.3.13");
  });

  it("adds a top-level _n3ary_release_bot_skip field with reason metadata", () => {
    const out = withSkipMarker(baseInput, "0.3.12", "0.3.13", "44b9241", "2026-07-12T21:11:05.000Z");
    const parsed = JSON.parse(out);
    expect(parsed._n3ary_release_bot_skip).toEqual({
      reason: "merge-changed-version",
      previous_version: "0.3.12",
      current_version: "0.3.13",
      merge_sha: "44b9241",
      at: "2026-07-12T21:11:05.000Z",
    });
  });

  it("produces a content change even when the input is already canonical", () => {
    // Regression: a re-serialization-only touch is a no-op for
    // canonical files (2-space indent, trailing newline). The
    // marker field guarantees a real diff every time, which is
    // what the publish workflow's paths filter needs to match.
    const out = withSkipMarker(baseInput, "0.3.12", "0.3.13", "44b9241", "2026-07-12T21:11:05.000Z");
    expect(out).not.toBe(baseInput);
    // The marker field must appear in the output.
    expect(out).toContain("_n3ary_release_bot_skip");
  });

  it("preserves all other fields verbatim", () => {
    const out = withSkipMarker(baseInput, "0.3.12", "0.3.13", "44b9241", "2026-07-12T21:11:05.000Z");
    const parsed = JSON.parse(out);
    expect(parsed.name).toBe("@n3ary/gtfs-adapter-cluj-napoca");
    expect(parsed.type).toBe("module");
    // No fields dropped, no fields renamed.
    expect(Object.keys(parsed).sort()).toEqual(
      ["_n3ary_release_bot_skip", "name", "type", "version"].sort(),
    );
  });

  it("overwrites a pre-existing marker field with the latest run's metadata", () => {
    // On a re-touch (dev bumps the same file in a later merge
    // without the bot bumping), the previous marker field is
    // overwritten with the new run's metadata. The `at` field
    // always reflects the most recent run, so a reader can tell
    // when the file was last touched.
    const withOld = JSON.stringify(
      {
        ...JSON.parse(baseInput),
        _n3ary_release_bot_skip: {
          reason: "merge-changed-version",
          previous_version: "0.3.11",
          current_version: "0.3.12",
          merge_sha: "9f4c475",
          at: "2026-07-12T20:35:55.000Z",
        },
      },
      null,
      2,
    );
    const out = withSkipMarker(withOld, "0.3.12", "0.3.13", "44b9241", "2026-07-12T21:11:05.000Z");
    const parsed = JSON.parse(out);
    expect(parsed._n3ary_release_bot_skip.previous_version).toBe("0.3.12");
    expect(parsed._n3ary_release_bot_skip.current_version).toBe("0.3.13");
    expect(parsed._n3ary_release_bot_skip.merge_sha).toBe("44b9241");
  });

  it("emits canonical JSON (2-space indent + trailing newline)", () => {
    // Matches the convention the bot already uses for bumped
    // files (`JSON.stringify(parsed, null, 2) + "\n"`). A
    // reviewer diffing the bot's release commit sees the same
    // shape for bumped and touched files.
    const out = withSkipMarker(baseInput, "0.3.12", "0.3.13", "44b9241", "2026-07-12T21:11:05.000Z");
    expect(out.endsWith("\n")).toBe(true);
    // 2-space indent -- no tabs, no 4-space indent.
    expect(out).toMatch(/^\{\n {2}"name":/);
  });
});
