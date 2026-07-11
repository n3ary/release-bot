// Discover package.json files, compute the next CalVer version,
// and open a pull request with the version bump against main.
//
// This is the PR-based release flow (the bot is a contributor,
// not a direct pusher). Works on the free GitHub plan because
// it doesn't need bypass-actor permission -- the PR goes through
// the normal review + checks path. Auto-merge is enabled on the
// PR so the version lands on main as soon as the required status
// checks pass (usually within seconds; with 0 required reviews,
// no human click is needed).
//
// Two skip rules apply, per file:
//   1. "no library changes" - the merge did not touch any file in
//      the package's directory (including the package.json itself).
//      A workflow-only or docs-only PR bumps nothing.
//   2. "skip-if-already-touched" - the merge commit's version
//      differs from the parent's, meaning the dev manually edited
//      the version. The bot no-ops on that file; the dev's edit
//      wins.
//
// Both skip reasons are reported in the log and the PR body, so
// the reason for a no-op is always visible.

import { Octokit } from "octokit";
import { DateTime } from "luxon";
import { nextCalVer } from "./bump.ts";
import {
  createBranch,
  enableAutoMerge,
  findOpenReleasePR,
  openPullRequest,
  type PullRequestResult,
} from "./pr.ts";
import type { Env, PackageJsonFile } from "./types.ts";

export interface ReleaseResult {
  bumped: PackageJsonFile[];
  skipped: string[];
  pr: PullRequestResult | null;
}

/**
 * Determine whether a given package.json file is "touched" by a set
 * of changed files in the merge commit.
 *
 * A package is touched if any changed file is in or under the
 * package's directory. For the root `package.json` (no directory
 * prefix), the only change that touches it is a modification of the
 * root `package.json` itself - this prevents the root from being
 * bumped on every workflow / docs / config change that lives at the
 * repo root.
 *
 * Examples (for the gtfs-publisher monorepo):
 *   - "apps/gtfs-rt/src/foo.ts"   -> touches "apps/gtfs-rt/package.json"
 *   - "apps/gtfs-rt/package.json" -> touches "apps/gtfs-rt/package.json"
 *   - "libs/spec/package.json"    -> touches "libs/spec/package.json"
 *   - ".github/workflows/x.yml"   -> touches nothing
 *   - "package.json" (modified)   -> touches the root "package.json"
 *   - "README.md"                 -> touches nothing
 *
 * Exported for unit testing.
 */
export function isPackageTouched(
  packageJsonPath: string,
  changedFiles: readonly string[],
): boolean {
  if (packageJsonPath === "package.json") {
    return changedFiles.includes("package.json");
  }
  const dir = packageJsonPath.replace(/\/package\.json$/, "");
  return changedFiles.some(
    (f) => f === dir || f.startsWith(dir + "/"),
  );
}

/**
 * Fetch the list of files changed between two commits via the
 * GitHub compare API. Returns paths (forward-slash, repo-relative).
 *
 * Empty on API error (caller treats as "no changes", so the bot
 * no-ops). A hard error would block releases for monorepos with
 * huge diffs; better to skip than to fail.
 */
async function getChangedFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<string[]> {
  try {
    const { data } = await octokit.rest.repos.compareCommits({
      owner,
      repo,
      base,
      head,
    });
    return (data.files ?? [])
      .map((f) => f.filename)
      .filter((f): f is string => typeof f === "string");
  } catch {
    return [];
  }
}

