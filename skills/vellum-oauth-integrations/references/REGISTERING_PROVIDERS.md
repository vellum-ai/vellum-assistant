# Registering New OAuth Providers

Vellum comes pre-configured with a number of providers, ready to use. However, you have the tools you need to register _any_ third-party software as a new OAuth provider, as long as it supports OAuth 2.0.


## When to Regsiter a New Provider
You should bias towards uisng an existing provider if available. View the list of them and their details using:

```bash
assistant oauth providers list
```

Or search for a specific provider using:
```bash
assistant oauth providers list --provider-key <search-term>
```

If you don't see the provider you're lookig for, or if its configuration isn't what you or your user desires, then it's totally valid to register your own custom provider.


## Registering a Custom Provider

### Collecting Provider Details
To see all the details that you'll need to register a new provider, run:

```bash
assistant oauth providers register --help
```

You or your user will need to find and provide these details. You are most likely to find them in the third party's developer documentation or in your prior knowledge.

Perform web searches and search for phrases like "integrating with <provider> oauth 2.0 in web applications" to find the proper documentation. If you struggle to find the details you need, ask your user for help.

If you later find that a mistake was made, you can either update the provider:

```bash
assistant oauth providers update <provider-key> ...
```

Or delete and recreate it:

```bash
assistant oauth providers delete <provider-key>
assistant oauth providers register ...
```

## Updating Providers
You generally should not need to update a previously registered provider. If you do, note that default providers are protected and will error upon attempted update.

In these cases, you can register a new provider and copy over the values you want to keep while making the changes you'd like.


## Using a Registered Provider
Once a new OAuth provider has been registered, OAuth applications can be created and associated with it.

For details, see [Configuring a New OAuth Application](references/CONFIGURING_APPLICATIONS.md).
