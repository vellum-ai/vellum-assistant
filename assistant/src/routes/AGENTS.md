# Route Host Subprocess — Agent Instructions

This directory hosts the **route host**: a dedicated OS subprocess that runs
user-defined `/x/*` route handlers off the daemon. It exists because a route
handler that blocks synchronously (a busy loop, a sync sleep, a blocking
`execSync`) freezes whatever event loop it runs on — inline on the daemon's
loop, one bad route stalls the whole daemon.

A subprocess (not a worker thread) is deliberate: on Bun/JavaScriptCore,
`Worker.terminate()` cannot interrupt a synchronous loop, so a wedged handler
can't be forcibly reclaimed in-thread. A separate process can be hard-killed
(`SIGKILL`), and it can grow into a DB-sharing peer once conversations are
backgroundable — which a thread sharing the daemon's isolate never could.

## Components

- **`worker.ts`** — the subprocess entry. Binds a Unix socket, writes its PID
  file as the readiness signal, and serves `invoke` requests: import the
  handler module, run it against a reconstructed `Request`, marshal the
  `Response` back. Lifecycle mirrors `monitoring/worker.ts` and reuses
  `util/worker-process.ts` (PID-file spawn/guard/cleanup).
- **`route-host-client.ts`** — the daemon-side client. Lazily spawns the host,
  holds one socket connection, correlates replies by id, and on per-request
  timeout **hard-kills** the host + respawns on the next call.
- **`route-host-protocol.ts`** — the `invoke` wire contract. Bodies ride in the
  framing's binary follow-frame, not the JSON envelope.
- **`proc-paths.ts`** — the `procs/<name>/` convention (below).

## `$VELLUM_WORKSPACE_DIR/procs/<name>/` convention

Every daemon-managed subprocess keeps its runtime bookkeeping — IPC socket, PID
file, per-process scratch — under one directory named for it. This replaces the
ad-hoc sprinkling of `.pid` / `.sock` files across the workspace: `ls
$VELLUM_WORKSPACE_DIR/procs` is a census of managed subprocesses, and cleanup is
one `rm -rf`. New subprocesses MUST follow this layout via `proc-paths.ts`
rather than inventing their own path. Keep socket basenames short — Unix
`sun_path` is ~104–108 bytes.

## No handler context (yet)

Handlers run with **no injected `context`**. Reaching daemon state (publishing
events, running conversation turns) is deferred to the plugin-api once it is
safe out-of-process. Do NOT reintroduce an in-process `context` bridge or let
the host `import` the daemon graph (`getDb`, the conversation store,
`runConversationTurn`): those resolve to _per-process_ singletons here — a
second DB connection, an empty conversation registry, and a migration-readiness
latch that defaults open — so they are wrong out-of-process until that state
becomes DB-backed. The host stays dependency-light: node stdlib + the IPC
framing only.

## Status / follow-ups

The host mechanism (spawn, invoke, timeout→kill→respawn) is in place and
covered by `__tests__/route-host.test.ts` (real subprocess). Not yet wired:
dispatch delegation from `runtime/routes/user-route-dispatcher.ts`, the config
flag that selects in-band vs. host execution, a host **pool** to isolate
route-from-route (a single host serializes on its one loop until a stall is
killed), and the plugin-api surface for out-of-process daemon access.
