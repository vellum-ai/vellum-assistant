---
name: "llm-provider-setup"
description: "Set up a new LLM provider connection, discover valid model ids, create and validate a model profile — securely and end-to-end via CLI. Covers managed vs BYO keys, secure credential collection, model discovery, profile creation, and live verification."
metadata:
  emoji: "🔌"
  vellum:
    category: "development"
    display-name: "LLM Provider Setup"
---

## Overview

This skill is the canonical procedure for adding a new LLM provider, model, or inference profile to a Vellum assistant. Follow the steps in order — each step's output feeds the next, and the final live-call verification is mandatory. Never skip ahead by writing raw config JSON.

## Step 0 — Check what's already available (avoid collecting keys unnecessarily)

Managed (platform-credentialed) connections may already cover the user's need — no API key required:

```bash
assistant inference providers connections list
assistant inference providers default        # default provider + availability status
assistant inference profiles list           # effective profiles: managed + user, with availability
```

If a managed connection for the desired provider exists and is available, skip to Step 3 (create a profile against it). Only collect an API key when the user wants a provider/tier the managed connections don't cover, or explicitly wants to use their own key.

## Step 1 — Reuse an existing key, or securely collect a new one

Before prompting the user for anything, check whether a suitable key is already stored:

```bash
assistant credentials list
```

If a credential for the target provider exists, reuse it — reference it by vault path in Step 2 and skip the prompt. Only collect a new key when none exists (or the user explicitly wants to replace it).

**Never ask for secrets in chat.** The key must not enter the conversation. Use the secure prompt:

```bash
assistant credentials prompt --service <provider> --field api_key \
  --label "<Provider> API Key" --placeholder "sk-..."
```

Exit code `0` = stored; exit code `130` = the user dismissed the prompt (a valid choice, not an error — ask whether they want to try again or stop). Any other non-zero exit is a real error.

## Step 2 — Create the provider connection

Reference the stored credential by vault path — the assistant only ever handles the reference string:

```bash
assistant inference providers connections create <connection-name> \
  --provider <provider> \
  --auth api_key \
  --credential credential/<provider>/api_key
```

For self-hosted or OpenAI-compatible endpoints, use `--provider openai-compatible` and supply the endpoint's base URL plus at least one model id (both are required for this provider type — the endpoint advertises no fixed catalog). Pass `--model` once per model the endpoint serves:

```bash
assistant inference providers connections create <connection-name> \
  --provider openai-compatible \
  --auth api_key \
  --credential credential/<provider>/api_key \
  --base-url https://<host>/v1 \
  --model <model-id> \
  --model <another-model-id>
```

For a local, keyless endpoint (e.g. LM Studio, vLLM) use `--auth none` and drop `--credential`. The managed Vellum connection is not editable — create a new named connection instead of modifying it.

## Step 3 — Discover a valid model id (do not guess)

Model ids are the most common failure point — never write one from memory:

```bash
assistant inference models list --provider <provider>
```

Pick from the catalog output. If the user wants a model not in the catalog (e.g. brand new or self-hosted), probe it with a live call before configuring anything:

```bash
assistant inference send --model <candidate-id> --max-tokens 32 "Reply with OK"
```

## Step 4 — Create the profile

```bash
assistant inference profiles create <profile-name> \
  --provider <provider> \
  --model <model-id> \
  --connection <connection-name> \
  --label "<Display Name>"
```

Creation validates the provider, model id (against the catalog — pass `--allow-unlisted` only for a model you already probed in Step 3), and connection existence. Optional tuning flags: `--effort`, `--max-tokens`, `--temperature`, `--thinking on|off`.

## Step 5 — Verify with a live call (mandatory)

Prove the whole chain — credential, connection, provider routing, model id — with one real call:

```bash
assistant inference send --profile <profile-name> --max-tokens 32 --json "Reply with OK"
```

If this fails, fix the profile before telling the user it is set up. Common failures: wrong model id (provider 4xx — go back to Step 3), missing/mistyped credential reference (auth error — check `assistant credentials list`), connection name typo (`assistant inference providers connections get <name>`).

## Step 6 — Put it to use

- Make it the chat model: `assistant inference profiles active <profile-name>`
- Use it for one conversation: `assistant inference session open <profile-name> --ttl 30m`
- Pin a specific background task to it: see the **llm-cost-optimizer** skill for call-site pinning and cost trade-offs before pinning anything.

## Reference: inspection commands

```bash
assistant inference profiles list [--json]      # effective profile catalog + availability
assistant inference profiles get <name>
assistant inference callsites list [--json]     # which profile each call site resolves to, default vs pinned
assistant inference callsites get <site>        # full resolution chain for one call site
assistant credentials list                       # stored credential names (never values)
```
