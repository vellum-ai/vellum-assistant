---
name: "Configure Settings"
description: "Read, update, or reset assistant configuration values using the vellum config CLI"
user-invocable: true
metadata: {"vellum": {"emoji": "⚙️"}}
---

You are helping the user view or change assistant configuration. All configuration is managed through the `vellum config` CLI which reads and writes `~/.vellum/workspace/config.json`.

## Reading a value

```bash
vellum config get <key>
```

Examples:
```bash
vellum config get platform.baseUrl
vellum config get memory.qdrant.url
vellum config get provider
vellum config get calls.enabled
```

If the result is empty, the compiled default is in effect.

## Setting a value

```bash
vellum config set <key> <value>
```

Examples:
```bash
vellum config set platform.baseUrl "https://platform.vellum.ai"
vellum config set provider "openai"
vellum config set memory.enabled false
vellum config set maxTokens 8000
```

## Resetting a value to its default

Set the key to an empty string (for strings) or omit it from the config file:

```bash
vellum config set <key> ""
```

## Listing all configuration

```bash
vellum config list
```

## Common configuration keys

| Key | Description |
|-----|-------------|
| `platform.baseUrl` | Vellum platform URL for auth and API calls |
| `provider` | Default LLM provider (anthropic, openai, etc.) |
| `model` | Default model name |
| `memory.enabled` | Enable/disable memory system |
| `memory.qdrant.url` | Qdrant vector store URL |
| `calls.enabled` | Enable/disable phone call support |
| `sandbox.enabled` | Enable/disable sandbox for tool execution |
| `ingress.publicBaseUrl` | Public ingress URL for webhooks |

## Notes

- Changes to most settings take effect after the daemon restarts or reconnects
- Platform URL changes take effect after the macOS app reconnects (Settings > Connect)
- Boolean values should be `true` or `false`; numeric values are bare numbers
- The full config schema is defined in `assistant/src/config/core-schema.ts`
