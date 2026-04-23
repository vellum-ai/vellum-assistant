# Updating Scopes

After a user has connected their account, you may discover that the connection doesn't have the scopes needed for a particular action. This is expected — connections should start with the bare minimum scopes and be upgraded only when needed.

## Recognizing When Scopes Need Updating

You'll typically encounter this when:

- An API request returns a `403 Forbidden` or `401 Unauthorized` error indicating insufficient permissions
- The provider's API response includes a message about missing scopes or insufficient privileges
- You're about to perform an action that requires a scope the user hasn't granted yet

You can check what scopes were granted on the current connection with:

```bash
assistant oauth status <provider-key>
```

Compare the granted scopes against what the provider's API requires for the action you're trying to perform. You can see what scopes are available for a provider with:

```bash
assistant oauth providers get <provider-key>
```

## Updating Scopes

To update the scopes on a connection, disconnect the existing account and reconnect with the updated scopes:

1. Disconnect the current connection:

```bash
assistant oauth disconnect <provider-key>
```

If there are multiple connected accounts, specify which one:

```bash
assistant oauth disconnect <provider-key> --account <account-identifier>
```

2. Reconnect with the scopes needed for the task at hand:

```bash
assistant oauth connect <provider-key> --scopes <scope1> <scope2> ...
```

The user will be prompted to log in again and authorize the new set of scopes.

**Important:** When reconnecting, include all scopes the user needs — both the ones they had before and any new ones. The `--scopes` flag replaces the provider's defaults entirely, so omitting a previously-granted scope means losing access to it.

## Best Practices

- **Explain to the user why you need additional scopes.** Tell them what action you're trying to perform and what permission it requires before asking them to reconnect.
- **Request only what you need.** Don't preemptively request every available scope — only the ones required for the task the user is asking you to do right now.
- **Batch scope upgrades when possible.** If you know the user's goal will require multiple new scopes, request them all in a single reconnect rather than disconnecting and reconnecting repeatedly.
