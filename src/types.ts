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
  // BOT_VERSION is injected by the deploy workflow
  // (.github/workflows/deploy.yml) from package.json. Visible in
  // the Workers dashboard and in every log line so a webhook
  // delivery can be correlated with a specific release.
  BOT_VERSION: string;

  // Optional: for the manual /test/bump endpoint. If unset, the endpoint
  // returns 403. Set via `wrangler secret put ADMIN_TOKEN`.
  ADMIN_TOKEN?: string;
}

export interface PullRequestEvent {
  action: string;
  pull_request: {
    merged: boolean;
    merge_commit_sha: string | null;
    // The PR author's login. Used by `isBotAuthoredPR` to filter
    // out the bot's own release PRs (otherwise the bot feeds
    // itself forever: every release PR auto-merges to main, the
    // webhook fires again, the bot opens another release PR, ad
    // infinitum). Optional so older fixtures and edge payloads
    // (e.g. events from before the field existed) don't break
    // the type.
    user?: { login: string };
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
