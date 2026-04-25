/**
 * `SkillHostClient` — IPC-backed concretion of the neutral `SkillHost`
 * interface. Lets an out-of-process first-party skill consume the daemon's
 * host surface over the Unix domain socket exposed by `SkillIpcServer`.
 *
 * Wire protocol (mirrors `assistant/src/ipc/skill-server.ts`):
 *
 *   skill-initiated RPC (one-shot)
 *     → { id: "s:<n>", method, params? }
 *     ← { id: "s:<n>", result } | { id: "s:<n>", error }
 *
 *   daemon-initiated RPC (one-shot, requires registered handler)
 *     ← { id: "d:<n>", method, params? }
 *     → { id: "d:<n>", result } | { id: "d:<n>", error }
 *
 *   streaming RPC (e.g. `host.events.subscribe`, skill-initiated only)
 *     → { id: "s:<n>", method, params? }
 *     ← { id: "s:<n>", result: { subscribed: true } }     (open ack)
 *     ← { id: "s:<n>", event: "delivery", payload: <data> } (0..N)
 *     ← { id: "s:<n>", error }                            (terminal)
 *     → { id: "s:<n>", method: "host.events.subscribe.close",
 *          params: { subscribeId: <original-id> } }
 *     ← { id: "s:<n>", result: { closed: true } }
 *
 * The `s:` / `d:` id prefixes namespace the two directions so each side can
 * route inbound responses to its own pending-request map without collision.
 *
 * ### Daemon-initiated dispatch handlers
 *
 * After the skill registers tools / routes / shutdown hooks via
 * `registries.registerTools`, `registries.registerSkillRoute`, and
 * `registries.registerShutdownHook`, the client also installs local
 * handlers for the matching `skill.dispatch_*` methods so the daemon can
 * invoke skill-side closures over the bidirectional RPC. The wire shapes
 * are:
 *
 *   skill.dispatch_tool
 *     daemon → skill: { name: string, input: Record<string, unknown>,
 *                        context?: unknown }
 *     skill → daemon: { result: unknown }
 *     errors: throws "unknown tool: <name>" when the tool name is not in
 *             the most recently registered provider's output.
 *
 *   skill.dispatch_route
 *     daemon → skill: { patternSource: string,
 *                        request: { method: string, url: string,
 *                                   headers?: Record<string, string>,
 *                                   body?: string } }
 *     skill → daemon: { status: number,
 *                        headers: Record<string, string>,
 *                        body: string }
 *     errors: throws "unknown route: <patternSource>" when no registered
 *             route matches the patternSource, or "url did not match
 *             pattern: <patternSource>" when the regex fails to match.
 *
 *   skill.shutdown
 *     daemon → skill: { name?: string, reason?: string }
 *     skill → daemon: { ok: true }
 *     semantics: when `name` is set, runs only that hook; otherwise runs
 *                all registered hooks in reverse-registration order. Per-
 *                hook errors are swallowed (logged via the host logger if
 *                `connect()` has populated one).
 *
 * ### Sync-method bootstrap
 *
 * The `SkillHost` contract exposes a number of synchronous accessors
 * (`identity.internalAssistantId`, `platform.workspaceDir()`,
 * `platform.runtimeMode()`, etc.) that naturally cannot round-trip an async
 * IPC call on every invocation. `connect()` prefetches the stable subset of
 * these values once, caches them locally, and every subsequent sync accessor
 * reads from the cache. Skill code MUST await `connect()` before any
 * synchronous host accessor fires; calling a sync accessor before connect
 * throws a clear "not connected" error.
 *
 * ### Opaque handle methods
 *
 * Several provider accessors on `SkillHost` (`providers.llm.getConfigured`,
 * `providers.llm.userMessage`, `providers.llm.extractToolUse`,
 * `providers.stt.resolveStreamingTranscriber`, `providers.tts.get`,
 * `speakers.createTracker`) return opaque handles whose concrete types live
 * inside `assistant/`. Across IPC they cannot carry the handle's method
 * closures — the skill treats the return value as a black-box token and
 * threads it into `host.providers.llm.complete` / future dispatch routes.
 * The client implements each as a passthrough that returns a tagged
 * descriptor object; the daemon-side handler that ultimately consumes the
 * token narrows it back to the concrete type at its boundary.
 *
 * ### Reconnect
 *
 * When `autoReconnect` is enabled, a lost socket connection is retried with
 * exponential backoff (capped at `reconnectMaxDelayMs`). In-flight requests
 * are rejected with a clear error because no response correlation survives
 * a socket reset; callers are responsible for retrying at a higher level.
 * Long-lived subscriptions are re-opened on reconnect with the same filter
 * so skill-side callbacks keep firing once the socket is back.
 */

import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";

