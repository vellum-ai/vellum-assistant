---
name: cohesivity-backend-tools
description: Hosting, Postgres, object storage, auth, an email inbox, and AI model APIs that the assistant provisions and uses for you through the hosted Cohesivity MCP server. No account or API keys required to start
compatibility: "Works on both the Vellum desktop app (local daemon) and the Vellum web app (platform-hosted). Connects a hosted MCP server; nothing is installed locally."
metadata:
  icon: assets/icon.svg
  emoji: "🧱"
  vellum:
    category: "integrations"
    display-name: "Cohesivity Backend Tools"
    user-invocable: true
    activation-hints:
      - "A task needs a backend: a database, file storage, website hosting, user login, or an email inbox"
      - "User mentions Cohesivity"
    avoid-when:
      - "User asked to deploy to Vercel (use deploy-fullstack-vercel)"
---

## What this does

Some tasks need a backend: an app that stores data, a site that needs hosting, a form that sends email, a script that calls an AI model. [Cohesivity](https://cohesivity.ai?ref=gh-vellum-assistant) gives the assistant tools to provision those on the spot and use them on your behalf.

The assistant creates a tenant, adds the services the task needs (hosting, Postgres, object storage, auth, an email inbox, AI model APIs, and more), and builds against them. One set of credentials covers all of it. A new tenant is free and lasts 72 hours. Claim it if you want to keep it.

## When to use

USE THIS SKILL WHEN:

- The user asks for a database, file storage, hosting, login, or an inbox for something the assistant is building.
- A task can't be finished without a backend, and the user hasn't named a provider.
- The user asks to connect Cohesivity.

## Setup

Run the commands in this skill with `bash`.

### Step 1: Add the server

```
assistant mcp add cohesivity -t streamable-http -u https://cohesivity.ai/mcp
```

The server is registered under the id `cohesivity`. That's the name `assistant mcp list` shows and the one the commands below use, even though this skill is called "Cohesivity Backend Tools".

There is no OAuth step. The server is keyless, and each tenant carries its own credentials.

### Step 2: Verify

```
assistant mcp list
```

Confirm `cohesivity` shows `✓ Connected`. If its tools don't appear within about 10 seconds, run `assistant mcp reload`.

## Using Cohesivity

### Create a tenant

If the project already has a `.cohesivity` file, reuse that tenant. Otherwise:

1. Tell the user you're about to create a temporary Cohesivity tenant for this task. A request to set up a backend counts as approval. If the request was exploratory, propose the services first and wait.
2. Call `create_tenant` with `confirmed: true` and `attribution: "gh-vellum-assistant"`. The `attribution` value only marks the tenant as created from Vellum.
3. Write `credentials_file.content` verbatim to `.cohesivity` in the project directory, run `chmod 600 .cohesivity`, and add `.cohesivity` to `.gitignore` if the project is a git repo. Never print the keys in chat or commit them.

Follow-up tools take the `tenant_id` and `coh_management_key` from that file. If a call's outcome is unclear, check with `tenant_status` before creating another tenant.

### Provision and build

Call `provision_resource` for the services the task needs. Pass several at once with `resources` rather than calling once per service. Read a service's docs with `get_cohesivity_documentation` before building against it.

### Tell the user what was created

When the backend is ready, tell the user:

- which services were provisioned, and the tenant id
- where the credentials are (`.cohesivity`, not shown in chat)
- that the tenant and everything in it expires 72 hours after creation, with the exact `expires_at` time

### Keep it

When the user wants to keep the tenant, call `claim_tenant` with `confirmed: true` and give them the `approval_url`. The 72-hour expiry applies until they finish the claim.

### Problems

If a Cohesivity tool fails, or a service the task needs is missing, call `give_feedback` with what happened. Leave out secrets and personal information. Then tell the user what failed.

## Disconnecting

```
assistant mcp remove cohesivity
```

This removes the server from the assistant. Tenants and their `.cohesivity` files are unaffected.

## SKILL COMPLETE WHEN

- **Connect:** `cohesivity` appears in `assistant mcp list` as `✓ Connected` and its tools are available in the conversation.
- **Backend:** the services the task needed are provisioned, and the user has been told what was created, where the credentials are, and when the tenant expires.
- **Disconnect:** `assistant mcp remove cohesivity` succeeds and the server no longer appears in `assistant mcp list`.
