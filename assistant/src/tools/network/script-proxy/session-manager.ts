import type { Server } from 'node:http';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProxyServer } from './server.js';
import type { ProxyServerConfig } from './server.js';
import { routeConnection } from './router.js';
import type {
  ProxySession,
  ProxySessionId,
  ProxySessionConfig,
  ProxyEnvVars,
  ProxyApprovalCallback,
} from './types.js';
import type { PolicyCallback } from './http-forwarder.js';
import { evaluateRequestWithApproval } from './policy.js';
import { getCAPath, ensureLocalCA } from './certs.js';
import { minimatch } from 'minimatch';
import { resolveById } from '../../credentials/resolve.js';
import { listCredentialMetadata } from '../../credentials/metadata-store.js';
import type { CredentialInjectionTemplate } from '../../credentials/policy-types.js';
import { getSecureKey } from '../../../security/secure-keys.js';

const DEFAULT_CONFIG: ProxySessionConfig = {
  idleTimeoutMs: 5 * 60 * 1000, // 5 minutes
  maxSessionsPerConversation: 3,
};

interface ManagedSession {
  session: ProxySession;
  server: Server | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  config: ProxySessionConfig;
  dataDir: string | null;
  approvalCallback: ProxyApprovalCallback | null;
  /** In-flight stop promise so concurrent callers can await the same shutdown. */
  stopPromise: Promise<void> | null;
}

const sessions = new Map<ProxySessionId, ManagedSession>();

/**
 * Per-conversation mutex for session acquisition. Prevents concurrent
 * proxied commands from each observing "no active session" and creating
 * duplicate sessions (check-then-act race).
 */
const acquireLocks = new Map<string, Promise<ProxySession>>();

/** Return a defensive copy so callers cannot mutate internal state. */
function cloneSession(s: ProxySession): ProxySession {
  return {
    ...s,
    credentialIds: [...s.credentialIds],
    createdAt: new Date(s.createdAt.getTime()),
  };
}

function resetIdleTimer(managed: ManagedSession): void {
  if (managed.idleTimer !== null) {
    clearTimeout(managed.idleTimer);
  }
  managed.idleTimer = setTimeout(() => {
    if (managed.session.status === 'active') {
      stopSession(managed.session.id).catch(() => {});
    }
  }, managed.config.idleTimeoutMs);
}

/**
 * Create a new proxy session bound to a conversation.
 * The session starts in 'starting' status with no port assigned yet.
 */
export function createSession(
  conversationId: string,
  credentialIds: string[],
  config?: Partial<ProxySessionConfig>,
  dataDir?: string,
  approvalCallback?: ProxyApprovalCallback,
): ProxySession {
  const merged: ProxySessionConfig = { ...DEFAULT_CONFIG, ...config };

  // Enforce per-conversation limit
  const existing = getSessionsForConversation(conversationId);
  const liveCount = existing.filter(
    (s) => s.status !== 'stopped',
  ).length;
  if (liveCount >= merged.maxSessionsPerConversation) {
    throw new Error(
      `Max sessions (${merged.maxSessionsPerConversation}) reached for conversation ${conversationId}`,
    );
  }

  const session: ProxySession = {
    id: randomUUID(),
    conversationId,
    credentialIds: [...credentialIds],
    status: 'starting',
    createdAt: new Date(),
    port: null,
  };

  sessions.set(session.id, {
    session,
    server: null,
    idleTimer: null,
    config: merged,
    dataDir: dataDir ?? null,
    approvalCallback: approvalCallback ?? null,
    stopPromise: null,
  });

  return cloneSession(session);
}

/**
 * Start the proxy session — opens an HTTP server on an ephemeral port.
 * When the session has credential IDs with injection templates, the proxy
 * is configured with a MITM handler that selectively intercepts HTTPS
 * connections to credential-matched hosts.
 */
