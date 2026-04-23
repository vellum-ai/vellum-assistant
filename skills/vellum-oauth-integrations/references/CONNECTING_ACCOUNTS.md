# Connecting Accounts

Your user must connect their account for you to be able to make requests on their behalf. This typically requires that they sign in to the third-party provider using their own credentials through a typical OAuth flow.

## Pre-Requisites

Before the user can connect to a provider, they must:

1. Have the provider configured to use "managed" mode, and the provider must support it; or
2. Have the provider configured to use "your-own" mode, and have created an OAuth app

Check to see what mode the provider is configured to use with:

```bash
assistant oauth mode <provider-key>
```

If set to "your-own", then check to see if at least one OAuth app has been created with:

```bash
assistant oauth apps list --provider-key <provider-key>
```

If there are none, they will either need to opt in to using "managed" mode or they will need to create an OAuth app (see [Configuring a New OAuth Application](CONFIGURING_APPLICATIONS.md)).

## Which References Apply

- If the provider is set to `managed`, stay in this document. Do **not** jump into `CONFIGURING_APPLICATIONS.md` or `provider-app-setups/<provider>.md` to invent an app-registration flow.
- Only use `provider-app-setups/<provider>.md` when the provider is set to `your-own` and you need instructions for creating the user's OAuth app.

## Initiating the Connection

To actually initiate a connection with the OAuth provider, run:

```bash
assistant oauth connect <provider-key>
```

**Tip:** You can optionally specify scopes using the `--scopes` flag. This is useful if you know ahead of time what your user is trying to accomplish and want to request the bare minimum scopes needed to accomplish the task at hand.

### Google on macOS desktop

On the macOS desktop app, Google consent should use a Chrome handoff instead of the default browser opener:

1. Run `assistant oauth connect google --no-browser`.
2. Open the returned authorization URL in the user's existing Google Chrome session.
3. Never use browser automation or computer-use for the Google consent screen.

This Chrome handoff rule applies when connecting Google in either `managed` or `your-own` mode. Creating Google Cloud credentials is still a `your-own`-only flow.

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
