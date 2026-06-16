---
name: plugin-builder
description: Walk the user through building, scaffolding, shipping, and editing a Vellum plugin that bundles hooks, tools, and skills into one installable package. Use when the user wants to extend their assistant with a new capability shipped as a plugin, publish to the marketplace, or push edits to an existing plugin's GitHub repo.
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🧩"
  vellum:
    category: "extensibility"
    display-name: "Plugin Builder"
    activation-hints:
      - "User wants to build, scaffold, or author a Vellum plugin"
      - "User wants to edit, update, or push changes to an existing plugin's GitHub repo"
      - "User wants to package skills, hooks, or tools into an installable plugin"
      - "User wants to extend their assistant with a new capability shipped as a plugin"
      - "User wants to publish a plugin to the Vellum marketplace catalog"
      - "User asks how to ship or distribute extensions for Vellum"
    avoid-when:
      - "User only wants to install or upgrade an existing plugin (use the `assistant plugins` CLI directly)"
      - "User only wants to author a single SKILL.md (use the skill-management skill)"
      - "User wants to add a one-off user_route or webhook (use the `assistant routes` skill)"
---

# Plugin Builder

You guide the user through building a Vellum plugin end to end: deciding what surfaces they need, scaffolding the directory, wiring imports against `@vellumai/plugin-api`, packaging the manifest, and shipping the plugin through the marketplace catalog.

Plugins are in beta. The peer-dep range you declare is what gets you load. Treat everything you write in this skill as something that can break between Vellum releases until 1.0 ships, and pin a real range.

## When to use this skill

USE THIS SKILL WHEN:
- The user wants to build a plugin for their assistant, even if they have not said "plugin" by name. Any "extend my assistant so it can do X automatically" request that implies shipping a capability is in scope.
- The user has existing skills, hooks, or tools scattered in their workspace and wants to bundle them.
- The user wants to publish a GitHub repo into the Vellum plugin marketplace.
- The user is exploring the surfaces (hooks, tools, skills) for the first time and needs a guided scaffold.

DO NOT use this skill when:
- The user only wants to install a plugin (`assistant plugins install <name>` is a 30-second CLI call, no skill needed).
- The user only wants a single SKILL.md authored (skill-management is the right skill).
- The user wants to add a webhook or user route (`assistant routes` is the right skill).
- The user wants to write a one-off TypeScript file the assistant should execute inline (no packaging needed).

## Before you write a single file

Ask before building. Five questions, in this order. Stop if the user is unclear on any of them.

1. **What job does the plugin do?** One sentence, plain language. If you cannot write this, the plugin should not be built yet.
2. **Which surfaces does it ship?** Tools (model calls), hooks (lifecycle transforms), and skills (on-demand instructions) are the three. Most plugins ship one or two, not all three.
3. **Does it need credentials?** An API key, OAuth token, or webhook secret is not a value that belongs in a `.ts` file. Anything sensitive gets declared in the manifest and resolved at `init` time.
4. **Where will the source live?** A GitHub repo, ideally under the user's own namespace. The marketplace entry pins to a full commit SHA.
5. **Is the user writing TypeScript or compiling ahead?** In-repo Bun/Node compile on daemon start is the default. If they want a different build, ask now.

You have an alignment problem if the user cannot answer questions 1 and 2. Push back and clarify before scaffolding. The most expensive waste of plugin-authoring time is building a plugin whose job is fuzzy.

✓ Checkpoint: alignment on job and surfaces locked before continuing.

## Mental model

A plugin is a directory with a manifest and zero or more surface subdirectories. The host walks the directory on load and discovers what the plugin contributes. Missing directories are silently skipped, so a plugin contributes only what it ships. A broken surface file fails only itself; sibling plugins keep loading.

| Surface | Lives in          | When it fires                                                                                                  |
| ------- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| Tools   | `tools/<name>.ts` | When the model decides to call the tool.                                                                       |
| Hooks   | `hooks/<name>.ts` | At fixed lifecycle events (init, user-prompt-submit, pre/post-model-call, post-tool-use, post-compact, stop). |
| Skills  | `skills/<name>/`  | When the conversation matches the skill's `description` and activation hints.                                  |