export async function discoverAndOpenPR(
  octokit: Octokit,
  owner: string,
  repo: string,
  defaultBranch: string,
  mergeSha: string,
  env: Env,
  log: (msg: string) => void,
): Promise<ReleaseResult> {
  // 1. Idempotency: if an open release/calver-* PR already exists,
  //    no-op. Avoids spamming PRs if multiple webhooks fire for the
  //    same merge, or if the bot is retried after a partial failure.
  const existing = await findOpenReleasePR(octokit, owner, repo);
  if (existing) {
    log(
      `Idempotency: open release PR #${existing.number} (${
        existing.head_ref
      }) already exists; no-op`,
    );
    return { bumped: [], skipped: [], pr: existing };
  }

  // 2. Resolve the merge commit's parent (HEAD~1) for the
  //    skip-if-already-touched comparison.
  const { data: mergeCommit } = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: mergeSha,
  });
  const parentSha = mergeCommit.parents[0]?.sha;
  if (!parentSha) {
    throw new Error(`Merge commit ${mergeSha} has no parent`);
  }

  // 3. Discover all package.json files in the tree.
  const { data: tree } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: mergeSha,
    recursive: "true",
  });
  const packagePaths = tree.tree
    .filter((entry) =>
      entry.type === "blob" &&
      entry.path !== undefined &&
      (entry.path === "package.json" || entry.path.endsWith("/package.json"))
    )
    .map((entry) => entry.path as string);

  if (packagePaths.length === 0) {
    log("No package.json files found in tree; nothing to bump");
    return { bumped: [], skipped: [], pr: null };
  }
  log(`Found ${packagePaths.length} package.json files`);

  // 4. Fetch the list of files changed in the merge commit. Used
  //    to filter down to "touched" packages only - a workflow-only
  //    PR should not bump library versions.
  const changedFiles = await getChangedFiles(
    octokit,
    owner,
    repo,
    parentSha,
    mergeSha,
  );
  log(`Merge commit changed ${changedFiles.length} files`);

  // 5. For each package.json, check both skip rules:
  //    a. "no library changes" - no changed file is under the
  //       package's directory. A docs-only / workflow-only PR
  //       should not bump anything.
  //    b. "skip-if-already-touched" - the merge commit already
  //       changed the version (dev's manual edit). Bot no-ops.
  const skipped: string[] = [];
  const toBump: { path: string; currentVersion: string; file: PackageJsonFile }[] = [];

  for (const path of packagePaths) {
    if (!isPackageTouched(path, changedFiles)) {
      log(`Skipping ${path}: no files changed in this package`);
      skipped.push(path);
      continue;
    }
    const headFile = await readPackageJsonAt(octokit, owner, repo, path, mergeSha);
    const parentFile = await readPackageJsonAt(octokit, owner, repo, path, parentSha);
    if (!headFile || !parentFile) {
      log(`Skipping ${path}: could not read at HEAD or HEAD~1`);
      skipped.push(path);
      continue;
    }
    if (headFile.version !== parentFile.version) {
      log(
        `Skipping ${path}: merge already changed version ` +
          `(${parentFile.version} -> ${headFile.version})`,
      );
      skipped.push(path);
      continue;
    }
    toBump.push({ path, currentVersion: headFile.version, file: headFile });
  }

  if (toBump.length === 0) {
    log("No files to bump (all skipped)");
    return { bumped: [], skipped, pr: null };
  }

  // 6. Compute the next CalVer for each file. All files share the
  //    same "now" so they're consistent on the same release.
  const now = DateTime.utc();
  const bumped: PackageJsonFile[] = [];
  for (const { path, currentVersion, file } of toBump) {
    const next = nextCalVer(currentVersion, now, env.TIMEZONE);
    log(`Bumping ${path}: ${currentVersion} -> ${next}`);
    const parsed = JSON.parse(file.content) as Record<string, unknown>;
    parsed.version = next;
    const newContent = JSON.stringify(parsed, null, 2) + "\n";
    bumped.push({ path, content: newContent, version: next });
  }

  // 7. Create the branch. Branch name encodes the next version so
  //    it's obvious in the PR list. If the branch already exists
  //    (from a previous failed attempt), use the existing one.
  const primaryVersion = bumped[0].version;
  const branchName = `release/calver-${primaryVersion}`;
  const branchResult = await createBranch(
    octokit,
    owner,
    repo,
    branchName,
    mergeSha,
  );
  log(
    `Branch ${branchName}: ${branchResult === "created" ? "created" : "already exists, using it"}`,
  );

  // 8. Create the commit with all bumped files. Uses the Git Data
  //    API: create blobs for the new content, build a tree based
  //    on the merge commit's tree, create a commit on the new
  //    branch, update the ref.
  //
  //    Note: when `base_tree` is set, GitHub preserves the base
  //    tree's entries. We only need to pass the entries that
  //    change (the bumped package.json blobs). Earlier code tried
  //    to pass the entire filtered base tree back, but the
  //    recursive tree returns mixed `blob` and `tree` entries and
  //    hard-coding `type: "tree"` for all of them caused GitHub
  //    to reject blob shas as "not a valid tree".
  const updatedBlobs = await Promise.all(
    bumped.map(async (file) => {
      const { data: blob } = await octokit.rest.git.createBlob({
        owner,
        repo,
        content: file.content,
        encoding: "utf-8",
      });
      return {
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.sha,
      };
    }),
  );

  const { data: newTree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: mergeCommit.tree.sha,
    tree: updatedBlobs,
  });

  const commitMessage = bumped.length === 1
    ? `chore(release): ${bumped[0].version}`
    : `chore(release): ${bumped.map((f) => f.version).join(", ")}`;

  const { data: newCommit } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: commitMessage,
    tree: newTree.sha,
    parents: [mergeSha], // The branch points at mergeSha; this commit's parent is mergeSha.
  });

  // 9. Update the new branch's ref to point at the new commit.
  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branchName}`,
    sha: newCommit.sha,
    force: false,
  });
  log(`Committed ${newCommit.sha} to ${branchName}`);

  // 10. Open the PR.
  const prTitle = bumped.length === 1
    ? `chore(release): ${bumped[0].version}`
    : `chore(release): ${bumped.map((f) => f.version).join(", ")}`;

  const prBody = renderPrBody(bumped, skipped, owner, repo, mergeSha);

  const pr = await openPullRequest(
    octokit,
    owner,
    repo,
    branchName,
    defaultBranch,
    prTitle,
    prBody,
  );
  log(`Opened PR #${pr.number}: ${pr.html_url}`);

  // 11. Enable auto-merge. The PR merges automatically when the
  //     required status checks pass. With 0 required reviews, this
  //     is usually within seconds.
  try {
    await enableAutoMerge(octokit, owner, repo, pr.number, pr.node_id, "SQUASH");
    log(`Enabled auto-merge on PR #${pr.number}`);
  } catch (err) {
    // Auto-merge enablement is best-effort. If it fails, the PR
    // is still open and the user can merge it manually. Log and
    // continue.
    log(
      `Failed to enable auto-merge on PR #${pr.number}: ${
        (err as Error).message
      }. PR is open and can be merged manually.`,
    );
  }

  return { bumped, skipped, pr };
}

