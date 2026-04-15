---
name: email-setup
description: Register the assistant's own @vellum.me email address (one-time setup)
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📧"
  vellum:
    display-name: "Email Setup"
    feature-flag: "email-channel"
---

You are setting up your own personal email address. This is a one-time operation — once you have an email, you do not need to run this again.

## Prerequisites

Only proceed if the user explicitly asks you to create or set up **your own** (the assistant's) email address — e.g., "set up your email", "create your email address", "I want you to have your own email". Generic email requests like "send an email", "check my email", or "set up email" are about the **user's personal email** and should be handled by the Messaging skill, not this one. Do NOT proactively run this skill.

## Step 1: Check if Email Already Exists

```bash
assistant email status --json
```

If the command returns an address and status "active", tell the user the existing address and stop — do NOT register another one.

## Step 2: Register Your Email

```bash
assistant email register <your-username>
```

For `<your-username>`, use your assistant name (lowercased, alphanumeric only). This creates `<username>@vellum.me`. Check your identity from `IDENTITY.md` to determine your name. If you don't have a name yet, ask the user what username they'd like.

## Step 3: Verify Status

```bash
assistant email status --json
```

Confirm the address is active.

## Step 4: Confirm Setup

1. Tell the user your new email address.
2. Store a note in your memory that your email has been provisioned.

## Rules

- **One-time only.** If an address already exists (Step 1), do not register another.
- **User-initiated only.** Never run this skill unless the user asks.
- **No API key prompting.** Email is handled through the platform — no provider API keys needed.

## Troubleshooting

### Registration failed

If `assistant email register` returns an error (e.g. username taken), try a variation of the name (append a number or use a nickname) and retry once. If it still fails, report the error to the user.
