/**
 * Reusable outbound proxy session core.
 *
 * Provides the portable session lifecycle primitives (create, start, stop,
 * env injection, idle timer, per-conversation limits, atomic acquire) that
 * are shared by the assistant trusted-session proxy and the CES secure
 * command egress layer. All credential resolution and policy wiring is
 * delegated to the caller via the `SessionStartHooks` interface so this
 * module has zero coupling to assistant or CES internals.
 */

import { randomUUID } from "node:crypto";
import type { Server } from "node:http";

import type {
  ProxyApprovalCallback,
  ProxyEnvVars,
  ProxySession,
  ProxySessionConfig,
  ProxySessionId,
} from "./types.js";

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ProxySessionConfig = {
  idleTimeoutMs: 5 * 60 * 1000, // 5 minutes
  maxSessionsPerConversation: 3,
};

// ---------------------------------------------------------------------------
// Internal managed session state
// ---------------------------------------------------------------------------

export interface ManagedSession {
  session: ProxySession;
  server: Server | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  config: ProxySessionConfig;
  dataDir: string | null;
  approvalCallback: ProxyApprovalCallback | null;
  /** The host address the server is bound to (e.g. '127.0.0.1'). */
  listenHost: string;
  /** In-flight stop promise so concurrent callers can await the same shutdown. */
  stopPromise: Promise<void> | null;
  /** Path to the combined CA bundle, set only when ensureCombinedCABundle succeeds. */
  combinedCABundlePath: string | null;
}

// ---------------------------------------------------------------------------
// Hooks — caller-provided wiring for credential resolution & server setup
// ---------------------------------------------------------------------------

/**
 * Hooks invoked during session start to wire up credential resolution,
 * proxy server creation, and CA setup. The caller (assistant session-manager
 * or CES egress enforcer) supplies these to customize behavior without
 * coupling the session core to runtime-specific modules.
 */
export interface SessionStartHooks {
  /**
   * Create and configure the HTTP proxy server for this session.
   * Called during `startSession` — the returned server is bound to an
   * ephemeral port by the core.
   */
  createServer: (managed: ManagedSession) => Promise<Server>;

  /**
   * Optional hook for CA / TLS setup before the server starts.
   * If it sets `managed.combinedCABundlePath`, `getSessionEnv` will
   * include `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`.
   */
  setupCA?: (managed: ManagedSession) => Promise<void>;

  /**
   * Return the path to the CA cert for `NODE_EXTRA_CA_CERTS`.
   * Only called when `managed.combinedCABundlePath` is set.
   */
  getCAPath?: (dataDir: string) => string;
}

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

/**
 * In-process session store. Exported so callers can construct isolated
 * stores (e.g. for testing) or share a singleton.
 */
export class SessionStore {
  readonly sessions = new Map<ProxySessionId, ManagedSession>();