function renderPrBody(
  bumped: PackageJsonFile[],
  skipped: string[],
  owner: string,
  repo: string,
  mergeSha: string,
): string {
  const lines: string[] = [];
  lines.push("## Version bump");
  lines.push("");
  lines.push("This PR was opened by the n3ary-release-bot to bump the version on `main`.");
  lines.push("");
  if (bumped.length === 1) {
    lines.push(`Bumps **${bumped[0].path}** to \`${bumped[0].version}\`.`);
  } else {
    lines.push(`Bumps ${bumped.length} package.json files:`);
    for (const file of bumped) {
      lines.push(`- \`${file.path}\` -> \`${file.version}\``);
    }
  }
  if (skipped.length > 0) {
    lines.push("");
    lines.push("Skipped:");
    for (const path of skipped) {
      lines.push(`- \`${path}\``);
    }
  }
  lines.push("");
  lines.push("## How it merges");
  lines.push("");
  lines.push("Auto-merge is enabled. The PR will merge automatically once the required status checks pass. With 0 required reviews, this is usually within seconds.");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    `Triggered by merge [${mergeSha.slice(0, 7)}](https://github.com/${owner}/${repo}/commit/${mergeSha}) on the n3ary-release-bot.`,
  );
  return lines.join("\n");
}

async function readPackageJsonAt(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<PackageJsonFile | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });
    if (Array.isArray(data) || data.type !== "file") return null;
    if (data.encoding !== "base64" || typeof data.content !== "string") return null;

    const content = atob(data.content.replace(/\n/g, ""));
    let parsed: { version?: string };
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }
    if (typeof parsed.version !== "string") return null;

    return { path, content, version: parsed.version };
  } catch (err: unknown) {
    if (err && typeof err === "object" && "status" in err && err.status === 404) {
      return null;
    }
    throw err;
  }
}
