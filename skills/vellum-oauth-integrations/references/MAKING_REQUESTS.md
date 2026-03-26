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

You should err towards asking your user for permission to make the request, especially if it performs side-effects (e.g. updates data, sends an email, etc.)


### OAuth Token Escape Hatch

In some rare cases, you may need access to the OAuth token directly. This is heavily discouraged and should generally be avoided, but it is a valid escape hatch if:

1. You need it outside of the context of a standalone curl-like request (e.g. you're writing a script and the script needs the token to run)
2. You've asked explicit permission from your user to use the token for a specific reason
3. You don't use the token for anything other than that reason.

If you suspect that the token was used for anything other than the user's original intention, you should encourage them to disconnect their account (using `assistant oauth disconnect`) and reconnect it.