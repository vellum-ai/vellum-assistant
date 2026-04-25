/**
 * meet-host entrypoint — the long-lived bin spawned by
 * `MeetHostSupervisor` via `bun run skills/meet-join/entrypoint.ts`.
 *
 * Lifecycle:
 *
 *   1. Parse CLI args:
 *      - `--ipc=<path>`            (required) skill IPC socket path
 *      - `--skill-id=<id>`         (optional) skill identifier; defaults
 *                                   to `meet-join`. The id is used as the
 *                                   default logger scope and as the owner
 *                                   key for tool/route registrations on
 *                                   the daemon side.
 *
 *   2. Construct `SkillHostClient({ socketPath, skillId })` and `await
 *      client.connect()`. The client prefetches sync state
 *      (`identity.internalAssistantId`, `platform.workspaceDir()`, etc.)
 *      so subsequent in-skill code reads cache hits, not RPC round-trips.
 *
 *   3. Import the skill's `register(host)` from `./register.js` and
 *      invoke it. `register(client)` walks the skill's tools, routes,
 *      and shutdown hooks outward through `host.registries.*`. PR B
 *      additionally installs inbound `skill.dispatch_*` handlers via
 *      `client.registerHandler(...)` so the daemon can later proxy tool
 *      and route invocations back to this process. PR B is in flight; if
 *      it has not landed yet, the dispatch handlers simply are not
 *      registered and the daemon's manifest loader will not yet send
 *      such requests.
 *
 *   4. Stay alive. The skill registries return synchronously; once they
 *      drain, the entrypoint has nothing further to do but keep the
 *      socket open so the daemon can issue dispatch requests against
 *      the long-lived connection.
 *
 *   5. Shut down on either of:
 *      - **Socket disconnect** — the daemon dropped the socket
 *        (graceful daemon shutdown or crash). Run any registered
 *        shutdown hooks, log, and exit `0`.
 *      - **`skill.shutdown` daemon-initiated request** — the daemon
 *        explicitly asked us to wind down. Same teardown path.
 *      - **OS signal** (SIGTERM/SIGINT) — an external lifecycle manager
 *        signaled us. Same teardown path.
 *
 *  ## Readiness handshake
 *
 *  `MeetHostSupervisor` waits for `notifyHandshake({ sourceHash })`
 *  to know the child has registered and is healthy. The supervisor's
 *  IPC route handler that observes the first `host.registries.register_tools`
 *  call forwards the source hash to the supervisor — so simply driving
 *  `register(client)` to completion (which fires `register_tools` over
 *  IPC) is what counts as readiness here. There is no separate
 *  `host.registries.ready` ping at the entrypoint layer.
 *
 *  ## Failure modes
 *
 *  - Connect failure (socket missing, perm denied, …) → log, exit 1.
 *  - register() throws (config schema invalid, sub-module wiring
 *    failure, …) → log, attempt clean disconnect, exit 1.
 *  - Unhandled rejection / exception inside steady-state operation →
 *    log, exit 1. Letting the process die so the supervisor can
 *    respawn is preferable to limping along in a half-broken state.
 *
 *  ## Why not use `register.ts` directly as the bin?
 *
 *  `register.ts` exports a pure `register(host)` function — it deliberately
 *  has no side effects on import so the manifest emitter
 *  (`scripts/emit-manifest.ts`) and the in-process daemon bootstrap
 *  (`assistant/src/daemon/external-skills-bootstrap.ts`) can both load
 *  it without spawning a network server. The entrypoint is the
 *  out-of-process wrapper that turns `register(host)` into a runnable
 *  bin: it owns the IPC connection, the readiness signaling, and the
 *  teardown loop, none of which belong in the registration function.
 */

import { parseArgs } from "node:util";

import { SkillHostClient } from "@vellumai/skill-host-contracts";

import { register } from "./register.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SKILL_ID = "meet-join" as const;

/**
 * Daemon→skill request method the supervisor uses to ask the skill to
 * shut itself down. Wired through `client.registerHandler(...)`. The
 * supervisor's current implementation (PR 27) sends `skill.shutdown` on
 * a fresh control socket; PR D replaces that path with a
 * daemon-initiated request on the long-lived connection that resolves
 * once registered shutdown hooks have run.
 */
