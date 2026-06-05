# Plugins — Codex

> Comparison reference. This file mirrors the structure of [`README.md`](./README.md)
> (our own plugin convention) but describes what **OpenAI Codex** actually
> supports in its plugin system, so we can line up surfaces and spot gaps. It is
> not a spec for our loader.

Sources: [Plugins](https://developers.openai.com/codex/plugins),
[Build plugins](https://developers.openai.com/codex/plugins/build),
[Hooks](https://developers.openai.com/codex/hooks),
[Customization](https://developers.openai.com/codex/concepts/customization).

## Table of contents

- [TL;DR](#tldr)
- [What a plugin can contribute today](#what-a-plugin-can-contribute-today)
- [Directory layout](#directory-layout)
- [Manifest](#manifest--codex-pluginpluginjson)
- [Public API surface](#public-api-surface)
- [Hooks](#hooks)
- [Tools](#tools)
- [Conventions](#conventions)

---

## TL;DR

1. Create a plugin folder with a manifest at `.codex-plugin/plugin.json`
   (`name` required; kebab-case, used as the component namespace).
2. Bundle **skills** (`skills/<name>/SKILL.md`), **apps** (connectors like
   GitHub/Slack/Drive), **MCP servers**, and optionally **hooks**.
3. List the plugin in a **marketplace** JSON (`.agents/plugins/marketplace.json`
   for repo scope, `~/.agents/plugins/marketplace.json` for personal).
4. Install via the `/plugins` directory (app or CLI) or
   `codex plugin marketplace add <owner/repo>`; restart Codex to load.

Fastest path: the built-in `@plugin-creator` skill scaffolds the manifest and a
local marketplace entry for you.

The defining trait vs. our loader: a Codex plugin is a **packaging+distribution
unit** for skills/apps/MCP/hooks, shipped through a marketplace catalog — not an
in-process hook/tool module.

---

## What a plugin can contribute today

| Surface       | Where                          | Discovery                                                  |
| ------------- | ------------------------------ | ---------------------------------------------------------- |
| Skills        | `skills/<name>/SKILL.md`       | metadata loaded; model-invoked, or `@`/`$skill` explicit   |
| Apps          | manifest connector entries     | OAuth connectors (GitHub, Slack, Gmail, Drive, …)          |
| MCP servers   | manifest / MCP config          | external tools join Codex's tool set                       |
| Hooks         | `hooks/hooks.json` in manifest | lifecycle events (see [Hooks](#hooks))                     |

Adjacent customization surfaces that are **not** part of a plugin bundle but
overlap with what our plugins do (worth noting for the gap analysis):

- **`AGENTS.md`** — layered, durable project/global instructions (precedence by
  directory depth; 32 KiB cap by default).
- **Memories** — context carried forward from prior work.
- **Subagents** — delegated specialized agents, configured under
  `[agents.<name>]` (TOML), with `.codex/agents/` role configs.

---

## Directory layout

```
my-plugin/
├── .codex-plugin/
│   └── plugin.json            # Manifest (required; name + version)
├── skills/
│   └── hello/
│       └── SKILL.md           # Skill (name + description frontmatter)
└── hooks/
    └── hooks.json             # Optional bundled lifecycle hooks
```

Distribution is via a separate **marketplace file** that points at the plugin
folder:

```
$REPO_ROOT/.agents/plugins/marketplace.json   # repo-scoped catalog
~/.agents/plugins/marketplace.json             # personal catalog
$REPO_ROOT/plugins/<name>/                     # common plugin storage location
~/.codex/plugins/<name>/                       # personal plugin storage location
```

Loader rules:

- `source.path` in the marketplace is resolved **relative to the marketplace
  root**, must be `./`-prefixed, and must stay inside that root.
- **Restart Codex** after changing plugin files or marketplace entries — there
  is no hot reload.
- Disable without uninstalling by setting `enabled = false` under
  `[plugins."<name>@<marketplace>"]` in `~/.codex/config.toml`.

---

## Manifest — `.codex-plugin/plugin.json`

```json
{
  "name": "my-first-plugin",
  "version": "1.0.0",
  "description": "Reusable greeting workflow",
  "skills": "./skills/"
}
```

- **`name`** _(required)_ — stable kebab-case id; the plugin identifier and
  component namespace.
- **`version`, `description`** — catalog metadata.
- Component pointers (e.g. `skills`) and bundled MCP/app/hook config are added
  as the plugin grows.

Marketplace entry (`marketplace.json`) — controls ordering, install policy, and
auth timing:

```json
{
  "name": "local-repo",
  "interface": { "displayName": "Local Example Plugins" },
  "plugins": [
    {
      "name": "my-plugin",
      "source": { "source": "local", "path": "./plugins/my-plugin" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    }
  ]
}
```

`source` may be `local`, `url` (git root), or `git-subdir`. `policy.installation`
is `AVAILABLE` / `INSTALLED_BY_DEFAULT` / `NOT_AVAILABLE`;
`policy.authentication` decides on-install vs. first-use auth.

---

## Public API surface

Like Claude Code, Codex has **no in-process plugin SDK**. Plugins are
declarative bundles:

- **Skills** are markdown (`SKILL.md` with `name` + `description` frontmatter)
  plus optional `scripts/`, `references/`, `assets/`. Invoked implicitly by
  description match or explicitly via `$skill-name` / `@`.
- **Tools** come from **MCP servers** bundled or referenced by the plugin.
- **Hooks** invoke external commands (see below).

There is no `@vellumai/plugin-api` analog and no `PluginHookFn` callback
contract — integration is by file convention, MCP, and subprocess.

---

## Hooks

Hooks are **enabled by default** (toggle with the `hooks` key in `config.toml`;
`codex_hooks` is a deprecated alias). Codex discovers them next to active config
layers and **plugins can bundle their own** via the plugin manifest or a default
`hooks/hooks.json`:

```
~/.codex/hooks.json            # global
~/.codex/config.toml [hooks]   # global, inline
<project>/.codex/hooks.json    # project
<project>/.codex/config.toml [hooks]
```

Configuration shape (event → matcher rules → `command` hooks), e.g.:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command",
                    "command": "python3 ~/.codex/hooks/session_start.py",
                    "statusMessage": "Loading session notes" }] }
    ],
    "PreToolUse": [
      { "matcher": "Bash",
        "hooks": [{ "type": "command",
                    "command": "python3 \"$(git rev-parse --show-toplevel)/.codex/hooks/pre_tool_use_policy.py\"",
                    "statusMessage": "Checking Bash command" }] }
    ]
  }
}
```

- Events include `SessionStart`, `PreToolUse`, `PermissionRequest`, and related
  lifecycle points; the `matcher` filters by tool name (e.g. `Bash`).
- Hook `type` today is `command` — an external process; decisions come back via
  exit code / output, not in-place context mutation.
- **Trust review**: non-managed hooks (including plugin-bundled ones) go through
  a review flow — inspect/trust/disable via the `/hooks` CLI browser. Hooks from
  system/MDM/cloud/`requirements.toml` are **managed**, trusted by policy, and
  can't be user-disabled.

---

## Tools

Codex plugins do not define tools via a per-file default export. Model-callable
tools are contributed by:

- **MCP servers** — bundled in the plugin or declared in config; they connect
  Codex to external tools and shared systems.
- **Apps** — OAuth connectors (GitHub, Slack, Gmail, Google Drive, …) bundled in
  a plugin; Codex reads from and acts in those tools after the user authorizes
  them.

Built-in tool *behavior* is shaped by the sandbox/approval model in
`config.toml` (`approval_policy`, `sandbox_mode`, granular approval rules),
which is configuration rather than a plugin surface.

### Tool naming & namespacing

MCP tools are namespaced by server before they reach the model — the (sanitized)
server name forms the tool namespace, so identically named tools on different
servers don't collide. Per-server `enabled_tools` / `disabled_tools` allow/deny
lists filter by the raw tool name, and `tools.<tool>.approval_mode` overrides
approval per tool. Same server-namespacing idea as our `mcp__<server>__<tool>`
tools. Source: [MCP](https://developers.openai.com/codex/mcp).

---

## Conventions

- **Plugin = distribution bundle.** It packages skills, apps, MCP, and hooks for
  sharing across a repo, team, or workspace — not an in-process module.
- **Marketplace-driven.** Discovery/install go through marketplace JSON catalogs
  (`.agents/plugins/marketplace.json`) and the `/plugins` directory; restart to
  load.
- **Scaffold with `@plugin-creator`.** The built-in skill writes the manifest
  and a test marketplace entry.
- **Skills are the primary reusable workflow unit.** Rich instructions +
  scripts + references, discoverable by description without bloating context.
- **Workspace sharing vs. marketplace.** Share to specific teammates via the
  Codex app ("Created by you" → Share), or distribute by repo/CLI via a
  marketplace; admins can disable sharing with `plugin_sharing = false` in
  `requirements.toml`.
- **Plugins are a distribution unit, not a requirement.** MCP servers, skills,
  and hooks can all be added standalone, with no plugin: MCP servers under
  `[mcp_servers]` in `~/.codex/config.toml` (or a project `.codex/config.toml`)
  or via `codex mcp add`; skills in `$HOME/.agents/skills` (user),
  `.agents/skills` (repo), or `/etc/codex/skills` (admin); hooks in
  `~/.codex/hooks.json` or project `.codex/hooks.json`. A plugin bundles these
  for distribution. Sources:
  [Skills](https://developers.openai.com/codex/skills),
  [MCP](https://developers.openai.com/codex/mcp).