import type { AssistantEvent } from "./assistant-event.js";
import type { DaemonRuntimeMode } from "./runtime-mode.js";
import type { ServerMessage } from "./server-message.js";
import type {
  AssistantEventCallback,
  ConfigFacet,
  EventsFacet,
  Filter,
  IdentityFacet,
  InsertMessageFn,
  LlmProvidersFacet,
  Logger,
  LoggerFacet,
  MemoryFacet,
  PlatformFacet,
  Provider,
  ProvidersFacet,
  RegistriesFacet,
  SecureKeysFacet,
  SkillHost,
  SkillRoute,
  SkillRouteHandle,
  SpeakersFacet,
  SttProvidersFacet,
  Subscription,
  ToolUse,
  TtsConfig,
  TtsProvider,
  TtsProvidersFacet,
  UserMessage,
} from "./skill-host.js";
import type { Tool, ToolContext } from "./tool-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUBSCRIBE_CLOSE_METHOD = "host.events.subscribe.close" as const;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 200;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 10_000;

/** Prefix for ids minted by the daemon (server) side. */
const DAEMON_ID_PREFIX = "d:" as const;
/** Prefix for ids minted by the skill (client) side. */
const SKILL_ID_PREFIX = "s:" as const;

// ---------------------------------------------------------------------------
// Wire-format types
// ---------------------------------------------------------------------------

type IpcRequest = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

type IpcResponseFrame = {
  id: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: string;
  event?: "delivery";
  payload?: unknown;
};

/**
 * Handler for a daemon-initiated request. Returning a value (or a Promise)
 * resolves the daemon's `sendRequest` call; throwing rejects it with the
 * thrown error's message. Synchronous returns are wrapped automatically.
 */
export type SkillHostRequestHandler = (
  params: unknown,
) => unknown | Promise<unknown>;

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

export interface SkillHostClientOptions {
  /** Absolute path to the `assistant-skill.sock` Unix domain socket. */
  socketPath: string;
  /**
   * Identifier for the owning skill. Sent as the default logger-scope name
   * when `logger.get(name)` is not explicitly scoped, and reserved for
   * future per-skill routing at the daemon boundary.
   */
  skillId: string;
  /**
   * Automatically reconnect the underlying socket when it drops. Existing
   * subscriptions are reopened with the same filter; in-flight one-shot
   * requests are rejected with a "connection lost" error.
   *
   * @default false
   */
  autoReconnect?: boolean;
  /** Initial retry delay (ms). Exponentially backs off to the max. */
  reconnectBaseDelayMs?: number;
  /** Maximum retry delay (ms). */
  reconnectMaxDelayMs?: number;
  /** Per-call timeout for one-shot RPCs. */
  callTimeoutMs?: number;
  /** Socket `connect()` timeout. */
  connectTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Internal state for pending calls and subscriptions
// ---------------------------------------------------------------------------

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveSubscription {
  id: string;
  filter: Filter;
  callback: AssistantEventCallback;
  disposed: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notConnected(): Error {
  return new Error(
    "SkillHostClient: not connected. Call `await client.connect()` before using synchronous host accessors.",
  );
}

/**
 * Wraps a sync logger call so a host.log RPC failure never throws at the
 * call site — skills treat logging as side-effectful and don't want a
 * transient socket issue to abort whatever they were doing.
 */
function swallow(err: unknown): void {
  // Intentional no-op; logging here would recurse into the same broken
  // logger. The stderr path is a deliberate last-resort sink.
  if (err && process.env.SKILL_HOST_CLIENT_DEBUG) {
    // eslint-disable-next-line no-console
    console.error("[SkillHostClient] log RPC failed:", err);
  }
}

/**
 * Stringify an unknown error value for the wire — `Error.message` when
 * available, otherwise `String(err)` so non-Error throws still surface
 * something readable on the daemon side.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Client implementation
// ---------------------------------------------------------------------------

export class SkillHostClient implements SkillHost {
  // Facets are populated in the constructor so every `SkillHost` method
  // has a concrete target even before `connect()` resolves. Sync methods
  // that depend on prefetched state throw `notConnected()` until then.
  readonly logger: LoggerFacet;
  readonly config: ConfigFacet;
  readonly identity: IdentityFacet;
  readonly platform: PlatformFacet;
  readonly providers: ProvidersFacet;
  readonly memory: MemoryFacet;
  readonly events: EventsFacet;
  readonly registries: RegistriesFacet;
  readonly speakers: SpeakersFacet;

  private readonly options: Required<
    Pick<
      SkillHostClientOptions,
      | "socketPath"
      | "skillId"
      | "callTimeoutMs"
      | "connectTimeoutMs"
      | "reconnectBaseDelayMs"
      | "reconnectMaxDelayMs"
    >
  > & { autoReconnect: boolean };

  private socket: Socket | null = null;
  private buffer = "";
  private readonly pending = new Map<string, PendingCall>();
  private readonly subscriptions = new Map<string, ActiveSubscription>();
  private connectingPromise: Promise<void> | null = null;
  private closed = false;
  private reconnectAttempt = 0;
  /**
   * Monotonic counter for skill-initiated request ids, formatted as
   * `s:<n>`. The daemon mints `d:<n>` ids independently, so the two
   * sequences never collide on a shared socket.
   */
  private nextSkillRequestSeq = 1;
  /**
   * Handlers for daemon-initiated requests, keyed by method name. Populated
   * via `registerHandler(method, handler)`. Daemon→skill request frames
   * (id starts with `d:`) are dispatched through this table.
   */
  private readonly daemonRequestHandlers = new Map<
    string,
    SkillHostRequestHandler
  >();

  // Prefetched sync state — populated by `connect()`.
  private cachedInternalAssistantId: string | null = null;
  private cachedAssistantName: string | undefined = undefined;
  private cachedWorkspaceDir: string | null = null;
  private cachedVellumRoot: string | null = null;
  private cachedRuntimeMode: DaemonRuntimeMode | null = null;

  // ── Local dispatch state ────────────────────────────────────────────────
  // Caches populated by `registries.register*` so the daemon can dispatch
  // skill-owned closures back over the bidirectional RPC. Mirrors what the
  // out-of-process skill installed in-process before the IPC split.

  /** Most recently registered tool provider (last writer wins, matching the in-process semantics where a single skill module owns one provider). */
  private cachedToolsProvider: (() => Tool[]) | null = null;
  /**
   * Routes keyed by `pattern.source`. Last writer wins on collision so
   * re-registering the same regex source replaces the prior handler — mirrors
   * how an in-process skill would re-`registerSkillRoute` on hot reload.
   */
  private readonly cachedRoutes = new Map<string, SkillRoute>();
  /**
   * Shutdown hooks ordered by registration time. We use an array (not a Map
   * keyed by name) because the spec requires running hooks in reverse-
   * registration order when no name is provided. Re-registering an existing
   * name replaces the prior entry in place to keep the cache idempotent.
   */
  private readonly cachedShutdownHooks: Array<{
    name: string;
    hook: (reason: string) => Promise<void>;
  }> = [];

  constructor(options: SkillHostClientOptions) {
    this.options = {
      socketPath: options.socketPath,
      skillId: options.skillId,
      autoReconnect: options.autoReconnect ?? false,
      callTimeoutMs: options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      reconnectBaseDelayMs:
        options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS,
      reconnectMaxDelayMs:
        options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS,
    };

    this.logger = this.buildLoggerFacet();
    this.config = this.buildConfigFacet();
    this.identity = this.buildIdentityFacet();
    this.platform = this.buildPlatformFacet();
    this.providers = this.buildProvidersFacet();
    this.memory = this.buildMemoryFacet();
    this.events = this.buildEventsFacet();
    this.registries = this.buildRegistriesFacet();
    this.speakers = this.buildSpeakersFacet();
  }

  // ── Public lifecycle ────────────────────────────────────────────────────

  /**
   * Connect to the skill IPC socket and prefetch sync-cacheable state
   * (assistant id, workspace dir, vellum root, runtime mode, assistant
   * name). Safe to call multiple times — the first call initiates the
   * connection, concurrent calls await the same promise.
   */
  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error("SkillHostClient: cannot connect after close()");
    }
    if (this.connectingPromise) return this.connectingPromise;
    // Fully connected: live socket *and* prefetch already populated.
    // If the socket survived but a prior `prefetchSyncState()` rejected,
    // the caches are still null and sync accessors would throw — fall
    // through and re-run prefetch over the existing socket.
    const socketAlive = !!this.socket && !this.socket.destroyed;
    const prefetchDone = this.cachedInternalAssistantId !== null;
    if (socketAlive && prefetchDone) return;

