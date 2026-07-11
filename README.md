# n3ary-release-bot

Org-level GitHub App + Cloudflare Worker for the n3ary org. Bumps `package.json#version` on `main` after every merged PR using CalVer (`YY.M.D-N`) in `Europe/Bucharest` timezone. Installed on the n3ary org.

**How it lands on `main`:** the bot is a PR-based contributor. On every merged PR, it opens a new pull request titled `chore(release): <version>` against `main`. The PR is the bot's branch (`release/calver-<version>`) containing a single commit that bumps the version. **Auto-merge is enabled on the PR**, so the version lands on `main` as soon as the required status checks pass (usually within seconds). With 0 required reviews, no human click is needed.

This is the "PR-based" flow that works on the free GitHub plan: no `bypass_actors` rule, no Team upgrade, no direct push to `main`.

## What it does

On every `pull_request: closed` event with `merged == true`, the bot:

1. Reads the repo's `package.json#version` on the current `main` tip.
2. Computes the next CalVer version: `YY.M.D-N`, counter resets at day boundary, counter starts at `1`.
3. Checks whether the merge commit already changed the version (the `skip-if-already-touched` rule). If yes, the bot no-ops on that file.
4. Creates a new branch `release/calver-<version>` from the merge commit.
5. Commits the version bump to the new branch (via the Git Data API).
6. Opens a PR from the new branch to `main`.
7. Enables auto-merge on the PR (squash merge).

The bot is a stateless Cloudflare Worker. It is a GitHub App installed on the n3ary org. The bot's identity (`n3ary-release-bot[bot]`) opens the PR like any other contributor.

## What it does NOT do

