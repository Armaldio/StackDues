# Production validation record

Last checked: 2026-10-08 (UTC)

## Checks completed by Codex

- The production Worker `stackdues` deployed to `dues.armaldio.xyz` as version `cdb87542-2b7f-4c69-a2b6-236f01b21c7f` at 15:23 UTC. The six-hour Cron trigger is configured as `17 */6 * * *`.
- `GET /` redirects to `/login` (303); `GET /login` and `/register` are public pages. Unauthenticated `GET /api/costs` and `GET /api/subscriptions` return 401.
- `wrangler d1 migrations list stackdues --remote` reported no migrations to apply.
- CI passed unit, D1, provider, worker security, hostinger, browser, build, typecheck, and dependency-audit checks for PR #12. The fixture-based worker integration verifies manual and scheduled sync use the same collection and persistence path.
- No production credentials, invoice data, or provider billing records were accessed during this check. This record does not validate actual provider amounts, currencies, credits, billing periods, renewals, or Cron execution against connected accounts.

## Owner-only verification still required

Use the authenticated interface at `https://dues.armaldio.xyz` and keep all account values and screenshots private.

1. Open `/register`, create the single owner account with the configured owner email and your chosen password, and use the one-time setup code through the form. Confirm it redirects to the dashboard. Open `/register` again and confirm another account cannot be created.
2. Sign out using the dashboard button. Confirm the browser returns to `/login`, then sign in again. In browser developer tools, verify the session cookie is Secure, HttpOnly, SameSite=Strict, and expires after eight hours; do not copy its value. Confirm logging out invalidates the prior session and private API requests without a session return 401.
3. In Connections, enter each provider's credentials through the password fields. Confirm the initial sync completes or shows a retryable error, and that saved credentials never reappear in the interface. Wait for the next configured Cron run (minute 17 every six hours) and confirm last-attempt/success timestamps advance in the dashboard for configured providers.
4. Privately compare each connected AWS, Cloudflare, and Hostinger view with its provider billing page or invoice for the same observation time. Check currencies separately, actual spend against provider totals including credits, the billed period, forecast labeling, Hostinger renewal price/recurrence/next-charge date, and whether renewal is enabled. Recheck after one manual sync and the next Cron run for duplicate or missing observations. Record only pass/fail, provider, product, observation timestamp, and discrepancy category in any shared report; do not record invoice details or amounts.
5. Add the owner's real Bitwarden Premium and ChatGPT Plus subscriptions manually with their own charge, currency, recurrence, and next renewal date. Confirm they appear as fixed commitments, are included once in fixed totals and upcoming renewals, and persist after reload and a second sign-in. Do not connect or scrape personal billing for these services.
6. Confirm a provider failure or an unavailable forecast leaves prior successful observations visible and does not show an unavailable value as zero. Confirm disconnected providers leave History intact but no longer contribute to tracked current totals.

Keep DUES-1 PR 6 unchecked until these production owner and real-account comparisons are completed and reported without private financial details.
