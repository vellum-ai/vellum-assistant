# turn-tally

An intentionally small example plugin that keeps a per-conversation
activity tally: prompts submitted, tool calls run (per tool name when
enabled), and how each turn ended. Its job is to demonstrate, in one
place, every core surface a plugin can ship and the state-ownership
contract they share. Read it alongside the `plugin-builder` skill
(`skills/plugin-builder/`), whose reference files document each contract
in full.

## Surface map

| File | Surface | Demonstrates |
| ---- | ------- | ------------ |
| `package.json` | Manifest | `name`, `version`, and the `@vellumai/plugin-api` peer-dependency range the loader checks. |
| `config.json` | User config | A default the user can edit in place; read via `InitContext.config` and preserved across upgrades. |
| `hooks/init.ts` | Lifecycle hook | Opens plugin-owned SQLite storage under `InitContext.pluginStorageDir` and applies schema idempotently. |
| `hooks/user-prompt-submit.ts` | Agent-loop hook | Observes each user prompt and emits a transient `ctx.broadcast` event. |
| `hooks/post-tool-use.ts` | Agent-loop hook | Observes each tool result, resolving the tool name from the history by `tool_use_id`. |
| `hooks/stop.ts` | Agent-loop hook | Records the turn's terminal `exitReason` once per run. |
| `hooks/conversation-deleted.ts` | Cleanup hook | Purges the deleted conversation's rows. |
| `hooks/conversations-cleared.ts` | Cleanup hook | Wipes all rows on the clear-all reset. |
| `hooks/shutdown.ts` | Lifecycle hook | Closes the storage handle opened by `init`. |
| `tools/turn_tally.ts` | Model-visible tool | A low-risk tool in the shared catalog; the file basename is the tool name. |
| `routes/tally.ts` | HTTP route | `GET /x/plugins/turn-tally/tally` serving the tallies as JSON. |
| `skills/tally-report/SKILL.md` | Skill | On-demand instructions that drive the `turn_tally` tool. |
| `src/tally-store.ts` | Internal module | Shared helpers; `src/` is not walked by the loader. |

The one core surface not shown here is apps (a compiled Preact bundle
rendered in the workspace panel); see
`skills/plugin-builder/references/apps.md` for that contract.

## State is plugin-owned

All durable state lives in one SQLite file inside the plugin's `data/`
directory. `init` creates it, `shutdown` closes it,
`conversation-deleted` and `conversations-cleared` purge it, and
uninstall removes the whole directory. Nothing touches the assistant's
own database. Every store operation fails open: a broken store degrades
to no-op tallies rather than blocking the turn.

One wrinkle worth copying: the route module cannot share the hooks'
in-memory handle, because the dispatcher re-imports route files with a
cache-busting URL. The store therefore lazily opens the same file from
the plugin's data directory (derived from `getWorkspaceDir()`) whenever
a surface with a fresh module instance touches it.

## Try it

Copy the directory into a workspace (or install it from a GitHub URL,
see `skills/plugin-builder/references/distribution.md`):

```
cp -R plugins/turn-tally "$VELLUM_WORKSPACE_DIR/plugins/turn-tally"
assistant plugins list        # status should be "ok"
```

Then exercise each surface the way a user would:

- **Hooks**: send a few messages, including one that runs a tool.
- **Tool / skill**: ask "how many prompts have I sent in this
  conversation?" and the model answers via `turn_tally` (guided by the
  `tally-report` skill when it activates).
- **Route**: `GET /x/plugins/turn-tally/tally` against the assistant's
  API base returns the tallies as JSON.
- **Cleanup**: delete the conversation and re-check the route; its rows
  are gone.
