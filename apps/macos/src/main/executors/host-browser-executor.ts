/**
 * Host browser executor — sends CDP commands to a local Chrome instance and
 * returns results to the daemon via the host proxy poster.
 *
 * Mirrors the Swift HostBrowserExecutor: target discovery via /json/list,
 * loopback-only security validation, WebSocket CDP JSON-RPC, session
 * matching by target id, connection pooling with idle timeout, and
 * cooperative cancellation.
 */

import type { HostProxyExecutor } from "../host-proxy-router";
import type { HostProxySseMessage } from "../host-proxy-sse";
import type { HostProxyPoster } from "../host-proxy-poster";
import log from "../logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CDP_PORT = 9222;
const DEFAULT_TIMEOUT_SECONDS = 30;
const IDLE_CLOSE_MS = 30_000;
const ALLOWED_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// ---------------------------------------------------------------------------
// CDP Error type
// ---------------------------------------------------------------------------

class CDPError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CDPError";
  }
}

// ---------------------------------------------------------------------------
// Connection pool entry
// ---------------------------------------------------------------------------

interface PoolEntry {
  ws: WebSocket;
  idleTimer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// In-flight request tracking
// ---------------------------------------------------------------------------

interface InFlightRequest {
  abortController: AbortController;
  timeoutTimer: ReturnType<typeof setTimeout>;
  ws: WebSocket | null;
  settled: boolean;
}

// ---------------------------------------------------------------------------
// Transport error helper
// ---------------------------------------------------------------------------

function transportError(
  requestId: string,
  code: string,
  message: string,
): { requestId: string; content: string; isError: true } {
  const payload = JSON.stringify({ code, message });
  log.error(`[host-browser] transport error: ${code} — ${message}`, { requestId });
  return { requestId, content: payload, isError: true };
}

// ---------------------------------------------------------------------------
// Loopback validation
// ---------------------------------------------------------------------------

function isLoopback(host: string): boolean {
  return ALLOWED_LOOPBACK_HOSTS.has(host.toLowerCase());
}

// ---------------------------------------------------------------------------
// HostBrowserExecutor
// ---------------------------------------------------------------------------

export class HostBrowserExecutor implements HostProxyExecutor {
  private readonly pool = new Map<string, PoolEntry>();
  private readonly inFlight = new Map<string, InFlightRequest>();
  private readonly cancelledIds = new Map<string, number>();
  private nextCommandId = 1;

  // -- HostProxyExecutor interface ------------------------------------------

  handleRequest(message: HostProxySseMessage, poster: HostProxyPoster): void {
    const requestId = message.requestId as string | undefined;
    if (!requestId) {
      log.warn("[host-browser] message missing requestId");
      return;
    }

    // Pre-flight cancellation check
    if (this.consumeCancelled(requestId)) {
      log.debug("[host-browser] skipped (pre-cancelled)", { requestId });
      return;
    }

    void this.execute(message, poster).catch((err) => {
      log.error("[host-browser] unexpected top-level error", { requestId, err });
    });
  }

  handleCancel(message: HostProxySseMessage, poster: HostProxyPoster): void {
    const requestId = message.requestId as string | undefined;
    if (!requestId) return;

    this.markCancelled(requestId);
    const pending = this.inFlight.get(requestId);
    if (pending) {
      pending.abortController.abort();
      clearTimeout(pending.timeoutTimer);
      if (pending.ws && (pending.ws.readyState === WebSocket.OPEN || pending.ws.readyState === WebSocket.CONNECTING)) {
        pending.ws.close();
      }
      pending.settled = true;
      this.inFlight.delete(requestId);
    }
    log.info("[host-browser] cancelled", { requestId });
  }

  // -- Teardown -------------------------------------------------------------

  destroy(): void {
    for (const [id, entry] of this.pool) {
      clearTimeout(entry.idleTimer);
      if (entry.ws.readyState === WebSocket.OPEN) {
        entry.ws.close();
      }
      this.pool.delete(id);
    }
    for (const [id, req] of this.inFlight) {
      req.abortController.abort();
      clearTimeout(req.timeoutTimer);
      req.settled = true;
      this.inFlight.delete(id);
    }
  }

  // -- Main execution flow --------------------------------------------------

