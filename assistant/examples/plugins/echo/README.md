# Echo plugin

Minimal example plugin. Observes every assistant pipeline and logs one JSON
line per invocation to `stderr`:

```json
{"plugin":"echo","pipeline":"tokenEstimate","durationMs":1,"outcome":"success"}
{"plugin":"echo","pipeline":"turn","durationMs":1873,"outcome":"success"}
```

Use this as a starting point for writing your own plugin, or as a quick way
to eyeball which pipelines fire during a conversation and how long they
take.

For the full plugin authoring guide, see
[`assistant/docs/plugins.md`](../../../docs/plugins.md).

## What it does

- Registers one observer middleware per slot in
  `PipelineMiddlewareMap` — `turn`, `memoryRetrieval`,
  `tokenEstimate`, `compaction`, `overflowReduce`, `persistence`, and
  `circuitBreaker`.
- Each middleware calls `next(args)` to pass the request through unchanged,
  measures wall-clock duration, and emits one line to `stderr` whether the
  downstream succeeded or threw.
- Never modifies arguments, never rewrites results, never swallows errors.
  It is purely observational — safe to stack alongside any other plugin.

## Install locally

The assistant scans `<workspaceDir>/plugins/*` (e.g.
`~/.vellum/workspace/plugins/`) for subdirectories containing a
`register.{ts,js}` file and dynamic-imports each one during assistant
startup. Dropping (or symlinking) this directory in place is enough to
enable it.

The plugin reads `registerPlugin` from `globalThis.__vellumPluginRuntime`,
which the daemon attaches before scanning plugins. This works against both
the `bun --compile`-bundled daemon binary AND a daemon running from
source — no special install procedure required either way.

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
works for the runtime imports (which go through the global bridge), but
the `import type` lines at the top of `register.ts` still resolve into
the in-repo assistant source tree. If your standalone copy lives outside
a vellum-assistant checkout, rewrite those `import type` paths to point
at an absolute path inside any checkout — they're erased at compile time
and have no module-identity effect at runtime:

```ts
// before (repo-local):
import type { VellumPluginRuntime } from "../../../src/plugins/external-api.js";
import type { Plugin } from "../../../src/plugins/types.js";
// after (standalone, edit to your checkout path):
import type { VellumPluginRuntime } from "/path/to/vellum-assistant/assistant/src/plugins/external-api.js";
import type { Plugin } from "/path/to/vellum-assistant/assistant/src/plugins/types.js";
```

No runtime-import rewriting is needed — the bridge already handles that.

### Restart the assistant

Plugins register at assistant startup. After installing, restart the
assistant:

```bash
vellum restart
```

## Verify it works

With the plugin installed and the assistant restarted, send any message
that exercises a pipeline — a conversation turn, a tool call, a title
generation — and tail the assistant's stderr log:

```bash
tail -f ~/.vellum/daemon.log
```

You should see one line per pipeline invocation, similar to:

```json
{"plugin":"echo","pipeline":"persistence","durationMs":3,"outcome":"success"}
{"plugin":"echo","pipeline":"tokenEstimate","durationMs":1,"outcome":"success"}
{"plugin":"echo","pipeline":"memoryRetrieval","durationMs":64,"outcome":"success"}
{"plugin":"echo","pipeline":"turn","durationMs":1590,"outcome":"success"}
```

If a pipeline throws (for example, a tool that errors out), you'll see a
line with `"outcome":"error"` — the plugin rethrows after logging so the
original error still propagates.

## Uninstall

Remove the symlink (or the copied directory) and restart the assistant:

```bash
rm ~/.vellum/workspace/plugins/echo
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
