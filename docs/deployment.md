# Production deployment

`.github/workflows/ci.yml` runs the full quality suite for pull requests and pushes to `main`. Only a successful push run can enter the `production` deployment job. The job checks out that run's exact commit, builds with Node 24, confirms it is still the current `main` commit, applies pending remote D1 migrations in order, checks `main` again, deploys through `npm run deploy` (the configured `worker/index.ts` entry point), and runs anonymous authentication smoke checks against `https://dues.armaldio.xyz`.

The deployment job is serialized and never cancels a running migration. A superseded pending job is skipped before changing production. A migration failure stops deployment. A post-deploy smoke failure fails the job and requires investigation; it does not automatically roll back D1 or Worker code.

## One-time GitHub configuration

1. In repository **Settings → Environments**, create an environment named `production`.
2. Restrict its deployment branches to `main`. Do not add required reviewers if merges should deploy unattended.
3. Add environment secret `CLOUDFLARE_API_TOKEN`. Never add it as a repository variable, commit it, or copy it into workflow logs.
4. Create an account-owned Cloudflare API token for CI. Grant the `stackdues` Worker the Workers **Editor** role, scoped to that Worker, and grant D1 **Edit** scoped to the `stackdues` database for remote migrations. The custom domain is already configured; if the deployment must change its route/domain binding, additionally grant **Workers Routes Write** only for the `armaldio.xyz` zone. Do not grant account-wide administrator access. Keep the token limited to this account and these resources.

The account ID is already pinned in `wrangler.jsonc`; the workflow uses it as `CLOUDFLARE_ACCOUNT_ID` and optionally checks a GitHub environment variable of the same name if you choose to set one. No duplicate account variable is required. The workflow's `GITHUB_TOKEN` permission is explicitly limited to `contents: read` so it can compare the run SHA with the latest `main` SHA. No GitHub write permission is needed.

The workflow does not set, rotate, or upload `SESSION_SECRET`, `SETUP_TOKEN`, `CREDENTIALS_KEY`, billing API credentials, owner passwords, or any other Worker secret. Those remain configured on Cloudflare. Missing GitHub environment values fail with an actionable message.

## Rollback

If the Worker deployment or smoke test fails, inspect the GitHub Actions run and Cloudflare Worker version history. For a code-only incident, redeploy the last known-good Worker version to 100% traffic using Cloudflare's version history or Wrangler's `wrangler versions deploy <version-id>@100% -y` command. Confirm the selected version is compatible with the current schema before rollback. Do not reverse D1 migrations automatically: migrations may already have committed, and production records must be preserved. Investigate and prepare a forward fix or a separately reviewed data-preserving migration when a schema issue is involved.

The workflow reports the deployed commit SHA and run link in the Actions summary. Its smoke checks make unauthenticated requests only and never print response bodies or billing data.
