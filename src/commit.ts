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
//      Pure no-op: file is not included in the bot's release commit.
//   2. "skip-if-already-touched" - the merge commit's version
//      differs from the parent's, meaning the dev manually edited
//      the version. The bot's `version` field for that file is a
//      no-op (the dev's edit wins). BUT the file is still included
//      in the bot's release commit with a touch marker (see
//      `withSkipMarker`) so the consumer's publish workflow's
//      paths filter matches and the dev's version gets published.
//
// The root package.json is NOT subject to rule #1 -- the bot's
// contract (see docs/standards/org-automation.md) is to bump the
// root version on every merged PR that didn't already touch the
// version. Workflow / docs / config changes ARE user-facing (they
// ship to production) and DO warrant a version bump. Rule #1 only
// narrows the bump to the right sub-package in a monorepo.
//
// Both skip reasons are reported in the log and the PR body, so
// the reason for a no-op is always visible. Rule #2's "touched
// for publish trigger" is reported in the PR body as a separate
// "Touched" section so the human reviewer can see the dev's
// version was preserved (not silently overwritten by the bot).

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
  /**
   * Files the dev's merge already bumped (skip-if-already-touched).
   * The bot did NOT change the version on these -- the dev's edit
   * wins. But the bot DID include them in the release commit with
   * a touch marker (see `withSkipMarker`) so the consumer's
   * publish workflow's paths filter matches and the dev's version
   * gets published to GH Packages.
   *
   * Empty when the merge did not manually bump any package.json
   * (every file went through the normal "bot bumps version" path).
   */
  touched: PackageJsonFile[];
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
    return { bumped: [], touched: [], skipped: [], pr: existing };
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
    return { bumped: [], touched: [], skipped: [], pr: null };
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
  //       should not bump anything. Pure no-op.
  //    b. "skip-if-already-touched" - the merge commit already
  //       changed the version (dev's manual edit). Bot does NOT
  //       bump the version (dev wins), but DOES include the file
  //       in the release commit with a touch marker so the
  //       consumer's publish workflow's paths filter matches and
  //       the dev's version gets published to GH Packages.
  //       Without this touch, a manual version bump on a
  //       library would land on main but never publish (the
  //       bot's release commit only touches the files it bumps,
  //       and the publish workflow's paths filter would exclude
  //       the commit entirely).
  const skipped: string[] = [];
  const touched: PackageJsonFile[] = [];
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
          `(${parentFile.version} -> ${headFile.version}); ` +
          `touching for publish trigger`,
      );
      skipped.push(path);
      touched.push({
        path,
        content: withSkipMarker(
          headFile.content,
          parentFile.version,
          headFile.version,
          mergeSha,
          new Date().toISOString(),
        ),
        // The dev's version is what gets published; the touch
        // marker is metadata only. Reporting the dev's version
        // here keeps the PR body's per-file summary truthful.
        version: headFile.version,
      });
      continue;
    }
    toBump.push({ path, currentVersion: headFile.version, file: headFile });
  }

  if (toBump.length === 0 && touched.length === 0) {
    log("No files to bump or touch (all skipped)");
    return { bumped: [], touched, skipped, pr: null };
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
  //
  //    Edge case: if every candidate was either a calver-shaped
  //    library (no next version computable) OR a touch (no version
  //    bump), `bumped` ends up empty. In that case we bail -- the
  //    "no real release happened" case. The touch will be
  //    re-detected on the next merge that actually bumps a version.
  if (bumped.length === 0) {
    log(
      "No files to bump after the bump loop (all calver-shaped " +
        "or all touched-only); not opening a release PR",
    );
    return { bumped: [], touched, skipped, pr: null };
  }

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

  // 8. Create the commit with all bumped + touched files. Uses the
  //    Git Data API: create blobs for the new content, build a
  //    tree based on the merge commit's tree, create a commit on
  //    the new branch, update the ref.
  //
  //    `bumped` = files the bot actually changed the version on.
  //    `touched` = files the bot didn't bump (dev's edit wins)
  //    but DID include in the commit so the consumer's publish
  //    workflow's paths filter matches. Without the touched files
  //    in the commit, a dev's manual version bump would land on
  //    main but never get published to GH Packages (the bot's
  //    release commit wouldn't touch the file, so the publish
  //    workflow's paths filter would exclude the push entirely).
  //
  //    Note: when `base_tree` is set, GitHub preserves the base
  //    tree's entries. We only need to pass the entries that
  //    change (the bumped + touched package.json blobs). Earlier
  //    code tried to pass the entire filtered base tree back, but
  //    the recursive tree returns mixed `blob` and `tree` entries
  //    and hard-coding `type: "tree"` for all of them caused
  //    GitHub to reject blob shas as "not a valid tree".
  const allChanged = [...bumped, ...touched];
  const updatedBlobs = await Promise.all(
    allChanged.map(async (file) => {
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

  const prBody = renderPrBody(bumped, touched, skipped, owner, repo, mergeSha);

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

  return { bumped, skipped, touched, pr };
}

/**
 * Decode a base64 string from the GitHub `getContent` API as
 * a UTF-8 string. `atob()` alone produces a "binary string"
 * whose code points are raw byte values (0x80, 0x94, etc.),
 * not valid UTF-8 code points. Passing that to `JSON.parse`
 * would preserve the raw code points as literal characters,
 * and re-stringifying + UTF-8 encoding the result produces
 * mojibake (`Ã¢ÂÂ` for a single em-dash). Decoding the
 * bytes explicitly with `TextDecoder("utf-8")` groups the
 * multi-byte sequences into proper code points.
 *
 * Exported for unit testing.
 */
export function decodeBase64Utf8(b64: string): string {
  return new TextDecoder("utf-8").decode(
    Uint8Array.from(
      atob(b64.replace(/\n/g, "")),
      (c) => c.charCodeAt(0),
    ),
  );
}

/**
 * Touch a package.json content with a skip-marker field so the
 * consumer's publish workflow's paths filter matches and the
 * dev's manual version bump gets published to GH Packages.
 *
 * Why a field, not a whitespace tweak: the file is usually
 * already canonical (2-space indent, trailing newline) by the
 * time the bot touches it, so a re-serialization is a no-op.
 * The marker field is a guaranteed real content change.
 *
 * Why a top-level field, not a comment or sidecar file: JSON
 * has no comments, and a sidecar file would be ignored by the
 * publish workflow's paths filter (which only matches files
 * inside the package's directory like `package.json`, `src/**`,
 * `tsconfig*.json`).
 *
 * Why `_n3ary_release_bot_skip` (underscore prefix): npm and
 * pnpm ignore unknown fields, but they recognize the
 * underscore-prefix convention as "private/internal". A future
 * dev can grep `_n3ary_release_bot_skip` to find every file the
 * bot has ever touched-on-skip and audit/clean them up.
 *
 * `at` is the bot's run time. On every release that re-touches
 * the file, the timestamp is updated, so the diff is real and
 * the file appears in subsequent bot release commits (so the
 * publish workflow keeps firing for libraries that the dev
 * keeps manually bumping).
 *
 * Exported for unit testing.
 */
export function withSkipMarker(
  content: string,
  previousVersion: string,
  currentVersion: string,
  mergeSha: string,
  at: string,
): string {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  parsed._n3ary_release_bot_skip = {
    reason: "merge-changed-version",
    previous_version: previousVersion,
    current_version: currentVersion,
    merge_sha: mergeSha,
    at,
  };
  return JSON.stringify(parsed, null, 2) + "\n";
}

function renderPrBody(
  bumped: PackageJsonFile[],
  touched: PackageJsonFile[],
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
  if (touched.length > 0) {
    lines.push("");
    lines.push(
      "Touched (version already bumped by the merge; included for the publish workflow's paths filter):",
    );
    for (const file of touched) {
      lines.push(`- \`${file.path}\` -> \`${file.version}\` (dev's bump)`);
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

    const content = decodeBase64Utf8(data.content);
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
