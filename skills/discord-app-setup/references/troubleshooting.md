# Discord Integration Troubleshooting

## Token & Auth Errors

### 401 Unauthorized

The bot token is invalid, has been reset, or was copied incorrectly.

- Open **https://discord.com/developers/applications/{application_id}/bot** and click **Reset Token**.
- Discord will display the new token **once** — paste it into the secure prompt immediately.
- Re-run `validate-token.ts` to confirm.

### 403 Forbidden on `/users/@me` or `/oauth2/applications/@me`

The token format is correct but the application has been disabled (e.g. ToS violation, owner deleted the app). Recreate the application and re-run setup.

### 401 / 403 from Discord Gateway WebSocket

The token validates against the REST API but the gateway closes the connection. Common causes:

- The bot was kicked from every server it was in. Re-invite via the Step 5 invite URL.
- The bot account was disabled by Discord Trust & Safety. Check the developer portal for warnings.

## Intent Errors

### "Disallowed intents" gateway close (code 4014)

Discord refused a privileged intent the app is not approved for. This client identifies with `GUILDS`, `GUILD_MESSAGES`, and `DIRECT_MESSAGES` only, all three non-privileged, so it should never provoke a 4014.

Enabling privileged intents is **not** the fix. If you see this code, the IDENTIFY bitmask is not the one this client builds: check that the running gateway version matches the deployed assistant, and report it, rather than turning portal toggles on to satisfy it.

### Messages arrive without content

Discord empties `content` for messages outside its exemption list. The four exempt cases are messages that mention your app, DMs with your app, your app's own messages, and the target of a message context-menu command.

The bot only acts on messages that mention it, so an admitted message always carries content. Empty content therefore means the message was not actually a mention of the bot, not that an intent is missing. Enabling the Message Content Intent is only required to read messages the bot is **not** mentioned in, which this integration does not do.

### The bot is online but never replies

This is the expected state of a fresh setup, not a fault. The bot acts only when it is @mentioned in a channel on the allow-list, and that list starts empty.

- Check the list: `assistant config get discord.allowedChannelIds`
- Populate it: `assistant config set discord.allowedChannelIds '["<channel id>"]'`
- Confirm you are mentioning the bot directly, not just posting in the channel.
- If it still stays silent, the channel's admission policy may be excluding the sender: by default Discord admits trusted contacts rather than anyone in the server.

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

## Token Validation

### `validate-token.ts` reports `Discord /users/@me → 401`

The bot token in the credential store is invalid. Reset the token in the developer portal, re-prompt via `store-bot-token.ts`, then re-run `validate-token.ts`.

### `print-invite-url.ts` reports `Discord /oauth2/applications/@me → 401`

Same root cause — the stored bot token is invalid. The invite URL script calls `/oauth2/applications/@me` to discover the application ID; a stale token will fail here too. Re-run `store-bot-token.ts`.

## Token Notes

- Bot tokens **do not expire** automatically.
- Resetting a token in the developer portal **immediately invalidates** the old one. All running connections using the old token will be disconnected.
- If the application is deleted, all its tokens are immediately revoked.
- Intent changes take effect on the **next gateway reconnect**, with no token reset needed. This integration requests no privileged intents, so toggling them in the portal changes nothing about what it receives.

## Removing the Bot

- To remove the bot from a single server, the server owner kicks it from the member list (or revokes the bot's role with no `Kick Members` permission).
- To revoke globally, click **Reset Token** in the developer portal — every existing client using the old token will get a 401 on next request.
- To delete the application entirely, use **Delete App** at the bottom of the General Information page.