  /**
   * Per-conversation mutex for session acquisition. Prevents concurrent
   * proxied commands from each observing "no active session" and creating
   * duplicate sessions (check-then-act race).
   */
  readonly acquireLocks = new Map<string, Promise<ProxySession>>();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return a defensive copy so callers cannot mutate internal state. */
export function cloneSession(s: ProxySession): ProxySession {
  return {
    ...s,
    credentialIds: [...s.credentialIds],
    createdAt: new Date(s.createdAt.getTime()),
  };
}

function resetIdleTimer(
  managed: ManagedSession,
  store: SessionStore,
): void {
  if (managed.idleTimer != null) {
    clearTimeout(managed.idleTimer);
  }
  managed.idleTimer = setTimeout(() => {
    if (managed.session.status === "active") {
      stopSession(managed.session.id, store).catch(() => {});
    }
  }, managed.config.idleTimeoutMs);
}

/** Sorted comparison so order doesn't matter. */
export function credentialIdsMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a new proxy session bound to a conversation.
 * The session starts in 'starting' status with no port assigned yet.
 */
export function createSession(
  store: SessionStore,
  conversationId: string,
  credentialIds: string[],
  config?: Partial<ProxySessionConfig>,
  dataDir?: string,
  approvalCallback?: ProxyApprovalCallback,
): ProxySession {
  const merged: ProxySessionConfig = { ...DEFAULT_CONFIG, ...config };

  // Enforce per-conversation limit
  const existing = getSessionsForConversation(store, conversationId);
  const liveCount = existing.filter((s) => s.status !== "stopped").length;
  if (liveCount >= merged.maxSessionsPerConversation) {
    throw new Error(
      `Max sessions (${merged.maxSessionsPerConversation}) reached for conversation ${conversationId}`,
    );
  }

  const session: ProxySession = {
    id: randomUUID(),
    conversationId,
    credentialIds: [...credentialIds],
    status: "starting",
    createdAt: new Date(),
    port: null,
  };

  store.sessions.set(session.id, {
    session,
    server: null,
    idleTimer: null,
    config: merged,
    dataDir: dataDir ?? null,
    approvalCallback: approvalCallback ?? null,
    listenHost: "127.0.0.1",
    stopPromise: null,
    combinedCABundlePath: null,
  });

  return cloneSession(session);
}

/**
 * Start the proxy session — invokes the caller's hooks to create the
 * server and opens it on an ephemeral port.
 */
export async function startSession(
  store: SessionStore,
  sessionId: ProxySessionId,
  hooks: SessionStartHooks,
  options?: { listenHost?: string },
): Promise<ProxySession> {
  const managed = store.sessions.get(sessionId);
  if (!managed) throw new Error(`Session not found: ${sessionId}`);
  if (managed.session.status !== "starting") {
    throw new Error(
      `Session ${sessionId} is ${managed.session.status}, expected starting`,
    );
  }

  // Optional CA setup
  if (hooks.setupCA) {
    try {
      await hooks.setupCA(managed);
    } catch (err) {
      store.sessions.delete(sessionId);
      throw err;
    }
  }

  // Create the proxy server via caller hook
  const server = await hooks.createServer(managed);
  const listenHost = options?.listenHost ?? "127.0.0.1";

  try {
    return await new Promise<ProxySession>((resolve, reject) => {
      server.listen(0, listenHost, () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("Failed to get server address"));
          return;
        }
        managed.server = server;
        managed.session.port = addr.port;
        managed.session.status = "active";
        managed.listenHost = listenHost;
        resetIdleTimer(managed, store);
        resolve(cloneSession(managed.session));
      });
      server.on("error", reject);
    });
  } catch (err) {
    server.close(() => {});
    store.sessions.delete(sessionId);
    throw err;
  }
}

/**
 * Gracefully stop a session — closes the HTTP server and clears the idle timer.
 */
export async function stopSession(
  sessionId: ProxySessionId,
  store: SessionStore,
): Promise<void> {
  const managed = store.sessions.get(sessionId);
  if (!managed) throw new Error(`Session not found: ${sessionId}`);
  if (managed.session.status === "stopped") return;

  // If a shutdown is already in flight, await it instead of returning early.
  if (managed.session.status === "stopping" && managed.stopPromise) {
    return managed.stopPromise;
  }

  managed.session.status = "stopping";

  const doStop = async () => {
    if (managed.idleTimer != null) {
      clearTimeout(managed.idleTimer);
      managed.idleTimer = null;
    }

    if (managed.server) {
      await new Promise<void>((resolve, reject) => {
        managed.server!.close((err) => (err ? reject(err) : resolve()));
      });
      managed.server = null;
    }

    managed.session.status = "stopped";
    managed.session.port = null;
    managed.approvalCallback = null;
    managed.stopPromise = null;
  };

  managed.stopPromise = doStop();
  return managed.stopPromise;
}

/**
 * Build environment variables to inject into a subprocess so its HTTP
 * traffic flows through this proxy session.
 */
export function getSessionEnv(
  store: SessionStore,
  sessionId: ProxySessionId,
  hooks?: Pick<SessionStartHooks, "getCAPath">,
): ProxyEnvVars {
  const managed = store.sessions.get(sessionId);
  if (!managed) throw new Error(`Session not found: ${sessionId}`);
  if (managed.session.status !== "active" || managed.session.port == null) {
    throw new Error(`Session ${sessionId} is not active`);
  }

  // Touch the idle timer on access
  resetIdleTimer(managed, store);

  const proxyUrl = `http://127.0.0.1:${managed.session.port}`;
  const env: ProxyEnvVars = {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: "localhost,127.0.0.1,::1",
  };

  // Only set cert env vars when the CA was actually initialized (MITM mode).
  if (managed.dataDir && managed.combinedCABundlePath) {
    if (hooks?.getCAPath) {
      env.NODE_EXTRA_CA_CERTS = hooks.getCAPath(managed.dataDir);
    }
    env.SSL_CERT_FILE = managed.combinedCABundlePath;
  }

  return env;
}