  private async execute(
    message: HostProxySseMessage,
    poster: HostProxyPoster,
  ): Promise<void> {
    const requestId = message.requestId as string;
    const cdpMethod = (message.cdpMethod as string) ?? "";
    const cdpParams = message.cdpParams as Record<string, unknown> | undefined;
    const cdpSessionId = message.cdpSessionId as string | undefined;
    const rawTimeout = (message.timeout_seconds as number) ?? DEFAULT_TIMEOUT_SECONDS;
    const timeoutSeconds =
      typeof rawTimeout === "number" && isFinite(rawTimeout) && rawTimeout >= 0 && rawTimeout <= 18_000_000_000
        ? rawTimeout
        : DEFAULT_TIMEOUT_SECONDS;
    const host = "localhost";
    const port = DEFAULT_CDP_PORT;

    // Set up abort / timeout tracking
    const abortController = new AbortController();
    const timeoutTimer = setTimeout(() => {
      abortController.abort();
      const pending = this.inFlight.get(requestId);
      if (pending && !pending.settled) {
        pending.settled = true;
        this.inFlight.delete(requestId);
        void poster.postBrowserResult(
          transportError(requestId, "timeout", `CDP command '${cdpMethod}' timed out after ${timeoutSeconds}s`),
        );
      }
    }, timeoutSeconds * 1000);

    const flight: InFlightRequest = {
      abortController,
      timeoutTimer,
      ws: null,
      settled: false,
    };
    this.inFlight.set(requestId, flight);

    try {
      // Step 1: Target discovery
      const targets = await this.fetchTargets(host, port, abortController.signal, timeoutSeconds);

      // Step 2: Select a page target
      const pageTargets = targets.filter(
        (t: Record<string, unknown>) => t.type === "page",
      );

      let selectedTarget: Record<string, unknown> | undefined;
      if (cdpSessionId) {
        selectedTarget = pageTargets.find(
          (t: Record<string, unknown>) => t.id === cdpSessionId,
        );
        if (!selectedTarget) {
          this.settle(requestId);
          void poster.postBrowserResult(
            transportError(
              requestId,
              "cdp_session_not_found",
              `cdpSessionId '${cdpSessionId}' did not match any page target in /json/list. The target may have been closed or navigated.`,
            ),
          );
          return;
        }
      } else {
        selectedTarget = pageTargets[0];
      }

      if (!selectedTarget || typeof selectedTarget.webSocketDebuggerUrl !== "string") {
        this.settle(requestId);
        void poster.postBrowserResult(
          transportError(
            requestId,
            "unreachable",
            `No debuggable page target found at ${host}:${port}. Ensure Chrome is running with --remote-debugging-port=${port}.`,
          ),
        );
        return;
      }

      const wsUrl = selectedTarget.webSocketDebuggerUrl as string;

      // Validate WebSocket URL is loopback
      let wsHost: string;
      try {
        const parsed = new URL(wsUrl);
        wsHost = parsed.hostname;
      } catch {
        this.settle(requestId);
        void poster.postBrowserResult(
          transportError(requestId, "transport_error", `Chrome returned an invalid WebSocket URL: ${wsUrl}`),
        );
        return;
      }

      if (!isLoopback(wsHost)) {
        this.settle(requestId);
        void poster.postBrowserResult(
          transportError(
            requestId,
            "non_loopback",
            `WebSocket URL host '${wsHost}' is not a loopback address. Only localhost, 127.0.0.1, and ::1 are permitted.`,
          ),
        );
        return;
      }

      // Step 3: Send CDP command via WebSocket
      const targetId = selectedTarget.id as string;
      const result = await this.sendCDPCommand(wsUrl, targetId, cdpMethod, cdpParams, flight);

      if (this.consumeCancelled(requestId)) {
        log.debug("[host-browser] result suppressed (cancelled)", { requestId });
        this.settle(requestId);
        return;
      }

      this.settle(requestId);
      void poster.postBrowserResult({ requestId, content: result, isError: false });
    } catch (err) {
      if (flight.settled) return;
      this.settle(requestId);

      if (this.consumeCancelled(requestId)) {
        log.debug("[host-browser] error suppressed (cancelled)", { requestId });
        return;
      }

      if (err instanceof CDPError) {
        if (err.code === "protocol_error") {
          // Protocol errors carry the CDP error code in the message as "code:message"
          void poster.postBrowserResult({ requestId, content: err.message, isError: true });
        } else {
          void poster.postBrowserResult(transportError(requestId, err.code, err.message));
        }
      } else if (abortController.signal.aborted) {
        // Timeout or cancellation already handled
      } else {
        void poster.postBrowserResult(
          transportError(
            requestId,
            "transport_error",
            `Unexpected error executing CDP command: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    }
  }

  // -- Target discovery -----------------------------------------------------

  private async fetchTargets(
    host: string,
    port: number,
    signal: AbortSignal,
    timeoutSeconds: number,
  ): Promise<Record<string, unknown>[]> {
    const url = `http://${host}:${port}/json/list`;
    const controller = new AbortController();

    // Link outer abort to our fetch
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new CDPError(
          "unreachable",
          `HTTP ${response.status} from ${url}`,
        );
      }
      const json = await response.json();
      if (!Array.isArray(json)) {
        throw new CDPError("unreachable", `Invalid JSON response from ${url}`);
      }
      return json as Record<string, unknown>[];
    } catch (err) {
      if (err instanceof CDPError) throw err;
      throw new CDPError(
        "unreachable",
        `Failed to connect to Chrome DevTools at ${host}:${port}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  // -- CDP command over WebSocket -------------------------------------------

  private sendCDPCommand(
    wsUrl: string,
    targetId: string,
    method: string,
    params: Record<string, unknown> | undefined,
    flight: InFlightRequest,
  ): Promise<string> {
    const commandId = this.nextCommandId++;

    return new Promise<string>((resolve, reject) => {
      if (flight.abortController.signal.aborted) {
        reject(new CDPError("cancelled", "CDP command cancelled"));
        return;
      }

      // Use pooled connection or create a new one
      let ws: WebSocket;
      const pooled = this.pool.get(targetId);
      if (pooled && pooled.ws.readyState === WebSocket.OPEN) {
        clearTimeout(pooled.idleTimer);
        ws = pooled.ws;
      } else {
        // Clean up stale pool entry if any
        if (pooled) {
          clearTimeout(pooled.idleTimer);
          this.pool.delete(targetId);
        }
        ws = new WebSocket(wsUrl);
      }

      flight.ws = ws;

      const message: Record<string, unknown> = { id: commandId, method };
      if (params) {
        message.params = params;
      }

      const onAbort = () => {
        cleanup();
        reject(new CDPError("cancelled", "CDP command cancelled"));
      };

      const onMessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
          if (data.id !== commandId) return; // Not our response, keep listening

          cleanup();

          if (data.error) {
            const code = data.error.code ?? -1;
            const msg = data.error.message ?? "Unknown CDP error";
            const errorPayload = JSON.stringify({ code, message: msg });
            reject(new CDPError("protocol_error", errorPayload));
            return;
          }

          const result = data.result !== undefined ? JSON.stringify(data.result) : "{}";
          resolve(result);
        } catch {
          // Malformed JSON, keep listening
        }
      };

      const onError = () => {
        cleanup();
        this.pool.delete(targetId);
        reject(new CDPError("transport_error", "WebSocket connection to Chrome DevTools failed"));
      };

      const onClose = () => {
        cleanup();
        this.pool.delete(targetId);
        // Only reject if not already settled
        reject(new CDPError("transport_error", "WebSocket closed before receiving response"));
      };

      const cleanup = () => {
        flight.abortController.signal.removeEventListener("abort", onAbort);
        ws.removeEventListener("message", onMessage);
        ws.removeEventListener("error", onError);
        ws.removeEventListener("close", onClose);

        // Return to pool with idle timeout
        if (ws.readyState === WebSocket.OPEN) {
          const idleTimer = setTimeout(() => {
            this.pool.delete(targetId);
            if (ws.readyState === WebSocket.OPEN) ws.close();
          }, IDLE_CLOSE_MS);
          this.pool.set(targetId, { ws, idleTimer });
        }
      };

      flight.abortController.signal.addEventListener("abort", onAbort, { once: true });
      ws.addEventListener("message", onMessage);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);

      const sendCommand = () => {
        if (flight.settled || flight.abortController.signal.aborted) return;
        ws.send(JSON.stringify(message));
      };

      if (ws.readyState === WebSocket.OPEN) {
        sendCommand();
      } else if (ws.readyState === WebSocket.CONNECTING) {
        ws.addEventListener("open", sendCommand, { once: true });
      } else {
        cleanup();
        this.pool.delete(targetId);
        reject(new CDPError("transport_error", "WebSocket is not in a connectable state"));
      }
    });
  }

  // -- Cancellation tracking ------------------------------------------------

  private markCancelled(requestId: string): void {
    const now = Date.now();
    this.cancelledIds.set(requestId, now);
    // Sweep entries older than 30s
    for (const [id, ts] of this.cancelledIds) {
      if (now - ts >= 30_000) this.cancelledIds.delete(id);
    }
  }

  private consumeCancelled(requestId: string): boolean {
    return this.cancelledIds.delete(requestId);
  }

  // -- Helpers --------------------------------------------------------------

  private settle(requestId: string): void {
    const pending = this.inFlight.get(requestId);
    if (pending) {
      clearTimeout(pending.timeoutTimer);
      pending.settled = true;
      this.inFlight.delete(requestId);
    }
  }
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

export const __testing = {
  CDPError,
  transportError,
  isLoopback,
  DEFAULT_CDP_PORT,
  DEFAULT_TIMEOUT_SECONDS,
  IDLE_CLOSE_MS,
  ALLOWED_LOOPBACK_HOSTS,
};