Everything else inside the plugin directory (`src/`, `utils/`, `schemas/`) is yours and is not walked by the loader. Put shared helpers there.

A broken plugin never blocks the rest of the workspace. Loading is per-plugin, per-surface, and time-boxed to 10 seconds.

## Scaffold the directory

The loader expects exactly this shape:

```
my-plugin/
├── package.json         # Manifest, required
├── README.md            # Optional docs
├── hooks/               # One file per hook
├── tools/               # One file per tool
├── skills/              # One directory per skill
│   └── <skill-name>/
│       └── SKILL.md
└── src/                 # Yours, not walked by the loader
```

Choose a kebab-case directory name. It becomes the install name. `@scope/<name>` is allowed; the loader strips the scope for the runtime plugin name. Duplicate names fail registration.

The manifest is a normal `package.json` with three watched fields:

```json
{
  "name": "@you/my-plugin",
  "version": "0.1.0",
  "peerDependencies": {
    "@vellumai/plugin-api": "^0.8.0"
  },
  "vellum": {}
}
```

- `name`: required. The scope is stripped for the runtime plugin name.
- `version`: informational. Defaults to `0.0.0` if absent.
- `peerDependencies["@vellumai/plugin-api"]`: required while the API is in beta. Pin a real range. Mismatches are logged but do not yet block load; they will harden into a hard reject before 1.0.
- `vellum`: reserved.

Install locally to test before pushing to the catalog. The CLI clones the directory into `<workspaceDir>/plugins/<name>/` and the loader picks it up on the next daemon start:

```
assistant plugins install --local /path/to/my-plugin
```

✓ Checkpoint: directory tree and manifest written. Local install succeeds. `assistant plugins list` shows your plugin with status `ok`.

## Recipe 1: a tool the model can call

A tool is a default-exported object from `tools/<name>.ts`. The file basename becomes the tool name unless you override `name`. Every field is optional, so `export default {}` is technically valid (and useless, leave yourself a working stub).

The minimal useful tool:

```ts
import type { ToolDefinition } from "@vellumai/plugin-api";

const lookup: ToolDefinition = {
  description: "Look up a value by key in the user's plugin storage.",
  input_schema: {
    type: "object",
    properties: {
      key: { type: "string", description: "The key to look up." },
    },
    required: ["key"],
  },
  defaultRiskLevel: "low",
  execute: async (input: { key: string }, ctx) => {
    const fs = await import("node:fs/promises");
    const path = `${ctx.pluginStorageDir}/store.json`;
    try {
      const raw = await fs.readFile(path, "utf8");
      return { content: JSON.parse(raw)[input.key] ?? null };
    } catch {
      return { content: null };
    }
  },
};

export default lookup;
```

Field reference (every field is optional; defaults fill in):

- `name`: overrides the file-derived tool name. Only set this when the filename would leak implementation details.
- `description`: written for the model. This is how it decides when to call the tool. Empty renders the tool invisible.
- `input_schema`: JSON Schema. The model is constrained to this shape.
- `defaultRiskLevel`: `"low" | "medium" | "high"`. Defaults to `medium`, which prompts the user on first call. Pick `low` for read-only, `high` for anything that touches credentials or sends external messages.
- `category`: grouping for channel-scoped permission enforcement.
- `executionTarget`: `"sandbox" | "host"`. Resolves automatically; only set if you need the host process specifically (file picker, OS APIs, GUI).
- `execute(input, ctx)`: returns `{ content, isError? }`. Use `ctx.signal` for cooperative cancellation. Use `ctx.onOutput` for streaming (fall back to a full result in `content` if it is absent).

## Recipe 2: a lifecycle hook