export async function startSession(sessionId: ProxySessionId, options?: { listenHost?: string }): Promise<ProxySession> {
  const managed = sessions.get(sessionId);
  if (!managed) throw new Error(`Session not found: ${sessionId}`);
  if (managed.session.status !== 'starting') {
    throw new Error(`Session ${sessionId} is ${managed.session.status}, expected starting`);
  }

  const config: ProxyServerConfig = {};

  // Build a templates map from credential metadata so the router and policy
  // engine can match request targets against injection host patterns.
  const templates = new Map<string, CredentialInjectionTemplate[]>();
  for (const credId of managed.session.credentialIds) {
    const resolved = resolveById(credId);
    if (resolved?.injectionTemplates?.length) {
      templates.set(credId, resolved.injectionTemplates);
    }
  }

  if (managed.dataDir && managed.session.credentialIds.length > 0) {
    const caDir = join(managed.dataDir, 'proxy-ca');

    if (templates.size > 0) {
      // Ensure the CA directory and cert/key exist before starting MITM.
      // If this fails (e.g. missing openssl, unwritable dir), clean up the
      // session so it doesn't linger as 'starting' and count toward the
      // per-conversation limit.
      try {
        await ensureLocalCA(managed.dataDir);
      } catch (err) {
        sessions.delete(sessionId);
        throw err;
      }

      // MITM interception relies on NODE_EXTRA_CA_CERTS to make the
      // generated CA trusted by child processes. This only works for
      // Node/Bun runtimes — non-Node clients (curl, Python, Go) will
      // reject the proxy's TLS certificates. For now, MITM is only
      // enabled when credential injection templates require it, and the
      // primary use case is Node/Bun subprocesses launched by the agent.
      config.mitmHandler = {
        caDir,
        shouldIntercept: (hostname: string, port: number) =>
          routeConnection(hostname, port, managed.session.credentialIds, templates),
        rewriteCallback: async (req) => {
          // Collect all matching candidates to detect ambiguity before
          // injecting any secrets — mirrors the HTTP policyCallback guard.
          const candidates: { credId: string; tpl: CredentialInjectionTemplate }[] = [];
          for (const [credId, tpls] of templates) {
            for (const tpl of tpls) {
              if (minimatch(req.hostname, tpl.hostPattern, { nocase: true })) {
                candidates.push({ credId, tpl });
              }
            }
          }

          if (candidates.length === 0) return req.headers;
          // Ambiguous — multiple templates match; block to avoid injecting
          // the wrong secret (403 Forbidden via null return).
          if (candidates.length > 1) return null;

          const { credId, tpl } = candidates[0];

          // Query param injection requires URL path rewriting, which the
          // current RewriteCallback interface doesn't support. Pass through
          // unchanged — query injection will be wired once the MITM handler
          // gains path-rewrite capability.
          if (tpl.injectionType === 'query') return req.headers;

          if (tpl.injectionType === 'header' && tpl.headerName) {
            const resolved = resolveById(credId);
            if (!resolved) return req.headers;
            const value = getSecureKey(resolved.storageKey);
            if (!value) return req.headers;

            req.headers[tpl.headerName.toLowerCase()] =
              (tpl.valuePrefix ?? '') + value;
            return req.headers;
          }

          return req.headers;
        },
      };
    }
  }

  // Build the policy callback for HTTP/CONNECT request gating
  const policyCallback: PolicyCallback = async (hostname: string, port: number | null, reqPath: string, scheme: 'http' | 'https') => {
    // Build allKnown from the full credential registry so the policy engine
    // can distinguish "known host, missing credential" from "unknown host".
    const allKnown: CredentialInjectionTemplate[] = [];
    for (const meta of listCredentialMetadata()) {
      if (meta.injectionTemplates?.length) {
        allKnown.push(...meta.injectionTemplates);
      }
    }

    const decision = evaluateRequestWithApproval(
      hostname, port, reqPath,
      managed.session.credentialIds, templates, allKnown, scheme,
    );

    switch (decision.kind) {
      case 'matched': {
        // Inject the credential value into the outbound request headers.
        // Secret values are read from secure storage at injection time and
        // MUST NEVER be logged — sanitizeHeaders in logging.ts handles redaction.
        const { credentialId, template } = decision;
        const resolved = resolveById(credentialId);
        if (!resolved) return {};
        const value = getSecureKey(resolved.storageKey);
        if (!value) return {};

        if (template.injectionType === 'header' && template.headerName) {
          const headerValue = (template.valuePrefix ?? '') + value;
          return { [template.headerName.toLowerCase()]: headerValue };
        }
        // Query param injection is handled via URL rewriting in the MITM path
        return {};
      }
      case 'ambiguous':
        return null; // block — can't auto-resolve
      case 'ask_missing_credential':
      case 'ask_unauthenticated':
        if (managed.approvalCallback) {
          const approved = await managed.approvalCallback({
            decision,
            sessionId: managed.session.id,
          });
          return approved ? {} : null;
        }
        return decision.kind === 'ask_unauthenticated' ? {} : null;
      case 'missing':
        return null;
      case 'unauthenticated':
        return {};
      default:
        return null;
    }
  };

  config.policyCallback = policyCallback;

  const server = createProxyServer(config);

  try {
    return await new Promise<ProxySession>((resolve, reject) => {
      server.listen(0, options?.listenHost ?? '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to get server address'));
          return;
        }
        managed.server = server;
        managed.session.port = addr.port;
        managed.session.status = 'active';
        resetIdleTimer(managed);
        resolve(cloneSession(managed.session));
      });
      server.on('error', reject);
    });
  } catch (err) {
    // Clean up: close the server if it started, and remove the session so it
    // doesn't linger as 'starting' and block future session creation.
    server.close(() => {});
    sessions.delete(sessionId);
    throw err;
  }
}

