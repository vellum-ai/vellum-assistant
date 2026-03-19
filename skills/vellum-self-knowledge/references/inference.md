# Inference Reference

## Current Model Identity

To determine what model and provider you are currently running as, run the self-info script:

```bash
bun run {baseDir}/scripts/self-info.ts
```

The script returns JSON with the current model ID, display name, provider, and provider display name. **Always run this script when asked about your model identity** rather than guessing — the config can change mid-session via the model switcher in the UI.

Example output:

```json
{
  "ok": true,
  "model": { "id": "gpt-5.2", "displayName": "GPT-5.2" },
  "provider": { "id": "openai", "displayName": "OpenAI" },
  "mode": "your-own",
  "summary": "You are running as GPT-5.2 via OpenAI (your-own API key)."
}
```

## Model Catalog

All known models by provider, so you can interpret model IDs from config:

| Provider | Model ID | Display Name |
|----------|----------|--------------|
| Anthropic | `claude-opus-4-6` | Claude Opus 4.6 |
| Anthropic | `claude-sonnet-4-6` | Claude Sonnet 4.6 |
| Anthropic | `claude-haiku-4-5-20251001` | Claude Haiku 4.5 |
| OpenAI | `gpt-5.2` | GPT-5.2 |
| OpenAI | `gpt-5.4` | GPT-5.4 |
| OpenAI | `gpt-5.4-nano` | GPT-5.4 Nano |
| Google Gemini | `gemini-3-flash` | Gemini 3 Flash |
| Google Gemini | `gemini-3-pro` | Gemini 3 Pro |
| Ollama | `llama3.2` | Llama 3.2 |
| Ollama | `mistral` | Mistral |
| Fireworks | `accounts/fireworks/models/kimi-k2p5` | Kimi K2.5 |
| OpenRouter | `x-ai/grok-4` | Grok 4 |
| OpenRouter | `x-ai/grok-4.20-beta` | Grok 4.20 Beta |

## Inference Configuration

Relevant config paths and what they control:

| Config Path | Description |
|-------------|-------------|
| `services.inference.model` | The active model ID (e.g. `claude-opus-4-6`, `gpt-5.2`) |
| `services.inference.provider` | The active provider: `anthropic`, `openai`, `gemini`, `ollama`, `fireworks`, `openrouter` |
| `services.inference.mode` | `"your-own"` (user's API key) vs `"managed"` (platform proxy) |
| `effort` | Inference effort level: `"low"`, `"medium"`, `"high"` |
| `thinking.enabled` | Whether extended thinking (chain-of-thought) is active |

Read any of these with `assistant config get <path>`, e.g.:

```bash
assistant config get services.inference.model
assistant config get services.inference.provider
```

## How Inference Routing Works

The daemon initializes a provider registry on startup, with a primary provider from config and fallback providers ordered by `providerOrder`. When a request is made, the primary provider is used first; if it fails, fallbacks are tried in order.

Model intents (`latency-optimized`, `quality-optimized`, `vision-optimized`) can select different models within the same provider, allowing the system to route to a faster or more capable model depending on the task without switching providers.
