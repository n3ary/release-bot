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
 */
export async function createBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  branchName: string,
  fromSha: string,
): Promise<void> {
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: fromSha,
  });
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
