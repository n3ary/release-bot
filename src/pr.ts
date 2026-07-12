// Pull request operations for the n3ary release bot.
//
// The bot creates a branch, commits the version bump, opens a PR
// against main, and enables auto-merge. The PR is the artifact
// the human reviews (or ignores) -- the bot itself is just a
// contributor. This is the PR-based flow that works on the free
// GitHub plan (no bypass-actor needed, no Team upgrade needed).

import { Octokit } from "octokit";

export interface PullRequestResult {
  number: number;
  html_url: string;
  node_id: string;
  head_ref: string;
}

/**
 * Create a new branch at the given SHA. The branch is the base
 * for the version-bump commit.
 *
 * Idempotent: if the branch already exists (e.g. from a previous
 * failed attempt), returns "exists" instead of erroring. The
 * caller can continue with the commit step; the existing branch's
 * tip should be the same merge SHA from the previous attempt.
 */
export async function createBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  branchName: string,
  fromSha: string,
): Promise<"created" | "exists"> {
  try {
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: fromSha,
    });
    return "created";
  } catch (err) {
    if (
      err && typeof err === "object" && "status" in err &&
      (err as { status: number }).status === 422
    ) {
      // "Reference already exists" -- a previous attempt created
      // the branch. We'll commit to the existing ref.
      return "exists";
    }
    throw err;
  }
}

/**
 * Check whether there's already an open release-bot PR in this
 * repo. Used for idempotency: if a previous webhook run already
 * created a release/calver-* PR and it's still open, no-op.
 */
export async function findOpenReleasePR(
  octokit: Octokit,
  owner: string,
  repo: string,
  branchPrefix: string = "release/calver-",
): Promise<PullRequestResult | null> {
  const { data: prs } = await octokit.rest.pulls.list({
    owner,
    repo,
    state: "open",
    per_page: 100,
  });
  for (const pr of prs) {
    if (pr.head.ref.startsWith(branchPrefix)) {
      return {
        number: pr.number,
        html_url: pr.html_url,
        node_id: pr.node_id,
        head_ref: pr.head.ref,
      };
    }
  }
  return null;
}

/**
 * Open a pull request. The head is the bot's branch (just created),
 * the base is the default branch (main).
 */
export async function openPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  head: string,
  base: string,
  title: string,
  body: string,
): Promise<PullRequestResult> {
  const { data } = await octokit.rest.pulls.create({
    owner,
    repo,
    head,
    base,
    title,
    body,
  });
  return {
    number: data.number,
    html_url: data.html_url,
    node_id: data.node_id,
    head_ref: data.head.ref,
  };
}

/**
 * Update the release branch's ref to point at the bot's new
 * release commit.
 *
 * Uses `force: true` so the bot can always complete a release
 * run even when a previous run left a stale branch at a
 * non-ancestor commit. The `createBranch` helper is idempotent
 * (returns "exists" instead of erroring on 422), but the
 * subsequent `updateRef` is NOT idempotent on its own -- a
 * non-fast-forward with `force: false` would 422 and the bot
 * would 500. See the 2026-07-12 n3ary/gtfs-adapters incident in
 * commit.ts for the full chain of events.
 *
 * The bot is the sole writer of `release/calver-*` branches, so
 * discarding a stale previous-run tip is safe. The semantic
 * guarantee is: "the release branch always points at the bot's
 * latest release commit".
 *
 * Exported for unit testing.
 */
export async function updateReleaseBranchRef(
  octokit: Octokit,
  owner: string,
  repo: string,
  branchName: string,
  newCommitSha: string,
): Promise<void> {
  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branchName}`,
    sha: newCommitSha,
    force: true,
  });
}

/**
 * Enable auto-merge on a pull request via the GraphQL API.
 * The PR's required status checks (if any) must pass before the
 * PR auto-merges. With 0 required reviews, auto-merge fires as
 * soon as the checks pass -- usually within seconds.
 *
 * Requires the GitHub App to have `pull_requests: write`
 * permission.
 */
export async function enableAutoMerge(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  nodeId: string,
  mergeMethod: "MERGE" | "SQUASH" | "REBASE" = "SQUASH",
): Promise<void> {
  const query = `
    mutation EnableAutoMerge($prId: ID!, $mergeMethod: PullRequestMergeMethod!) {
      enablePullRequestAutoMerge(input: {
        pullRequestId: $prId,
        mergeMethod: $mergeMethod
      }) {
        pullRequest { number }
      }
    }
  `;
  await octokit.graphql(query, {
    prId: nodeId,
    mergeMethod,
  });
  // nodeId is the parameter; owner/repo/prNumber are kept in the
  // signature for symmetry with the other helpers and for future
  // log lines. The GraphQL call only uses the node ID.
  void owner;
  void repo;
  void prNumber;
}
