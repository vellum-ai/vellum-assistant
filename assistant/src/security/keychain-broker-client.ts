/**
 * TypeScript client for the keychain broker Unix domain socket protocol.
 *
 * The keychain broker runs inside the macOS app and exposes SecItem*
 * operations over a newline-delimited JSON protocol on a UDS. This client
 * provides a graceful-fallback interface: every public method returns a
 * safe default on failure and never throws.
 *
 * Socket path: derived from getRootDir() as `~/.vellum/keychain-broker.sock`.
 * Auth token: read from ~/.vellum/protected/keychain-broker.token on first
 * connection, cached for process lifetime.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Socket } from "node:net";
import { createConnection } from "node:net";
import { join } from "node:path";

import { pathExists } from "../util/fs.js";
import { getLogger } from "../util/logger.js";
import { getRootDir } from "../util/platform.js";

const log = getLogger("keychain-broker-client");

const REQUEST_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 3_000;

/** Cooldown periods (ms) after consecutive connection failures: 5s, 15s, 30s, 60s, 5min, then cap at 5min. */
const RECONNECT_COOLDOWN_MS = [5_000, 15_000, 30_000, 60_000, 300_000];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a `get()` call. `null` means broker error (caller should fall
 *  back); `{ found: false }` means the key doesn't exist in the keychain. */
export type BrokerGetResult = { found: boolean; value?: string } | null;

/** Result of a `set()` call — distinguishes broker-unreachable from an active
 *  rejection so callers can log meaningful diagnostics. */
export type BrokerSetResult =
  | { status: "ok" }
  | { status: "unreachable" }
  | { status: "rejected"; code: string; message: string };

export interface KeychainBrokerClient {
  isAvailable(): boolean;
  ping(): Promise<{ pong: boolean } | null>;
  get(account: string): Promise<BrokerGetResult>;
  set(account: string, value: string): Promise<BrokerSetResult>;
  del(account: string): Promise<boolean>;
  list(): Promise<string[]>;
}

interface BrokerRequest {
  v: number;
  id: string;
  method: string;
  token: string;
  params?: Record<string, unknown>;
}

interface BrokerResponse {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

interface PendingRequest {
  resolve: (response: BrokerResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

function getTokenPath(): string {
  return join(getRootDir(), "protected", "keychain-broker.token");
}

function getSocketPath(): string {
  return join(getRootDir(), "keychain-broker.sock");
}

// ---------------------------------------------------------------------------
// Client implementation
// ---------------------------------------------------------------------------

export function createBrokerClient(): KeychainBrokerClient {
  let socket: Socket | null = null;
  /** Promise that resolves when the in-flight connect() completes. */
  let connectPromise: Promise<Socket> | null = null;
  /** Timestamp when the broker became unavailable, or null if available. */
  let unavailableSince: number | null = null;
  /** Number of consecutive connection failures (drives cooldown escalation). */
  let consecutiveFailures = 0;
  /** Cached token string, or undefined if not yet successfully read. */
  let cachedToken: string | undefined;

  /** Buffer for incoming data — responses are newline-delimited JSON. */
  let inBuffer = "";

  const pending = new Map<string, PendingRequest>();

  // -------------------------------------------------------------------------
  // Token management
  // -------------------------------------------------------------------------

  function readToken(): string | null {
    try {
      const tokenPath = getTokenPath();
      if (!pathExists(tokenPath)) return null;
      return readFileSync(tokenPath, "utf-8").trim();
    } catch {
      return null;
    }
  }

  function getToken(): string | null {
    if (cachedToken !== undefined) return cachedToken;
    const token = readToken();
    // Only cache non-null results so we re-attempt on next call if the
    // token file hasn't appeared yet (startup race).
    if (token) cachedToken = token;
    return token;
  }

  /** Re-read the token from disk (handles app restart with new token). */
  function refreshToken(): string | null {
    const token = readToken();
    // Update the cache: set to the new value if found, clear if not so
    // subsequent getToken() calls will re-read from disk.
    cachedToken = token ?? undefined;
    return token;
  }

  // -------------------------------------------------------------------------
  // Socket lifecycle
  // -------------------------------------------------------------------------

  function handleData(chunk: Buffer | string): void {
    inBuffer += chunk.toString();
    let newlineIdx: number;
    while ((newlineIdx = inBuffer.indexOf("\n")) !== -1) {
      const line = inBuffer.slice(0, newlineIdx).trim();
      inBuffer = inBuffer.slice(newlineIdx + 1);
      if (!line) continue;

      try {
        const response = JSON.parse(line) as BrokerResponse;
        const entry = pending.get(response.id);
        if (entry) {
          clearTimeout(entry.timer);
          pending.delete(response.id);
          entry.resolve(response);
        }
      } catch {
        log.warn("Received malformed JSON from keychain broker");
      }
    }
  }

  function cleanupSocket(): void {
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
      socket = null;
    }
    inBuffer = "";
    // Reject all pending requests
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({
        id,
        ok: false,
        error: { code: "DISCONNECTED", message: "disconnected" },
      });
    }
    pending.clear();
  }

  function connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socketPath = getSocketPath();
      if (!pathExists(socketPath)) {
        reject(new Error("No socket path"));
        return;
      }

      const sock = createConnection({ path: socketPath });

      const connectTimer = setTimeout(() => {
        sock.destroy();
        reject(new Error("Connect timeout"));
      }, CONNECT_TIMEOUT_MS);

      sock.on("connect", () => {
        clearTimeout(connectTimer);
        socket = sock;
        consecutiveFailures = 0;
        unavailableSince = null;
        resolve(sock);
      });

      sock.on("error", (err) => {
        clearTimeout(connectTimer);
        log.warn({ err }, "Keychain broker socket error");
        cleanupSocket();
        reject(err);
      });

