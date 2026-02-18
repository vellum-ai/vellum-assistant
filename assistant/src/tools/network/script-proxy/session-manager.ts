import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type {
  ProxySession,
  ProxySessionId,
  ProxySessionConfig,
  ProxyEnvVars,
} from './types.js';
import { getCAPath } from './certs.js';

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
}

const sessions = new Map<ProxySessionId, ManagedSession>();

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
  });

  return cloneSession(session);
}

/**
 * Start the proxy session — opens an HTTP server on an ephemeral port.
 * Resolves once the server is listening.
 */
export async function startSession(sessionId: ProxySessionId): Promise<ProxySession> {
  const managed = sessions.get(sessionId);
  if (!managed) throw new Error(`Session not found: ${sessionId}`);
  if (managed.session.status !== 'starting') {
    throw new Error(`Session ${sessionId} is ${managed.session.status}, expected starting`);
  }

  const server = createServer((_req, res) => {
    // Placeholder — no traffic routing in this PR
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Proxy not yet implemented');
  });

  return new Promise<ProxySession>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
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
}

/**
 * Gracefully stop a session — closes the HTTP server and clears the idle timer.
 */
export async function stopSession(sessionId: ProxySessionId): Promise<void> {
  const managed = sessions.get(sessionId);
  if (!managed) throw new Error(`Session not found: ${sessionId}`);
  if (managed.session.status === 'stopped' || managed.session.status === 'stopping') return;

  managed.session.status = 'stopping';

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
}

/**
 * Build environment variables to inject into a subprocess so its HTTP
 * traffic flows through this proxy session.
 */
export function getSessionEnv(sessionId: ProxySessionId): ProxyEnvVars {
  const managed = sessions.get(sessionId);
  if (!managed) throw new Error(`Session not found: ${sessionId}`);
  if (managed.session.status !== 'active' || managed.session.port === null) {
    throw new Error(`Session ${sessionId} is not active`);
  }

  // Touch the idle timer on access
  resetIdleTimer(managed);

  const proxyUrl = `http://127.0.0.1:${managed.session.port}`;
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
