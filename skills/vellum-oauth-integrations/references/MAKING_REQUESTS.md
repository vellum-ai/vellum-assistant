# Making Requests on Behalf of the User

Read this section to learn how to make authenticated requests to third-party OAuth applications on behalf of your user.

## Pre-Requisites

This section requires that the user has previously created a connection for a given provider. You can check a provider's status with:

```bash
assistant oauth status <provider-key>
```

If there are no active connections, refer to [Connecting Accounts](CONNECTING_ACCOUNTS.md).

If you have any doubt in the validity of the connection, you can ping the provider with:

```bash
assistant oauth ping <provider-key>
```

## Making Requests

For the vast majority of use cases, you should make authenticated requests to the provider using:

```bash
assistant oauth request ...
```

This CLI provides a curl-like interface and handles authentication on your behalf, including handling the OAuth token securely and refreshing it as needed.

For details on how to use this command, run:

```bash
assistant oauth request --help
```

**Side-effect requests require explicit user confirmation.** If the request performs a side-effect (updates data, sends an email, deletes a record, etc.), gate it with `assistant ui confirm` so the user has a hard runtime veto — do not rely solely on SKILL.md prose instructions.

For simple shell branching (proceed on confirm, abort otherwise), use the exit code directly:

```bash
# Simple gate: exit code 0 = confirmed, 1 = denied/cancelled/timed_out
if assistant ui confirm \
  --title "Send email" \
  --message "Send draft to jane@example.com — Subject: Q2 Report" \
  --confirm-label "Send" \
  --deny-label "Cancel"; then
  assistant oauth request POST "/v1.0/me/messages/${DRAFT_ID}/send" \
    --provider microsoft-graph
else
  echo "Cancelled — email not sent."
  exit 0
fi
```

For scripts that need to inspect the result programmatically, use `--json` and branch on `status` and `confirmed`:

```bash
RESULT=$(assistant ui confirm \
  --title "Delete calendar event" \
  --message "Permanently delete '${EVENT_TITLE}'?" \
  --confirm-label "Delete" \
  --deny-label "Keep" \
  --json)

STATUS=$(echo "$RESULT" | jq -r '.status')

case "$STATUS" in
  submitted)
    CONFIRMED=$(echo "$RESULT" | jq -r '.confirmed')
    if [ "$CONFIRMED" = "true" ]; then
      assistant oauth request DELETE "/v1.0/me/events/${EVENT_ID}" \
        --provider microsoft-graph
    else
      echo "User chose to keep the event."
    fi
    ;;
  cancelled)
    echo "User dismissed the prompt — event not deleted."
    ;;
  timed_out)
    echo "Confirmation timed out — event not deleted."
    ;;
esac
```

> **Note**: The `cancellationReason` field (for distinguishing user dismissal from operational failures like `no_interactive_surface`) is only available in `assistant ui request --json` output, not `ui confirm --json`. For `ui confirm`, use the exit-code pattern above for simple cases, or branch on `status` and `confirmed` for `--json` mode.

For read-only requests (fetching data, listing resources), no confirmation gate is needed.

### OAuth Token Escape Hatch

In some rare cases, you may need access to the OAuth token directly. This is heavily discouraged and should generally be avoided, but it is a valid escape hatch if:

1. You need it outside of the context of a standalone curl-like request (e.g. you're writing a script and the script needs the token to run)
2. You've asked explicit permission from your user to use the token for a specific reason
3. You don't use the token for anything other than that reason.

You can retrieve the token using:

```bash
assistant oauth token <provider-key>
```

If you suspect that the token was used for anything other than the user's original intention, you should encourage them to disconnect their account (using `assistant oauth disconnect`) and reconnect it.
