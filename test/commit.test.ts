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
  isPackageTouched,
  isPrivatePackage,
  shouldBumpPackage,
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
  it("returns calver for private packages", () => {
    expect(bumpSchemeFor('{"private": true, "name": "x"}')).toBe("calver");
  });

  it("returns semver for libraries", () => {
    expect(bumpSchemeFor('{"name": "@scope/x", "version": "0.3.7"}'))
      .toBe("semver");
    expect(bumpSchemeFor('{"private": false, "name": "x"}'))
      .toBe("semver");
  });
});
