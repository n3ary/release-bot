// Read and bump the repo's package.json files via the GitHub API.
//
// Strategy:
//   1. Find every package.json under the repo tree.
//   2. For each, read its content at the current main tip and at the
//      merge commit's parent. If the versions differ, the merge commit
//      already changed the version (dev's manual edit wins) — skip.
//   3. For each "needs bump" file, compute the next CalVer and
//      prepare the new content.
//   4. Create a single commit via the Git Data API that updates all
//      the bumped files at once.
//   5. Push the commit by updating the main branch ref.
//
// The Git Data API flow (vs the simpler Contents API) lets us bump
// multiple package.json files atomically in one commit. The Contents
// API would create one commit per file, which is wrong for
// multi-package repos (gtfs-publisher has libs/spec, gtfs-adapters
// has adapters/*).

import { Octokit } from "octokit";
import { DateTime } from "luxon";
import { nextCalVer, parseCalVer } from "./bump.ts";
import type { Env, PackageJsonDiff, PackageJsonFile } from "./types.ts";

export async function discoverAndBump(
  octokit: Octokit,
  owner: string,
  repo: string,
  defaultBranch: string,
  mergeSha: string,
  env: Env,
  log: (msg: string) => void,
): Promise<{ bumped: PackageJsonFile[]; skipped: PackageJsonDiff[] }> {
  // 1. Resolve main tip and the merge commit's parent.
  const { data: mainRef } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${defaultBranch}`,
  });
  const mainSha = mainRef.object.sha;

  const { data: mergeCommit } = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: mergeSha,
  });
  const parentSha = mergeCommit.parents[0]?.sha;
  if (!parentSha) {
    throw new Error(`Merge commit ${mergeSha} has no parent`);
  }

  // 2. Recursively list the tree at the merge commit. Find package.json files.
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
    return { bumped: [], skipped: [] };
  }

  log(`Found ${packagePaths.length} package.json files: ${packagePaths.join(", ")}`);

  // 3. For each package.json, read the version at HEAD and HEAD~1.
  //    If they differ, the merge already touched the version -- skip.
  const skipped: PackageJsonDiff[] = [];
  const toBump: { path: string; currentVersion: string; file: PackageJsonFile }[] = [];

  for (const path of packagePaths) {
    const headFile = await readPackageJsonAt(octokit, owner, repo, path, mergeSha);
    const parentFile = await readPackageJsonAt(octokit, owner, repo, path, parentSha);
    if (!headFile || !parentFile) {
      log(`Skipping ${path}: could not read at HEAD or HEAD~1`);
      continue;
    }

    if (headFile.version !== parentFile.version) {
      log(
        `Skipping ${path}: merge already changed version ` +
          `(${parentFile.version} -> ${headFile.version})`,
      );
      skipped.push({
        path,
        fromVersion: parentFile.version,
        toVersion: headFile.version,
        changed: true,
      });
      continue;
    }

    toBump.push({ path, currentVersion: headFile.version, file: headFile });
  }

  if (toBump.length === 0) {
    log("No files to bump");
    return { bumped: [], skipped };
  }

  // 4. Compute next version for each file. The "current" version is
  //    the merge commit's version (which equals HEAD on main).
  //    We use a single "now" for all files so they're consistent.
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

  if (bumped.length === 0) {
    return { bumped: [], skipped };
  }

  // 5. Create a commit via the Git Data API. Bump each file in
  //    a single commit; use the merge commit's tree as the base.
  const { data: baseTree } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: mergeCommit.tree.sha,
  });

  // Build the tree entries for the updated files. We use the
  // "blob" mode with the file content directly (base64-encoded).
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

  // Filter out the original package.json entries from the base tree
  // (they'll be replaced by the new blobs).
  const basePathsToReplace = new Set(bumped.map((f) => f.path));
  const filteredBase = baseTree.tree.filter(
    (entry) => entry.path !== undefined && !basePathsToReplace.has(entry.path),
  );

  const { data: newTree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: mergeCommit.tree.sha,
    tree: [
      ...filteredBase.map((entry) => ({
        path: entry.path as string,
        mode: (entry.mode ?? "100644") as "100644",
        type: "tree" as const,
        sha: entry.sha as string,
      })),
      ...updatedBlobs,
    ],
  });

  const message = bumped.length === 1
    ? `chore(release): ${bumped[0].version}`
    : `chore(release): ${bumped.map((f) => f.version).join(", ")}`;

  const { data: newCommit } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message,
    tree: newTree.sha,
    parents: [mainSha],
  });

  // 6. Update the main branch ref. If this fails with 409 (someone
  //    else pushed between our read and write), the caller retries.
  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${defaultBranch}`,
    sha: newCommit.sha,
    force: false,
  });

  log(`Pushed ${newCommit.sha}: ${message}`);

  return { bumped, skipped };
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
    // 404 means the file doesn't exist at this ref (e.g. a sub-package
    // was added in this PR and the parent doesn't have it yet).
    if (err && typeof err === "object" && "status" in err && err.status === 404) {
      return null;
    }
    throw err;
  }
}
