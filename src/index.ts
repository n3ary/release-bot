// n3ary-release-bot Cloudflare Worker entry point.
//
// Routes:
//   POST /webhook   - GitHub webhook ingress (the only real route)
//   POST /test/bump - manual bump (requires ADMIN_TOKEN bearer auth)
//   GET  /health    - health check
//
// The bot is a stateless webhook handler. On every merged PR, it
// opens a pull request against the default branch that bumps the
// version in each package.json to the next CalVer (YY.M.D-N) in
// Europe/Bucharest timezone. Auto-merge is enabled on the PR, so
// the version lands on main as soon as the required status checks
// pass (usually within seconds; with 0 required reviews, no human
// click is needed).

import { Octokit } from "octokit";
import { getInstallationToken } from "./auth.ts";
import { discoverAndOpenPR } from "./commit.ts";
import { isMergedPullRequestClose, verifyWebhookSignature } from "./webhook.ts";
import type { Env, PullRequestEvent } from "./types.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const log = makeLogger(env);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env, log);
    }

    if (request.method === "POST" && url.pathname === "/test/bump") {
      return handleManualBump(request, env, log);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleWebhook(
  request: Request,
  env: Env,
  log: (msg: string) => void,
): Promise<Response> {
  // 1. Verify signature. Reject unsigned.
  const ok = await verifyWebhookSignature(request, env.GITHUB_WEBHOOK_SECRET);
  if (!ok) {
    log("Webhook signature verification failed");
    return new Response("invalid signature", { status: 401 });
  }

  // 2. Parse the event. GitHub sends a different event type per
  //    `X-GitHub-Event` header.
  const eventType = request.headers.get("X-GitHub-Event");
  if (eventType !== "pull_request") {
    log(`Ignoring event type: ${eventType}`);
    return new Response("ignored", { status: 200 });
  }

  const event: PullRequestEvent = await request.json();

  if (!isMergedPullRequestClose(event)) {
    log(`Ignoring pull_request action=${event.action} merged=${event.pull_request?.merged}`);
    return new Response("ignored", { status: 200 });
  }

  if (!event.installation?.id || !event.pull_request.merge_commit_sha) {
    log("Event missing installation.id or merge_commit_sha");
    return new Response("ignored", { status: 200 });
  }

  const installationId = event.installation.id;
  const mergeSha = event.pull_request.merge_commit_sha;
  const { owner, repo } = {
    owner: event.repository.owner.login,
    repo: event.repository.name,
  };
  const defaultBranch = event.repository.default_branch;

  log(`Processing merge: ${owner}/${repo}@${mergeSha} (branch: ${defaultBranch})`);

  // 3. Get an installation access token. Exchange the app's JWT.
  let token: string;
  try {
    const result = await getInstallationToken(installationId, env);
    token = result.token;
  } catch (err) {
    log(`Failed to get installation token: ${(err as Error).message}`);
    return new Response("auth failed", { status: 500 });
  }

  // 4. Run the release with bounded retries on 409 Conflict (someone
  //    else pushed between our read and write, or the branch was
  //    created in a parallel webhook).
  const octokit = new Octokit({ auth: token, userAgent: "n3ary-release-bot" });
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await discoverAndOpenPR(
        octokit,
        owner,
        repo,
        defaultBranch,
        mergeSha,
        env,
        log,
      );
      const prInfo = result.pr
        ? ` PR #${result.pr.number} (${result.pr.html_url}) opened with auto-merge.`
        : " No PR opened (idempotency no-op or no files to bump).";
      log(
        `Done: ${result.bumped.length} bumped, ${result.skipped.length} skipped.${prInfo}`,
      );
      return new Response("ok", { status: 200 });
    } catch (err) {
      const message = (err as Error).message;
      const is409 = err && typeof err === "object" && "status" in err &&
        (err as { status: number }).status === 409;
      if (is409 && attempt < maxRetries) {
        log(`409 Conflict on attempt ${attempt}; retrying`);
        continue;
      }
      log(`Release failed after ${attempt} attempt(s): ${message}`);
      // Return 500 so GitHub marks the delivery as failed and retries.
      return new Response("release failed", { status: 500 });
    }
  }

  return new Response("release failed after retries", { status: 500 });
}

async function handleManualBump(
  request: Request,
  env: Env,
  log: (msg: string) => void,
): Promise<Response> {
  if (!env.ADMIN_TOKEN) {
    return new Response("manual endpoint disabled", { status: 403 });
  }

  const authHeader = request.headers.get("Authorization") ?? "";
  if (authHeader !== `Bearer ${env.ADMIN_TOKEN}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const body = await request.json() as {
    owner: string;
    repo: string;
    ref?: string;
  };

  if (!body.owner || !body.repo) {
    return new Response("owner and repo required", { status: 400 });
  }

  log(`Manual bump: ${body.owner}/${body.repo} (ref: ${body.ref ?? "main"})`);

  // For the manual endpoint, we need an installation ID. We can't
  // get one from a webhook payload, so the caller must include it.
  // (This endpoint is for ops use; the operator knows the
  // installation ID from the GH UI.)
  return new Response(
    "manual bump endpoint not yet implemented; use the GitHub UI to trigger a test merge or call the Worker with an installation ID via a follow-up PR",
    { status: 501 },
  );
}

function makeLogger(env: Env): (msg: string) => void {
  const level = env.LOG_LEVEL ?? "info";
  const order = { debug: 0, info: 1, warn: 2, error: 3 } as const;
  return (msg: string) => {
    // Workers' `console.log` goes to the Workers log stream
    // (visible via `wrangler tail` or the CF dashboard).
    if (order[level] <= order.info) {
      console.log(`[n3ary-release-bot] ${msg}`);
    }
  };
}
