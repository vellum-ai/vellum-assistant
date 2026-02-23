---
name: "Email Setup"
description: "Create the assistant's own email address via the Vellum hosted API (one-time setup)"
user-invocable: true
metadata: {"vellum": {"emoji": "📧"}}
---

You are setting up your own personal email address. This is a one-time operation — once you have an email, you do not need to run this again.

## Prerequisites

Only proceed if the user explicitly asks you to create or set up your email address. Do NOT proactively run this skill.

## Step 1: Check if Email Already Exists

Before doing anything, check whether you already have an email address configured:

```bash
vellum email inbox list --json
```

If the response contains one or more inboxes, you already have an email address. Tell the user your existing email address and stop — do NOT create another one.

## Step 2: Create Your Email

Call the Vellum hosted API to provision your email. Use `host_bash` to make the request:

```bash
vellum email inbox create --username <your-name> --json
```

For `<your-name>`, use your assistant name (lowercased, alphanumeric only). Check your identity from `IDENTITY.md` or `USER.md` to determine your name. If you don't have a name yet, ask the user what username they'd like for your email.

The inbox will be created on the default AgentMail domain (e.g. `<your-name>@agentmail.to`).

## Step 3: Confirm Setup

After the inbox is created successfully:

1. Parse the JSON response to extract your new email address.
2. Tell the user your new email address.
3. Store a note in your memory or `USER.md` that your email has been provisioned so you remember it in future conversations.

## Rules

- **One-time only.** If an inbox already exists (Step 1), do not create another. Inform the user of the existing address.
- **User-initiated only.** Never run this skill unless the user asks you to set up or create an email.
- **No custom domains.** Use the default provider domain. Do not attempt domain setup.
- **No API key prompting.** The AgentMail API key should already be configured. If the `vellum email` command fails with an API key error, tell the user the AgentMail integration is not yet configured and suggest loading the `agentmail` skill for full setup instructions.

## Troubleshooting

### API key not configured
If you get an error about a missing API key, the AgentMail provider has not been set up. Tell the user:
> "AgentMail isn't configured yet. Would you like me to walk you through the full email setup? I can load the email configuration guide."

Then load the `agentmail` skill for detailed setup instructions.

### Inbox creation failed
If inbox creation returns an error (e.g. username taken), try a variation of the name (append a number or use a nickname) and retry once. If it still fails, report the error to the user.
