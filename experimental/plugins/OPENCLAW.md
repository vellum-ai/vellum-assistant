# Plugins — OpenClaw

> Comparison reference. This file mirrors the structure of [`README.md`](./README.md)
> (our own plugin convention) but describes what **OpenClaw** actually supports
> in its plugin system, so we can line up surfaces and spot gaps. It is not a
> spec for our loader.

Sources: [Plugins](https://docs.openclaw.ai/plugins),
[Plugin manifest](https://docs.openclaw.ai/plugins/manifest),
[Agent runtimes](https://docs2.openclaw.ai/concepts/agent-runtimes),
[Agent harness plugins](https://docs2.openclaw.ai/plugins/sdk-agent-harness).

## Table of contents

- [TL;DR](#tldr)
- [What a plugin can contribute today](#what-a-plugin-can-contribute-today)
- [Directory layout](#directory-layout)
- [Manifest](#manifest--openclawpluginjson)
- [Public API surface](#public-api-surface--openclawplugin-sdk)
- [Hooks](#hooks)
- [Tools](#tools)
- [Conventions](#conventions)

---

## TL;DR

1. Create a plugin package with a `package.json` (npm metadata + code entry) and
   an `openclaw.plugin.json` **cold manifest** in the plugin root.
2. Register runtime behavior from your plugin code via the
   `openclaw/plugin-sdk/*` surfaces (tools, hooks, services, Gateway methods,
   CLI commands, providers, channels, agent harnesses).
3. Install from a source: `openclaw plugins install clawhub:<pkg>` (also
   `npm:`, `git:`, local `./path`, or `--marketplace` for Claude bundles).
4. Enable it (`openclaw plugins enable <id>`), then **restart the Gateway** so
   the runtime loads it. Verify with `openclaw plugins inspect <id> --runtime`.

The defining trait vs. our loader: OpenClaw plugins are **whole-capability
extensions** — they can add not just tools/hooks but entire model providers,
chat channels, and even the **agent runtime/harness** that executes a turn. The
manifest is a cheap, code-free metadata layer the host reads *before* booting
plugin code.

---

## What a plugin can contribute today

| Surface              | How it's contributed                                  | Notes                                                        |
| -------------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| Tools                | `ctx.register*` from plugin runtime code              | join the agent's tool set                                    |
| Hooks                | runtime hook registration                             | lifecycle interception                                       |
| Services / Gateway methods | runtime registration                            | callable surfaces exposed by the plugin                      |
| CLI commands         | plugin-owned commands                                 | `openclaw <plugin-command>`                                  |
| Skills               | declared skill roots                                  | also read from compatible Claude bundles                     |
| Model providers      | `providers` + provider request/endpoint metadata      | new LLM APIs (HTTP/WebSocket transport)                      |
| CLI inference backends | `cliBackends`                                       | run a local CLI process as the model backend                 |
| Agent harnesses      | `openclaw/plugin-sdk/agent-harness`                   | native session runtime for a model family (e.g. `codex`)     |
| Channels             | `channels` + channel env metadata                     | chat platforms / ChatOps surfaces                            |
| Generation/media backends | `contracts.*` ownership snapshots                | image/video/music gen, speech, transcription, web fetch/search |
| Memory / context engine | `kind: "memory" \| "context-engine"` exclusive slots | one active per `plugins.slots.*`                          |

This is the **widest** contribution surface of the four harnesses here — it
extends the host at the provider and runtime layer, not just within a single
agent turn.

---

## Directory layout

```
my-plugin/
├── package.json               # npm metadata + code entrypoint (runtime behavior)
├── openclaw.plugin.json        # Cold manifest (required; inspected without running code)
└── src/                        # Plugin runtime: register tools/hooks/providers/...
    └── index.ts
```

Loader rules:

- **`openclaw.plugin.json` is mandatory** and validated *without executing
  plugin code*. A missing or invalid manifest is a plugin error that blocks
  config validation.
- The manifest must be **cheap to inspect** — identity, config schema, auth /
  onboarding metadata, model-family ownership, capability `contracts`. It must
  **not** declare code entrypoints or runtime behavior; that lives in your
  plugin code + `package.json`.
- Code-side installs/uninstalls require a **Gateway restart** (auto on managed
  Gateways with reload enabled; otherwise `openclaw gateway restart`).
- A restrictive `plugins.allow` list must contain the id before it can load;
  `openclaw plugins install` adds the id to `allow` and removes it from `deny`.

**Compatibility bundles** — OpenClaw also auto-detects foreign plugin layouts
(but does *not* validate them against `openclaw.plugin.json`):

- Codex bundle: `.codex-plugin/plugin.json`
- Claude bundle: `.claude-plugin/plugin.json` (or default Claude layout, no manifest)
- Cursor bundle: `.cursor-plugin/plugin.json`

For these it reads bundle metadata, skill roots, Claude command roots, Claude
`settings.json` / LSP defaults, and supported hook packs.

---

## Manifest — `openclaw.plugin.json`

Minimal:

```json
{
  "id": "voice-call",
  "configSchema": { "type": "object", "additionalProperties": false, "properties": {} }
}
```

Rich (a provider plugin):

```json
{
  "id": "openrouter",
  "name": "OpenRouter",
  "version": "1.0.0",
  "providers": ["openrouter"],
  "modelSupport": { "modelPrefixes": ["router-"] },
  "cliBackends": ["openrouter-cli"],
  "setup": { "providers": [{ "id": "openrouter", "envVars": ["OPENROUTER_API_KEY"] }] },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": { "apiKey": { "type": "string" } }
  }
}
```

Key fields (selected from a large schema):

- **`id`** _(required)_ — canonical plugin id used in `plugins.entries.<id>`.
- **`configSchema`** _(required)_ — inline JSON Schema for the plugin's config.
- **`enabledByDefault` / `enabledByDefaultOnPlatforms`** — bundled-plugin
  default-on behavior (explicit config still wins).
- **`requiresPlugins`** — soft dependency ids (loadable but warns when missing).
- **`providers` / `channels` / `cliBackends`** — capability ownership for
  discovery and config validation.
- **`kind`** — `"memory"` or `"context-engine"` exclusive slot.
- **`contracts`** — static capability-ownership snapshot (embeddings, speech,
  transcription, voice, media understanding, image/music/video gen, web
  fetch/search, tool ownership).
- **`setup` / `providerAuthChoices` / `uiHints`** — onboarding, auth picker, and
  config-UI metadata read before runtime loads.

Anything that needs running code (registering behavior, npm install metadata)
belongs in plugin code and `package.json`, **not** here.

---

## Public API surface — `openclaw/plugin-sdk`

Unlike Claude Code / Codex, OpenClaw **does** expose an in-process plugin SDK.
Plugin runtime code imports typed surfaces and registers behavior. Example —
an **agent harness** plugin (`openclaw/plugin-sdk/agent-harness`):

```ts
import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness";

const myHarness: AgentHarness = {
  id: "my-harness",
  label: "My native agent harness",

  supports(ctx) {
    return ctx.provider === "my-provider"
      ? { supported: true, priority: 100 }
      : { supported: false };
  },

  async runAttempt(params) {
    // params.prompt, params.tools, params.images, params.onPartialReply,
    // params.onAgentEvent, ... — start or resume your native thread.
    return await runMyNativeTurn(params);
  },
};
```

- A **harness** is the low-level executor for one prepared agent turn (not a
  provider, channel, or tool registry). Register one only when a model family
  has its own native session runtime; for ordinary HTTP/WebSocket model APIs,
  build a **provider** plugin instead.
- Harness **selection policy**: model-scoped runtime pin → provider-scoped pin →
  `auto` (asks registered harnesses via `supports()`) → embedded fallback. Once
  a plugin harness claims a run, OpenClaw will not replay that turn through
  another runtime (avoids duplicate side effects / auth drift).
- Bundled examples: the `codex` and `copilot` harnesses are themselves opt-in
  plugin harnesses; `claude-cli` is a CLI backend, **not** an embedded harness.

The SDK also exposes registration for tools, hooks, services, Gateway methods,
CLI commands, providers, and channels — verifiable at runtime with
`openclaw plugins inspect <id> --runtime --json`.

---

## Hooks

Hooks are registered from plugin runtime code (not a static file convention) and
surface in the runtime inspector alongside registered tools, services, Gateway
methods, and CLI commands. Because OpenClaw plugins can also own the **agent
harness**, a plugin can influence the turn lifecycle at a far lower level than a
per-turn hook — `runAttempt(params)` receives streaming callbacks
(`onPartialReply`, `onAgentEvent`) for the entire prepared turn.

Compatible Claude bundles contribute their **hook packs** when the layout
matches OpenClaw runtime expectations, so Claude-style lifecycle hooks can be
reused without rewriting them as native OpenClaw hooks.

---

## Tools

Tools are registered from plugin runtime code and join the agent's tool set;
ownership can be snapshotted in the manifest's `contracts` for cold inspection.
Verify live tool registration with:

```bash
openclaw plugins inspect <plugin-id> --runtime --json
```

Beyond ordinary tools, a plugin can own entire **capability backends** declared
in `contracts` — web fetch, web search, embeddings, speech/transcription/voice,
and image/music/video generation — which the host routes to the owning plugin.
This capability-ownership model has no analog in our loader, where a plugin only
contributes hooks and tools.

### Tool naming & namespacing

Tool names are **explicit and static**, not prefixed by plugin id: a tool sets
its own `name`, and a factory can override or fan out names via
`registerTool(tool, { name })` / `{ names: [...] }`. Instead of name-prefix
namespacing, OpenClaw tracks **ownership** per plugin — cold in the manifest's
`contracts.tools`, hot at runtime registration — so the host knows which plugin
owns a given tool name and `openclaw plugins build` derives `contracts.tools`
from the declared tools. This differs from our (and Claude Code's / Codex's)
`mcp__<server>__<tool>` server-prefix scheme. Source:
[Tools](https://docs.openclaw.ai/plugins/tools).

---

## Conventions

- **Cold manifest, hot code.** `openclaw.plugin.json` is metadata-only and
  inspected without booting plugin code; runtime behavior lives in plugin code
  registered through `openclaw/plugin-sdk/*`.
- **Treat installs as running code.** Pin versions for reproducible production
  installs; `clawhub:`, `npm:`, `git:`, `npm-pack:` select a deterministic
  source.
- **Gateway restart to load.** Installing/updating/uninstalling plugin code
  needs a Gateway reload; enable/disable refresh the cold registry.
- **Capability ownership is explicit.** Providers, channels, CLI backends,
  harnesses, and generation backends are declared so the host can route and
  validate before runtime loads.
- **Foreign-bundle compatibility.** Claude/Codex/Cursor plugin layouts are
  auto-detected for skills, commands, settings/LSP defaults, and hook packs —
  but not validated against the native schema.
- **MCP and skills don't require a plugin.** OpenClaw keeps its own MCP client
  registry (`openclaw mcp add` / `set`, stored under `mcp.servers` in
  `~/.openclaw/openclaw.json`) and projects those servers into the runtimes it
  launches — independent of the plugin system. Skills load from declared skill
  roots (and the auto-detected foreign bundles above). Plugins are reserved for
  the richer capability surfaces (providers, channels, harnesses, generation
  backends). Source: [MCP](https://docs.openclaw.ai/cli/mcp).

---

## Install & versioning

- **Install.** `openclaw plugins install` with an explicit source selector —
  `clawhub:<pkg>`, `npm:<pkg>`, `git:github.com/<owner>/<repo>@<ref>`,
  `npm-pack:<tgz>`, a local `<path>`, or `<plugin>@<marketplace>`; ClawHub is the
  primary surface. ([CLI](https://docs.openclaw.ai/cli/plugins),
  [manage](https://docs.openclaw.ai/plugins/manage-plugins))
- **Versioning.** The most complete of the five: `@1.2.3` exact pins, `@beta`
  dist-tags, and `--pin`; the tracked install spec is stored and reused by
  `openclaw plugins update <id>` / `--all`. Dependency resolution happens **only
  at install/update time** — runtime never runs a package manager.
  ([dependency resolution](https://docs.openclaw.ai/plugins/dependency-resolution))
- **Editing the installed copy.** npm/git/ClawHub installs land in
  **OpenClaw-owned package roots the runtime never mutates**, so a hand-edit
  there is overwritten by `update` (or `--force`); local-path/dev installs load
  your own source in place. Uninstall removes managed install dirs unless
  `--keep-files`.
