# Discord Integration Troubleshooting

## Token & Auth Errors

### 401 Unauthorized

The bot token is invalid, has been reset, or was copied incorrectly.

- Open **https://discord.com/developers/applications/{application_id}/bot** and click **Reset Token**.
- Discord will display the new token **once** — paste it into the secure prompt immediately.
- Re-run `validate-and-configure.ts` to confirm.

### 403 Forbidden on `/users/@me` or `/oauth2/applications/@me`

The token format is correct but the application has been disabled (e.g. ToS violation, owner deleted the app). Recreate the application and re-run setup.

### 401 / 403 from Discord Gateway WebSocket

The token validates against the REST API but the gateway closes the connection. Common causes:

- The bot was kicked from every server it was in. Re-invite via the Step 5 invite URL.
- The bot account was disabled by Discord Trust & Safety. Check the developer portal for warnings.

## Intent Errors

### "Disallowed intents" gateway close (code 4014)

The bot is connecting with an intent flag that is not enabled on the application.

- Open **Bot → Privileged Gateway Intents** in the developer portal.
- Enable **Message Content Intent** and **Server Members Intent**, then **Save Changes**.
- The connection will succeed on the next reconnect.

### Messages arrive without content

The Message Content Intent is not enabled, or not requested in the gateway identify payload. Re-check Step 2.

## OAuth Invite Errors

### "Bot requires a code grant" on invite

The application has **Public Bot** disabled and **Requires OAuth2 Code Grant** enabled. For most personal-assistant use cases:

- Open **OAuth2 → General** in the developer portal.
- Disable **Requires OAuth2 Code Grant**.
- Optionally disable **Public Bot** if only the owner should be able to invite the bot.

### "This application requires a redirect URI"

This appears when the invite URL is built with a `response_type=code` query parameter. The skill's `print-invite-url.ts` does not include `response_type` — if you've hand-edited the URL, regenerate it from the script.

### "You don't have permission to add bots to this server"

The user inviting the bot must have **Manage Server** permission on the target guild. Have a server admin run the invite link, or grant the user the role.

## Application Metadata

### `discord_channel.applicationId` is empty

`validate-and-configure.ts` was never run, or it failed before the config writes. Run it again — it requires a valid `discord_channel:bot_token` to be present in the credential store.

### `validate-and-configure.ts` reports `Discord /users/@me → 401`

The bot token in the credential store is invalid. Reset the token in the developer portal, re-prompt with `credential_store`, then re-run the script.

## Token Notes

- Bot tokens **do not expire** automatically.
- Resetting a token in the developer portal **immediately invalidates** the old one. All running connections using the old token will be disconnected.
- If the application is deleted, all its tokens are immediately revoked.
- Privileged intent changes take effect on the **next gateway reconnect** — no token reset needed.

## Removing the Bot

- To remove the bot from a single server, the server owner kicks it from the member list (or revokes the bot's role with no `Kick Members` permission).
- To revoke globally, click **Reset Token** in the developer portal — every existing client using the old token will get a 401 on next request.
- To delete the application entirely, use **Delete App** at the bottom of the General Information page.
