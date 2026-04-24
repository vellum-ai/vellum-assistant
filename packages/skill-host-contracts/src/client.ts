/**
 * `SkillHostClient` — IPC-backed concretion of the neutral `SkillHost`
 * interface. Lets an out-of-process first-party skill consume the daemon's
 * host surface over the Unix domain socket exposed by `SkillIpcServer`.
 *
 * Wire protocol (mirrors `assistant/src/ipc/skill-server.ts`):
 *
 *   one-shot RPC
 *     → { id, method, params? }
 *     ← { id, result } | { id, error }
 *
 *   streaming RPC (e.g. `host.events.subscribe`)
 *     → { id, method, params? }
 *     ← { id, result: { subscribed: true } }            (open ack)
 *     ← { id, event: "delivery", payload: <data> }       (0..N)
 *     ← { id, error }                                    (terminal)
 *     → { id: ctrl-id, method: "host.events.subscribe.close",
 *          params: { subscribeId: <original-id> } }
 *     ← { id: ctrl-id, result: { closed: true } }
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
import type { Tool } from "./tool-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUBSCRIBE_CLOSE_METHOD = "host.events.subscribe.close" as const;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 200;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 10_000;

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
  result?: unknown;
  error?: string;
  event?: "delivery";
  payload?: unknown;
};

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

  // Prefetched sync state — populated by `connect()`.
  private cachedInternalAssistantId: string | null = null;
  private cachedAssistantName: string | undefined = undefined;
  private cachedWorkspaceDir: string | null = null;
  private cachedVellumRoot: string | null = null;
  private cachedRuntimeMode: DaemonRuntimeMode | null = null;

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
    if (this.socket && !this.socket.destroyed) return;

    this.connectingPromise = this.doConnect()
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
    this.writeFrame({
      id: fresh.id,
      method: "host.events.subscribe",
      params: { filter: fresh.filter },
    });
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

  private writeFrame(req: IpcRequest): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("SkillHostClient: not connected");
    }
    this.socket.write(JSON.stringify(req) + "\n");
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
    const id = randomUUID();
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
    const id = randomUUID();
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
    const ackTimer = setTimeout(() => {
      if (this.pending.delete(id)) {
        // Ack timeout — dispose the subscription silently.
        active.disposed = true;
        this.subscriptions.delete(id);
      }
    }, this.options.callTimeoutMs);
    this.pending.set(id, {
      resolve: () => {
        clearTimeout(ackTimer);
      },
      reject: (err) => {
        clearTimeout(ackTimer);
        active.disposed = true;
        this.subscriptions.delete(id);
        swallow(err);
      },
      timer: ackTimer,
    });
    try {
      this.writeFrame({
        id,
        method: "host.events.subscribe",
        params: { filter },
      });
    } catch (err) {
      this.pending.delete(id);
      clearTimeout(ackTimer);
      active.disposed = true;
      this.subscriptions.delete(id);
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
        // Fire-and-forget; registration failures surface in the daemon log.
        this.call("host.registries.register_tools", { tools: manifests }).catch(
          swallow,
        );
      },
      registerSkillRoute: (route: SkillRoute): SkillRouteHandle => {
        // The `handler` closure cannot cross IPC; the daemon side installs
        // a proxy that dispatches back over `skill.dispatch_route` (PR 28).
        this.call("host.registries.register_skill_route", {
          patternSource: route.pattern.source,
          methods: route.methods,
        }).catch(swallow);
        // The contract models the handle as a branded opaque object — we
        // return a structurally inert placeholder.
        return {} as SkillRouteHandle;
      },
      registerShutdownHook: (name: string, _hook) => {
        // The `hook` closure cannot cross IPC; PR 28 wires the
        // reverse-direction dispatch so the daemon can invoke it at
        // shutdown. For now, just register the hook name so the daemon
        // logs its firing during teardown.
        this.call("host.registries.register_shutdown_hook", { name }).catch(
          swallow,
        );
      },
    };
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
