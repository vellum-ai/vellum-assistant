import { getLogger } from "../../../util/logger.js";
import {
  buildBrowserWsUrl,
  type DevToolsTarget,
  type DevToolsVersionInfo,
  discoverTargetsViaWs,
  isHttpDiscoveryFallbackEligible,
  listDevToolsTargets,
  pickDefaultTarget,
  probeDevToolsJsonVersion,
} from "./cdp-inspect/discovery.js";
import {
  type CdpWsTransport,
  CdpWsTransportError,
  connectCdpWsTransport,
} from "./cdp-inspect/ws-transport.js";
import { CdpError } from "./errors.js";
import type { CdpClientKind, ScopedCdpClient } from "./types.js";

const log = getLogger("cdp-inspect-client");

/**
 * Default timeout (ms) for each discovery HTTP probe. Kept short so a
 * user who has no chrome running on the configured port fails fast
 * instead of blocking the entire tool invocation. The ws-transport
 * has its own, separate connect timeout.
 */
const DEFAULT_DISCOVERY_TIMEOUT_MS = 2_000;

/**
 * Subset of DevTools endpoint config the CdpInspectClient needs. The
 * higher-level factory is responsible for feeding these values
 * from the user's settings. Everything else — connect timeouts, ws
 * retries, abort plumbing — is controlled locally here so we don't
 * leak transport knobs into tool call sites.
 */
export interface CdpInspectClientOptions {
  /** Loopback host — enforced by discovery helpers before any I/O. */
  host: string;
  /** Port the user's Chrome is listening on for DevTools HTTP. */
  port: number;
  /** Optional per-attach discovery probe timeout. */
  discoveryTimeoutMs?: number;
  /**
   * Optional per-attach ws connect timeout. Forwarded verbatim to
   * {@link connectCdpWsTransport}.
   */
  wsConnectTimeoutMs?: number;
  /**
   * Test seam: override the discovery / transport helpers so unit
   * tests don't need a real Chrome or a Bun.serve-backed fake peer.
   * The factory does not use this path.
   */
  helpers?: CdpInspectHelpers;
}

/**
 * Override shape used by tests. Each field defaults to the real
 * implementation imported at the top of this module when omitted.
 */
export interface CdpInspectHelpers {
  probeDevToolsJsonVersion?: typeof probeDevToolsJsonVersion;
  listDevToolsTargets?: typeof listDevToolsTargets;
  pickDefaultTarget?: typeof pickDefaultTarget;
  connectCdpWsTransport?: typeof connectCdpWsTransport;
  /** Override for the WS-only fallback target discovery. */
  discoverTargetsViaWs?: typeof discoverTargetsViaWs;
  /** Override for building the well-known browser WS URL. */
  buildBrowserWsUrl?: typeof buildBrowserWsUrl;
}

interface AttachedSession {
  transport: CdpWsTransport;
  sessionId: string;
  target: DevToolsTarget;
  /**
   * Version info from HTTP `/json/version`. `null` when the session
   * was established via the WS-only fallback path (no HTTP discovery).
   */
  version: DevToolsVersionInfo | null;
}

/**
 * In-flight attach handle. Wraps the shared attach promise with a
 * dedicated {@link AbortController} and a ref-count of live callers
 * waiting on the attach. When every caller has raced its own signal
 * and given up, the ref-count drops to zero and the shared controller
 * aborts so the underlying discovery / ws / `Target.attachToTarget`
 * work stops promptly instead of wedging the socket.
 */
interface PendingAttach {
  /** Shared attach promise — resolved exactly once per attach attempt. */
  promise: Promise<AttachedSession>;
  /** Controller wired through probe / list / connect / attach. */
  controller: AbortController;
  /** Number of live callers still awaiting this attach. */
  waiters: number;
}

