// GitHub App authentication for the n3ary release bot.
//
// Flow:
//   1. Sign a JWT with the app's private key (RS256). The JWT's
//      `iss` is the app ID, the lifetime is 10 minutes, with a
//      60-second clock-skew buffer on `iat`.
//   2. Exchange the JWT for an installation access token via
//      POST /app/installations/{id}/access_tokens. The installation
//      token is short-lived (1 hour) and scoped to one installation.
//
// We implement this with the Web Crypto API so it works in Cloudflare
// Workers (no Node crypto, no polyfills). The `privateKey` PEM is
// imported as a PKCS#8 RSA key.

import type { Env } from "./types.ts";

export async function getInstallationToken(
  installationId: number,
  env: Env,
): Promise<{ token: string; expiresAt: Date }> {
  const jwt = await signAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${jwt}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "n3ary-release-bot",
      },
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Failed to get installation token (${res.status}): ${body}`,
    );
  }

  const data = await res.json() as {
    token: string;
    expires_at: string;
  };
  return { token: data.token, expiresAt: new Date(data.expires_at) };
}

async function signAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const key = await importPrivateKey(privateKeyPem);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,        // 60s clock-skew buffer
    exp: now + 10 * 60,   // 10-minute lifetime
    iss: appId,
  };

  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );

  const sigB64 = b64url(new Uint8Array(signature));
  return `${signingInput}.${sigB64}`;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Strip PEM headers and whitespace, then base64-decode.
  const pemContents = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    "pkcs8",
    binary,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input;
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
