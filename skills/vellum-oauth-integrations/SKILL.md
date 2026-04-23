---
name: vellum-oauth-integrations
description: Act on behalf of your user in any third-party software that supports OAuth 2.0
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔌"
  vellum:
    display-name: "Vellum OAuth Integrations"
---

## Using OAuth Integrations

Integrating with a third-party software via OAuth is typically used to perform actions on behalf of the user. It involves having the user log in using their own credentials, specifying the scopes that they want to provide, and then afterwards, API requests can be made on their behalf.

**Important:** Avoid reaching for an OAuth integration if your intent is to act as yourself rather than as your user.

## The Assistant OAuth CLI

You are provided with the `assistant oauth` CLI for performing all necessary oauth-related actions.

**Important:** When in doubt how a command works or how to do something, read the references at the bottom. Never guess at how the CLI works. Read references and use the `--help` flag for any command you're about to run.

## Viewing Available OAuth Providers

Vellum assistants can natively integrate with any application that supports OAuth 2.0. Many OAuth providers come pre-configured and ready to use. You can view them by running:

```bash
assistant oauth providers list
```

You can also search for specific providers. Here's an example that searches for the "google" provider:

```bash
assistant oauth providers list --provider-key google
```

## Managed vs Your-Own Mode

All providers support "your-own" mode and some support "managed" mode.

### Managed Mode

"managed" mode relies on a first-class integration with the Vellum Platform. Managed mode is typically easier to set up and get going, often only requiring the user to log in with no additional configuration needed before they can begin using the integration. Managed mode is the recommended method for most users, especially those that are less technical or newer to their Vellum assistant.

Note that using managed mode:

- Requires an account with the Vellum Platform
- May result in billable usage
- Requires that requests to the third party are sent through Vellum's servers

### Your-Own Mode

"your-own" mode requires that the user creates their own OAuth application directly with the third-party and then enter the application's Client ID and Client Secret into Vellum.

Your-own mode is typically best if:

- Vellum does not have a first-party integration with the provider and managed mode is not supported
- The user is more tech-savvy and comfortable setting up OAuth apps
- The user does not want to create an account with the Vellum Platform
- The user is more sensitive to potential billing implications
- The user is sensitive to their data going to the Vellum Platform

### Differentiating & Setting a Provider's Mode

You can determine whether a given provider supports managed mode based on the details returned by:

```bash
# Find the provider of interest in the list response
assistant oauth providers list

# Or, return just the provider of interest with their details
assistant oauth providers get <provider-key>
```

You can determine what mode the provider is currently set to use with:

```bash
assistant oauth mode <provider-key>
```

You can update which mode a given provider should use with:

```bash
assistant oauth mode <provider-key> --set "managed"|"your-own"
```

## Troubleshooting

### Permission / Insufficient Scope Errors

If an API request returns a `403 Forbidden`, `401 Unauthorized`, or a message about missing scopes, the connection likely doesn't have the scopes needed for that action. See [Updating Scopes](references/UPDATING_SCOPES.md) for how to disconnect and reconnect with the required scopes.

# Reference

For detailed information on the following topics, see the reference files:

- **[Registering New OAuth Providers](references/REGISTERING_PROVIDERS.md)** - How to register a new OAuth provider that doesn't come with Vellum's defaults
- **[Configuring a New OAuth Application](references/CONFIGURING_APPLICATIONS.md)** - How to configure a user-managed OAuth Application for providers whose mode is set to "your-own"
- **[Connecting Accounts](references/CONNECTING_ACCOUNTS.md)** - How to direct the user to log in and create a new OAuth connection
- **[Updating Scopes](references/UPDATING_SCOPES.md)** - How to update the scopes on an existing connection when additional permissions are needed
- **[Making Requests on Behalf of the User](references/MAKING_REQUESTS.md)** - How to make requests and take actions on behalf of the user once they have connected their account
