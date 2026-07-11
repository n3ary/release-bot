// Webhook signature verification and event dispatch.
//
// The bot's single ingress is POST /webhook. We verify the
// X-Hub-Signature-256 HMAC against the raw request body using the
// shared webhook secret, then dispatch on event type and action.
//
// The only event we care about is pull_request with action=closed
// and merged=true. Everything else gets a 200 OK with no work.

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
