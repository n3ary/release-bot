// Tests for the webhook event predicates.
//
// The two predicates gate the bot's work:
//   - isMergedPullRequestClose  -- "is this a closed+merged PR?"
//   - isMergedIntoDefaultBranch -- "did the merge land on the
//     repo's default branch (e.g. main)?"
//
// The second predicate is the regression guard for the
// 2026-07-12 incident: n3ary/gtfs-adapters PR #78 was merged
// into `feat/issue-26-tags-networks` and the bot (which previously
// only checked `merged === true`) fired and opened a release PR
// against main carrying the entire feature-branch tree.
//
// Both predicates are pure functions over the event payload, so
// the tests can construct minimal fixtures without spinning up a
// Worker.

import { describe, expect, it } from "vitest";
import {
  isMergedIntoDefaultBranch,
  isMergedPullRequestClose,
} from "../src/webhook.ts";
import type { PullRequestEvent } from "../src/types.ts";

function makeEvent(overrides: Partial<PullRequestEvent> = {}): PullRequestEvent {
  return {
    action: "closed",
    pull_request: {
      merged: true,
      merge_commit_sha: "abc123",
      head: { sha: "head-sha" },
      base: { ref: "main", sha: "base-sha" },
    },
    repository: {
      name: "some-repo",
      full_name: "n3ary/some-repo",
      owner: { login: "n3ary" },
      default_branch: "main",
    },
    installation: { id: 12345 },
    ...overrides,
  };
}

describe("isMergedPullRequestClose", () => {
  it("returns true for a closed + merged PR", () => {
    expect(isMergedPullRequestClose(makeEvent())).toBe(true);
  });

  it("returns false for a closed but not-merged PR", () => {
    expect(
      isMergedPullRequestClose(
        makeEvent({
          pull_request: {
            merged: false,
            merge_commit_sha: null,
            head: { sha: "h" },
            base: { ref: "main", sha: "b" },
          },
        }),
      ),
    ).toBe(false);
  });

  it("returns false for a non-closed action (e.g. opened, reopened)", () => {
    expect(isMergedPullRequestClose(makeEvent({ action: "opened" }))).toBe(
      false,
    );
    expect(isMergedPullRequestClose(makeEvent({ action: "reopened" }))).toBe(
      false,
    );
  });
});

describe("isMergedIntoDefaultBranch", () => {
  it("returns true when the PR base ref equals the repo default branch", () => {
    // n3ary org's default branch is `main`.
    expect(
      isMergedIntoDefaultBranch(
        makeEvent({
          pull_request: {
            merged: true,
            merge_commit_sha: "x",
            head: { sha: "h" },
            base: { ref: "main", sha: "b" },
          },
          repository: {
            name: "r",
            full_name: "n3ary/r",
            owner: { login: "n3ary" },
            default_branch: "main",
          },
        }),
      ),
    ).toBe(true);
  });

  it("returns true when the default branch is non-`main` and matches the base", () => {
    // Some repos use a non-`main` default (e.g. `master`, `trunk`).
    // The predicate must be config-driven, not hard-coded to "main".
    expect(
      isMergedIntoDefaultBranch(
        makeEvent({
          pull_request: {
            merged: true,
            merge_commit_sha: "x",
            head: { sha: "h" },
            base: { ref: "trunk", sha: "b" },
          },
          repository: {
            name: "r",
            full_name: "org/r",
            owner: { login: "org" },
            default_branch: "trunk",
          },
        }),
      ),
    ).toBe(true);
  });

  it("returns false when the PR was merged into a feature branch", () => {
    // Regression for n3ary/gtfs-adapters PR #78 (2026-07-12):
    // merged into feat/issue-26-tags-networks, default_branch = main.
    expect(
      isMergedIntoDefaultBranch(
        makeEvent({
          pull_request: {
            merged: true,
            merge_commit_sha: "f500bed",
            head: { sha: "h" },
            base: { ref: "feat/issue-26-tags-networks", sha: "b" },
          },
          repository: {
            name: "gtfs-adapters",
            full_name: "n3ary/gtfs-adapters",
            owner: { login: "n3ary" },
            default_branch: "main",
          },
        }),
      ),
    ).toBe(false);
  });

  it("returns false for a merge into a stacked-PR base (epic branch)", () => {
    // Same shape as the incident, different ref name. Catches
    // any case where the user is using long-lived feature
    // branches as "epic" bases for stacked PRs.
    expect(
      isMergedIntoDefaultBranch(
        makeEvent({
          pull_request: {
            merged: true,
            merge_commit_sha: "x",
            head: { sha: "h" },
            base: { ref: "epic/q3-platform-rewrite", sha: "b" },
          },
        }),
      ),
    ).toBe(false);
  });

  it("returns false for a merge into a release branch", () => {
    // release/X branches are common in some workflows. The bot
    // must not bump when PRs are merged into them.
    expect(
      isMergedIntoDefaultBranch(
        makeEvent({
          pull_request: {
            merged: true,
            merge_commit_sha: "x",
            head: { sha: "h" },
            base: { ref: "release/2026-q3", sha: "b" },
          },
        }),
      ),
    ).toBe(false);
  });

  it("returns false when the event has no pull_request (defensive)", () => {
    // The predicate is called only after isMergedPullRequestClose,
    // which already requires a merged PR. But the optional-chaining
    // is still useful as a defense-in-depth contract.
    const event = makeEvent();
    (event as { pull_request: unknown }).pull_request = undefined;
    expect(isMergedIntoDefaultBranch(event)).toBe(false);
  });
});