A hook is a default-exported async function from `hooks/<name>.ts`. The filename must match a wired hook name: `init.ts`, `user-prompt-submit.ts`, `pre-model-call.ts`, `post-model-call.ts`, `post-tool-use.ts`, `post-compact.ts`, `stop.ts`. The full set lives in the `HOOKS` constant; reference hooks by constant, not free-form strings.

The minimum useful hook:

```ts
import { HOOKS, type PluginHookFn } from "@vellumai/plugin-api";

const onPrompt: PluginHookFn = async (ctx) => {
  if (ctx.isNonInteractive) return;
  const last = ctx.latestMessages[ctx.latestMessages.length - 1];
  if (!last || last.role !== "user") return;
  ctx.logger.info({ conversationId: ctx.conversationId }, "turn started");
};

export default {
  [HOOKS.USER_PROMPT_SUBMIT]: onPrompt,
};
```

Hook reference (the ones that matter for plugins shipping today):

- `init`: once at boot. Validate config, open resources, fetch credentials. Throwing aborts this plugin's load. Gets `credentials`, `pluginStorageDir`, `assistantVersion`, `logger`.
- `user-prompt-submit`: once per turn, before the agent loop. Mutate `latestMessages` (the working message list) or return a replacement. `originalMessages` is read-only and is your baseline for diffing.
- `pre-model-call`: before every provider call, including tool-result follow-ups. Edit `systemPrompt` (guard the null case). Set `deferAssistantOutput: true` to defer streaming and emit final text from a `post-model-call` hook.
- `post-model-call`: at every model outcome. Mutate `content` text blocks; leave `tool_use` alone. Own the continue decision: return `{ decision: { type: "continue" | "end-turn" } }`. `error` is set on a rejection outcome; guard on it and return early on rejection-only logic.
- `post-tool-use`: once per tool result. Read the result and transform it.
- `post-compact`: re-apply context that compaction dropped. Inject blocks forward-attributed with `requestId`. `injectionMode` is `"full"` or `"minimal"`.
- `stop`: terminal. Fires once per turn after the loop commits to ending.

`pre-model-call`, `post-model-call`, and `post-tool-use` can fire more than once per user turn because the loop iterates. Plan for that.

## Recipe 3: a skill to ship inside the plugin

A skill is a directory with `SKILL.md` at its root. Required frontmatter is `name` and `description`; everything in `metadata.vellum` is optional and refines how the skill gets presented and matched. Write `description` and `activation-hints` for the model, not for a human reader. The assistant matches against them to decide when to load the skill.

```yaml
---
name: standup-notes
description: >-
  Draft a daily standup update from recent activity. Use when the user
  asks for their standup, daily update, or what they did yesterday.
metadata:
  emoji: "📋"
  vellum:
    display-name: "Standup Notes"
    activation-hints:
      - "User asks for their standup or daily update"
    avoid-when:
      - "User wants a full weekly report, not a daily standup"
```

Body is plain Markdown. Convention: anchor the activation situation at the top, walk the workflow, end with a concrete next step. Optional `references/` and `scripts/` subdirectories sit alongside `SKILL.md` if the skill needs them. Scripts the skill runs are just files the assistant calls via `bash`; nothing magical about the directory.

## The plugin-api package: what to import, what not to