/**
 * Gracefully stop a session — closes the HTTP server and clears the idle timer.
 */
export async function stopSession(sessionId: ProxySessionId): Promise<void> {
  const managed = sessions.get(sessionId);
  if (!managed) throw new Error(`Session not found: ${sessionId}`);
  if (managed.session.status === 'stopped') return;

  // If a shutdown is already in flight, await it instead of returning early.
  if (managed.session.status === 'stopping' && managed.stopPromise) {
    return managed.stopPromise;
  }

  managed.session.status = 'stopping';

  const doStop = async () => {
    if (managed.idleTimer !== null) {
      clearTimeout(managed.idleTimer);
      managed.idleTimer = null;
    }

    if (managed.server) {
      await new Promise<void>((resolve, reject) => {
        managed.server!.close((err) => (err ? reject(err) : resolve()));
      });
      managed.server = null;
    }

    managed.session.status = 'stopped';
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
  sessionId: ProxySessionId,
  options?: { dockerMode?: boolean },
): ProxyEnvVars {
  const managed = sessions.get(sessionId);
  if (!managed) throw new Error(`Session not found: ${sessionId}`);
  if (managed.session.status !== 'active' || managed.session.port === null) {
    throw new Error(`Session ${sessionId} is not active`);
  }

  // Touch the idle timer on access
  resetIdleTimer(managed);

  // Inside Docker, 127.0.0.1 is the container's own loopback — use
  // host.docker.internal so traffic reaches the host-side proxy.
  const host = options?.dockerMode ? 'host.docker.internal' : '127.0.0.1';
  const proxyUrl = `http://${host}:${managed.session.port}`;
  const env: ProxyEnvVars = {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: 'localhost,127.0.0.1,::1',
  };

  if (managed.dataDir) {
    env.NODE_EXTRA_CA_CERTS = getCAPath(managed.dataDir);
  }

  return env;
}

/** Sorted comparison so order doesn't matter. */
function credentialIdsMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
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
  conversationId: string,
  credentialIds: string[],
  config?: Partial<ProxySessionConfig>,
  dataDir?: string,
  approvalCallback?: ProxyApprovalCallback,
  options?: { listenHost?: string },
): Promise<{ session: ProxySession; created: boolean }> {
  // Fast path — session already active, no lock needed.
  const existing = getActiveSession(conversationId);
  if (existing) {
    if (credentialIdsMatch(existing.credentialIds, credentialIds)) {
      return { session: existing, created: false };
    }
    // Credential mismatch — tear down the stale session so we can create
    // one with the correct bindings.
    await stopSession(existing.id);
  }

  // Serialize: if another caller is already creating a session for this
  // conversation, wait for it rather than creating a second one.
  const inflight = acquireLocks.get(conversationId);
  if (inflight) {
    const session = await inflight;
    if (credentialIdsMatch(session.credentialIds, credentialIds)) {
      return { session, created: false };
    }
    // Credential mismatch — tear down and fall through to create a new session.
    await stopSession(session.id);
  }

  const promise = (async () => {
    // Re-check after winning the lock — a session may have become active
    // between our initial check and acquiring the lock.
    const recheck = getActiveSession(conversationId);
    if (recheck) {
      if (credentialIdsMatch(recheck.credentialIds, credentialIds)) {
        return { session: recheck, created: false };
      }
      await stopSession(recheck.id);
    }

    const session = createSession(conversationId, credentialIds, config, dataDir, approvalCallback);
    const started = await startSession(session.id, options);
    return { session: started, created: true };
  })();

  // Wrap the inner promise to extract just the session for lock waiters.
  const sessionPromise = promise.then((r) => r.session);
  sessionPromise.catch(() => {}); // Rejection handled by `await promise` below
  acquireLocks.set(conversationId, sessionPromise);
  try {
    return await promise;
  } finally {
    acquireLocks.delete(conversationId);
  }
}

/**
 * Find an active session for a conversation (returns the first match).
 */
export function getActiveSession(conversationId: string): ProxySession | undefined {
  for (const managed of sessions.values()) {
    if (
      managed.session.conversationId === conversationId &&
      managed.session.status === 'active'
    ) {
      return cloneSession(managed.session);
    }
  }
  return undefined;
}

/**
 * Get all sessions for a given conversation.
 */
export function getSessionsForConversation(conversationId: string): ProxySession[] {
  const result: ProxySession[] = [];
  for (const managed of sessions.values()) {
    if (managed.session.conversationId === conversationId) {
      result.push(cloneSession(managed.session));
    }
  }
  return result;
}

/**
 * Stop all sessions and clear internal state. Useful for daemon shutdown.
 */
export async function stopAllSessions(): Promise<void> {
  const ids = [...sessions.keys()];
  await Promise.all(ids.map((id) => stopSession(id).catch(() => {})));
  sessions.clear();
}
