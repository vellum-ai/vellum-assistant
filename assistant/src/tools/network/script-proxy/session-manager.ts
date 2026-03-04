import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { join } from "node:path";

import { getProviderProfile } from "../../../oauth/provider-profiles.js";
import {
  buildDecisionTrace,
  createProxyServer,
  ensureCombinedCABundle,
  ensureLocalCA,
  evaluateRequestWithApproval,
  getCAPath,
  type PolicyCallback,
  type ProxyApprovalCallback,
  type ProxyEnvVars,
  type ProxyServerConfig,
  type ProxySession,
  type ProxySessionConfig,
  type ProxySessionId,
  routeConnection,
  stripQueryString,
} from "../../../outbound-proxy/index.js";
import { getSecureKey } from "../../../security/secure-keys.js";
import { getLogger } from "../../../util/logger.js";
import { silentlyWithLog } from "../../../util/silently.js";
import {
  compareMatchSpecificity,
  type HostMatchKind,
  matchHostPattern,
} from "../../credentials/host-pattern-match.js";
import { listCredentialMetadata } from "../../credentials/metadata-store.js";
import type { CredentialInjectionTemplate } from "../../credentials/policy-types.js";
import {
  resolveById,
  type ResolvedCredential,
} from "../../credentials/resolve.js";

const log = getLogger("proxy-session");

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
  /** The host address the server is bound to (e.g. '127.0.0.1'). */
  listenHost: string;
  /** In-flight stop promise so concurrent callers can await the same shutdown. */
  stopPromise: Promise<void> | null;
  /** Path to the combined CA bundle, set only when ensureCombinedCABundle succeeds. */
  combinedCABundlePath: string | null;
}

const sessions = new Map<ProxySessionId, ManagedSession>();

/**
 * Per-conversation mutex for session acquisition. Prevents concurrent
 * proxied commands from each observing "no active session" and creating
 * duplicate sessions (check-then-act race).
 */
const acquireLocks = new Map<string, Promise<ProxySession>>();

/**
 * Resolve injection templates for a credential.
 *
 * Preferred source is credential metadata. For legacy OAuth credentials that
 * predate provider-level template registration, fall back to well-known
 * profile templates when this is an access_token credential.
 */
function resolveInjectionTemplates(
  resolved: ResolvedCredential | undefined,
): CredentialInjectionTemplate[] {
  if (!resolved) return [];
  if (resolved.injectionTemplates.length > 0)
    return resolved.injectionTemplates;
  if (resolved.field !== "access_token") return [];

  const profile = getProviderProfile(resolved.service);
  if (!profile?.injectionTemplates?.length) return [];
  return profile.injectionTemplates;
}

/** Return a defensive copy so callers cannot mutate internal state. */
function cloneSession(s: ProxySession): ProxySession {
  return {
    ...s,
    credentialIds: [...s.credentialIds],
    createdAt: new Date(s.createdAt.getTime()),
  };
}

