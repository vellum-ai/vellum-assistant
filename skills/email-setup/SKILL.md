---
name: email-setup
description: Create the assistant's own email address via the Vellum hosted API (one-time setup)
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📧"
  vellum:
    display-name: "Email Setup"
    feature-flag: "email-channel"
---

You are setting up your own personal email address. This is a one-time operation — once you have an email, you do not need to run this again.

## Prerequisites

Only proceed if the user explicitly asks you to create or set up **your own** (the assistant's) email address — e.g., "set up your email", "create your email address", "I want you to have your own email". Generic email requests like "send an email", "check my email", or "set up email" are about the **user's Gmail** and should be handled by the Messaging skill, not this one. Do NOT proactively run this skill.

## Step 1: Check if Email Already Exists

Before doing anything, check whether you already have an email address configured:

```bash
assistant email status
```

Inspect `health.inboxes` in the response. If at least one inbox exists, tell the user the existing address and stop — do NOT create another one.

## Step 2: Create Your Email

Create a new inbox through the CLI:

```bash
assistant email inbox create --username <your-username>
```

For `<your-username>`, use your assistant name (lowercased, alphanumeric only). Check your identity from `IDENTITY.md` or `USER.md` to determine your name. If you don't have a name yet, ask the user what username they'd like for your email.

Use the returned `inbox.address` (or `inbox.id` if `address` is empty) as the created email address.

## Step 3: Verify Status

```bash
assistant email status
```

Confirm the created inbox appears in `health.inboxes`.

## Step 4: Confirm Setup

After the inbox is created and visible in status:

1. Tell the user your new email address.
2. Store a note in your memory or `USER.md` that your email has been provisioned so you remember it in future conversations.

## Rules

- **One-time only.** If an inbox already exists (Step 1), do not create another. Inform the user of the existing address.
- **User-initiated only.** Never run this skill unless the user asks you to set up or create an email.
- **No custom domains.** Use the default provider domain. Do not attempt domain setup.
- **No API key prompting.** The email API key should already be configured. If the `assistant email` command fails with an API key error, tell the user the email integration is not yet configured and ask them to set it up.

## Troubleshooting

### API key not configured

If you get an error about a missing API key, the email provider has not been set up. Tell the user:

> "Email isn't configured yet. Please set up the email integration first."

### Inbox creation failed

If inbox creation returns an error (e.g. username taken), try a variation of the name (append a number or use a nickname) and retry once. If it still fails, report the error to the user.