- **Push directly to `main`.** The bot's commits land via a PR + auto-merge, not via a direct push. This means no bypass-actor permission is needed.
- **Bump on a tag, on a schedule, or on `push` to `main` directly.** Those are anti-patterns. See [n3ary/standards/standards/version-management.md](https://github.com/n3ary/standards/blob/main/standards/version-management.md).
- **Require a human to merge the version-bump PR.** Auto-merge handles it.
- **Publish to npm, push a container image, or deploy.** Those are per-consumer workflows with repo-specific secrets.

## Why PR-based (not direct push)

GitHub's `bypass_actors` feature for GitHub Apps requires **GitHub Team or Enterprise** ($4/user/month at minimum). The n3ary org is on the free plan. The PR-based flow works on the free plan because:

- The bot is a contributor (not a privileged actor).
- The version-bump PR goes through the normal review + status-checks path.
- With 0 required reviews (n3ary's branch protection standard for solo dev), auto-merge fires as soon as the required status checks pass.
- No bypass-actor rule, no Team upgrade, no direct push permission on the bot.

The trade-off vs. direct push:

| | Direct push (paid plan) | PR-based (free plan) |
|---|---|---|
| Latency from merge to bumped version | ~1 second | ~10-30 seconds (CI must pass) |
| Visible as a PR in your queue | No | Yes (you can ignore it) |
| Requires bypass-actor permission | Yes (Team+) | No |
| Works on free plan | No | **Yes** |
| Single point of failure | Bot identity | PR merge (status checks must pass) |

For the n3ary org, the trade-off is the right one. The PR is trivial to review (1 line in `package.json`) and you can ignore it. If a status check is broken, the PR sits open and you get a notification.

## Repo layout

```
n3ary/release-bot/
├── app.yml               # GitHub App manifest
├── src/
│   ├── auth.ts           # JWT signing + installation token exchange
│   ├── bump.ts           # CalVer arithmetic: nextCalVer(current, now, tz)
│   ├── commit.ts         # discoverAndOpenPR: discover, compute, branch, commit, PR, auto-merge
│   ├── pr.ts             # createBranch, openPullRequest, enableAutoMerge, findOpenReleasePR
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

If you already have a previous version of the app installed (e.g. v0.1.0's "push directly to main" version), you'll need to **re-accept the new permissions** in the GH UI after step 3. The new permission (`pull_requests: write`) requires explicit user acceptance.

### 2. Set the Cloudflare Worker secrets

From this repo root:

```bash
# Required
wrangler secret put GITHUB_APP_ID
# paste the App ID from step 1

wrangler secret put GITHUB_APP_PRIVATE_KEY
# paste the entire PEM, including the BEGIN/END lines.
# Use a file redirect to avoid terminal mangling:
#   wrangler secret put GITHUB_APP_PRIVATE_KEY < ~/path/to/key.pem

wrangler secret put GITHUB_WEBHOOK_SECRET
# paste a strong random string; same value goes into the app's "Webhook secret" field in the GH UI

# Optional: enables the manual /test/bump endpoint
wrangler secret put ADMIN_TOKEN
# paste a strong random string; bearer-token auth for the manual endpoint
```

Generate the webhook secret with `openssl rand -hex 32` or similar.

### 3. Deploy the Worker

**Option A: automatic, via GitHub Actions (preferred).**

The `.github/workflows/deploy.yml` workflow deploys on every push to `main`. To use it, set two secrets on the repo (Settings → Secrets and variables → Actions):

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with `Workers Scripts:Edit` scope on the n3ary account.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID (32-char hex).

Then just merge to main. The workflow:

1. Reads `BOT_VERSION` from `package.json`.
2. Writes it to `wrangler.toml` so the Workers dashboard and the bot's first log line per webhook show the version.
3. Runs `wrangler deploy`.
4. Hits `https://n3ary-release-bot.ciotlos.workers.dev/health` and asserts the response includes the deployed version.

**Option B: manual, from a local checkout.**

```bash
pnpm install   # installs deps; first run will prompt to approve build scripts (esbuild, sharp, workerd)
pnpm deploy    # wrangler builds and uploads the Worker
```

You can also do this to seed the initial deploy before the GitHub Actions secret is in place.

The Worker is now live at a `*.workers.dev` URL. Note the URL — you need it in step 4.

### 4. Configure the GitHub App's webhook URL

In the GitHub App settings (Settings → Developer settings → GitHub Apps → `n3ary-release-bot`):

- Set the **Webhook URL** to `<worker-url>/webhook` (the URL from step 3, with `/webhook` appended).
- Set the **Webhook secret** to the same value you used in step 2 for `GITHUB_WEBHOOK_SECRET`.
- Set the **Active** checkbox.

### 5. Install the app on the org

In the GitHub App settings, click "Install App" and select the n3ary org. Grant access to "All repositories" (or a specific subset if you want to limit the bot to certain repos).

### 6. Re-accept the new permissions (only if upgrading from v0.1.0)

If you already had the bot installed before the `pull_requests: write` permission was added, GitHub will show a "new permissions requested" banner in the app's settings. Click through and accept. Without this, the bot can create the branch and commit, but cannot open the PR or enable auto-merge.

## Branch protection

The bot's PR-based flow works with **any** branch protection setup, because the bot is just a contributor. No bypass-actor rule is needed.

For n3ary's standard branch protection, see the [repo-settings standard](https://github.com/n3ary/standards/blob/main/standards/repo-settings.md). The relevant settings:

- Required approving reviews: **0** (the bot's PR auto-merges as soon as checks pass; no review needed)
- Required status checks: whatever the repo has
- Strict (require up-to-date): yes

If you bump reviews to 1 in the future, the version-bump PR will wait for that review. The bot still works; it just takes longer to land. Auto-merge waits for the same things.

## Development

```bash
# Install deps
pnpm install

# If pnpm 11 prompts about build scripts (esbuild, sharp, workerd), run:
#   pnpm approve-builds
# (one-time per machine; the .npmrc lists the allowed packages, but
# pnpm 11 requires explicit confirmation on first install)
#
# If you want to skip the approval entirely, install with --ignore-scripts:
#   pnpm install --ignore-scripts
# (the build scripts install prebuilt binaries that are already in the
# packages; --ignore-scripts skips the post-install step and is safe for
# Cloudflare Worker projects because wrangler uses the prebuilt binaries)

# Run the CalVer unit tests
pnpm test

# Run the Worker locally
pnpm dev
# (the Worker is at http://localhost:8787)

# Type check
pnpm typecheck

# Build (alias for typecheck; no separate compile step -- wrangler bundles on deploy)
pnpm build
```

The Worker is stateless. There is no local database. Tests cover the CalVer logic (the only piece of stateful-ish logic); the GitHub API interactions are best tested against a real repo via the bot's actual deployment.

## Package manager

The bot uses **pnpm** (consistent with the rest of the n3ary org). The `packageManager` field in `package.json` pins the exact pnpm version; Corepack (built into Node 20+) reads this and uses the right version automatically. The `.npmrc` file (in `[pnpm]` section) whitelists the three native deps that wrangler needs (`esbuild`, `sharp`, `workerd`); pnpm 11 still requires a one-time `pnpm approve-builds` confirmation on first install, after which subsequent installs are silent. The `pnpm-lock.yaml` is committed for reproducible builds.

## How the auto-merge works

The bot's PR is opened with auto-merge enabled via the GraphQL API. The PR's auto-merge behavior:

- All required status checks must pass.
- If the PR is behind `main`, GitHub auto-updates the branch from `main` before merging.
- The merge is a squash merge (one commit on `main`).
- Once merged, the PR closes and the version-bump commit lands on `main`.

If auto-merge fails (e.g. a status check is broken), the PR sits open with the `auto-merge enabled` label. You can:

- Fix the check and the PR auto-merges.
- Merge the PR manually.
- Close the PR; the bot creates a new one on the next event.

The PR's URL is logged by the bot in its Cloudflare Worker logs. You can find it with `wrangler tail`.

## On-call runbook

When the bot fails:

1. Check the Cloudflare Worker logs: `wrangler tail` from this repo root.
2. If the failure is a GitHub API error (5xx), wait and retry. GitHub's API has transient failures.
3. If the failure is `403 Forbidden` on the auto-merge enablement, the app is missing `pull_requests: write`. Re-do step 6 of the install.
4. If the failure is `404 Not Found` on the installation token, the app isn't installed on the org. Re-do step 5.
5. If the bot opens a PR but auto-merge doesn't fire, check the PR's "Checks" tab. The required status checks must pass.
6. If the bot is no-op'ing on every merge, check the logs for "Idempotency: open release PR already exists". A previous PR is still open; merge or close it.

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