function resetIdleTimer(managed: ManagedSession): void {
  if (managed.idleTimer != null) {
    clearTimeout(managed.idleTimer);
  }
  managed.idleTimer = setTimeout(() => {
    if (managed.session.status === "active") {
      silentlyWithLog(stopSession(managed.session.id), "idle session cleanup");
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

  sessions.set(session.id, {
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
 * Start the proxy session — opens an HTTP server on an ephemeral port.
 * When the session has credential IDs with injection templates, the proxy
 * is configured with a MITM handler that selectively intercepts HTTPS
 * connections to credential-matched hosts.
 */
export async function startSession(
  sessionId: ProxySessionId,
  options?: { listenHost?: string },
): Promise<ProxySession> {
  const managed = sessions.get(sessionId);
  if (!managed) throw new Error(`Session not found: ${sessionId}`);
  if (managed.session.status !== "starting") {
    throw new Error(
      `Session ${sessionId} is ${managed.session.status}, expected starting`,
    );
  }

  const config: ProxyServerConfig = {};

  // Build a templates map from credential metadata so the router and policy
  // engine can match request targets against injection host patterns.
  const templates = new Map<string, CredentialInjectionTemplate[]>();
  for (const credId of managed.session.credentialIds) {
    const resolved = resolveById(credId);
    const injectionTemplates = resolveInjectionTemplates(resolved);
    if (injectionTemplates.length > 0) {
      templates.set(credId, injectionTemplates);
    }
  }

  if (managed.dataDir && managed.session.credentialIds.length > 0) {
    const caDir = join(managed.dataDir, "proxy-ca");

    if (templates.size > 0) {
      // Ensure the CA directory and cert/key exist before starting MITM.
      // If this fails (e.g. missing openssl, unwritable dir), clean up the
      // session so it doesn't linger as 'starting' and count toward the
      // per-conversation limit.
      try {
        await ensureLocalCA(managed.dataDir);
        // Build a combined CA bundle (system roots + proxy CA) so
        // non-Node clients like curl, Python, and Go trust the proxy's
        // leaf certs via SSL_CERT_FILE (see getSessionEnv).
        managed.combinedCABundlePath = await ensureCombinedCABundle(
          managed.dataDir,
        );
      } catch (err) {
        sessions.delete(sessionId);
        throw err;
      }
      config.mitmHandler = {
        caDir,
        shouldIntercept: (hostname: string, port: number) =>
          routeConnection(
            hostname,
            port,
            managed.session.credentialIds,
            templates,
          ),
        rewriteCallback: async (req) => {
          // Per-credential best-match selection, mirroring the policy engine's
          // specificity logic (PR 04). For each credential, pick the single
          // best header template by specificity (exact > wildcard).
          const perCredentialBest: {
            credId: string;
            tpl: CredentialInjectionTemplate;
          }[] = [];

          for (const [credId, tpls] of templates) {
            let bestMatch: HostMatchKind = "none";
            let bestCandidates: CredentialInjectionTemplate[] = [];

            for (const tpl of tpls) {
              if (tpl.injectionType === "query") continue;
              const match = matchHostPattern(req.hostname, tpl.hostPattern, {
                includeApexForWildcard: true,
              });
              if (match === "none") continue;

              const cmp = compareMatchSpecificity(match, bestMatch);
              if (cmp < 0) {
                bestMatch = match;
                bestCandidates = [tpl];
              } else if (cmp === 0) {
                bestCandidates.push(tpl);
              }
            }

            if (bestCandidates.length === 1) {
              perCredentialBest.push({ credId, tpl: bestCandidates[0] });
            } else if (bestCandidates.length > 1) {
              // Same credential, same-specificity tie — ambiguous, block
              return null;
            }
          }

          if (perCredentialBest.length === 0) return req.headers;
          // Cross-credential ambiguity — block
          if (perCredentialBest.length > 1) return null;

          const { credId, tpl } = perCredentialBest[0];
          log.debug(
            {
              host: req.hostname,
              pattern: tpl.hostPattern,
              credentialId: credId,
            },
            "MITM rewrite: injecting credential",
          );

          if (tpl.injectionType === "header" && tpl.headerName) {
            const resolved = resolveById(credId);
            if (!resolved) return req.headers;
            const value = getSecureKey(resolved.storageKey);
            if (!value) return req.headers;

            req.headers[tpl.headerName.toLowerCase()] =
              (tpl.valuePrefix ?? "") + value;
            return req.headers;
          }

          return req.headers;
        },
      };
    }
  }

  // Cache the full credential registry with a TTL so the policy callback
  // doesn't hit disk on every proxied request (listCredentialMetadata uses
  // synchronous readFileSync + JSON.parse) while still picking up changes
  // to credential metadata within the session lifetime.
  let allKnownCache: CredentialInjectionTemplate[] | null = null;
  let allKnownCacheTime = 0;
  const CACHE_TTL_MS = 30_000; // 30 seconds

  function getAllKnown(): CredentialInjectionTemplate[] {
    const now = Date.now();
    if (!allKnownCache || now - allKnownCacheTime > CACHE_TTL_MS) {
      allKnownCache = [];
      for (const meta of listCredentialMetadata()) {
        if (meta.injectionTemplates?.length) {
          allKnownCache.push(...meta.injectionTemplates);
        }
      }
      allKnownCacheTime = now;
    }
    return allKnownCache;
  }

  // Build the policy callback for HTTP/CONNECT request gating
  const policyCallback: PolicyCallback = async (
    hostname: string,
    port: number | null,
    reqPath: string,
    scheme: "http" | "https",
  ) => {
    const decision = evaluateRequestWithApproval(
      hostname,
      port,
      reqPath,
      managed.session.credentialIds,
      templates,
      getAllKnown(),
      scheme,
    );

    log.debug(
      {
        trace: buildDecisionTrace(
          hostname,
          port,
          stripQueryString(reqPath),
          scheme,
          decision,
        ),
      },
      "Policy decision",
    );

    switch (decision.kind) {
      case "matched": {
        // Inject the credential value into the outbound request headers.
        // Secret values are read from secure storage at injection time and
        // MUST NEVER be logged — sanitizeHeaders in logging.ts handles redaction.
        const { credentialId, template } = decision;
        const resolved = resolveById(credentialId);
        if (!resolved) return {};
        const value = getSecureKey(resolved.storageKey);
        if (!value) return {};

        if (template.injectionType === "header" && template.headerName) {
          const headerValue = (template.valuePrefix ?? "") + value;
          return { [template.headerName.toLowerCase()]: headerValue };
        }
        // Query param injection is handled via URL rewriting in the MITM path
        return {};
      }
      case "ambiguous":
        return null; // block — can't auto-resolve
      case "ask_missing_credential":
      case "ask_unauthenticated":
        if (managed.approvalCallback) {
          const approved = await managed.approvalCallback({
            decision,
            sessionId: managed.session.id,
          });
          return approved ? {} : null;
        }
        return decision.kind === "ask_unauthenticated" ? {} : null;
      case "missing":
        return null;
      case "unauthenticated":
        return {};
      default:
        return null;
    }
  };

  config.policyCallback = policyCallback;

  const server = createProxyServer(config);

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
        resetIdleTimer(managed);
        resolve(cloneSession(managed.session));
      });
      server.on("error", reject);
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
export function getSessionEnv(sessionId: ProxySessionId): ProxyEnvVars {
  const managed = sessions.get(sessionId);
  if (!managed) throw new Error(`Session not found: ${sessionId}`);
  if (managed.session.status !== "active" || managed.session.port == null) {
    throw new Error(`Session ${sessionId} is not active`);
  }

  // Touch the idle timer on access
  resetIdleTimer(managed);

  const proxyUrl = `http://127.0.0.1:${managed.session.port}`;
  const env: ProxyEnvVars = {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: "localhost,127.0.0.1,::1",
  };

  if (managed.dataDir) {
    env.NODE_EXTRA_CA_CERTS = getCAPath(managed.dataDir);
    // Combined bundle lets non-Node clients (curl, Python, Go) trust
    // the proxy CA alongside system roots via SSL_CERT_FILE.
    // Only set when the bundle was actually created — pointing at a
    // missing file would replace the system trust store with nothing.
    if (managed.combinedCABundlePath) {
      env.SSL_CERT_FILE = managed.combinedCABundlePath;
    }
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
  const requestedHost = options?.listenHost ?? "127.0.0.1";

  // Fast path — session already active with matching credentials and listen host, no lock needed.
  const existing = getActiveSession(conversationId);
  if (existing && credentialIdsMatch(existing.credentialIds, credentialIds)) {
    const managed = sessions.get(existing.id);
    if (managed && managed.listenHost === requestedHost) {
      return { session: existing, created: false };
    }
  }
  // If credentials don't match (or no session exists), fall through to the
  // lock-protected section. Stopping a mismatched session outside the lock
  // would let another caller slip in and create a different-credential session.

  // Serialize: if another caller is already creating a session for this
  // conversation, wait for it rather than creating a second one.
  // Loop so that after a credential-mismatch teardown we re-check for a new
  // inflight lock — otherwise 3+ concurrent callers with different credentials
  // can all fall through and create duplicate sessions.
  for (;;) {
    const inflight = acquireLocks.get(conversationId);
    if (!inflight) break;
    const session = await inflight;
    if (credentialIdsMatch(session.credentialIds, credentialIds)) {
      const m = sessions.get(session.id);
      if (m && m.listenHost === requestedHost) {
        return { session, created: false };
      }
    }
    // Credential or listenHost mismatch — tear down and loop back to re-check
    // whether another waiter has already started a replacement session.
    await stopSession(session.id);
  }

  const promise = (async () => {
    // Re-check after winning the lock — a session may have become active
    // between our initial check and acquiring the lock.
    const recheck = getActiveSession(conversationId);
    if (recheck) {
      const m = sessions.get(recheck.id);
      if (
        credentialIdsMatch(recheck.credentialIds, credentialIds) &&
        m &&
        m.listenHost === requestedHost
      ) {
        return { session: recheck, created: false };
      }
      await stopSession(recheck.id);
    }

    const session = createSession(
      conversationId,
      credentialIds,
      config,
      dataDir,
      approvalCallback,
    );
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
export function getActiveSession(
  conversationId: string,
): ProxySession | undefined {
  for (const managed of sessions.values()) {
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
  conversationId: string,
): ProxySession[] {
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
  await Promise.all(
    ids.map((id) =>
      stopSession(id).catch((err: unknown) =>
        log.debug({ err, id }, "session shutdown error"),
      ),
    ),
  );
  sessions.clear();
}
