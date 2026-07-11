// Test the "is package touched by merge" logic.
//
// The release bot only bumps a package.json if the merge commit
// actually changed something in that package's directory. This is
// the "no library changes -> no bump" rule that keeps workflow-only
// and docs-only PRs from triggering version bumps in every package
// of a monorepo.

import { describe, expect, it } from "vitest";
import { isPackageTouched } from "../src/commit.ts";

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

  describe("root package.json", () => {
    it("returns true when the root package.json itself changed", () => {
      expect(isPackageTouched("package.json", ["package.json"])).toBe(true);
    });

    it("returns false when a workflow file changed (not the root package.json)", () => {
      expect(
        isPackageTouched("package.json", [
          ".github/workflows/build-gtfs-rt.yml",
        ]),
      ).toBe(false);
    });

    it("returns false when a docs file changed", () => {
      expect(isPackageTouched("package.json", ["README.md"])).toBe(false);
    });

    it("returns false when a sub-package's file changed", () => {
      // Sub-package changes are "owned" by the sub-package's
      // package.json, not the root.
      expect(
        isPackageTouched("package.json", ["apps/gtfs-rt/src/main.ts"]),
      ).toBe(false);
    });

    it("returns false when no files changed", () => {
      expect(isPackageTouched("package.json", [])).toBe(false);
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

    function touchedBy(changed: string[]): string[] {
      return packages.filter((p) => isPackageTouched(p, changed));
    }

    it("workflow-only change: nothing bumped", () => {
      expect(
        touchedBy([".github/workflows/build-gtfs-rt.yml"]),
      ).toEqual([]);
    });

    it("docs-only change: nothing bumped", () => {
      expect(touchedBy(["README.md", "docs/specs/x.md"])).toEqual([]);
    });

    it("gtfs-rt code change: only that package bumped", () => {
      expect(
        touchedBy(["apps/gtfs-rt/src/main.ts"]),
      ).toEqual(["apps/gtfs-rt/package.json"]);
    });

    it("libs/spec change: only that package bumped", () => {
      expect(
        touchedBy(["libs/spec/src/index.ts", "libs/spec/package.json"]),
      ).toEqual(["libs/spec/package.json"]);
    });

    it("multi-package change: all touched packages bumped", () => {
      expect(
        touchedBy([
          "apps/gtfs-rt/src/main.ts",
          "libs/spec/src/index.ts",
        ]),
      ).toEqual([
        "apps/gtfs-rt/package.json",
        "libs/spec/package.json",
      ]);
    });

    it("root package.json change: only root bumped", () => {
      expect(
        touchedBy(["package.json", "pnpm-workspace.yaml"]),
      ).toEqual(["package.json"]);
    });
  });
});
