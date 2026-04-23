# Echo plugin

Minimal example plugin. Observes every assistant pipeline and logs one JSON
line per invocation to `stderr`:

```json
{"plugin":"echo","pipeline":"toolExecute","durationMs":42,"outcome":"success"}
{"plugin":"echo","pipeline":"llmCall","durationMs":1873,"outcome":"success"}
```

Use this as a starting point for writing your own plugin, or as a quick way
to eyeball which pipelines fire during a conversation and how long they
take.

For the full plugin authoring guide, see
[`assistant/docs/plugins.md`](../../../docs/plugins.md).

## What it does

- Registers one observer middleware per slot in
  `PipelineMiddlewareMap` — `turn`, `llmCall`, `toolExecute`,
  `memoryRetrieval`, `historyRepair`, `tokenEstimate`, `compaction`,
  `overflowReduce`, `persistence`, `titleGenerate`, `toolResultTruncate`,
  `emptyResponse`, `toolError`, and `circuitBreaker`.
- Each middleware calls `next(args)` to pass the request through unchanged,
  measures wall-clock duration, and emits one line to `stderr` whether the
  downstream succeeded or threw.
- Never modifies arguments, never rewrites results, never swallows errors.
  It is purely observational — safe to stack alongside any other plugin.

## Install locally

The assistant scans `~/.vellum/plugins/*` for subdirectories containing a
`register.{ts,js}` file and dynamic-imports each one during daemon startup.
Dropping (or symlinking) this directory in place is enough to enable it.

### Option 1 — symlink from the repo

From the repo root:

```bash
mkdir -p ~/.vellum/plugins
ln -s "$(pwd)/assistant/examples/plugins/echo" ~/.vellum/plugins/echo
```

Symlinks let you edit the plugin in-place and restart the daemon to pick
up changes.

### Option 2 — copy

If you prefer an isolated install that won't move with the repo:

```bash
mkdir -p ~/.vellum/plugins
cp -R assistant/examples/plugins/echo ~/.vellum/plugins/echo
```

### Restart the assistant

Plugins register at daemon startup. After installing, restart the
assistant:

```bash
vellum restart
```

## Verify it works

With the plugin installed and the daemon restarted, send any message that
exercises a pipeline — a conversation turn, a tool call, a title generation
— and tail the daemon's stderr log:

```bash
tail -f ~/.vellum/daemon.log
```

You should see one line per pipeline invocation, similar to:

```json
{"plugin":"echo","pipeline":"persistence","durationMs":3,"outcome":"success"}
{"plugin":"echo","pipeline":"tokenEstimate","durationMs":1,"outcome":"success"}
{"plugin":"echo","pipeline":"memoryRetrieval","durationMs":64,"outcome":"success"}
{"plugin":"echo","pipeline":"historyRepair","durationMs":0,"outcome":"success"}
{"plugin":"echo","pipeline":"llmCall","durationMs":1520,"outcome":"success"}
{"plugin":"echo","pipeline":"turn","durationMs":1590,"outcome":"success"}
```

If a pipeline throws (for example, a tool that errors out), you'll see a
line with `"outcome":"error"` — the plugin rethrows after logging so the
original error still propagates.

## Uninstall

Remove the symlink (or the copied directory) and restart the daemon:

```bash
rm ~/.vellum/plugins/echo
vellum restart
```

## Next steps

- Read [`assistant/docs/plugins.md`](../../../docs/plugins.md) for the full
  plugin authoring guide: manifest shape, middleware patterns
  (observe / transform / short-circuit / veto), strict-fail semantics, the
  per-pipeline timeout table, credential and config access, and
  troubleshooting.
- Look at the first-party default plugins under
  `assistant/src/plugins/defaults/` for examples of non-observational
  middleware.
- Build your own plugin by copying this directory, renaming the manifest
  `name`, and replacing the observer with a middleware that does whatever
  you need.
