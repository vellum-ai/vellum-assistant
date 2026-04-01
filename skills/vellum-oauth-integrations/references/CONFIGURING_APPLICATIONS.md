# Configuring a New OAuth Application

Read this section to learn about how to register a new OAuth application for an existing provider.

Note that this section is only applicable for providers whose mode is set to "your-own". If the provider's mode is set to "managed" then you do not need to create an OAuth application.

If you're trying to create an OAuth application for a provider that doesn't yet exist, see [Registering New OAuth Providers](REGISTERING_PROVIDERS.md).

## Evaluating if Custom OAuth Apps Are a Good Fit

Your user will need to manually create the OAuth application in the third party's web UI. This process is typically more technical in nature. Before embarking on it, check to see if Vellum supports the provider-of-interest in their managed offerings:

```bash
assistant oauth providers get <provider-key> | jq -r '.managedServiceConfigKey'
```

If so, encourage the user to start with using managed mode, especially if they seem less technical.

## Creating the OAuth App in the Third Party Software

Check if a provider-specific setup guide exists at `provider-app-setups/<provider>.md` in this skill's references directory. If it does, read it and follow its instructions to guide the user through creating the OAuth app.

If no provider-specific guide exists, perform web searches for provider-specific instructions using search terms like "how to create an oauth 2.0 application in <provider>".

Guide your user the best you can through the process of creating the app.

You'll know they've succeeded once they're able to see a "Client ID" and "Client Secret" that they can provide to you.

## Registering the OAuth App

Once your user has gone through the setup process and has a Client ID and Client Secret handy, you're ready to register the OAuth app for use.

**Step 1:**
Prompt the user to enter the Client ID conversationally through chat. This is safe because Client ID is not a secret value.

**Step 2:**
Securely collect the Client Secret using:

```
credential_store prompt:
  service: "<provider-key>"
  field: "client_secret"
  label: "OAuth Client Secret"
  description: "Copy the Client Secret from the app credentials page and paste it here."
  placeholder: "..."
```

Do NOT collect the client secret conversationally.

**Step 3:**
Create the app using the CLI, subbing out values for `<provider-key>` and `<client-id>`:

```bash
assistant oauth apps upsert --provider <provider-key> --client-id <client-id> --client-secret-credential-path "<provider-key>:client_secret"
```

## Connecting Accounts

Once the OAuth app has been created and registered, it's ready to be connected to. Creating a connection is the last step needed before you're able to make requests to the provider.

For details on how to connect, see [Connecting Accounts](CONNECTING_ACCOUNTS.md).
