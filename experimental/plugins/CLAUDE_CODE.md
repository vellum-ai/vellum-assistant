# Plugins — Claude Code

> Comparison reference. This file mirrors the structure of [`README.md`](./README.md)
> (our own plugin convention) but describes what **Anthropic's Claude Code**
> actually supports in its plugin system, so we can line up surfaces and spot
> gaps. It is not a spec for our loader.

Sources: [Plugins reference](https://code.claude.com/docs/en/plugins-reference),
[Create plugins](https://code.claude.com/docs/en/plugins),
[Discover and install plugins](https://code.claude.com/docs/en/discover-plugins),
[Hooks](https://code.claude.com/docs/en/hooks).

## Table of contents

- [TL;DR](#tldr)
- [What a plugin can contribute today](#what-a-plugin-can-contribute-today)
- [Directory layout](#directory-layout)
- [Manifest](#manifest--claude-pluginpluginjson)
- [Public API surface](#public-api-surface)
- [Hooks](#hooks)
- [Tools](#tools)
- [Conventions](#conventions)

---

## TL;DR

1. Create a directory with a `.claude-plugin/plugin.json` manifest (`name` required).
2. Drop components in convention-named directories: `commands/`, `skills/`,
   `agents/`, `hooks/hooks.json`, `.mcp.json`, `.lsp.json`.
3. Publish it through a **marketplace** — a `.claude-plugin/marketplace.json`
   catalog hosted in a git repo (or the official Anthropic marketplace).
4. Users run `/plugin marketplace add <owner/repo>` then
   `/plugin install <name>@<marketplace>`; components register on next start.

The defining trait vs. our loader: Claude Code plugins are **multi-surface
bundles** (commands + skills + subagents + hooks + MCP + LSP + monitors) shipped
through a marketplace, not a single hooks/tools tree.

---

## What a plugin can contribute today

| Surface             | Directory / file            | Discovery                                                       |
| ------------------- | --------------------------- | --------------------------------------------------------------- |
| Slash commands      | `commands/<name>.md`        | filename → `/<name>` (markdown prompt files)                    |
| Skills              | `skills/<name>/SKILL.md`    | auto-discovered; model-invoked by description                   |
| Subagents           | `agents/<name>.md`          | frontmatter-described; shown in `/agents`, model-invoked        |
| Lifecycle hooks     | `hooks/hooks.json`          | event-matcher config (see [Hooks](#hooks))                      |
| MCP servers         | `.mcp.json`                 | standard MCP config; tools join Claude's catalog                |
| LSP servers         | `.lsp.json`                 | language-server config for real-time diagnostics                |
| Background monitors | declared in manifest        | started automatically when the plugin is enabled                |

Tools are **not** a first-class plugin surface the way they are for us — a
plugin adds model-callable tools by bundling an **MCP server** (`.mcp.json`).

---

## Directory layout

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json            # Manifest (required; name only mandatory field)
├── commands/
│   └── deploy.md              # Slash command → /deploy
├── skills/
│   └── pdf-processor/
│       └── SKILL.md           # Skill (+ optional reference.md, scripts/)
├── agents/
│   └── code-reviewer.md       # Subagent (frontmatter + system prompt)
├── hooks/
│   └── hooks.json             # Event handlers
├── .mcp.json                  # Bundled MCP servers
└── .lsp.json                  # Bundled LSP servers
```

Loader rules:

- **`.claude-plugin/plugin.json` is the only required file**; every component
  directory is optional and silently skipped when absent.
- Component paths can be **overridden** in the manifest, and several configs
  (`hooks`, `mcpServers`, `lspServers`) may be declared **inline** in
  `plugin.json` instead of as separate files.
- `${CLAUDE_PLUGIN_ROOT}` expands to the plugin's absolute install path inside
  hook commands and MCP/LSP configs — use it instead of hardcoded paths.
- The **language-server / MCP binaries are not bundled**: the plugin only
  configures how to launch them; the user installs the binary separately.

---

## Manifest — `.claude-plugin/plugin.json`

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "author": { "name": "You" },
  "commands": "./commands/",
  "agents": "./agents/",
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json",
  "lspServers": "./.lsp.json"
}
```

- **`name`** _(required)_ — kebab-case identifier; the component namespace.
- **`version`, `description`, `author`, `homepage`, `license`, `keywords`** —
  informational catalog metadata.
- **Component path fields** (`commands`, `agents`, `hooks`, `mcpServers`,
  `lspServers`) — optional overrides; default to the convention directories.

Plugins are distributed through a **marketplace manifest**
(`.claude-plugin/marketplace.json`) that lists plugins and their sources. The
official Anthropic marketplace (`claude-plugins-official`) ships by default;
anyone can host their own by committing a `marketplace.json` to a git repo and
having users `/plugin marketplace add <owner/repo>`.

---

## Public API surface

Claude Code has **no in-process plugin SDK** — plugins do not import a typed API
package or export JS/TS functions. Every surface is **declarative or
subprocess-based**:

- Commands, skills, and agents are **markdown** (prompt + YAML frontmatter).
- Hooks invoke **external processes / HTTP / MCP tools / sub-prompts** (see
  below) — never an in-runtime callback.
- Tools come from **MCP servers** the plugin launches as child processes,
  speaking the [Model Context Protocol](https://modelcontextprotocol.io/).

This is the biggest structural contrast with our `@vellumai/plugin-api`: there
is no shared type contract or `PluginHookFn`; integration is by file convention
and process boundary.

---

## Hooks

Hooks are configured in `hooks/hooks.json` (or inline). Each event maps to an
array of `{ matcher, hooks: [...] }` rules; the `matcher` is a regex against the
tool name (e.g. `"Write|Edit"`). Far broader event set than our five wired hooks:

| Event                  | When it fires (abridged)                                        |
| ---------------------- | --------------------------------------------------------------- |
| `SessionStart` / `SessionEnd` | Session begins/resumes / terminates                      |
| `Setup`                | One-time prep in `--init`/CI modes                              |
| `UserPromptSubmit`     | After a prompt is submitted, before Claude processes it         |
| `UserPromptExpansion`  | When a typed command expands into a prompt (can block)          |
| `PreToolUse`           | Before a tool call (can block)                                  |
| `PostToolUse` / `PostToolUseFailure` | After a tool call succeeds / fails               |
| `PostToolBatch`        | After a parallel batch resolves                                 |
| `PermissionRequest` / `PermissionDenied` | Permission dialog shown / call denied         |
| `SubagentStart` / `SubagentStop` | A subagent is spawned / finishes                      |
| `TaskCreated` / `TaskCompleted` | Task lifecycle via `TaskCreate`                        |
| `PreCompact` / `PostCompact` | Around context compaction                                 |
| `Stop` / `StopFailure` | Claude finishes responding / turn ends on API error            |
| `Notification`, `MessageDisplay`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `FileChanged`, `WorktreeCreate`/`WorktreeRemove`, `Elicitation`/`ElicitationResult`, `TeammateIdle` | environment, display, worktree, and MCP-elicitation events |

**Hook types** (the `type` field on each entry) — what a hook *runs*:

- `command` — execute a shell command / script
- `http` — POST the event JSON to a URL
- `mcp_tool` — call a tool on a configured MCP server
- `prompt` — evaluate an LLM prompt (`$ARGUMENTS` placeholder for context)
- `agent` — run an agentic verifier with tools for complex checks

Hooks communicate decisions (block / allow / retry) via **exit codes and JSON on
stdout** — there is no in-place context mutation like our `PluginHookFn`.

---

## Tools

Claude Code plugins expose model-callable tools **only through bundled MCP
servers** declared in `.mcp.json`:

```json
{
  "mcpServers": {
    "plugin-database": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/db-server",
      "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
      "env": { "DB_PATH": "${CLAUDE_PLUGIN_ROOT}/data" }
    }
  }
}
```

- Servers start automatically when the plugin is enabled and their tools appear
  in Claude's standard tool catalog alongside built-ins.
- Tools are defined by the **MCP server implementation**, not by a per-file
  default export. The schema/`execute` split lives inside the MCP server in
  whatever language it's written in.
- For code intelligence, plugins can additionally ship **LSP servers**
  (`.lsp.json`) that surface diagnostics, go-to-definition, and hover info —
  there is no analog in our loader.

### Tool naming & namespacing

MCP tools are exposed to the model as `mcp__<server>__<tool>` (double
underscore) in the Claude Code CLI / Agent SDK — the server name is the
namespace, so two servers can each expose `create_issue` without colliding.
MCP-provided slash commands follow the same scheme (`/mcp__<server>__<prompt>`).
Note the convention is **not** universal: Agent Skills and the direct Messages
API instead use the colon form `<Server>:<tool>`
([anthropics/claude-code#18763](https://github.com/anthropics/claude-code/issues/18763)).
Same `mcp__server__tool` namespacing as our own MCP tools, but ours is the only
collision-safe surface — Claude Code has no flat plugin-tool registry to clash
with because every plugin tool *is* an MCP tool.

---

## Conventions

- **Self-contained, multi-surface bundle.** One plugin can ship commands,
  skills, agents, hooks, MCP, and LSP together; users enable/disable it as a
  unit.
- **Marketplace distribution.** Plugins are discovered and installed from
  marketplace catalogs (`/plugin install <name>@<marketplace>`), not copied
  into a workspace directory.
- **`${CLAUDE_PLUGIN_ROOT}` for paths.** Always reference bundled scripts and
  data through the env var so the plugin is relocatable.
- **No bundled binaries.** MCP/LSP server binaries and language servers are the
  user's responsibility; the plugin only declares how to launch them.
- **Security carve-outs.** Plugin-shipped agents cannot declare `hooks`,
  `mcpServers`, or `permissionMode`; the only `isolation` value is `"worktree"`.
- **Plugins are a bundle, not a requirement.** Both MCP servers and skills can
  be added standalone, outside any plugin: MCP via `claude mcp add` or a
  `.mcp.json` (`local` / `user` / `project` scope), and skills by dropping a
  `SKILL.md` into `~/.claude/skills/` (personal) or `.claude/skills/` (project).
  A plugin is just one of four skill locations (enterprise / personal / project
  / plugin) — the bundle adds distribution, not new capability. Sources:
  [MCP](https://code.claude.com/docs/en/mcp),
  [Skills](https://code.claude.com/docs/en/skills).
