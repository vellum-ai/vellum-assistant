# Inference Reference

## Current Model Identity

Your current model identity (model ID, provider, and mode) is automatically injected into the SKILL.md body at skill-load time via inline command expansion. There is no need to run a script manually — the information is pre-populated when the skill loads and reflects the live configuration.

If the user switches models mid-session via the UI, the skill will reflect the updated config the next time it is loaded.

## Model Catalog

The authoritative model catalog is maintained in `assistant/src/providers/model-catalog.ts` and generated into `meta/llm-provider-catalog.json` for consumers that need provider and model metadata without importing assistant internals. That generated catalog includes model IDs, display names, context-window sizes, output limits, feature support, and local display/pricing metadata.

Client settings and config surfaces should use the generated catalog or the metadata exposed by the assistant, not a copied table in this skill. When the generated catalog is unavailable because the skill is running outside a repo checkout, treat model and provider IDs from config as the source of truth and display the raw ID.

## Inference Configuration

Relevant config paths and what they control:

| Config Path                    | Description                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm.default.model`            | The active model ID (e.g. `claude-opus-4-6`, `gpt-5.2`)                                                                                                       |
| `llm.default.provider`         | The active provider: `anthropic`, `openai`, `gemini`, `ollama`, `fireworks`, `openrouter`                                                                     |
| `services.inference.mode`      | `"your-own"` (user's API key) vs `"managed"` (platform proxy)                                                                                                 |
| `llm.default.effort`           | Inference effort level: `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` (`xhigh` sits between `high` and `max`, for models that support it — e.g. Opus 4.7) |
| `llm.default.thinking.enabled` | Whether extended thinking (chain-of-thought) is active                                                                                                        |

Read any of these with `assistant config get <path>`, e.g.:

```bash
assistant config get llm.default.model
assistant config get llm.default.provider
```

## How Inference Routing Works

The assistant initializes a provider registry on startup with the providers whose API keys are present. Each LLM request is tagged with a stable call-site identifier (`LLMCallSite` from `assistant/src/config/schemas/llm.ts`) — for example `mainAgent`, `memoryRetrieval`, or `interactionClassifier`. The provider layer resolves the effective config for that call site by layering `llm.callSites.<id>` on top of an optional named profile (`llm.profiles.<name>`) on top of the required `llm.default` base.

Per-call-site overrides live under `llm.callSites.<id>.{provider, model, maxTokens, effort, speed, temperature, thinking, contextWindow, profile}`. Any field omitted at the call-site level falls through to the profile (if `profile` is set) and finally to `llm.default`. Read a specific override with `assistant config get llm.callSites.<id>` (e.g. `assistant config get llm.callSites.memoryRetrieval`); the catalog of valid call-site IDs is the `LLMCallSiteEnum` in `assistant/src/config/schemas/llm.ts`.
