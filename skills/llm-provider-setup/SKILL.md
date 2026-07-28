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

**Run the steps strictly sequentially — one command per step, and read its output before running the next.** Never batch create → verify → activate into a single turn: creation can fail validation, verification can fail on a wrong model id or missing credential, and activation must not happen until verification passed. Each step's output is the gate for the next one.

## Step 0 — Check what's already available (avoid collecting keys unnecessarily)

Managed (platform-credentialed) routing may already cover the user's need — no API key required:

```bash
assistant inference providers list          # provider entries; `vellum` is the platform-managed route
assistant inference providers default       # default provider + availability status
assistant inference profiles list           # effective profiles: managed + user, with availability
```

**Managed first.** If the user is signed in to Vellum and the model they asked for is served by the managed route, build the profile on it — `--provider vellum --model <model-id>`, no `--connection`, no credential, nothing to prompt for. Skip Steps 1 and 2 entirely and go to Step 3; there is no key to collect. If the model turns out not to be managed-routable, profile creation says so explicitly (Step 4) — only then fall back to key collection.

Collect an API key only when there is genuinely no managed option: the user is not signed in to Vellum, the model is not served by the managed route, or the user explicitly wants to use their own key.

## Step 1 — Reuse an existing key, or securely collect a new one

Before prompting the user for anything, check whether a suitable key is already stored:

```bash
assistant credentials list
```

If a credential for the target provider exists, reuse it — reference it by vault path in Step 2 and skip the prompt. Only collect a new key when none exists (or the user explicitly wants to replace it).

**Never ask for secrets in chat, and never send the user to the Settings page for this.** The key must not enter the conversation, and the collection happens inline in the current conversation — the secure prompt renders a masked input right where the user already is:

```bash
assistant credentials prompt --service <provider> --field api_key \
  --label "<Provider> API Key" --placeholder "sk-..."
```

Exit code `0` = stored; exit code `130` = the user dismissed the prompt (a valid choice, not an error — ask whether they want to try again or stop). Any other non-zero exit is a real error.

## Step 2 — Create the provider connection

Reference the stored credential by vault path — the assistant only ever handles the reference string:

```bash
assistant inference providers create <connection-name> \
  --provider <provider> \
  --auth api_key \
  --credential credential/<provider>/api_key
```

For self-hosted or OpenAI-compatible endpoints, use `--provider openai-compatible` and supply the endpoint's base URL plus at least one model id (both are required for this provider type — the endpoint advertises no fixed catalog). Pass `--model` once per model the endpoint serves:

```bash
assistant inference providers create <connection-name> \
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

On the managed route (Step 0), there is no connection to name:

```bash
assistant inference profiles create <profile-name> \
  --provider vellum \
  --model <model-id> \
  --label "<Display Name>"
```

On a BYO key, point the profile at the connection from Step 2:

```bash
assistant inference profiles create <profile-name> \
  --provider <provider> \
  --model <model-id> \
  --connection <connection-name> \
  --label "<Display Name>"
```

**Always pass `--label` with the human-readable model name** (e.g. `"Gemini 3.6 Flash"`, `"Claude Opus 5"`) — the label is what the model picker and chat composer display, so a missing or terse one surfaces a raw config key like `gemini-latest` to the user. When `--label` is omitted the daemon falls back to the catalog's display name for the model, but an explicit label is better when the user asked for something specific ("my fast model"). The profile _name_ stays a short kebab-case key.

Creation validates the provider, model id (against the catalog — pass `--allow-unlisted` only for a model you already probed in Step 3), and connection existence. It also refuses a profile that provably cannot dispatch — no connection, no stored key, or a model the managed route does not serve — so an unusable profile can never reach the chat model. Read the refusal message and fix the underlying gap (go back to Step 0 or Step 1); it names what is missing. Optional tuning flags: `--effort`, `--max-tokens`, `--temperature`, `--thinking on|off`.

## Step 5 — Verify with a live call (mandatory)

Prove the whole chain — credential, connection, provider routing, model id — with one real call:

```bash
assistant inference send --profile <profile-name> --max-tokens 32 --json "Reply with OK"
```

If this fails, fix the profile before telling the user it is set up, and before Step 6 — a profile that has not answered a live call must not become the chat model. Common failures: wrong model id (provider 4xx — go back to Step 3), missing/mistyped credential reference (auth error — check `assistant credentials list`), connection name typo (`assistant inference providers get <name>`).

## Step 6 — Put it to use

Only after Step 5 returned a real response:

- Make it the chat model: `assistant inference profiles active <profile-name>` — refused for a profile that cannot dispatch, so a failed Step 5 leaves the user's working chat model untouched.
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