/**
 * CdpClient backed by the DevTools JSON protocol over a raw
 * WebSocket (the `cdp-inspect` transport). Composes the discovery
 * helpers (`probeDevToolsJsonVersion` + `listDevToolsTargets` +
 * `pickDefaultTarget`) with the shared `connectCdpWsTransport` to
 * reach an already-running Chrome instance the user has launched
 * with `--remote-debugging-port`.
 *
 * Lifetime mirrors {@link import("./local-cdp-client.js").LocalCdpClient}:
 *
 *  - Lazy one-time attach: the first `send()` performs version probe
 *    + target discovery + ws connect + `Target.attachToTarget`, then
 *    caches the session for every subsequent call.
 *  - Concurrent callers share a single in-flight attach promise so
 *    `Target.attachToTarget` runs exactly once per client instance.
 *  - Each `send(..., signal)` caller can race its own AbortSignal
 *    against the shared attach and cut through promptly. When every
 *    concurrent caller has aborted, the shared attach work is also
 *    cancelled so we don't leak discovery fetches or a half-open ws.
 *  - If the attach promise rejects, the cached promise is cleared so
 *    the next `send()` retries from scratch instead of replaying the
 *    same failure forever.
 *  - `dispose()` is idempotent and tears down the ws transport if an
 *    attach ever resolved.
 */
export class CdpInspectClient implements ScopedCdpClient {
  readonly kind: CdpClientKind = "cdp-inspect";

  private pending: PendingAttach | null = null;
  private session: AttachedSession | null = null;
  private disposed = false;
  private readonly helpers: Required<CdpInspectHelpers>;

  constructor(
    public readonly conversationId: string,
    private readonly options: CdpInspectClientOptions,
  ) {
    this.helpers = {
      probeDevToolsJsonVersion:
        options.helpers?.probeDevToolsJsonVersion ?? probeDevToolsJsonVersion,
      listDevToolsTargets:
        options.helpers?.listDevToolsTargets ?? listDevToolsTargets,
      pickDefaultTarget:
        options.helpers?.pickDefaultTarget ?? pickDefaultTarget,
      connectCdpWsTransport:
        options.helpers?.connectCdpWsTransport ?? connectCdpWsTransport,
      discoverTargetsViaWs:
        options.helpers?.discoverTargetsViaWs ?? discoverTargetsViaWs,
      buildBrowserWsUrl:
        options.helpers?.buildBrowserWsUrl ?? buildBrowserWsUrl,
    };
  }

  /**
   * Lazily attach (and cache) a CDP session against the configured
   * DevTools endpoint. Each caller races its own `signal` against the
   * shared attach so an individual abort always wins promptly; when
   * every waiter has aborted, the shared attach work is cancelled
   * too via the pending attach's internal controller. See class-level
   * docs for the resilience contract — in particular, transient
   * attach failures must NOT poison the cached promise for subsequent
   * calls.
   */
  private async ensureSession(signal?: AbortSignal): Promise<AttachedSession> {
    if (this.disposed) {
      throw new CdpError("disposed", "CdpInspectClient already disposed");
    }
    if (this.session) return this.session;

    const pending = this.pending ?? this.startAttach();
    pending.waiters += 1;

    // `onAbort` fires exactly once if this caller's signal wins the
    // race. It (a) drops this caller's waiter slot and (b) aborts
    // the shared controller iff no other caller is still listening,
    // so the underlying discovery / ws / attach work is cancelled
    // promptly instead of leaking into the background.
    let released = false;
    const onAbort = () => {
      if (released) return;
      released = true;
      pending.waiters -= 1;
      if (pending.waiters <= 0 && this.pending === pending) {
        // Clear the cached pending attach synchronously BEFORE
        // firing the shared controller's abort. Otherwise a new
        // `send()` that enters `ensureSession` between this abort
        // and the async `.catch()` handler in `startAttach()` would
        // reuse this already-aborted attach and immediately fail
        // with an `aborted` error even though the new caller never
        // aborted its own signal.
        this.pending = null;
        try {
          pending.controller.abort();
        } catch {
          // best effort
        }
      }
    };

    try {
      return await raceAbort(pending.promise, signal, onAbort);
    } finally {
      // Inner attach resolved or rejected before this caller's
      // signal fired — drop the waiter slot without touching the
      // shared controller (it's already settled). If `onAbort` ran,
      // `released` is already true and this is a no-op.
      if (!released) {
        released = true;
        pending.waiters -= 1;
      }
    }
  }

