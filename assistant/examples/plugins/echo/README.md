# Echo plugin

Minimal example plugin. Observes the assistant's turn-lifecycle hooks and logs
one JSON line per hook invocation to `stderr`:

```json
{
  "plugin": "echo",
  "hook": "post-tool-use",
  "conversationId": "conv_abc123"
}
```

Use this as a starting point for writing your own plugin, or as a quick way
to eyeball which hooks fire during a conversation.

For the full plugin authoring guide — manifest shape, every contribution
surface, hook patterns, and conventions — see
[`plugins/README.md`](../../../../plugins/README.md).
[`simple-memory`](../../../../plugins/simple-memory/) is the
canonical reference implementation that exercises every wired surface.

## What it does

- Contributes one observer hook per turn-lifecycle event:
  `user-prompt-submit`, `post-tool-use`, and `stop`.
- Each hook emits one line to `stderr` and returns `void`, so the threaded
  context flows through unchanged.
- Never modifies the turn's messages, tool results, or stop decision. It is
  purely observational — safe to stack alongside any other plugin.

## Directory layout

The assistant discovers a plugin by its `package.json` manifest and builds the
`Plugin` from the interface directories — `hooks/<name>.ts` files whose default
export is the hook function. Files under `src/` are internal helpers and are
not walked by the loader.

```
echo/
├── package.json               # Manifest (name + @vellumai/plugin-api range)
├── README.md
├── hooks/
│   ├── user-prompt-submit.ts  # default export = hook function
│   ├── post-tool-use.ts
│   └── stop.ts
└── src/
    └── emit.ts                # shared stderr emitter (not a surface)
```

## Install locally

The assistant scans `<workspaceDir>/plugins/*` (e.g.
`~/.vellum/workspace/plugins/`) for subdirectories containing a `package.json`
and loads each one during assistant startup. Dropping (or symlinking) this
directory in place is enough to enable it.

### Option 1 — symlink from the repo (simplest in-repo dev)

From the repo root:

```bash
mkdir -p ~/.vellum/workspace/plugins
ln -s "$(pwd)/assistant/examples/plugins/echo" ~/.vellum/workspace/plugins/echo
```

Symlinks let you edit the plugin in-place and restart the assistant to
pick up changes.

### Option 2 — standalone copy

A plain `cp -R` of this directory into `~/.vellum/workspace/plugins/echo/`
works as-is. The hooks import their types from the public `@vellumai/plugin-api`
specifier, which the daemon materializes as a workspace-level shim before it
loads any plugin — so the copied directory resolves it without any path
rewriting, in or out of a vellum-assistant checkout.

### Restart the assistant

Plugins register at assistant startup. After installing, restart the
assistant:

```bash
vellum restart
```

## Verify it works

With the plugin installed and the assistant restarted, send any message
that exercises a turn — a conversation reply, a tool call — and tail the
assistant's stderr log:

```bash
tail -f ~/.vellum/daemon.log
```

You should see one line per hook invocation, similar to:

```json
{
  "plugin": "echo",
  "hook": "post-tool-use",
  "conversationId": "conv_abc123"
}
```

## Uninstall

Remove the symlink (or the copied directory) and restart the assistant:

```bash
rm ~/.vellum/workspace/plugins/echo
vellum restart
```

## Next steps

- Read [`plugins/README.md`](../../../../plugins/README.md)
  for the full plugin authoring guide: manifest shape, every contribution
  surface, hook patterns (observe / transform), tool contributions, and
  conventions.
- Look at the first-party default plugins under
  `assistant/src/plugins/defaults/` for examples of hooks that transform a
  turn rather than just observing it.
- Build your own plugin by copying this directory, renaming the manifest
  `name`, and replacing the observer hooks with ones that do whatever you
  need.