      sock.on("close", () => {
        cleanupSocket();
      });

      sock.on("data", handleData);
    });
  }

  /** Compute the cooldown duration for the current failure count. The first
   *  two failures (initial + immediate retry) map to index 0 (5s). */
  function getCooldownMs(): number {
    const idx = Math.min(
      Math.max(consecutiveFailures - 2, 0),
      RECONNECT_COOLDOWN_MS.length - 1,
    );
    return RECONNECT_COOLDOWN_MS[idx];
  }

  async function ensureConnected(): Promise<Socket | null> {
    // If in cooldown, check whether the cooldown period has elapsed.
    if (unavailableSince != null) {
      if (Date.now() - unavailableSince < getCooldownMs()) {
        return null;
      }
      // Cooldown elapsed — clear and attempt reconnection below.
      unavailableSince = null;
    }

    if (socket && !socket.destroyed) return socket;

    // If a connect() is already in flight, wait for it instead of returning
    // null — this prevents concurrent callers from silently failing.
    if (connectPromise) {
      try {
        return await connectPromise;
      } catch {
        return null;
      }
    }

    connectPromise = connect();
    try {
      const sock = await connectPromise;
      return sock;
    } catch {
      consecutiveFailures++;

      // First failure triggers one immediate retry (preserves the original
      // "try once more" behavior).
      if (consecutiveFailures === 1) {
        connectPromise = connect();
        try {
          return await connectPromise;
        } catch {
          consecutiveFailures++;
          unavailableSince = Date.now();
          log.warn(
            `Keychain broker reconnect failed, will retry in ${getCooldownMs() / 1000}s`,
          );
          return null;
        } finally {
          connectPromise = null;
        }
      }

      // Subsequent failures — enter cooldown.
      unavailableSince = Date.now();
      log.warn(
        `Keychain broker connection failed (attempt ${consecutiveFailures}), will retry in ${getCooldownMs() / 1000}s`,
      );
      return null;
    } finally {
      connectPromise = null;
    }
  }

  // -------------------------------------------------------------------------
  // Request / response
  // -------------------------------------------------------------------------

  function sendRequest(request: BrokerRequest): Promise<BrokerResponse> {
    return new Promise((resolve) => {
      if (!socket || socket.destroyed) {
        resolve({
          id: request.id,
          ok: false,
          error: { code: "NOT_CONNECTED", message: "not connected" },
        });
        return;
      }

      const timer = setTimeout(() => {
        pending.delete(request.id);
        resolve({
          id: request.id,
          ok: false,
          error: { code: "TIMEOUT", message: "timeout" },
        });
      }, REQUEST_TIMEOUT_MS);

      pending.set(request.id, { resolve, timer });

      const data = JSON.stringify(request) + "\n";
      socket.write(data, (err) => {
        if (err) {
          clearTimeout(timer);
          pending.delete(request.id);
          resolve({
            id: request.id,
            ok: false,
            error: { code: "WRITE_ERROR", message: "write error" },
          });
        }
      });
    });
  }

  async function doRequest(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<BrokerResponse | null> {
    const sock = await ensureConnected();
    if (!sock) return null;

    const token = getToken();
    if (!token) return null;

    const id = randomUUID();
    const request: BrokerRequest = {
      v: 1,
      id,
      method,
      token,
      ...(Object.keys(params).length > 0 ? { params } : {}),
    };
    const response = await sendRequest(request);

    // On UNAUTHORIZED, re-read the token once and retry. This handles
    // the case where the app restarted with a new token while the daemon
    // is still running with the old cached one.
    if (response.error?.code === "UNAUTHORIZED") {
      const newToken = refreshToken();
      if (!newToken || newToken === request.token) return response;

      const retryRequest: BrokerRequest = {
        ...request,
        id: randomUUID(),
        token: newToken,
      };
      return await sendRequest(retryRequest);
    }

    return response;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    isAvailable(): boolean {
      if (unavailableSince != null) {
        if (Date.now() - unavailableSince < getCooldownMs()) return false;
      }
      if (!pathExists(getSocketPath())) return false;
      return pathExists(getTokenPath());
    },

    async ping(): Promise<{ pong: boolean } | null> {
      try {
        const response = await doRequest("broker.ping");
        if (!response || !response.ok) return null;
        return {
          pong: !!(response.result as Record<string, unknown> | undefined)
            ?.pong,
        };
      } catch {
        return null;
      }
    },

    async get(account: string): Promise<BrokerGetResult> {
      try {
        const response = await doRequest("key.get", { account });
        if (!response) return null;
        if (!response.ok) return null;
        const result = response.result as
          | { found?: boolean; value?: string }
          | undefined;
        if (!result) return null;
        return { found: !!result.found, value: result.value };
      } catch {
        return null;
      }
    },

    async set(account: string, value: string): Promise<BrokerSetResult> {
      try {
        const response = await doRequest("key.set", { account, value });
        if (!response) return { status: "unreachable" };
        if (response.ok) return { status: "ok" };
        return {
          status: "rejected",
          code: response.error?.code ?? "UNKNOWN",
          message: response.error?.message ?? "unknown error",
        };
      } catch {
        return { status: "unreachable" };
      }
    },

    async del(account: string): Promise<boolean> {
      try {
        const response = await doRequest("key.delete", { account });
        return response?.ok === true;
      } catch {
        return false;
      }
    },

    async list(): Promise<string[]> {
      try {
        const response = await doRequest("key.list");
        if (!response || !response.ok) return [];
        const result = response.result as { accounts?: string[] } | undefined;
        return result?.accounts ?? [];
      } catch {
        return [];
      }
    },
  };
}
