# MCP servers

Ship MCP servers with a plugin. A root `mcp.json` declares servers the assistant connects on install, and their tools land in the same catalog as workspace-configured MCP tools.

This is a declaration, not a TypeScript surface: there is no `mcp/` directory and nothing to import from `@vellumai/plugin-api`. The file follows the [Agent Plugins 1.0.0](https://agent-plugins.org) MCP schema.

## When to ship MCP

Use `mcp.json` when the capability already exists as an MCP server and you want it to come up with the plugin. Prefer a native [plugin tool](tools.md) when you are writing the action yourself: a plugin tool has an explicit risk level, a typed `execute` context, and no extra process.

A user can also add MCP servers in settings without a plugin. A plugin is what lets you version, install, and distribute those servers with the rest of the capability.

## The manifest

Place `mcp.json` at the plugin root, next to `package.json`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "example": { "type": "streamable-http", "url": "https://mcp.example.com" }
  }
}
```

`stdio`, `sse`, and `streamable-http` transports are supported:

```json
{
  "mcpServers": {
    "local-tools": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@example/mcp-server"],
      "env": { "DATA_DIR": "${PLUGIN_DATA}" }
    },
    "remote-sse": {
      "type": "sse",
      "url": "https://mcp.example.com/sse"
    }
  }
}
```

A missing file is skipped. An invalid file disables MCP for that plugin only. An invalid individual entry disables only that entry. Sibling plugins keep their servers.

## Server ids and tool names

Plugin servers share one namespace with workspace MCP servers. The assistant qualifies each id with the plugin name, then collapses the redundant case:

| Plugin name     | `mcp.json` key | Server id               | Tool names                           |
| --------------- | -------------- | ----------------------- | ------------------------------------ |
| `example`       | `example`      | `example`               | `mcp__example__<tool>`               |
| `example-tools` | `search`       | `example-tools__search` | `mcp__example-tools__search__<tool>` |

Two plugins claiming the same id is a skip, not a shadow. The second declaration is logged and dropped so the first plugin's tools stay put.

## Path interpolation (`stdio` only)

`${PLUGIN_ROOT}` and `${PLUGIN_DATA}` interpolate in `args`, `env` values, and `cwd`. They never interpolate in `command`, a URL, or a header, so a manifest cannot use them to build the executable path itself.

`cwd` is accepted by the spec but has no host equivalent. It is ignored, with a warning, and the server runs in the assistant's working directory. Put absolute paths in `args` or `env` via `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` instead.

## Credentials and risk

A plugin cannot ship a credential. The spec defines no portable OAuth or credential-reference fields, and any `headers` in the file are literal package data. Plugin servers also never resolve the assistant's stored `mcp:<serverId>:*` credentials: a plugin controls both its server key and its URL, so honoring them would send a workspace credential to an endpoint the plugin chose.

Risk defaults to `low`, so the tools run without prompting under the default auto-approve threshold. `mcp.json` has no risk field (the spec defines none). The review is the marketplace whitelist plus the user's decision to install. A user who wants a different bar sets `defaultRiskLevel` on a workspace `config.json` entry of the same id, which outranks the plugin's declaration and replaces it wholesale (transport included).

Each server is capped at 20 tools (`maxTools`). That is the same default a workspace MCP entry ships with.

## Lifecycle

The assistant connects these servers on start and registers their tools alongside workspace-configured ones. Installing, removing, upgrading, enabling, or disabling a plugin reconnects the set as part of that operation: its servers come up and go down with the plugin, no restart involved.

A disabled plugin (`.disabled` sentinel) contributes no MCP servers, matching hooks, tools, and routes. A directory with no loadable `package.json` is ignored even if it has an `mcp.json`.

`assistant mcp list` shows plugin servers with their originating plugin, and `status: declared` for one the assistant holds no live connection to.

## Anatomy

```
example/
├── package.json
├── mcp.json
└── ...
```

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "example": {
      "type": "streamable-http",
      "url": "https://mcp.example.com"
    }
  }
}
```

The plugin above yields tools named `mcp__example__<tool>` (the plugin name and server key match, so the id collapses).