    const ensureSocket = socketAlive ? Promise.resolve() : this.doConnect();
    this.connectingPromise = ensureSocket
      .then(async () => {
        await this.prefetchSyncState();
      })
      .finally(() => {
        this.connectingPromise = null;
      });
    return this.connectingPromise;
  }

  /**
   * Close the socket, reject outstanding calls, and dispose all active
   * subscriptions. Safe to call multiple times.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Mark every subscription disposed so stray deliveries during teardown
    // don't fire user callbacks.
    for (const sub of this.subscriptions.values()) {
      sub.disposed = true;
    }
    this.subscriptions.clear();
    // Reject any in-flight calls.
    const closeErr = new Error(
      "SkillHostClient: client closed while request was in flight",
    );
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(closeErr);
    }
    this.pending.clear();
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = null;
  }

  /**
   * Install a handler for daemon-initiated requests of the given method.
   * The daemon's `SkillIpcServer.sendRequest(connection, method, ...)`
   * resolves with whatever the handler returns (or rejects with the
   * handler's thrown error). Re-registering a method replaces the prior
   * handler — last writer wins.
   */
  registerHandler(method: string, handler: SkillHostRequestHandler): void {
    this.daemonRequestHandlers.set(method, handler);
  }

  // ── Internal: socket lifecycle ──────────────────────────────────────────

  private async doConnect(): Promise<void> {
    const { socketPath, connectTimeoutMs } = this.options;
    return new Promise<void>((resolve, reject) => {
      const socket = connect(socketPath);
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(
          new Error(
            `SkillHostClient: connect timed out after ${connectTimeoutMs}ms (${socketPath})`,
          ),
        );
      }, connectTimeoutMs);

      socket.once("connect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // The client may have been `close()`d while `connect()` was
        // still pending. If we attach now we'd reintroduce a live
        // socket on a closed client and leak the server-side connection
        // until process teardown.
        if (this.closed) {
          socket.destroy();
          reject(new Error("SkillHostClient: closed during connect"));
          return;
        }
        this.attachSocket(socket);
        resolve();
      });

      socket.once("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            `SkillHostClient: socket error during connect: ${err.message}`,
          ),
        );
      });
    });
  }

  private attachSocket(socket: Socket): void {
    this.socket = socket;
    this.buffer = "";
    this.reconnectAttempt = 0;

    socket.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let newlineIdx: number;
      while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newlineIdx).trim();
        this.buffer = this.buffer.slice(newlineIdx + 1);
        if (line) this.handleFrame(line);
      }
    });

    socket.on("close", () => {
      this.socket = null;
      const err = new Error(
        "SkillHostClient: socket closed before response",
      );
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(err);
      }
      this.pending.clear();
      if (!this.closed && this.options.autoReconnect) {
        void this.scheduleReconnect();
      }
    });

    socket.on("error", (err) => {
      swallow(err);
    });
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.closed) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(
      this.options.reconnectBaseDelayMs *
        Math.pow(2, this.reconnectAttempt - 1),
      this.options.reconnectMaxDelayMs,
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.closed) return;
    try {
      await this.doConnect();
      // Re-open every live subscription with a fresh request so the
      // server-side hub installs a new callback.
      const live = [...this.subscriptions.values()].filter((s) => !s.disposed);
      this.subscriptions.clear();
      for (const sub of live) {
        this.reopenSubscription(sub);
      }
    } catch (err) {
      swallow(err);
      if (!this.closed) {
        void this.scheduleReconnect();
      }
    }
  }

  private reopenSubscription(prev: ActiveSubscription): void {
    // Same id so the application-visible Subscription handle still works.
    const fresh: ActiveSubscription = {
      id: prev.id,
      filter: prev.filter,
      callback: prev.callback,
      disposed: false,
    };
    this.subscriptions.set(fresh.id, fresh);
    // Mirror `openSubscription`: pre-register a pending entry so the
    // server's `{ id, result: { subscribed: true } }` ack frame is
    // matched (otherwise `handleFrame` silently drops it) and so we
    // tear the subscription down on ack timeout instead of leaking it.
    this.registerSubscribeAck(fresh);
    try {
      this.writeFrame({
        id: fresh.id,
        method: "host.events.subscribe",
        params: { filter: fresh.filter },
      });
    } catch (err) {
      this.cancelSubscribeAck(fresh);
      swallow(err);
    }
  }

  private registerSubscribeAck(active: ActiveSubscription): void {
    const ackTimer = setTimeout(() => {
      if (this.pending.delete(active.id)) {
        active.disposed = true;
        this.subscriptions.delete(active.id);
      }
    }, this.options.callTimeoutMs);
    this.pending.set(active.id, {
      resolve: () => {
        clearTimeout(ackTimer);
      },
      reject: (err) => {
        clearTimeout(ackTimer);
        active.disposed = true;
        this.subscriptions.delete(active.id);
        swallow(err);
      },
      timer: ackTimer,
    });
  }

  private cancelSubscribeAck(active: ActiveSubscription): void {
    const entry = this.pending.get(active.id);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(active.id);
    }
    active.disposed = true;
    this.subscriptions.delete(active.id);
  }

  // ── Internal: frame I/O ─────────────────────────────────────────────────

  private handleFrame(line: string): void {
    let frame: IpcResponseFrame;
    try {
      frame = JSON.parse(line) as IpcResponseFrame;
    } catch (err) {
      swallow(err);
      return;
    }

    if (
      !frame ||
      typeof frame !== "object" ||
      Array.isArray(frame) ||
      typeof frame.id !== "string"
    ) {
      return;
    }

    // Delivery frames route into the subscription callback.
    if (frame.event === "delivery") {
      const sub = this.subscriptions.get(frame.id);
      if (sub && !sub.disposed) {
        try {
          const r = sub.callback(frame.payload as AssistantEvent);
          if (r instanceof Promise) r.catch(swallow);
        } catch (err) {
          swallow(err);
        }
      }
      return;
    }

    // Daemon-initiated request frame — dispatch to a registered handler
    // and write back the response. Identified by the `d:` id prefix and
    // the presence of a `method` field.
    if (
      typeof frame.method === "string" &&
      frame.id.startsWith(DAEMON_ID_PREFIX)
    ) {
      this.dispatchDaemonRequest(frame.id, frame.method, frame.params);
      return;
    }

    // Response frame — resolve or reject the pending call.
    const pending = this.pending.get(frame.id);
    if (pending) {
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error !== undefined) {
        pending.reject(
          new Error(`SkillHostClient: remote error: ${frame.error}`),
        );
      } else {
        pending.resolve(frame.result);
      }
      return;
    }

    // No pending entry — could be a terminal error on a subscription.
    if (frame.error !== undefined) {
      const sub = this.subscriptions.get(frame.id);
      if (sub) {
        sub.disposed = true;
        this.subscriptions.delete(frame.id);
      }
    }
  }

  private dispatchDaemonRequest(
    id: string,
    method: string,
    params: unknown,
  ): void {
    const handler = this.daemonRequestHandlers.get(method);
    if (!handler) {
      this.writeResponseFrame({
        id,
        error: `method not found: ${method}`,
      });
      return;
    }
    let result: unknown;
    try {
      result = handler(params);
    } catch (err) {
      this.writeResponseFrame({ id, error: errorMessage(err) });
      return;
    }
    if (result instanceof Promise) {
      result.then(
        (value) => {
          this.writeResponseFrame({ id, result: value });
        },
        (err) => {
          this.writeResponseFrame({ id, error: errorMessage(err) });
        },
      );
    } else {
      this.writeResponseFrame({ id, result });
    }
  }

  private writeResponseFrame(response: {
    id: string;
    result?: unknown;
    error?: string;
  }): void {
    if (!this.socket || this.socket.destroyed) {
      // The peer is gone; silently drop. The daemon-side pending entry
      // will already have been rejected by the connection-close path.
      return;
    }
    this.socket.write(JSON.stringify(response) + "\n");
  }

  private writeFrame(req: IpcRequest): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("SkillHostClient: not connected");
    }
    this.socket.write(JSON.stringify(req) + "\n");
  }

  /** Allocate the next `s:<n>` id for a skill-initiated request. */
  private nextSkillRequestId(): string {
    return `${SKILL_ID_PREFIX}${this.nextSkillRequestSeq++}`;
  }

  private async call<T>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    if (this.closed) {
      throw new Error("SkillHostClient: client is closed");
    }
    if (!this.socket || this.socket.destroyed) {
      throw new Error(
        "SkillHostClient: not connected. Call `await client.connect()` first.",
      );
    }
    const id = this.nextSkillRequestId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(
            new Error(
              `SkillHostClient: call '${method}' timed out after ${this.options.callTimeoutMs}ms`,
            ),
          );
        }
      }, this.options.callTimeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      try {
        this.writeFrame({ id, method, params });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  // ── Internal: bootstrap cache ───────────────────────────────────────────

  private async prefetchSyncState(): Promise<void> {
    const [assistantId, workspaceDir, vellumRootValue, runtimeMode, name] =
      await Promise.all([
        this.call<string>("host.identity.getInternalAssistantId"),
        this.call<string>("host.platform.workspaceDir"),
        this.call<string>("host.platform.vellumRoot"),
        this.call<DaemonRuntimeMode>("host.platform.runtimeMode"),
        this.call<string | null>("host.identity.getAssistantName"),
      ]);
    this.cachedInternalAssistantId = assistantId;
    this.cachedWorkspaceDir = workspaceDir;
    this.cachedVellumRoot = vellumRootValue;
    this.cachedRuntimeMode = runtimeMode;
    this.cachedAssistantName = name ?? undefined;
  }

  // ── Facet builders ──────────────────────────────────────────────────────

  private buildLogger(name: string): Logger {
    const scope = name || this.options.skillId;
    const write = (
      level: "debug" | "info" | "warn" | "error",
      msg: string,
      meta?: unknown,
    ) => {
      // Fire-and-forget: skills expect logging to be non-blocking and
      // infallible. If the socket is down we just drop the line.
      this.call("host.log", { level, msg, name: scope, meta }).catch(swallow);
    };
    return {
      debug: (msg, meta) => write("debug", msg, meta),
      info: (msg, meta) => write("info", msg, meta),
      warn: (msg, meta) => write("warn", msg, meta),
      error: (msg, meta) => write("error", msg, meta),
    };
  }

  private buildLoggerFacet(): LoggerFacet {
    return {
      get: (name) => this.buildLogger(name),
    };
  }

  private buildConfigFacet(): ConfigFacet {
    return {
      // `isFeatureFlagEnabled` and `getSection` are typed as sync on the
      // contract but require a round-trip to resolve. We cannot block on
      // async I/O inside a sync accessor, so the client surfaces the
      // async semantics by returning a stale-safe value if one has been
      // cached via `prefetchFlag` / `prefetchSection` helpers (future
      // work) — for now, these throw a clear error so skill code that
      // ever reaches them on the client path is audible instead of
      // silently returning a wrong value. Async callers should use the
      // underlying IPC method names directly via `rawCall`.
      isFeatureFlagEnabled: (_key: string): boolean => {
        throw new Error(
          "SkillHostClient.config.isFeatureFlagEnabled: synchronous feature-flag reads are not supported over IPC. Use `client.rawCall('host.config.isFeatureFlagEnabled', { key })` and await the result.",
        );
      },
      getSection: <T>(_path: string): T | undefined => {
        throw new Error(
          "SkillHostClient.config.getSection: synchronous config reads are not supported over IPC. Use `client.rawCall('host.config.getSection', { path })` and await the result.",
        );
      },
    };
  }

  private buildIdentityFacet(): IdentityFacet {
    const self = this;
    return {
      getAssistantName: () => {
        if (self.cachedInternalAssistantId === null) throw notConnected();
        return self.cachedAssistantName;
      },
      get internalAssistantId(): string {
        if (self.cachedInternalAssistantId === null) throw notConnected();
        return self.cachedInternalAssistantId;
      },
    };
  }

  private buildPlatformFacet(): PlatformFacet {
    return {
      workspaceDir: () => {
        if (this.cachedWorkspaceDir === null) throw notConnected();
        return this.cachedWorkspaceDir;
      },
      vellumRoot: () => {
        if (this.cachedVellumRoot === null) throw notConnected();
        return this.cachedVellumRoot;
      },
      runtimeMode: () => {
        if (this.cachedRuntimeMode === null) throw notConnected();
        return this.cachedRuntimeMode;
      },
    };
  }

  private buildLlmProvidersFacet(): LlmProvidersFacet {
    // The provider, user-message, and tool-use values are opaque tokens on
    // the contract; the client synthesizes structurally inert descriptors
    // that round-trip through future dispatch routes.
    return {
      getConfigured: async (callSite: string): Promise<Provider | null> =>
        ({
          __vellumSkillHostClientHandle: "llm-provider",
          callSite,
        }) as unknown as Provider,
      userMessage: (text: string): UserMessage =>
        ({
          __vellumSkillHostClientHandle: "user-message",
          text,
        }) as unknown as UserMessage,
      extractToolUse: (_response: unknown): ToolUse | null => {
        // The client cannot inspect daemon-shaped completion responses
        // without pulling in the Anthropic SDK types; skills that need
        // typed tool-use extraction should do it via the completion's
        // `content` array directly. Return null as the conservative
        // "no tool_use" answer.
        return null;
      },
      createTimeout: (ms: number) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ms);
        return {
          signal: controller.signal,
          cleanup: () => clearTimeout(timer),
        };
      },
    };
  }

  private buildSttProvidersFacet(): SttProvidersFacet {
    // stt sub-facet exposes two pure-data queries and one opaque-handle
    // builder. The data queries would require async fetches; we expose
    // them synchronously via the same "call rawCall" pattern the config
    // facet uses.
    return {
      listProviderIds: (): string[] => {
        throw new Error(
          "SkillHostClient.providers.stt.listProviderIds: use `client.rawCall('host.providers.stt.listProviderIds')` and await the result.",
        );
      },
      supportsBoundary: (_id: string): boolean => {
        throw new Error(
          "SkillHostClient.providers.stt.supportsBoundary: use `client.rawCall('host.providers.stt.supportsBoundary', { id, boundary: 'daemon-streaming' })` and await the result.",
        );
      },
      resolveStreamingTranscriber: async (spec: unknown) =>
        ({
          __vellumSkillHostClientHandle: "streaming-transcriber",
          spec,
        }) as unknown,
    };
  }

  private buildTtsProvidersFacet(): TtsProvidersFacet {
    return {
      get: (id: string): TtsProvider =>
        ({
          __vellumSkillHostClientHandle: "tts-provider",
          id,
        }) as unknown as TtsProvider,
      resolveConfig: (): TtsConfig => {
        throw new Error(
          "SkillHostClient.providers.tts.resolveConfig: use `client.rawCall('host.providers.tts.resolveConfig')` and await the result.",
        );
      },
    };
  }

  private buildSecureKeysFacet(): SecureKeysFacet {
    return {
      getProviderKey: async (id: string): Promise<string | null> =>
        this.call<string | null>("host.providers.secureKeys.getProviderKey", {
          id,
        }),
    };
  }

  private buildProvidersFacet(): ProvidersFacet {
    return {
      llm: this.buildLlmProvidersFacet(),
      stt: this.buildSttProvidersFacet(),
      tts: this.buildTtsProvidersFacet(),
      secureKeys: this.buildSecureKeysFacet(),
    };
  }

  private buildMemoryFacet(): MemoryFacet {
    const addMessage: InsertMessageFn = async (
      conversationId,
      role,
      content,
      metadata,
      opts,
    ) =>
      this.call("host.memory.addMessage", {
        conversationId,
        role,
        content,
        metadata,
        opts,
      });

    return {
      addMessage,
      wakeAgentForOpportunity: async (req) => {
        // The contract types `req` as opaque; the daemon route validates
        // the concrete `{ conversationId, hint, source }` shape.
        await this.call("host.memory.wakeAgentForOpportunity", {
          ...(req as Record<string, unknown>),
        });
      },
    };
  }

  private buildEventsFacet(): EventsFacet {
    return {
      publish: async (event) => {
        await this.call("host.events.publish", { event });
      },
      subscribe: (filter, cb) => this.openSubscription(filter, cb),
      buildEvent: (message: ServerMessage, conversationId?: string) => {
        // `buildEvent` is typed as sync on the contract (the daemon
        // allocates a uuid + timestamp and returns the envelope). A sync
        // round-trip isn't possible, so the client produces an envelope
        // locally using the cached assistant id and the standard uuid /
        // timestamp sources. This matches the observable shape of the
        // daemon's `buildAssistantEvent` without the round-trip.
        if (this.cachedInternalAssistantId === null) throw notConnected();
        return {
          id: randomUUID(),
          assistantId: this.cachedInternalAssistantId,
          conversationId,
          emittedAt: new Date().toISOString(),
          message,
        };
      },
    };
  }

  private openSubscription(
    filter: Filter,
    callback: AssistantEventCallback,
  ): Subscription {
    const id = this.nextSkillRequestId();
    const active: ActiveSubscription = {
      id,
      filter,
      callback,
      disposed: false,
    };
    this.subscriptions.set(id, active);
    // Pre-register a pending call for the open ack. The server writes a
    // `{ id, result: { subscribed: true } }` frame back; subsequent
    // `delivery` frames share the same id.
    this.registerSubscribeAck(active);
    try {
      this.writeFrame({
        id,
        method: "host.events.subscribe",
        params: { filter },
      });
    } catch (err) {
      this.cancelSubscribeAck(active);
      throw err;
    }

    const self = this;
    return {
      get active() {
        return !active.disposed;
      },
      dispose: () => {
        if (active.disposed) return;
        active.disposed = true;
        self.subscriptions.delete(id);
        // Fire-and-forget close RPC — we don't await the ack because the
        // server also tears down on socket close, which is the fallback.
        if (self.socket && !self.socket.destroyed) {
          self
            .call(SUBSCRIBE_CLOSE_METHOD, { subscribeId: id })
            .catch(swallow);
        }
      },
    };
  }

  private buildRegistriesFacet(): RegistriesFacet {
    return {
      registerTools: (provider) => {
        // Invoke the provider synchronously so a failure blows up at the
        // registration call site (matching the in-process semantics)
        // rather than silently dropping the tools into the RPC.
        const tools: Tool[] = provider();
        const manifests = tools.map((t) => {
          const def = t.getDefinition();
          return {
            name: t.name,
            description: t.description,
            input_schema: def.input_schema,
            defaultRiskLevel: t.defaultRiskLevel,
            category: t.category,
            executionTarget: t.executionTarget,
            executionMode: t.executionMode ?? "proxy",
            ownerSkillId: t.ownerSkillId ?? this.options.skillId,
            ownerSkillBundled: t.ownerSkillBundled,
            ownerSkillVersionHash: t.ownerSkillVersionHash,
          };
        });
        // Cache the provider so `skill.dispatch_tool` can resolve a tool
        // name back to its `execute` closure. Last writer wins.
        this.cachedToolsProvider = provider;
        this.ensureDaemonHandler(
          "skill.dispatch_tool",
          this.dispatchTool.bind(this),
        );
        // Fire-and-forget; registration failures surface in the daemon log.
        this.call("host.registries.register_tools", { tools: manifests }).catch(
          swallow,
        );
      },
      registerSkillRoute: (route: SkillRoute): SkillRouteHandle => {
        // Cache the route by its regex source — `skill.dispatch_route` uses
        // the same key to find the handler closure. Re-registering the same
        // source replaces the prior route, matching in-process hot-reload.
        this.cachedRoutes.set(route.pattern.source, route);
        this.ensureDaemonHandler(
          "skill.dispatch_route",
          this.dispatchRoute.bind(this),
        );
        // The `handler` closure cannot cross IPC; the daemon side installs
        // a proxy that dispatches back over `skill.dispatch_route` (PR D).
        // `patternFlags` ships separately so `i/m/g/s/u/y` survive the
        // RegExp → string round-trip — `new RegExp(source)` alone drops them.
        this.call("host.registries.register_skill_route", {
          patternSource: route.pattern.source,
          patternFlags: route.pattern.flags,
          methods: route.methods,
        }).catch(swallow);
        // The contract models the handle as a branded opaque object — we
        // return a structurally inert placeholder.
        return {} as SkillRouteHandle;
      },
      registerShutdownHook: (name: string, hook) => {
        // Cache the hook so `skill.shutdown` can invoke it. If the same
        // name is re-registered, replace in place to keep the array tidy
        // without disturbing relative order of unrelated entries.
        const existingIdx = this.cachedShutdownHooks.findIndex(
          (h) => h.name === name,
        );
        const entry = { name, hook };
        if (existingIdx >= 0) {
          this.cachedShutdownHooks[existingIdx] = entry;
        } else {
          this.cachedShutdownHooks.push(entry);
        }
        this.ensureDaemonHandler(
          "skill.shutdown",
          this.dispatchShutdown.bind(this),
        );
        // Fire-and-forget; the daemon registers a proxy that fires the
        // skill.shutdown dispatch at teardown (PR D).
        this.call("host.registries.register_shutdown_hook", { name }).catch(
          swallow,
        );
      },
    };
  }

  // ── Local dispatch helpers ──────────────────────────────────────────────

  /**
   * Install a daemon-initiated request handler exactly once per method.
   * Idempotent so repeated `register*` calls don't churn the handler table
   * — every dispatch is routed through the same bound method anyway.
   */
  private ensureDaemonHandler(
    method: string,
    handler: SkillHostRequestHandler,
  ): void {
    if (!this.daemonRequestHandlers.has(method)) {
      this.daemonRequestHandlers.set(method, handler);
    }
  }

  /**
   * `skill.dispatch_tool` handler — resolves the tool by name from the
   * cached provider and invokes its `execute(input, context)`. Returns
   * `{ result }` so the daemon can distinguish the wrapper from the
   * tool's own (potentially undefined) return value.
   */
  private async dispatchTool(params: unknown): Promise<{ result: unknown }> {
    const { name, input, context } = (params ?? {}) as {
      name?: unknown;
      input?: unknown;
      context?: unknown;
    };
    if (typeof name !== "string" || !name) {
      throw new Error(
        "skill.dispatch_tool: missing or invalid 'name' parameter",
      );
    }
    const provider = this.cachedToolsProvider;
    if (!provider) {
      throw new Error(`unknown tool: ${name}`);
    }
    // Re-invoke the provider on each dispatch so feature-flag-gated tool
    // lists stay live — matches the daemon's lazy-manifest semantics in
    // `assistant/src/tools/registry.ts`.
    const tools = provider();
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      throw new Error(`unknown tool: ${name}`);
    }
    // The daemon-side `ToolContext` is opaque on the wire; the skill's
    // `Tool.execute` runtime-validates any field it actually reads, so a
    // structural cast is sufficient here. Missing required-on-paper fields
    // are tolerated in practice — meet-host's tools only consult a small
    // subset that the daemon serializes through.
    const ctx = (context ?? {}) as ToolContext;
    const result = await tool.execute(
      (input ?? {}) as Record<string, unknown>,
      ctx,
    );
    return { result };
  }

  /**
   * `skill.dispatch_route` handler — looks up the route by patternSource,
   * re-runs the regex against the inbound URL to recover match groups,
   * invokes the handler, and serializes the `Response` to a
   * JSON-friendly `{ status, headers, body }`.
   */
  private async dispatchRoute(params: unknown): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }> {
    const { patternSource, request } = (params ?? {}) as {
      patternSource?: unknown;
      request?: unknown;
    };
    if (typeof patternSource !== "string" || !patternSource) {
      throw new Error(
        "skill.dispatch_route: missing or invalid 'patternSource' parameter",
      );
    }
    const route = this.cachedRoutes.get(patternSource);
    if (!route) {
      throw new Error(`unknown route: ${patternSource}`);
    }
    const req = (request ?? {}) as {
      method?: string;
      url?: string;
      headers?: Record<string, string>;
      body?: string;
    };
    if (typeof req.url !== "string" || !req.url) {
      throw new Error(
        "skill.dispatch_route: missing or invalid 'request.url' parameter",
      );
    }
    // Reset lastIndex so a global/sticky regex doesn't carry state across
    // dispatches — `exec()` mutates lastIndex on g/y flags and the route's
    // RegExp may be reused across requests.
    if (route.pattern.global || route.pattern.sticky) {
      route.pattern.lastIndex = 0;
    }
    const match = route.pattern.exec(req.url);
    if (!match) {
      throw new Error(`url did not match pattern: ${patternSource}`);
    }
    const init: RequestInit = {
      method: req.method ?? "GET",
      headers: req.headers ?? {},
    };
    // GET/HEAD requests cannot carry a body in the standard fetch `Request`
    // constructor; only attach when the verb permits.
    if (
      req.body !== undefined &&
      init.method !== "GET" &&
      init.method !== "HEAD"
    ) {
      init.body = req.body;
    }
    const response = await route.handler(new Request(req.url, init), match);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const body = await response.text();
    return { status: response.status, headers, body };
  }

  /**
   * `skill.shutdown` handler — runs cached shutdown hooks. With `name`
   * set, runs only that hook; otherwise runs all hooks in reverse-
   * registration order. Per-hook errors are logged via the host logger
   * and otherwise swallowed so one misbehaving hook can't block the
   * daemon's overall teardown.
   */
  private async dispatchShutdown(params: unknown): Promise<{ ok: true }> {
    const { name, reason } = (params ?? {}) as {
      name?: unknown;
      reason?: unknown;
    };
    const reasonStr = typeof reason === "string" ? reason : "shutdown";
    const log = this.buildLogger(this.options.skillId);
    const runOne = async (entry: {
      name: string;
      hook: (reason: string) => Promise<void>;
    }): Promise<void> => {
      try {
        await entry.hook(reasonStr);
      } catch (err) {
        log.warn(`shutdown hook '${entry.name}' threw`, {
          error: errorMessage(err),
        });
      }
    };
    if (typeof name === "string" && name) {
      const entry = this.cachedShutdownHooks.find((h) => h.name === name);
      if (entry) await runOne(entry);
      // Silently no-op for unknown names — the daemon may call shutdown
      // for a hook that was never registered (e.g. a stale registration
      // leftover from a previous skill load), which shouldn't fail the
      // overall teardown.
      return { ok: true };
    }
    // Reverse-registration order so later-registered hooks (which often
    // depend on earlier ones) tear down first.
    for (let i = this.cachedShutdownHooks.length - 1; i >= 0; i--) {
      const entry = this.cachedShutdownHooks[i];
      if (entry) await runOne(entry);
    }
    return { ok: true };
  }

  private buildSpeakersFacet(): SpeakersFacet {
    return {
      createTracker: () =>
        ({
          __vellumSkillHostClientHandle: "speaker-tracker",
        }) as unknown,
    };
  }

  // ── Public escape hatch ─────────────────────────────────────────────────

  /**
   * Escape hatch for invoking any `host.*` IPC method directly. Callers
   * that need to bypass the sync-method ergonomic gap (e.g. async reads
   * of `host.config.*` or `host.providers.stt.listProviderIds`) use this
   * to await a single RPC round-trip. The return type is unknown because
   * the method surface is open.
   */
  async rawCall<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    return this.call<T>(method, params);
  }
}
