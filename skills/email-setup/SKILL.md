---
name: email-setup
description: Set up this assistant's own `[name].vellum.me` domain and email address (one-time setup)
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📧"
  vellum:
    display-name: "Email Setup"
    feature-flag: "email-channel"
---

You are setting up your own custom domain and email address. This is a one-time operation — once you have a domain and email, you do not need to run this again.

## Prerequisites

Only proceed if the user explicitly asks you to create or set up **your own** (the assistant's) email address — e.g., "set up your email", "create your email address", "I want you to have your own email". Generic email requests like "send an email", "check my email", or "set up email" are about the **user's personal email** and should be handled by the Messaging skill, not this one. Do NOT proactively run this skill.

## Step 1: Check if Domain & Email Already Exist

```bash
assistant domain status --json
assistant email status --json
```

If both commands show an active domain and email address, tell the user the existing address and stop.

If an email exists but no domain, the email was set up under the legacy shared domain — it still works. Ask the user if they want to keep it or migrate to a custom subdomain.

## Step 2: Register Your Domain

Each assistant gets its own subdomain (e.g. `mybot.vellum.me`). This must be registered before creating an email address.

```bash
assistant domain register <subdomain>
```

For `<subdomain>`, use your assistant name (lowercased, alphanumeric, hyphens allowed). Check your identity from `IDENTITY.md` to determine your name. If you don't have a name yet, ask the user what subdomain they'd like.

If the domain is already registered, `domain status` will show it — skip to Step 3.

## Step 3: Register Your Email

Once the domain is active, register your email username on that domain:

```bash
assistant email register <username>
```

This creates `<username>@<subdomain>.vellum.me`. Use the same name as your subdomain for simplicity (e.g. `mybot@mybot.vellum.me`), or ask the user if they prefer a different local part.

## Step 4: Verify Status

```bash
assistant email status --json
```

Confirm the address is active.

## Step 5: Confirm Setup

1. Tell the user your new email address.
2. Store a note in your memory that your domain and email have been provisioned.

## Rules

- **One-time only.** If a domain and email already exist, do not register another.
- **Domain first.** `email register` will fail if no domain is registered. Always check/register the domain before the email.
- **User-initiated only.** Never run this skill unless the user asks.
- **No API key prompting.** Email is handled through the Vellum platform — no provider API keys or DNS configuration needed.

## Troubleshooting

### Domain registration failed

If `assistant domain register` returns an error (e.g. subdomain taken), try a variation (append a number or use a nickname) and retry once. If it still fails, report the error to the user.

### Email registration failed

If `assistant email register` returns an error:

- **"No domain registered"** — run `assistant domain register` first.
- **Username taken** — try a different local part.
- **Other errors** — report the error to the user.

## Email Management

Once set up, the assistant has full email capabilities:

| Command                                               | Description                                            |
| ----------------------------------------------------- | ------------------------------------------------------ |
| `assistant email send <to...> -s "Subject" -b "Body"` | Send an email (supports `--cc`, `--bcc`, `--reply-to`) |
| `assistant email list`                                | List sent and received emails                          |
| `assistant email download <id>`                       | Download a specific email                              |
| `assistant email status`                              | Check email address status and usage                   |
| `assistant email unregister --confirm`                | Remove the email address                               |