/**
 * Find an active session for a conversation (returns the first match).
 */
export function getActiveSession(
  store: SessionStore,
  conversationId: string,
): ProxySession | undefined {
  for (const managed of store.sessions.values()) {
    if (
      managed.session.conversationId === conversationId &&
      managed.session.status === "active"
    ) {
      return cloneSession(managed.session);
    }
  }
  return undefined;
}

/**
 * Get all sessions for a given conversation.
 */
export function getSessionsForConversation(
  store: SessionStore,
  conversationId: string,
): ProxySession[] {
  const result: ProxySession[] = [];
  for (const managed of store.sessions.values()) {
    if (managed.session.conversationId === conversationId) {
      result.push(cloneSession(managed.session));
    }
  }
  return result;
}

/**
 * Atomically acquire a proxy session for a conversation — reuses an active
 * session or creates + starts a new one. Serialized per conversation so
 * concurrent callers share the same session instead of each spawning one.
 *
 * If the active session was created with different `credentialIds`, it is
 * stopped and a fresh session is created so callers always get a session
 * bound to the requested credentials.
 *
 * Returns `{ session, created }` so the caller knows whether it owns the
 * session lifecycle (and should stop it) or is borrowing a shared one.
 */
export async function getOrStartSession(
  store: SessionStore,
  conversationId: string,
  credentialIds: string[],
  hooks: SessionStartHooks,
  config?: Partial<ProxySessionConfig>,
  dataDir?: string,
  approvalCallback?: ProxyApprovalCallback,
  options?: { listenHost?: string },
): Promise<{ session: ProxySession; created: boolean }> {
  const requestedHost = options?.listenHost ?? "127.0.0.1";

  // Fast path — session already active with matching credentials and listen
  // host, no lock needed.
  const existing = getActiveSession(store, conversationId);
  if (existing && credentialIdsMatch(existing.credentialIds, credentialIds)) {
    const managed = store.sessions.get(existing.id);
    if (managed && managed.listenHost === requestedHost) {
      return { session: existing, created: false };
    }
  }

  // Serialize: if another caller is already creating a session for this
  // conversation, wait for it rather than creating a second one.
  for (;;) {
    const inflight = store.acquireLocks.get(conversationId);
    if (!inflight) break;
    const session = await inflight;
    if (credentialIdsMatch(session.credentialIds, credentialIds)) {
      const m = store.sessions.get(session.id);
      if (m && m.listenHost === requestedHost) {
        return { session, created: false };
      }
    }
    await stopSession(session.id, store);
  }

  const promise = (async () => {
    // Re-check after winning the lock
    const recheck = getActiveSession(store, conversationId);
    if (recheck) {
      const m = store.sessions.get(recheck.id);
      if (
        credentialIdsMatch(recheck.credentialIds, credentialIds) &&
        m &&
        m.listenHost === requestedHost
      ) {
        return { session: recheck, created: false };
      }
      await stopSession(recheck.id, store);
    }

    const session = createSession(
      store,
      conversationId,
      credentialIds,
      config,
      dataDir,
      approvalCallback,
    );
    const started = await startSession(store, session.id, hooks, options);
    return { session: started, created: true };
  })();

  // Wrap the inner promise to extract just the session for lock waiters.
  const sessionPromise = promise.then((r) => r.session);
  sessionPromise.catch(() => {}); // Rejection handled by `await promise` below
  store.acquireLocks.set(conversationId, sessionPromise);
  try {
    return await promise;
  } finally {
    store.acquireLocks.delete(conversationId);
  }
}

/**
 * Stop all sessions and clear internal state. Useful for daemon shutdown.
 *
 * @param onError — optional callback invoked for each session that fails to
 *   stop.  When omitted, errors are silently swallowed so shutdown always
 *   completes.
 */
export async function stopAllSessions(
  store: SessionStore,
  onError?: (sessionId: ProxySessionId, err: unknown) => void,
): Promise<void> {
  const ids = [...store.sessions.keys()];
  await Promise.all(
    ids.map((id) =>
      stopSession(id, store).catch((err) => {
        onError?.(id, err);
      }),
    ),
  );
  store.sessions.clear();
}
