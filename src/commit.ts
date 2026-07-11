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
// Skip rules, per file:
//   1. "no library changes" (sub-packages only) - the merge did
//      not touch any file in the sub-package's directory. A
//      workflow-only or docs-only PR bumps nothing in a monorepo.
//   2. "skip-if-already-touched" - the merge commit's version
//      differs from the parent's, meaning the dev manually edited
//      the version. The bot no-ops on that file; the dev's edit
//      wins.
//
// The root package.json is NOT subject to rule #1 -- the bot's
// contract (see docs/standards/org-automation.md) is to bump the
// root version on every merged PR that didn't already touch the
// version. Workflow / docs / config changes ARE user-facing (they
// ship to production) and DO warrant a version bump. Rule #1 only
// narrows the bump to the right sub-package in a monorepo.
//
// Both skip reasons are reported in the log and the PR body, so
// the reason for a no-op is always visible.

import { Octokit } from "octokit";
import { DateTime } from "luxon";
import { nextCalVer, nextSemVer } from "./bump.ts";
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
 * Determine whether a given SUB-package's directory was touched by
 * a set of changed files in the merge commit. The root `package.json`
 * is NOT handled here -- it is always eligible to bump (per the
 * bot's contract in org-automation.md); see `shouldBumpPackage` for
 * the caller-level policy that combines the root rule with this
 * sub-package check.
 *
 * A sub-package is touched if any changed file is in or under the
 * sub-package's directory. Sibling sub-packages with similar
 * directory names are not matched (e.g. `apps/gtfs-rt-old/...` does
 * not touch `apps/gtfs-rt/package.json`).
 *
 * Examples (for the gtfs-publisher monorepo):
 *   - "apps/gtfs-rt/src/foo.ts"   -> touches "apps/gtfs-rt/package.json"
 *   - "apps/gtfs-rt/package.json" -> touches "apps/gtfs-rt/package.json"
 *   - "libs/spec/package.json"    -> touches "libs/spec/package.json"
 *   - ".github/workflows/x.yml"   -> touches nothing
 *   - "README.md"                 -> touches nothing
 *
 * Exported for unit testing.
 */
export function isPackageTouched(
  packageJsonPath: string,
  changedFiles: readonly string[],
): boolean {
  // The root `package.json` has no directory prefix. This function
  // is the sub-package rule and explicitly does NOT take a position
  // on the root -- callers route the root through shouldBumpPackage.
  // Returning false here keeps the function "no opinion on root"
  // instead of accidentally matching `package.json === dir` when
  // the path collapses to itself.
  if (packageJsonPath === "package.json") return false;
  const dir = packageJsonPath.replace(/\/package\.json$/, "");
  return changedFiles.some(
    (f) => f === dir || f.startsWith(dir + "/"),
  );
}

/**
 * Caller-level policy: should this package be bumped?
 *
 * - The root `package.json` is ALWAYS bumped (unless the merge
 *   already touched the version -- that skip rule lives in the
 *   caller's `headFile.version !== parentFile.version` check).
 *   Workflow / docs / config changes ship to production and DO
 *   warrant a root version bump. See org-automation.md.
 * - Sub-packages follow `isPackageTouched`: only bump a sub-package
 *   whose directory the merge actually touched.
 *
 * Exported for unit testing the root-bypass regression.
 */
export function shouldBumpPackage(
  packageJsonPath: string,
  changedFiles: readonly string[],
): boolean {
  if (packageJsonPath === "package.json") return true;
  return isPackageTouched(packageJsonPath, changedFiles);
}

/**
 * Determine whether a package.json is "private" (an app, deployed
 * but not published to a registry) or a "library" (published to a
 * registry and consumed by other packages). Per the bot's
 * contract, private packages use CalVer (YY.M.D-N) and library
 * packages use semver (MAJOR.MINOR.PATCH).
 *
 * The check is just on the parsed `private` field. Defaults to
 * `false` (library) when the field is missing, which matches npm's
 * default behaviour: a package.json without `private: true` is
 * publishable.
 *
 * On a JSON parse error, also default to `false` (library). The
 * caller's existing skip rules will no-op on unparseable package
 * metadata anyway; "library" is the safer default because it
 * keeps semver's stricter ordering (vs. calver's monotonic-day
 * counter) which is more conservative for downstream consumers.
 */
export function isPrivatePackage(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { private?: unknown };
    return parsed.private === true;
  } catch {
    return false;
  }
}

/**
 * Which bump scheme applies to a given package? Returns
 * `"calver"` for apps (private: true) and `"semver"` for
 * libraries (the default). Used to pick between nextCalVer and
 * nextSemVer in the bump loop.
 */
export function bumpSchemeFor(content: string): "calver" | "semver" {
  return isPrivatePackage(content) ? "calver" : "semver";
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
    if (!shouldBumpPackage(path, changedFiles)) {
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

  // 6. Compute the next version for each file. The scheme is
  //    picked per-file: private packages (apps) get CalVer,
  //    non-private packages (libraries) get semver. Libraries
  //    on a calver-shaped version (e.g. `26.7.11-2`) are
  //    skipped with a clear log line so a human can do the
  //    one-time cutover to a clean `MAJOR.MINOR.PATCH` -- the
  //    bot never produces the hybrid "calver-as-semver" value
  //    that a naive drop-prerelease would yield.
  const now = DateTime.utc();
  const bumped: PackageJsonFile[] = [];
  for (const { path, currentVersion, file } of toBump) {
    const scheme = bumpSchemeFor(file.content);
    const next = scheme === "calver"
      ? nextCalVer(currentVersion, now, env.TIMEZONE)
      : nextSemVer(currentVersion);

    // nextSemVer returns null when the current version is a
    // calver-shaped value (a library that was previously on
    // the calver scheme). Skip the file with a clear log line;
    // the commit message + PR body will list the skipped path
    // so the human reviewer can do the one-time cutover.
    if (next === null) {
      log(
        `Skipping ${path}: current version ${currentVersion} is ` +
          `calver-shaped; manual cutover to semver required before ` +
          `the next release`,
      );
      skipped.push(path);
      continue;
    }

    log(`Bumping ${path}: ${currentVersion} -> ${next} (${scheme})`);

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