  /**
   * Kick off a fresh shared attach. The returned {@link PendingAttach}
   * is cached on `this.pending` until it either resolves (in which
   * case the session is stashed on `this.session`) or rejects (in
   * which case the cache is cleared so the next caller retries from
   * scratch).
   */
  private startAttach(): PendingAttach {
    const controller = new AbortController();
    const pending: PendingAttach = {
      controller,
      waiters: 0,
      promise: this.attach(controller.signal),
    };
    this.pending = pending;

    pending.promise
      .then((session) => {
        // Another concurrent attach may have won the race (e.g. after
        // a dispose + retry). Only cache the result if we're still
        // the current attempt.
        if (this.pending === pending) {
          this.pending = null;
          if (this.disposed) {
            // Dispose landed before we could publish the session —
            // tear down the transport immediately so we don't leak.
            try {
              session.transport.dispose();
            } catch {
              // best effort
            }
            return;
          }
          this.session = session;
        } else {
          // A stale attempt — drop the transport so we don't leak.
          try {
            session.transport.dispose();
          } catch {
            // best effort
          }
        }
      })
      .catch(() => {
        // Clear the cached pending attach on rejection so the next
        // call retries from scratch instead of replaying the same
        // failure forever. Only clear if we're still the current
        // attempt — a concurrent dispose may have already nulled it.
        if (this.pending === pending) {
          this.pending = null;
        }
      });

    return pending;
  }

  /**
   * Perform the actual discovery + ws-connect + attach sequence. All
   * underlying errors are rethrown unchanged so the `send()` wrapper
   * can map them to stable `CdpError` codes without double-wrapping
   * the already-typed discovery / ws-transport errors.
   *
   * Two discovery strategies are tried in order:
   *
   * 1. **HTTP discovery** (primary): `/json/version` + `/json/list`.
   * 2. **WS-only fallback**: direct WebSocket connect to the well-known
   *    browser endpoint + CDP `Target.getTargets`. Only attempted when
   *    HTTP discovery fails with `invalid_response` or `unreachable`.
   *
   * The `signal` here is the shared, internal {@link PendingAttach}
   * signal — NOT the per-caller signal. It is aborted when the last
   * caller interested in this attach has given up, or when `dispose()`
   * races an in-flight attach.
   */
  private async attach(signal: AbortSignal): Promise<AttachedSession> {
    const discoveryTimeoutMs =
      this.options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
    const { host, port } = this.options;

    // --- Try HTTP discovery first ---
    const httpResult = await this.tryHttpDiscovery(
      host,
      port,
      discoveryTimeoutMs,
      signal,
    );

    if (httpResult.ok) {
      return this.connectAndAttach(
        httpResult.wsUrl,
        httpResult.target,
        httpResult.version,
        signal,
      );
    }

    // HTTP discovery failed — check if the error is eligible for the
    // WS-only fallback.
    if (!isHttpDiscoveryFallbackEligible(httpResult.error)) {
      // Non-recoverable error (non_loopback, non_chrome, timeout) —
      // rethrow without attempting the WS fallback.
      throw httpResult.error;
    }

    // Guard against the narrow race where tryHttpDiscovery returned a
    // fallback-eligible error (unreachable / invalid_response) but the
    // signal was aborted between that return and this check. The abort
    // CdpError from tryHttpDiscovery itself only surfaces when the signal
    // is already aborted *during* a fetch/probe; this covers the gap
    // between the last await inside tryHttpDiscovery and the fallback
    // eligibility check above.
    if (signal.aborted) {
      throw new CdpError("aborted", "CdpInspectClient attach aborted");
    }

    // --- WS-only fallback path ---
    log.debug(
      {
        conversationId: this.conversationId,
        httpErrorCode: httpResult.error.code,
        httpErrorMessage: httpResult.error.message,
      },
      "HTTP discovery unavailable, attempting WS-only fallback",
    );

    return this.tryWsFallback(host, port, httpResult.error, signal);
  }

