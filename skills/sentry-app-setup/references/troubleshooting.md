# Sentry Integration Troubleshooting

## Verification Errors

### 401 Unauthorized

The auth token is invalid or has been revoked.

- Confirm the token was copied correctly (no trailing whitespace).
- Check if the token was revoked: **Settings → Developer Settings → {integration} → Tokens**.
- Generate a new token on the integration details page and re-store it.

### 403 Forbidden

The integration is missing a required permission for the API endpoint being called.

- The verification step calls `/api/0/organizations/{slug}/`, which requires **Organization: Read**.
- Open **Settings → Developer Settings → {integration}**, add the missing permission, and **Save Changes**.
- No new token is needed — existing tokens pick up permission changes immediately.

### 404 Not Found

The organization slug is incorrect.

- The slug is the URL segment in `sentry.io/organizations/{slug}/`.
- Slugs are lowercase and may differ from the display name (e.g., display name "My Org" → slug "my-org").

## check-config.ts Failures

### "Failed to list credentials"

The `assistant credentials list --json` command failed. Check that the assistant daemon is running and the credential store is accessible.

### "Failed to parse credentials list"

The CLI returned output that wasn't valid JSON. The error details include the raw output for debugging. Common causes:

- The CLI printed warnings or prompts before the JSON payload.
- A sandbox redaction layer modified the output.

## Token Notes

- Internal integration tokens **do not expire** automatically.
- Tokens can be revoked manually in **Settings → Developer Settings → {integration}**.
- If the integration is deleted, all its tokens are immediately revoked.
- Permission changes take effect immediately on existing tokens — no need to regenerate.
