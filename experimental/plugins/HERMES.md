# Plugins — Hermes

> Comparison reference. This file mirrors the structure of [`README.md`](./README.md)
> (our own plugin convention) but describes what **Nous Research's Hermes Agent**
> actually supports in its plugin system, so we can line up surfaces and spot
> gaps. It is not a spec for our loader.

Sources: [Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins),
[Build a Hermes Plugin](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/build-a-hermes-plugin.md),
[Event Hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks).

## Table of contents

- [TL;DR](#tldr)
- [What a plugin can contribute today](#what-a-plugin-can-contribute-today)
- [Directory layout](#directory-layout)
- [Manifest](#manifest--pluginyaml)
- [Public API surface](#public-api-surface--the-register-context)
- [Hooks](#hooks)
- [Tools](#tools)
- [Conventions](#conventions)

---

## TL;DR

1. Create a directory `~/.hermes/plugins/<name>/` with a `plugin.yaml` manifest.
2. Write `schemas.py` (what the LLM sees) and `tools.py` (handlers), then wire
   them in `__init__.py` via the `register(ctx)` entrypoint.
3. Call `ctx.register_tool(...)`, `ctx.register_hook(...)`,
   `ctx.register_command(...)`, `ctx.register_skill(...)`, etc.
4. Drop-in load from `~/.hermes/plugins/`, or distribute via pip using the
   `hermes_agent.plugins` entry-point group.

The defining trait vs. our loader: Hermes is **Python and imperative**. A single
`register(ctx)` call wires *every* surface (tools, hooks, slash commands, CLI
subcommands, skills, channels, providers) through one rich context object —
rather than our filesystem-convention loader where each file's default export is
one contribution.

---

## What a plugin can contribute today

| Surface                      | How (`ctx` method / mechanism)                                          |
| ---------------------------- | ----------------------------------------------------------------------- |
| Tools                        | `ctx.register_tool(name, toolset, schema, handler)`                     |
| Hooks                        | `ctx.register_hook("post_tool_call", callback)`                        |
| Slash commands               | `ctx.register_command(name, handler, description)` → `/name`           |
| Dispatch a tool from command | `ctx.dispatch_tool(name, args)` (parent-agent context auto-wired)      |
| CLI subcommands              | `ctx.register_cli_command(name, help, setup_fn, handler_fn)` → `hermes <name>` |
| Inject messages              | `ctx.inject_message(content, role="user")`                            |
| Bundle skills                | `ctx.register_skill(name, path)` → namespaced `plugin:skill`           |
| Ship data files              | `Path(__file__).parent / "data" / "file.yaml"`                        |
| Gateway channels             | `ctx.register_platform(name, label, adapter_factory, check_fn, ...)`   |
| Image / video gen backends   | `ctx.register_image_gen_provider(...)` / `register_video_gen_provider(...)` |
| Context-compression engine   | `ctx.register_context_engine(engine)`                                  |
| Memory backend               | subclass `MemoryProvider` in `plugins/memory/<name>/__init__.py`       |
| Env gating                   | `requires_env: [API_KEY]` in `plugin.yaml`                            |
| Distribution                 | `[project.entry-points."hermes_agent.plugins"]` (pip)                  |

Config-driven / drop-in surfaces that aren't Python plugins but extend Hermes:
**MCP servers** (`mcp_servers.<name>` in `config.yaml`), **gateway event hooks**
(`HOOK.yaml` + `handler.py` directories), **shell hooks** (`hooks:` in config),
model/TTS/STT providers, and additional skill "taps".

---

## Directory layout

```
~/.hermes/plugins/calculator/
├── plugin.yaml                # Manifest (name, version, provides_*, requires_env)
├── schemas.py                 # Tool JSON schemas — what the LLM reads
├── tools.py                   # Tool handlers — the code that runs
├── __init__.py                # register(ctx) entrypoint — wires schemas → handlers
├── data/                      # Optional shipped data files
└── skills/                    # Optional bundled skills (register_skill)
```

Loader rules:

- Plugins drop into `~/.hermes/plugins/<name>/` (or install via pip entry
  points). `plugin.yaml` declares what the plugin provides.
- The **`register(ctx)` function is the single entrypoint**; everything the
  plugin contributes is wired imperatively inside it.
- Ship data files relative to the module (`Path(__file__).parent / "data"`).
- Bundled skills are **namespaced** as `plugin:skill` and loaded via
  `skill_view("plugin:skill")`.

---

## Manifest — `plugin.yaml`

```yaml
name: calculator
version: 1.0.0
description: Math calculator — evaluate expressions and convert units
provides_tools:
  - calculate
  - unit_convert
provides_hooks:
  - post_tool_call
```

Optional fields:

```yaml
author: Your Name
requires_env:                # gate loading on env vars; prompted during install
  - SOME_API_KEY             # simple form — plugin disabled if missing
  - name: OTHER_KEY          # rich form — description/url shown during install
    description: "Key for the Other service"
    url: "https://other.com/keys"
    secret: true
```

- **`name`** _(required)_ — plugin id.
- **`provides_tools` / `provides_hooks`** — declarative lists of what the plugin
  registers (mirrors the imperative `register(ctx)` calls).
- **`requires_env`** — env-var gating, prompted during `hermes plugins install`;
  a missing required var disables the plugin.

---

## Public API surface — the `register` context

Hermes exposes a Python **registration context** (`ctx`) — the closest analog to
our `@vellumai/plugin-api`, but imperative rather than per-file default exports.
Wiring (`__init__.py`):

```python
from . import schemas, tools

def register(ctx):
    ctx.register_tool(
        name="calculate",
        toolset="calculator",
        schema=schemas.CALCULATE,
        handler=tools.calculate,
    )
    ctx.register_tool(
        name="unit_convert",
        toolset="calculator",
        schema=schemas.UNIT_CONVERT,
        handler=tools.unit_convert,
    )
    ctx.register_hook("post_tool_call", tools.log_tool_call)
```

The context wires every surface in the contribution table above through one
object — tools, hooks, commands, CLI subcommands, skills, channels, and
generation/context/memory backends.

---

## Hooks

Hermes has **three** hook systems (all non-blocking — handler errors are caught
and logged, never crash the agent):

| System         | Registered via                                          | Runs in        | Use case                                |
| -------------- | ------------------------------------------------------- | -------------- | --------------------------------------- |
| Plugin hooks   | `ctx.register_hook(event, callback)` in a plugin        | CLI + Gateway  | tool interception, metrics, guardrails  |
| Gateway hooks  | `HOOK.yaml` + `handler.py` in `~/.hermes/hooks/<name>/` | Gateway only   | logging, alerts, webhooks               |
| Shell hooks    | `hooks:` block in `config.yaml` → shell scripts         | CLI + Gateway  | blocking, auto-format, context inject   |

**Plugin hooks** attach to events like `post_tool_call` via a Python callback.

**Gateway hooks** subscribe to lifecycle events (the `events:` list in
`HOOK.yaml`, wildcards like `command:*` allowed); the handler must be named
`handle(event_type, context)` (`async def` or `def`):

| Event             | When it fires                          | Context keys                                              |
| ----------------- | -------------------------------------- | --------------------------------------------------------- |
| `gateway:startup` | Gateway process starts                 | `platforms`                                               |
| `session:start`   | New messaging session                  | `platform`, `user_id`, `session_id`, `session_key`        |
| `session:end`     | Session ended (before reset)           | `platform`, `user_id`, `session_key`                      |
| `session:reset`   | User ran `/new` or `/reset`            | `platform`, `user_id`, `session_key`                      |
| `agent:start`     | Agent begins processing a message      | `platform`, `user_id`, `session_id`, `message`            |
| `agent:step`      | Each tool-calling loop iteration       | `platform`, `user_id`, `session_id`, `iteration`, `tool_names` |
| `agent:end`       | Agent finishes processing              | `platform`, `user_id`, `session_id`, `message`, `response` |
| `command:*`       | Any slash command executed             | `platform`, `user_id`, `command`, `args`                  |

This is a richer, channel-aware lifecycle than our five wired hooks, but our
`PluginHookFn` ctx-mutation contract (return new ctx or mutate in place) has no
direct equivalent — Hermes plugin hooks are observe/intercept callbacks.

---

## Tools

A tool is a **schema + handler pair** registered through `ctx.register_tool`.
The schema (`schemas.py`) is what the model reads to decide when to call; the
handler (`tools.py`) runs the work:

```python
CALCULATE = {
    "name": "calculate",
    "description": "Evaluate a mathematical expression and return the result. ...",
    "parameters": {
        "type": "object",
        "properties": {
            "expression": { "type": "string",
                            "description": "Math expression (e.g., '2**10', 'sqrt(144)')" },
        },
        "required": ["expression"],
    },
}

def calculate(args: dict, **kwargs) -> str:
    # ... do the work ...
    return json.dumps({"expression": args["expression"], "result": result})
```

Handler rules:

- **Signature** — `def handler(args: dict, **kwargs) -> str` (accept `**kwargs`
  for forward compatibility).
- **Always return a JSON string** — success and errors alike.
- **Never raise** — catch all exceptions and return error JSON instead.
- Tools are grouped into a **`toolset`** and can be invoked from slash commands
  via `ctx.dispatch_tool(name, args)`.

### Tool naming & namespacing

Tools are keyed by a **unique `name`** in a singleton registry and grouped into
a `toolset` (the toolset is a bundle label for enable/disable, *not* a name
prefix). On a name collision across toolsets a warning is logged and the
**later registration wins** — there is no per-plugin namespace for tool names,
so a plugin can shadow a core tool. Bundled *skills*, by contrast, **are**
namespaced `plugin:skill`. This is the inverse of our model, where MCP tools are
namespaced (`mcp__<server>__<tool>`) but skills are not. Source:
[Tools runtime](https://hermes-agent.nousresearch.com/docs/developer-guide/tools-runtime).

---

## Conventions

- **Python + imperative.** One `register(ctx)` entrypoint wires every surface;
  there is no per-file default-export convention.
- **Schema/handler split.** The schema is the model-facing contract; the handler
  is pure execution and must always return JSON and never raise.
- **Three hook systems.** Pick plugin hooks (Python, CLI+Gateway), gateway hooks
  (drop-in directories, Gateway-only), or shell hooks (config-driven) per use
  case.
- **Drop-in or pip.** Install by dropping into `~/.hermes/plugins/` or publish
  via the `hermes_agent.plugins` entry-point group.
- **Env gating up front.** `requires_env` is prompted at install and disables
  the plugin when required vars are missing.
- **Far wider backend surface.** Beyond tools/hooks, a plugin can register chat
  platforms, image/video generation, context-compression engines, and memory
  backends — backend categories our loader does not expose.
- **Not every extension is a Python plugin.** MCP servers are configured under
  `mcp_servers.<name>` in `config.yaml`, gateway hooks are drop-in
  `HOOK.yaml` + `handler.py` directories under `~/.hermes/hooks/`, and shell
  hooks live in `config.yaml` — none of these is a `register(ctx)` plugin. A
  plugin is the path for Python-imperative tools/hooks/commands/backends.
  Source: [Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins).
