# Inference Reference

## Current Model Identity

Your current model identity (model ID, provider, and mode) is automatically injected into the SKILL.md body at skill-load time via inline command expansion. There is no need to run a script manually — the information is pre-populated when the skill loads and reflects the live configuration.

If the user switches models mid-session via the UI, the skill will reflect the updated config the next time it is loaded.

## Model Catalog

All known models by provider, so you can interpret model IDs from config:

| Provider | Model ID | Display Name |
|----------|----------|--------------|
| Anthropic | `claude-opus-4-7` | Claude Opus 4.7 |
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
| OpenRouter | `deepseek/deepseek-r1-0528` | DeepSeek R1 |
| OpenRouter | `deepseek/deepseek-chat-v3-0324` | DeepSeek V3 |
| OpenRouter | `qwen/qwen3.5-plus-02-15` | Qwen 3.5 Plus |
| OpenRouter | `qwen/qwen3.5-397b-a17b` | Qwen 3.5 397B |
| OpenRouter | `qwen/qwen3.5-flash-02-23` | Qwen 3.5 Flash |
| OpenRouter | `qwen/qwen3-coder-next` | Qwen 3 Coder |
| OpenRouter | `moonshotai/kimi-k2.5` | Kimi K2.5 |
| OpenRouter | `mistralai/mistral-medium-3` | Mistral Medium 3 |
| OpenRouter | `mistralai/mistral-small-2603` | Mistral Small 4 |
| OpenRouter | `mistralai/devstral-2512` | Devstral 2 |
| OpenRouter | `meta-llama/llama-4-maverick` | Llama 4 Maverick |
| OpenRouter | `meta-llama/llama-4-scout` | Llama 4 Scout |
| OpenRouter | `amazon/nova-pro-v1` | Amazon Nova Pro |

## Inference Configuration

Relevant config paths and what they control:

| Config Path | Description |
|-------------|-------------|
| `services.inference.model` | The active model ID (e.g. `claude-opus-4-6`, `gpt-5.2`) |
| `services.inference.provider` | The active provider: `anthropic`, `openai`, `gemini`, `ollama`, `fireworks`, `openrouter` |
| `services.inference.mode` | `"your-own"` (user's API key) vs `"managed"` (platform proxy) |
| `effort` | Inference effort level: `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` (`xhigh` sits between `high` and `max`, for models that support it — e.g. Opus 4.7) |
| `thinking.enabled` | Whether extended thinking (chain-of-thought) is active |

Read any of these with `assistant config get <path>`, e.g.:

```bash
assistant config get services.inference.model
assistant config get services.inference.provider
```

## How Inference Routing Works

The assistant initializes a provider registry on startup with the configured provider from config. Available providers are determined by which API keys are present. Model intents route to appropriate models within the configured provider.

Model intents (`latency-optimized`, `quality-optimized`, `vision-optimized`) can select different models within the same provider, allowing the system to route to a faster or more capable model depending on the task without switching providers.
