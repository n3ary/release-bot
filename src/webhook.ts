// Webhook signature verification and event dispatch.
//
// The bot's single ingress is POST /webhook. We verify the
// X-Hub-Signature-256 HMAC against the raw request body using the
// shared webhook secret, then dispatch on event type and action.
//
// The only event we care about is pull_request with action=closed
// and merged=true AND base.ref == repository.default_branch.
// Everything else gets a 200 OK with no work.

import type { Env, PullRequestEvent } from "./types.ts";

export async function verifyWebhookSignature(
  request: Request,
  secret: string,
): Promise<boolean> {
  const signatureHeader = request.headers.get("X-Hub-Signature-256");
  if (!signatureHeader) return false;

  const body = await request.clone().text();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  const expected = "sha256=" +
    Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  // Constant-time comparison.
  if (expected.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return diff === 0;
}

export function isMergedPullRequestClose(event: PullRequestEvent): boolean {
  return event.action === "closed" && event.pull_request?.merged === true;
}

/**
 * The bot is a main-only bumper: it should only act on PRs merged
 * into the repo's default branch. A merge into a feature / epic /
 * release branch is a user-internal workflow step, not a "release
 * to production" event.
 *
 * Without this guard, the bot will read the merge commit on the
 * feature branch, treat the diff vs that branch's parent as "the
 * release" (which includes accumulated code from earlier stacked
 * PRs on that branch), and open a version-bump PR against the
 * default branch carrying the entire feature-branch tree, not just
 * the version line. This is the wrong shape for a release PR.
 *
 * Concrete incident: 2026-07-12, n3ary/gtfs-adapters PR #78 was
 * merged into `feat/issue-26-tags-networks`. The bot fired and
 * opened PR #79 against main with 1700+ lines of un-released
 * route-tags code + a 0.3.10 -> 0.3.11 version bump.
 *
 * Exported for unit testing.
 */
export function isMergedIntoDefaultBranch(event: PullRequestEvent): boolean {
  return event.pull_request?.base?.ref === event.repository?.default_branch;
}
