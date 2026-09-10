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

### Pointing a Third-Party CLI at the Proxy

Some tools cannot be driven with `assistant oauth request`: a vendor CLI, an SDK, or a script that builds its own requests and expects to be handed an API base URL and an access token. Point it at the passthrough proxy instead of handing it the real token:

```bash
eval "$(assistant oauth proxy-url <provider-key> --export)"
```

That mints a short-lived grant and exports:

- `VELLUM_OAUTH_PROXY_BASE_URL`: the base URL to point the tool at
- `VELLUM_OAUTH_PROXY_TOKEN`: the grant, to use as the tool's bearer token
- `VELLUM_OAUTH_PROXY_EXPIRES_AT`: when the grant stops working
- `VELLUM_OAUTH_PROXY_ACCOUNT`: the account it resolved to (omitted when the connection carries none)

Map them onto whatever the tool reads:

```bash
eval "$(assistant oauth proxy-url stripe_link --export)"
LINK_API_BASE_URL="$VELLUM_OAUTH_PROXY_BASE_URL" \
  LINK_ACCESS_TOKEN="$VELLUM_OAUTH_PROXY_TOKEN" \
  LINK_NO_REFRESH=1 \
  link-cli payment-methods list --format json
```

The tool sends the grant as its own bearer token; the proxy strips it, substitutes the provider credential, and forwards the request, so the provider token never reaches the tool. The grant opens one provider (and one account, when several are connected) and nothing else, and it expires: 900 seconds by default, `--ttl <seconds>` to change it within 60 to 3600. Pin an account with `--account`, and run `assistant oauth status <provider-key>` to find the identifier.

An unlabeled connection can be selected with `--account <connection-id>`. For bring-your-own connections, an exact account-label match takes precedence over a connection-ID match.

A side-effect request made through the proxy still needs the `assistant ui confirm` gate described above.

**Fidelity depends on the connection's mode.** On a bring-your-own connection the passthrough is byte-exact: the provider's response bytes and the query string arrive as written. A managed connection is proxied by the Vellum platform, which parses the response and rebuilds the query, so duplicate JSON keys and integers past 2^53 can change, `%20` becomes `+`, a valueless `?flag` becomes `flag=`, redirects are followed server-side instead of handed back, and HEAD is rejected. A provider that signs its own query string therefore works only on a bring-your-own connection. Check the mode with `assistant oauth mode <provider-key>`.

A 3xx that does reach you keeps its status, but its target moves to the `x-vellum-proxy-location` response header, so nothing follows it automatically while carrying the grant. A tool that must follow one reads that header.

Managed connections forward only `Content-Type`, `Accept`, `User-Agent`, and `X-Request-Id`. Requests with other headers, including `If-Match`, `Idempotency-Key`, and provider-version headers, return 400 before reaching the provider. Node fetch defaults `Accept-Language: *` and `Sec-Fetch-Mode: cors` are discarded. Use a bring-your-own connection when the CLI requires unsupported headers; do not remove write safeguards to bypass the rejection. Non-redirect responses, including `201 Created`, preserve `Location` on bring-your-own connections.

### OAuth Token Escape Hatch

In some rare cases, you may need access to the OAuth token directly. This is heavily discouraged and should generally be avoided. Reach for `proxy-url` above first: a script that "needs the token to run" almost always needs a base URL and a bearer token, which is exactly what the proxy hands it without exposing the credential. The proxy is also the only option on a managed connection, where `assistant oauth token` returns an error by design.

The escape hatch is valid only if:

1. The proxy genuinely cannot serve the case: the tool offers no way to override its API base URL, the token has to go somewhere a request header cannot reach (a request signature, a websocket handshake, an SDK that refreshes its own credential), or the call targets a host outside the connection's configured API base
2. You've asked explicit permission from your user to use the token for a specific reason
3. You don't use the token for anything other than that reason.

You can retrieve the token using:

```bash
assistant oauth token <provider-key>
```

If you suspect that the token was used for anything other than the user's original intention, you should encourage them to disconnect their account (using `assistant oauth disconnect`) and reconnect it.