const SKILL_SHUTDOWN_METHOD = "skill.shutdown" as const;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  socketPath: string;
  skillId: string;
}

/**
 * Parse the supervisor-supplied CLI args. Throws a descriptive error
 * with usage info when `--ipc` is missing so the supervisor's stderr
 * forwarder surfaces a clear message instead of an opaque crash.
 */
export function parseEntrypointArgs(argv: readonly string[]): ParsedArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      ipc: { type: "string" },
      "skill-id": { type: "string" },
    },
    strict: true,
  });

  const socketPath = values.ipc;
  if (!socketPath) {
    throw new Error(
      "meet-host entrypoint: missing required --ipc=<socket-path> argument. " +
        "Usage: bun run skills/meet-join/entrypoint.ts --ipc=<socket> [--skill-id=<id>]",
    );
  }
  const skillId = values["skill-id"] ?? DEFAULT_SKILL_ID;
  return { socketPath, skillId };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run the entrypoint to completion. Returns the exit code the caller
 * should pass to `process.exit`. Split out so the unit test can
 * exercise the connect/register/teardown flow without spawning a
 * subprocess or letting the harness terminate via `process.exit`.
 */
export async function runEntrypoint(args: ParsedArgs): Promise<number> {
  const client = new SkillHostClient({
    socketPath: args.socketPath,
    skillId: args.skillId,
  });

  // Promise that resolves once we should begin teardown — set by the
  // socket-disconnect listener, the SIGTERM/SIGINT handler, or the
  // `skill.shutdown` daemon-initiated request handler.
  let resolveExit!: (reason: string) => void;
  const exitTrigger = new Promise<string>((resolve) => {
    resolveExit = resolve;
  });

  // Daemon-initiated `skill.shutdown` handler. Resolves immediately so
  // the supervisor's `sendRequest` ack returns; the actual teardown is
  // driven by `exitTrigger` and the registered shutdown hooks. The
  // handler closure is harmless if PR D never wires the route — the
  // dispatch table only fires on a matching `d:`-prefixed frame.
  client.registerHandler(SKILL_SHUTDOWN_METHOD, () => {
    resolveExit("skill.shutdown");
  });

  try {
    await client.connect();
  } catch (err) {
    // Connect failures are fatal — there's no useful work the entrypoint
    // can do without the daemon. Surface to stderr so the supervisor's
    // stderr forwarder picks it up, then exit non-zero.
    // eslint-disable-next-line no-console -- pre-logger fatal
    console.error(
      `meet-host entrypoint: failed to connect to ${args.socketPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 1;
  }

  const log = client.logger.get("entrypoint");

  // Watch the underlying socket for unexpected close so we can shut down
  // when the daemon goes away. The client's `close()` is also our path
  // for explicit teardown — both routes funnel through `exitTrigger`.
  // The client doesn't expose its socket directly; instead we install a
  // best-effort poller on the next tick that resolves when `rawCall`
  // throws "not connected" or the socket is destroyed.
  void watchSocketHealth(client, resolveExit);

  // Drive the skill's registration. `register()` is synchronous — every
  // host call is fire-and-forget over IPC — so any failure here is from
  // a wiring exception (e.g. session-manager constructor throws), not a
  // registration RPC error. Surface it and exit non-zero.
  try {
    register(client);
  } catch (err) {
    log.error("register() threw during bootstrap", {
      err: err instanceof Error ? err.message : String(err),
    });
    client.close();
    return 1;
  }

  log.info("meet-host registered; awaiting daemon requests", {
    skillId: args.skillId,
    socketPath: args.socketPath,
  });

  // Install OS signal handlers so an external SIGTERM (e.g. supervisor's
  // signal escalation path, container teardown) walks the same teardown
  // path as a `skill.shutdown` request. The returned uninstall removes
  // the listeners on clean exit so repeated `runEntrypoint` invocations
  // (notably under `bun test`) do not accumulate handlers and breach
  // Node's default `maxListeners` ceiling.
  const uninstallSignals = installSignalHandlers(resolveExit);

  // Wait for any teardown trigger.
  const reason = await exitTrigger;
  uninstallSignals();
  log.info("meet-host beginning teardown", { reason });

  // Close the client — this rejects any in-flight calls and dispose()s
  // every active subscription so registered shutdown hooks (PR D) see a
  // clean shutdown sequence.
  try {
    client.close();
  } catch (err) {
    log.warn("client.close() failed during teardown", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return 0;
}

/**
 * Best-effort socket-health watcher. Periodically pokes the client with
 * a no-op ping; if the underlying socket has dropped, the call rejects
 * with a connection-closure error and we resolve `exitTrigger`. The
 * check interval is set high enough (one second) that it does not
 * hot-loop the daemon while still triggering teardown promptly when
 * the connection drops.
 *
 * Only confirmed connection-closure errors trigger teardown. Timeouts
 * and other transient `rawCall` failures are ignored — a busy or
 * temporarily stalled daemon must not be mistaken for a dead socket,
 * since that would interrupt active sessions.
 *
 * The internal timer is `unref()`d so a hung loop does not pin the
 * process alive past `process.exit` on the happy path.
 *
 * Future work (PR D): swap this poller for a `disconnect` event the
 * `SkillHostClient` exposes directly so the entrypoint observes
 * close-of-socket without the indirection.
 */
async function watchSocketHealth(
  client: SkillHostClient,
  resolveExit: (reason: string) => void,
): Promise<void> {
  const log = client.logger.get("entrypoint");
  const intervalMs = 1_000;
  while (true) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, intervalMs);
      t.unref();
    });
    try {
      await client.rawCall<string>("host.identity.getInternalAssistantId");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isConnectionClosureError(message)) {
        resolveExit("socket-disconnect");
        return;
      }
      // Transient (e.g. call timeout in a busy daemon). Log and keep
      // polling — the next tick will retry.
      log.warn("socket health probe failed; continuing", { err: message });
    }
  }
}

/**
 * Distinguish confirmed connection-closure errors from transient
 * `rawCall` failures (timeouts, etc). The message strings are owned by
 * `SkillHostClient` — see `call()` and the `socket.on("close")` handler
 * in `packages/skill-host-contracts/src/client.ts`.
 */
function isConnectionClosureError(message: string): boolean {
  return (
    message.includes("not connected") ||
    message.includes("client is closed") ||
    message.includes("socket closed")
  );
}

/**
 * Install SIGTERM/SIGINT handlers that drive the same teardown path as
 * a daemon-issued `skill.shutdown`. Returns an uninstall fn the caller
 * runs on clean exit so the handlers don't outlive the run. Repeated
 * signals after the first are no-ops — Node's default SIGKILL
 * escalation still applies if we hang during teardown.
 */
function installSignalHandlers(
  resolveExit: (reason: string) => void,
): () => void {
  let triggered = false;
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  const handlers = signals.map((sig) => {
    const handler = (): void => {
      if (triggered) return;
      triggered = true;
      resolveExit(`signal:${sig}`);
    };
    process.on(sig, handler);
    return { sig, handler };
  });
  return () => {
    for (const { sig, handler } of handlers) {
      process.off(sig, handler);
    }
  };
}

// ---------------------------------------------------------------------------
// Bin guard
// ---------------------------------------------------------------------------

// `import.meta.main` is true only when this file is the process entry
// point (Bun + Node 22+). Tests import the file as a module so they
// reach `runEntrypoint` directly without firing the bootstrap below.
if (import.meta.main) {
  const args = parseEntrypointArgs(process.argv.slice(2));
  runEntrypoint(args)
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      // Top-level catch for anything that escapes runEntrypoint's
      // try/catch (should be impossible, but defends against future
      // refactors that move work outside it).
      // eslint-disable-next-line no-console -- top-level fatal
      console.error(
        `meet-host entrypoint: fatal error: ${
          err instanceof Error ? err.stack ?? err.message : String(err)
        }`,
      );
      process.exit(1);
    });
}