Everything you import against the host goes through [`@vellumai/plugin-api`](https://github.com/vellum-ai/vellum-assistant/tree/main/assistant/src/plugin-api). It is the only supported contract. Anything not exported from there is internal and can change without notice.

What to import:

- Hook context types and the `HOOKS` constant. Reference hooks by constant.
- `ToolDefinition`, `ToolContext`, `ToolExecutionResult`, `RiskLevel`.
- `PluginLogger` (Pino-compatible, scoped to your plugin, threaded onto contexts).
- Runtime handles: `assistantEventHub` (the pub/sub hub for runtime events) and `getSecureKeyAsync` (read a secret by key). Both rebind to the assistant's live singletons via a boot-time shim; do not wrap them.

What not to import:

- Any internal handler, service, or module under the host's own paths. If you need something that is not in `plugin-api`, request it upstream.
- Anything that requires running outside the host process without first declaring `executionTarget: "host"` on the tool.

## Distribution: get your plugin into the catalog

The marketplace is a single file: `plugins/marketplace.json` at the root of `vellum-ai/vellum-assistant`. It is the only source for installable plugins. There is no open registry. The Vellum team reviews each entry before it lands.

Add your plugin as a new entry. Keep the schema minimal:

```json
{
  "name": "my-plugin",
  "source": {
    "source": "github",
    "repo": "your-org/my-plugin",
    "ref": "e83c5163316f89bfbde7d9ab23ca2e25604af290"
  },
  "description": "Short summary shown in the catalog.",
  "category": "productivity",
  "homepage": "https://github.com/your-org/my-plugin",
  "license": "MIT"
}
```

The fields the entry must set:

- `name`: single kebab-case segment. Becomes the install name and the catalog row.
- `source.source`: only `"github"` is resolved today.
- `source.repo`: `owner/repo` of the external repository.
- `source.ref`: a full commit SHA (40 or 64 hex chars). Tags and branches are rejected.
- `source.path`: optional subdirectory within the repo holding the plugin root. `..` segments are rejected.
- `description`, `category`, `homepage`, `license`: optional but expected by reviewers.

Why the SHA pin matters: the assistant shallow-clones the repo and imports the code at install time. A mutable ref means the upstream owner can change what executes between your review and the user's install. The full SHA is the only reproducible shape. To pin a release tag, peel it with `^{}` so you record the commit, not the tag object.

To submit:

1. Open a PR against `vellum-ai/vellum-assistant` adding your entry to `plugins/marketplace.json`.
2. Bump the entry's `source.ref` to the commit you actually want users to run.
3. Wait for the Vellum team's review. The catalog is curated.

Once merged, users install by name:

```
assistant plugins install my-plugin
```

The install is not hot-loaded. The user restarts their assistant to pick up the new code. Upgrades work the same way; `assistant plugins upgrade <name>` moves to the marketplace's current pin.

✓ Checkpoint: entry added with a pinned SHA, restart the assistant, verify `assistant plugins list` shows it and `assistant plugins inspect <name>` reports `up-to-date` with `drift: none`.

## Verify before shipping

Local verification in order:

1. `assistant plugins install --local /path/to/my-plugin` succeeds.
2. `assistant plugins list` shows your plugin with status `ok` (not `error`, not `skipped`).
3. `assistant plugins inspect <name>` reports `up-to-date` and `drift: none`.
4. The plugin loads inside the 10-second import budget. Anything slower is treated as a load failure and skipped.
5. Each surface is exercised on a real code path: a tool gets called by the model, a hook fires on the right event, a skill loads when the activation hints match.
6. Compiled files win. If you ship both `.js` and `.ts` for the same basename, the `.js` is loaded. Either commit the build output or stay on `.ts` only.

Common failure modes, by surface:

- "broken surface" in `assistant plugins list` → your file default-exported something the loader could not read. Check syntax and that you used `export default`.
- "load timeout" → `init` is too slow or imports cycle back into the host.
- Tool never gets called → empty `description`. The model matches on text, not on `input_schema`.
- Hook fires twice unexpectedly → `pre-model-call` and friends fire once per loop iteration. Your transformation must be idempotent.
- Skill never fires → activation hints too narrow or wrong category. Loosen, test, narrow again.
- Catalog PR rejected → `source.ref` is a tag or branch instead of a full SHA.

## SKILL COMPLETE WHEN

- Job and surfaces locked in the alignment pass (questions 1 and 2 answered).
- Directory matches the loader convention (`hooks/`, `tools/`, `skills/`, optional `src/`).
- `package.json` declares `name`, `version`, and a real `peerDependencies["@vellumai/plugin-api"]` range.
- Each surface has been exercised locally with a working example.
- A `marketplace.json` entry exists with a full SHA in `source.ref`, and the Vellum team's review is in flight.

Once those are true, the plugin is shippable. Push the catalog PR and mark this skill done.
