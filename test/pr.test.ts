// Tests for the release-branch ref update.
//
// The bot creates a `release/calver-<version>` branch per release
// and points it at the bot's release commit. The branch name is
// deterministic (it encodes the version), so a second release run
// can land on a branch that already exists from a previous run --
// possibly at a commit that is NOT a fast-forward from the new
// merge SHA. A non-fast-forward `updateRef` with `force: false`
// returns 422 and the bot 500s, leaving the next webhook delivery
// to retry against the same broken state.
//
// Concrete incident (2026-07-12, n3ary/gtfs-adapters): PR #78
// merged into a feature branch, the bot opened PR #79 with a
// release branch pointed at the feature-branch tip. The user
// closed PR #79. PR #77 (the same feature branch) was then
// squash-merged to main. The bot's next run tried to reuse the
// release branch; the tip was not an ancestor of the new merge
// SHA; `updateRef` with `force: false` failed; the bot 500'd
// silently; no release PR was opened.
//
// The fix is `force: true` in the `updateRef` call. This test
// pins that behavior so the bug cannot regress silently.

import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "octokit";
import { updateReleaseBranchRef } from "../src/pr.ts";

interface UpdateRefCall {
  owner: string;
  repo: string;
  ref: string;
  sha: string;
  force: boolean;
}

function makeMockOctokit(capture: { calls: UpdateRefCall[] }): Octokit {
  return {
    rest: {
      git: {
        updateRef: vi.fn(async (args: UpdateRefCall) => {
          capture.calls.push(args);
          return { data: { object: { sha: args.sha } } };
        }) as unknown as Octokit["rest"]["git"]["updateRef"],
      },
    },
  } as unknown as Octokit;
}

describe("updateReleaseBranchRef", () => {
  it("calls updateRef with force: true", async () => {
    // Regression for the 2026-07-12 n3ary/gtfs-adapters incident.
    // The default `force: false` would 422 when the existing
    // branch tip is a non-ancestor of the new commit. `force: true`
    // allows the bot to always complete a release run.
    const capture: { calls: UpdateRefCall[] } = { calls: [] };
    const octokit = makeMockOctokit(capture);

    await updateReleaseBranchRef(
      octokit,
      "n3ary",
      "gtfs-adapters",
      "release/calver-0.3.11",
      "new-commit-sha",
    );

    expect(capture.calls).toHaveLength(1);
    const args = capture.calls[0];
    expect(args.owner).toBe("n3ary");
    expect(args.repo).toBe("gtfs-adapters");
    expect(args.ref).toBe("heads/release/calver-0.3.11");
    expect(args.sha).toBe("new-commit-sha");
    expect(args.force).toBe(true);
  });

  it("uses force: true even when the branch name suggests a fast-forward is expected", async () => {
    // The default mental model for `updateRef` is "fast-forward
    // only". A maintainer reading this code might think "we
    // always want fast-forward here" and remove the `force: true`.
    // This test pins `force: true` explicitly so a future
    // cleanup cannot silently regress to `force: false`.
    const capture: { calls: UpdateRefCall[] } = { calls: [] };
    const octokit = makeMockOctokit(capture);

    await updateReleaseBranchRef(
      octokit,
      "n3ary",
      "gtfs-adapters",
      "release/calver-26.7.12-1",
      "another-new-sha",
    );

    expect(capture.calls[0].force).toBe(true);
  });
});
