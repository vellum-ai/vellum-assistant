# Connecting Accounts

Your user must connect their account for you to be able to make requests on their behalf. This typically requires that they sign in to the third-party provider using their own credentials through a typical OAuth flow.

## Pre-Requisites

Before the user can connect to a provider, they must have it in one of two states:

1. **Managed mode** (preferred when supported), or
2. **Your-own mode** with at least one OAuth app already created.

### Step 1: Check whether managed mode is supported

```bash
assistant oauth providers get <provider-key> --json | jq -r '.managedServiceConfigKey'
```

If this returns a non-null value, managed mode is supported. Unless the user has already chosen your-own mode for a deliberate reason, prefer managed mode.

### Step 2: Check the current mode

```bash
assistant oauth mode <provider-key> --json | jq -r '.mode'
```

- **Returns `managed`**: proceed to "Initiating the Connection".
- **Returns `your-own` and managed mode IS supported**: ask the user whether they'd like to switch to managed mode (it's simpler — no app to create). If yes, run `assistant oauth mode <provider-key> --set managed` and proceed. If no, continue to Step 3.
- **Returns `your-own` and managed mode is NOT supported**: continue to Step 3.

Do not perform this step if the user already has an active connection — `assistant oauth status <provider-key>` returning a live connection means the user has already chosen a mode; respect it.

### Step 3: Verify your-own setup (only if you reached this step)

Check whether at least one OAuth app exists:

```bash
assistant oauth apps list --provider-key <provider-key>
```

If there are none, see [Configuring a New OAuth Application](CONFIGURING_APPLICATIONS.md).

## Choosing Scopes

For managed mode, do not choose or display scopes yourself. Managed providers use the platform's configured scopes, and the chat surface handles the connection affordance.

For your-own mode, consider what the user is trying to accomplish and request only the scopes needed for that task. You can see what scopes are available for a provider with:

```bash
assistant oauth providers get <provider-key>
```

**Always request the bare minimum scopes needed for the task at hand.** For example, if the user only wants to read their calendar, don't also request write access. If they only need to view emails, don't request send permissions. This follows the principle of least privilege and builds trust with the user — they'll see exactly what they're granting on the provider's consent screen.

If the user later needs additional scopes for a different task in your-own mode, you can disconnect and reconnect with updated scopes. See [Updating Scopes](UPDATING_SCOPES.md) for details.

## Initiating the Connection

### Managed mode: show the in-chat connect surface

If the provider is in managed mode, use `ui_show` with `surface_type: "oauth_connect"`. This is the same managed connection path available through Settings, but presented in chat at the moment the task needs it.

Use a short task-specific description, and let the client own the action label. Do not include scopes, raw OAuth URLs, or a custom connect button label in the surface.

```json
{
  "surface_type": "oauth_connect",
  "title": "Connect Google",
  "data": {
    "providerKey": "google",
    "displayName": "Google",
    "description": "Connect Gmail, Calendar, and Drive for this task."
  }
}
```

Wait for the user to complete or dismiss the surface before proceeding. If they connect, verify the connection before making requests. If they dismiss it, continue only if the task can proceed without that account.

### Your-own mode: run the CLI connect command

If the provider is in your-own mode, initiate the connection with the OAuth provider by running:

```bash
assistant oauth connect <provider-key> --scopes <scope1> <scope2> ...
```

This will open a new web browser tab where the user can log in to the third-party provider. Upon success, they should be redirected to a confirmation page and told that it's safe to close the browser tab and come back here.

## Verification

You can verify that the connection was successfully created and you're ready to start making requests with:

```bash
assistant oauth status <provider-key>
```

Lastly, you can ping the provider to actually make a request and be certain that the connection works fully:

```bash
assistant oauth ping <provider-key>
```

## Connecting Multiple Accounts

It is totally valid for the user to want to connect multiple accounts to the same provider/app. For example, they may want to connect both their personal and work email.

After they've done so, you should see those multiple connections returned when you run:

```bash
assistant oauth status <provider-key>
```

When there are multiple connected accounts, you'll later need to specify which account to use for certain `assistant oauth` CLI commands. For example, the `ping` request becomes:

```bash
assistant oauth ping <provider-key> --account <account-identifier>
```

Where `<account-identifier>` is a provider-specific identifier for the account (e.g. in the case of google, this is the user's email address).

## Disconnecting Accounts

The user may later want to disconnect an account. You should happily do this via:

```bash
assistant oauth disconnect <provider-key>
```

If there are multiple connected accounts, you will need to provide the `--account` flag to specify which you want to disconnect.

## Making Requests

Once an account has been connected, you're all set to start making requests and performing actions on behalf of the user.

For details, see [Making Requests on Behalf of the User](MAKING_REQUESTS.md).
