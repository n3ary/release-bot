# n3ary-release-bot

Org-level GitHub App + Cloudflare Worker for the n3ary org. Bumps `package.json#version` on `main` after every merged PR using CalVer (`YY.M.D-N`) in `Europe/Bucharest` timezone. Installed on the n3ary org.

## What it does

On every `pull_request: closed` event with `merged == true`, the bot:

1. Reads the repo's `package.json#version` on the current `main` tip.
2. Computes the next CalVer version: `YY.M.D-N`, counter resets at day boundary, counter starts at `1`.
3. Checks whether the merge commit already changed the version (the `skip-if-already-touched` rule). If yes, the bot no-ops.
4. Writes the new version to `package.json` (and any sub-package `package.json`s — e.g. `libs/spec/`, `adapters/*/`).
5. Commits with `chore(release): <version>` and pushes the commit to `main`.

The bot is a stateless Cloudflare Worker. It is a GitHub App installed on the n3ary org. The bot's identity (`n3ary-release-bot[bot]`) is added to the org's branch protection bypass list, so its commits land on `main` directly, no PR required.

## What it does NOT do

- **Bump on the PR branch.** The PR branch is the dev's; the bot has no business there.
- **Bump on a tag, on a schedule, or on `push` to `main` directly.** Those are anti-patterns. See [n3ary/standards/standards/version-management.md](https://github.com/n3ary/standards/blob/main/standards/version-management.md).
- **Open a Release PR.** The bot pushes the version bump directly to `main`.
- **Publish to npm, push a container image, or deploy.** Those are per-consumer workflows with repo-specific secrets.

## Repo layout

```
n3ary/release-bot/
├── app.yml               # GitHub App manifest
├── src/
│   ├── auth.ts           # JWT signing + installation token exchange
│   ├── bump.ts           # CalVer arithmetic: nextCalVer(current, now, tz)
│   ├── commit.ts         # discoverAndBump: reads, computes, pushes
│   ├── webhook.ts        # signature verification
│   ├── index.ts          # Worker entry, route dispatch
│   └── types.ts          # shared types
├── test/
│   ├── bump.test.ts      # CalVer unit tests
│   └── helpers.ts        # test helpers
├── wrangler.toml         # Cloudflare Worker config
├── vitest.config.ts
├── tsconfig.json
├── package.json
├── .gitignore
└── README.md
```

## Install (one-time, on the n3ary org)

### 1. Register the GitHub App

The app is registered via a manifest-based flow:

1. Go to `https://github.com/organizations/n3ary/settings/apps/new` (or the org equivalent).
2. Paste the contents of `app.yml` as the manifest.
3. Confirm the app's name (`n3ary-release-bot`) and webhook URL.
4. GitHub creates the app and provides an **App ID** and a **private key** (PEM). Download the private key; it does not get shown again.

For local dev, the webhook URL can be a placeholder — you'll update it in step 4 after the Worker is deployed.

### 2. Set the Cloudflare Worker secrets

From this repo root:

```bash
# Required
wrangler secret put GITHUB_APP_ID
# paste the App ID from step 1

wrangler secret put GITHUB_APP_PRIVATE_KEY
# paste the entire PEM, including the BEGIN/END lines

wrangler secret put GITHUB_WEBHOOK_SECRET
# paste a strong random string; same value goes into the app's "Webhook secret" field in the GH UI

# Optional: enables the manual /test/bump endpoint
wrangler secret put ADMIN_TOKEN
# paste a strong random string; bearer-token auth for the manual endpoint
```

Generate the webhook secret with `openssl rand -hex 32` or similar.

### 3. Deploy the Worker

```bash
npm install
npm run deploy
```

The Worker is now live at a `*.workers.dev` URL. Note the URL — you need it in step 4.

### 4. Configure the GitHub App's webhook URL

In the GitHub App settings (Settings → Developer settings → GitHub Apps → `n3ary-release-bot`):

- Set the **Webhook URL** to `<worker-url>/webhook` (the URL from step 3, with `/webhook` appended).
- Set the **Webhook secret** to the same value you used in step 2 for `GITHUB_WEBHOOK_SECRET`.
- Set the **Active** checkbox.

### 5. Install the app on the org

In the GitHub App settings, click "Install App" and select the n3ary org. Grant access to "All repositories" (or a specific subset if you want to limit the bot to certain repos).

### 6. Add the org-level branch protection bypass

In the org settings: Settings → Branches → Branch protection rules → edit the rule for `main` (or create one if it doesn't exist). Under "Allow specified actors to bypass required pull requests", add `n3ary-release-bot[bot]`. Save.

This single rule covers every repo in the org. The bot's `chore(release)` commits land on `main` directly, no PR required.

## Development

```bash
# Run the CalVer unit tests
npm test

# Run the Worker locally
npm run dev
# (the Worker is at http://localhost:8787)

# Type check
npm run typecheck
```

The Worker is stateless. There is no local database; the only local "state" is the `wrangler dev` cache. Tests cover the CalVer logic (the only piece of stateful-ish logic); the GitHub API interactions are best tested against a real repo via the bot's actual deployment.

## On-call runbook

When the bot fails:

1. Check the Cloudflare Worker logs: `wrangler tail` from this repo root. Look for the last 100 events.
2. If the failure is a GitHub API error (5xx), wait and retry. GitHub's API has transient failures.
3. If the failure is a `409 Conflict` after 3 retries, the bot's push was rejected because main advanced under it. This should self-heal on the next PR merge (the bot will pick up the new state). If it doesn't, file an issue and use the manual endpoint:
   ```bash
   curl -X POST https://n3ary-release-bot.REPLACE_ME.workers.dev/test/bump \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -d '{"owner":"n3ary","repo":"<repo>"}'
   ```
4. If the failure is repeated across multiple repos, check the bot's installation status in the GitHub UI. The app may have been suspended or its installation token may have expired.
5. If the failure is a Cloudflare Worker issue (Worker down, region outage), the version bumps are deferred. The next successful deploy re-triggers them via the next PR merge.

## Secret rotation

The bot has four secrets, all stored as Cloudflare Worker secrets:

- `GITHUB_APP_ID` — the app's numeric ID. Stable; rotate only if the app is recreated.
- `GITHUB_APP_PRIVATE_KEY` — the app's PEM private key. Rotate annually. The old key remains valid until you remove it from the GH UI; the new key works immediately. No downtime.
- `GITHUB_WEBHOOK_SECRET` — a strong random string used to sign webhooks. Rotate annually, or immediately if a leak is suspected. To rotate, set a new value via `wrangler secret put`, then update the app's "Webhook secret" in the GH UI to match.
- `ADMIN_TOKEN` — bearer token for the manual endpoint. Rotate annually.

After rotating any secret, verify with a test PR merge that the bot still fires.

## Related

- [n3ary/standards/standards/version-management.md](https://github.com/n3ary/standards/blob/main/standards/version-management.md) — the spec the bot implements
- [n3ary/standards/standards/org-automation.md](https://github.com/n3ary/standards/blob/main/standards/org-automation.md) — the org-automation standard (broader context)
- [n3ary/standards/issues/20](https://github.com/n3ary/standards/issues/20) — the migration tracking issue

## License

MIT.