  /**
   * Attempt HTTP-based discovery (probe `/json/version` + enumerate
   * `/json/list`). Returns a discriminated result so the caller can
   * branch on success vs. failure without try/catch nesting.
   */
  private async tryHttpDiscovery(
    host: string,
    port: number,
    discoveryTimeoutMs: number,
    signal: AbortSignal,
  ): Promise<
    | {
        ok: true;
        version: DevToolsVersionInfo;
        target: DevToolsTarget;
        wsUrl: string;
      }
    | { ok: false; error: unknown }
  > {
    try {
      const version = await this.helpers.probeDevToolsJsonVersion({
        host,
        port,
        timeoutMs: discoveryTimeoutMs,
        signal,
      });
      if (signal.aborted) {
        return {
          ok: false,
          error: new CdpError("aborted", "CdpInspectClient attach aborted"),
        };
      }
      const targets = await this.helpers.listDevToolsTargets({
        host,
        port,
        timeoutMs: discoveryTimeoutMs,
        signal,
      });
      if (signal.aborted) {
        return {
          ok: false,
          error: new CdpError("aborted", "CdpInspectClient attach aborted"),
        };
      }
      const target = this.helpers.pickDefaultTarget(targets);
      const wsUrl = version.webSocketDebuggerUrl || target.webSocketDebuggerUrl;
      return { ok: true, version, target, wsUrl };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  /**
   * WS-only fallback: connect directly to the well-known browser
   * WebSocket endpoint, enumerate targets via CDP `Target.getTargets`,
   * pick a default, and attach. Used when HTTP discovery endpoints
   * (`/json/version`, `/json/list`) are absent.
   */
  private async tryWsFallback(
    host: string,
    port: number,
    httpError: unknown,
    signal: AbortSignal,
  ): Promise<AttachedSession> {
    let wsUrl: string;
    try {
      wsUrl = this.helpers.buildBrowserWsUrl(host, port);
    } catch (err) {
      // buildBrowserWsUrl enforces loopback — if it throws, the host
      // is non-loopback and we should not attempt any WS connection.
      throw err;
    }

    let transport: CdpWsTransport;
    try {
      transport = await this.helpers.connectCdpWsTransport(wsUrl, {
        connectTimeoutMs: this.options.wsConnectTimeoutMs,
        signal,
      });
    } catch (wsConnectErr) {
      // WS connect also failed — surface a classified error that
      // explains both the HTTP and WS failures.
      const wsMsg =
        wsConnectErr instanceof Error
          ? wsConnectErr.message
          : String(wsConnectErr);
      const httpMsg =
        httpError instanceof Error ? httpError.message : String(httpError);
      throw new CdpError(
        "transport_error",
        `CDP endpoint unreachable: HTTP discovery failed (${httpMsg}) ` +
          `and WS-only fallback also failed (${wsMsg}). ` +
          `Ensure a Chrome/Chromium instance is listening on ${host}:${port} ` +
          `with --remote-debugging-port or a compatible CDP proxy.`,
        { underlying: wsConnectErr },
      );
    }

    // dispose / abort checks after successful WS connect.
    if (this.disposed) {
      try {
        transport.dispose();
      } catch {
        // best effort
      }
      throw new CdpError(
        "disposed",
        "CdpInspectClient disposed during WS fallback attach",
      );
    }
    if (signal.aborted) {
      try {
        transport.dispose();
      } catch {
        // best effort
      }
      throw new CdpError(
        "aborted",
        "CdpInspectClient attach aborted during WS fallback",
      );
    }

    // Discover targets via CDP Target.getTargets on the browser socket.
    let targets: DevToolsTarget[];
    try {
      targets = await this.helpers.discoverTargetsViaWs({
        transport,
        host,
        port,
        signal,
      });
    } catch (err) {
      try {
        transport.dispose();
      } catch {
        // best effort
      }
      throw err;
    }

    if (signal.aborted) {
      try {
        transport.dispose();
      } catch {
        // best effort
      }
      throw new CdpError(
        "aborted",
        "CdpInspectClient attach aborted after WS target discovery",
      );
    }

    const target = this.helpers.pickDefaultTarget(targets);

    log.debug(
      {
        conversationId: this.conversationId,
        targetId: target.id,
        targetCount: targets.length,
      },
      "WS-only fallback: discovered targets via CDP Target.getTargets",
    );

    // Attach to the selected target using the browser-level transport.
    return this.attachToTarget(transport, target, null, signal);
  }

  /**
   * Shared attach-to-target + session-id extraction logic. Used by both
   * the HTTP discovery path and the WS-only fallback path.
   */
  private async connectAndAttach(
    wsUrl: string,
    target: DevToolsTarget,
    version: DevToolsVersionInfo | null,
    signal: AbortSignal,
  ): Promise<AttachedSession> {
    const transport = await this.helpers.connectCdpWsTransport(wsUrl, {
      connectTimeoutMs: this.options.wsConnectTimeoutMs,
      signal,
    });

    if (this.disposed) {
      try {
        transport.dispose();
      } catch {
        // best effort
      }
      throw new CdpError("disposed", "CdpInspectClient disposed during attach");
    }
    if (signal.aborted) {
      try {
        transport.dispose();
      } catch {
        // best effort
      }
      throw new CdpError(
        "aborted",
        "CdpInspectClient attach aborted after ws connect",
      );
    }

    return this.attachToTarget(transport, target, version, signal);
  }

  /**
   * Send `Target.attachToTarget` over the transport and extract the
   * session ID. Disposes the transport on failure so we don't leak
   * sockets.
   */
  private async attachToTarget(
    transport: CdpWsTransport,
    target: DevToolsTarget,
    version: DevToolsVersionInfo | null,
    signal: AbortSignal,
  ): Promise<AttachedSession> {
    let attachResult: unknown;
    try {
      attachResult = await transport.send<unknown>(
        "Target.attachToTarget",
        {
          targetId: target.id,
          flatten: true,
        },
        { signal },
      );
    } catch (err) {
      try {
        transport.dispose();
      } catch {
        // best effort
      }
      throw err;
    }

    const sessionId = extractSessionId(attachResult);
    if (!sessionId) {
      try {
        transport.dispose();
      } catch {
        // best effort
      }
      throw new CdpError(
        "cdp_error",
        "Target.attachToTarget did not return a sessionId",
        { cdpMethod: "Target.attachToTarget" },
      );
    }

    log.debug(
      {
        conversationId: this.conversationId,
        targetId: target.id,
        sessionId,
        discoveryMode: version ? "http" : "ws-only",
      },
      "Attached CdpInspectClient session",
    );

    return { transport, sessionId, target, version };
  }

  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.disposed) {
      throw new CdpError("disposed", "CdpInspectClient already disposed", {
        cdpMethod: method,
        cdpParams: params,
      });
    }
    if (signal?.aborted) {
      throw new CdpError("aborted", "Aborted before send", {
        cdpMethod: method,
        cdpParams: params,
      });
    }

    let attached: AttachedSession;
    try {
      attached = await this.ensureSession(signal);
    } catch (err) {
      if (signal?.aborted) {
        throw new CdpError("aborted", "Aborted during send", {
          cdpMethod: method,
          cdpParams: params,
          underlying: err,
        });
      }
      // If a concurrent dispose() aborted the shared attach under us,
      // surface a stable "disposed" error instead of the incidental
      // discovery / transport rejection that the aborted work threw.
      if (this.disposed) {
        throw new CdpError("disposed", "CdpInspectClient already disposed", {
          cdpMethod: method,
          cdpParams: params,
          underlying: err,
        });
      }
      throw mapEnsureSessionError(err, method, params);
    }

    // A late dispose may have landed while ensureSession was in
    // flight — surface a "disposed" error instead of sending into a
    // torn-down transport.
    if (this.disposed) {
      throw new CdpError("disposed", "CdpInspectClient already disposed", {
        cdpMethod: method,
        cdpParams: params,
      });
    }

    try {
      return (await attached.transport.send<T>(method, params, {
        sessionId: attached.sessionId,
        signal,
      })) as T;
    } catch (err) {
      if (signal?.aborted) {
        throw new CdpError("aborted", "Aborted during send", {
          cdpMethod: method,
          cdpParams: params,
          underlying: err,
        });
      }
      if (err instanceof CdpWsTransportError) {
        if (err.code === "aborted") {
          throw new CdpError("aborted", err.message, {
            cdpMethod: method,
            cdpParams: params,
            underlying: err,
          });
        }
        if (err.code === "cdp_error") {
          throw new CdpError("cdp_error", err.cdpMessage ?? err.message, {
            cdpMethod: method,
            cdpParams: params,
            underlying: err,
          });
        }
        // closed / timeout / transport_error all map onto
        // transport_error in the shared CdpClient taxonomy.
        throw new CdpError("transport_error", err.message, {
          cdpMethod: method,
          cdpParams: params,
          underlying: err,
        });
      }
      if (err instanceof CdpError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new CdpError("cdp_error", msg, {
        cdpMethod: method,
        cdpParams: params,
        underlying: err,
      });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // Cancel any in-flight attach so discovery / ws / Target.attach
    // stop promptly. The `.then()` handler in startAttach() will
    // tear down any transport that managed to open before dispose
    // landed.
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      try {
        pending.controller.abort();
      } catch {
        // best effort
      }
    }

    const session = this.session;
    this.session = null;
    if (session) {
      try {
        session.transport.dispose();
      } catch (err) {
        log.debug(
          { err },
          "CdpInspectClient: transport.dispose threw (ignored)",
        );
      }
    }
  }
}

/**
 * Classify an `ensureSession()` rejection into a stable CdpError
 * code. Discovery + ws-transport failures become `transport_error`,
 * while CDP-level errors returned by `Target.attachToTarget` become
 * `cdp_error`. Already-typed CdpErrors (e.g. a missing-sessionId
 * attach response or a concurrent dispose) are rewritten so that
 * the internal `cdpMethod` (`"Target.attachToTarget"`) is replaced
 * with the caller's method, while preserving the underlying error
 * shape.
 */
function mapEnsureSessionError(
  err: unknown,
  method: string,
  params?: Record<string, unknown>,
): CdpError {
  if (err instanceof CdpError) {
    // Rewrite cdpMethod to the caller's method so attach-stage
    // metadata (e.g. "Target.attachToTarget") doesn't leak into the
    // caller-visible error. Preserve code, message, and the original
    // underlying error so logging / upstream mapping can still
    // introspect the real cause.
    return new CdpError(err.code, err.message, {
      cdpMethod: method,
      cdpParams: params,
      underlying: err.underlying ?? err,
    });
  }
  if (err instanceof CdpWsTransportError) {
    if (err.code === "cdp_error") {
      return new CdpError("cdp_error", err.cdpMessage ?? err.message, {
        cdpMethod: method,
        cdpParams: params,
        underlying: err,
      });
    }
    return new CdpError("transport_error", err.message, {
      cdpMethod: method,
      cdpParams: params,
      underlying: err,
    });
  }
  // DevToolsDiscoveryError (and any other non-CDP rejection) is
  // treated as a transport-level failure.
  const msg = err instanceof Error ? err.message : String(err);
  return new CdpError("transport_error", msg, {
    cdpMethod: method,
    cdpParams: params,
    underlying: err,
  });
}

/**
 * Race a long-running shared promise against a per-caller
 * {@link AbortSignal}. When the signal fires first, the returned
 * promise rejects with a synthetic `abort` error and the optional
 * `onAbort` hook is invoked exactly once so callers can decrement
 * ref-counts, release locks, etc. The underlying `inner` promise is
 * intentionally NOT cancelled here — shared in-flight work is
 * cancelled separately via the owning {@link PendingAttach}
 * controller once every waiter has given up.
 */
function raceAbort<T>(
  inner: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<T> {
  if (!signal) return inner;
  if (signal.aborted) {
    try {
      onAbort();
    } catch {
      // best effort
    }
    return Promise.reject(new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      try {
        onAbort();
      } catch {
        // best effort
      }
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    inner.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", handleAbort);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", handleAbort);
        reject(err);
      },
    );
  });
}

/**
 * Pull the `sessionId` field out of a `Target.attachToTarget` CDP
 * result. CDP returns an object shaped `{ sessionId: string }`; we
 * guard defensively against malformed replies so a broken Chrome
 * fork cannot silently send us into an un-typed send loop.
 */
function extractSessionId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  const sessionId = record.sessionId;
  if (typeof sessionId === "string" && sessionId.length > 0) {
    return sessionId;
  }
  return null;
}

/**
 * Factory for a fresh {@link CdpInspectClient} bound to a
 * conversation. Keeping the constructor + factory split lets the
 * cdp-client factory wires this up alongside local / extension
 * without exposing the class directly to callers.
 */
export function createCdpInspectClient(
  conversationId: string,
  options: CdpInspectClientOptions,
): CdpInspectClient {
  return new CdpInspectClient(conversationId, options);
}
