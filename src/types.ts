// Shared types for the n3ary-release-bot Cloudflare Worker.
//
// The Cloudflare Workers types (Request, Response, crypto.subtle, etc.)
// come from @cloudflare/workers-types, configured in tsconfig.json.

export interface Env {
  // Secrets (set via `wrangler secret put`)
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;

  // Vars (set in wrangler.toml)
  TIMEZONE: string;
  LOG_LEVEL: "debug" | "info" | "warn" | "error";

  // Optional: for the manual /test/bump endpoint. If unset, the endpoint
  // returns 403. Set via `wrangler secret put ADMIN_TOKEN`.
  ADMIN_TOKEN?: string;
}

export interface PullRequestEvent {
  action: string;
  pull_request: {
    merged: boolean;
    merge_commit_sha: string | null;
    head: { sha: string };
    base: { ref: string; sha: string };
  };
  repository: {
    name: string;
    full_name: string;
    owner: { login: string };
    default_branch: string;
  };
  installation?: { id: number };
}

export interface PackageJsonFile {
  path: string;       // path in the repo, e.g. "package.json" or "libs/spec/package.json"
  content: string;    // raw file content (decoded)
  version: string;    // parsed version field
}

export interface PackageJsonDiff {
  path: string;
  fromVersion: string;   // version at HEAD~1
  toVersion: string;     // version at HEAD
  changed: boolean;      // did the merge commit change the version?
}
