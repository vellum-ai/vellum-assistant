---
name: vellum-self-knowledge
description: Answer questions about Vellum, the assistant's architecture, and its current configuration including which model and provider are active
metadata:
  emoji: "🪞"
  vellum:
    display-name: "Vellum Self-Knowledge"
    activation-hints:
      - "When the user asks what model the assistant is running on"
      - "When the user asks about Vellum, how the assistant works, or its architecture"
      - "When the user asks about the assistant's current configuration or settings"
    avoid-when:
      - "When the user wants to change configuration (use in-chat config instead)"
---

## What is Vellum

Vellum is a personal AI assistant platform that runs as a local daemon on the user's machine. It supports multiple LLM providers (Anthropic, OpenAI, Gemini, Ollama, Fireworks, OpenRouter) and is accessible via a macOS desktop app, voice calls, and messaging channels like Telegram.

## Architecture at a Glance

The assistant runs as a daemon HTTP server. Conversations are managed by a coordinator that delegates to an AgentLoop, which sends messages to the configured LLM provider and executes tools. The system prompt is composed from workspace files (IDENTITY.md, SOUL.md, USER.md) plus dynamic context. Skills extend capabilities via lazy-loaded instruction sets.

## Configuration System

Config is stored in `config.json` in the workspace directory. Use the CLI to interact with it:

- **Read a value**: `assistant config get <key>`
- **Set a value**: `assistant config set <key> <value>`
- **Search config**: `assistant config list --search <query>`

## Reference Files

Consult these reference files for detailed knowledge on specific topics. Read the relevant file before answering questions in that domain.

- `references/inference.md` — Model identity, provider details, model catalog, and how inference routing works. **Read this when asked what model you are or about inference configuration.**

## Self-Info Script

To determine what model and provider you are currently running as, run:

```bash
bun run {baseDir}/scripts/self-info.ts
```

**Always run this script when asked about your model identity** rather than guessing — the config can change mid-session via the model switcher in the UI.

## Critical Rule

Never guess or hallucinate information about yourself. If unsure, consult the relevant reference file or run the self-info script above.
