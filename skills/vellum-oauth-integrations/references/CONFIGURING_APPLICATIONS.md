# Configuring a New OAuth Application

Read this section to learn about how to register a new OAuth application for an existing provider.

Note that this section is only applicable for providers whose mode is set to "your-own". If the provider's mode is set to "managed" then you do not need to create an OAuth application.

If you're trying to create an OAuth application for a provider that doesn't yet exist, see [Registering New OAuth Providers](REGISTERING_PROVIDERS.md).

## Evaluating if Custom OAuth Apps Are a Good Fit

Your user will need to manually create the OAuth application in the third party's web UI. This process is typically more technical in nature. Before embarking on it, check to see if Vellum supports the provider-of-interest in their managed offerings:

```bash
assistant oauth providers get <provider-key> --json | jq -r '.managedServiceConfigKey'
```

If so, encourage the user to start with using managed mode, especially if they seem less technical.

## Creating the OAuth App in the Third Party Software

Check if a provider-specific setup guide exists at `provider-app-setups/<provider>.md` in this skill's references directory. If it does, read it and follow its instructions to guide the user through creating the OAuth app.

If no provider-specific guide exists, perform web searches for provider-specific instructions using search terms like "how to create an oauth 2.0 application in <provider>".

Guide your user the best you can through the process of creating the app.

You'll know they've succeeded once they're able to see a "Client ID" and "Client Secret" that they can provide to you.

## Registering the OAuth App

Once your user has gone through the setup process and has a Client ID and Client Secret handy, you're ready to register the OAuth app for use.

**Step 1: Collect Client ID and Client Secret together**

Present BOTH the conversational Client ID request AND the `assistant credentials prompt` for the Client Secret in the same turn. Do not wait for the Client ID before showing the secret form. Output the chat text first asking for the Client ID, then run `assistant credentials prompt` (via the bash tool) in the same turn.

Presenting both inputs together lets the user fill them in while the provider's credentials page is still open, instead of requiring a round-trip between each field.

In your message, ask the user to paste the Client ID in chat (this is safe — Client ID is not a secret value), and simultaneously open the secure prompt for the Client Secret:

```bash
assistant credentials prompt --service <provider-key> --field client_secret \
  --label "OAuth Client Secret" \
  --placeholder "..." \
  --description "Copy the Client Secret from the app credentials page and paste it here."
```

Do NOT collect the client secret conversationally. Never solicit the secret in chat and never store a chat-pasted value with `assistant credentials set`. Always collect it through the secure `assistant credentials prompt` flow so it never transits the conversation.

### Prompt outcomes

`assistant credentials prompt` has three outcomes, and only one of them stores the value. Check the exit code before Step 2. The Client ID may be requested in the same turn the prompt is opened (see the guidance above about presenting both inputs together); it is only the registration in Step 2 that has to wait for the outcome.

- **Exit `0`** - the secret is stored. Proceed to Step 2.
- **Exit `75`** - the channel has no secure input surface, so the command generated a one-time collection link instead and printed it. Nothing is stored yet. Relay that link to the user in-channel, tell them the value is entered on that page rather than in chat, and wait for them to say they are done. Then verify the credential exists before Step 2:

  ```bash
  assistant credentials inspect --service <provider-key> --field client_secret
  ```

  `inspect` masks the value (it shows only the first 4 characters), so it confirms storage without revealing the secret. If the credential is still missing, the user has not finished the page: ask again rather than registering the app.

- **Exit `130`** - the user dismissed the prompt. Nothing is stored. This is a valid choice, not a failure: ask whether they want to try again or stop.
- **Any other non-zero exit** - a real error. Report it and troubleshoot before continuing.

**Step 2: Register the app**

After both values are collected, create the app using the CLI, subbing out values for `<provider-key>` and `<client-id>`:

```bash
assistant oauth apps upsert --provider <provider-key> --client-id <client-id> --client-secret-credential-path "<provider-key>:client_secret"
```

## Connecting Accounts

Once the OAuth app has been created and registered, it's ready to be connected to. Creating a connection is the last step needed before you're able to make requests to the provider.

For details on how to connect, see [Connecting Accounts](CONNECTING_ACCOUNTS.md).
