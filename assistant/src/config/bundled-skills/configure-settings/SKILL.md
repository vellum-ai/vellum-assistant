---
name: "Configure Settings"
description: "Read, update, or reset assistant configuration values using the vellum config CLI"
user-invocable: true
metadata: { "vellum": { "emoji": "⚙️" } }
---

You are helping the user view or change assistant configuration through the `vellum` CLI. Treat CLI commands as the canonical interface. Do **not** read or edit config files directly.

## Domain Status Reads First

When a user asks for setup/status of a specific capability, prefer domain commands before generic `vellum config get`:

```bash
vellum integrations voice config --json
vellum integrations ingress config --json
vellum integrations twilio config --json
vellum email status --json
```

Use `vellum config get` for generic keys that do not have a domain command.

## Reading a value

```bash
vellum config get <key>
```

Examples:

```bash
vellum config get platform.baseUrl
vellum config get memory.qdrant.url
vellum config get provider
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

| Key                     | Description                                    |
| ----------------------- | ---------------------------------------------- |
| `platform.baseUrl`      | Vellum platform URL for auth and API calls     |
| `provider`              | Default LLM provider (anthropic, openai, etc.) |
| `model`                 | Default model name                             |
| `memory.enabled`        | Enable/disable memory system                   |
| `memory.qdrant.url`     | Qdrant vector store URL                        |
| `calls.enabled`         | Enable/disable phone call support              |
| `sandbox.enabled`       | Enable/disable sandbox for tool execution      |
| `ingress.publicBaseUrl` | Public ingress URL for webhooks                |

## Notes

- Changes to most settings take effect after the assistant restarts or reconnects
- Platform URL changes take effect after the macOS app reconnects (Settings > Connect)
- Boolean values should be `true` or `false`; numeric values are bare numbers
- The full config schema is defined in `assistant/src/config/core-schema.ts`
