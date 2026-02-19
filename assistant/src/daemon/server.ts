import * as net from 'node:net';
import { randomBytes } from 'node:crypto';
import { existsSync, chmodSync, readFileSync, writeFileSync, unlinkSync, readdirSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { getSocketPath, getSessionTokenPath, getRootDir, getWorkspaceDir, getWorkspaceSkillsDir, getSandboxWorkingDir, removeSocketFile, getTCPPort, getTCPHost, isTCPEnabled } from '../util/platform.js';
import { hasNoAuthOverride } from './connection-policy.js';
import { getLogger } from '../util/logger.js';
import { getFailoverProvider, initializeProviders } from '../providers/registry.js';
import { RateLimitProvider } from '../providers/ratelimit.js';
import { getConfig, invalidateConfigCache } from '../config/loader.js';
import { buildSystemPrompt } from '../config/system-prompt.js';
import { clearCache as clearTrustCache } from '../permissions/trust-store.js';
import { resetAllowlist, validateAllowlistFile } from '../security/secret-allowlist.js';
import { checkIngressForSecrets } from '../security/secret-ingress.js';
import { IngressBlockedError } from '../util/errors.js';
import { clearEmbeddingBackendCache } from '../memory/embedding-backend.js';
import * as conversationStore from '../memory/conversation-store.js';
import * as attachmentsStore from '../memory/attachments-store.js';
import { Session, DEFAULT_MEMORY_POLICY, type SessionMemoryPolicy } from './session.js';
import { resolveChannelCapabilities } from './session-runtime-assembly.js';
import { ComputerUseSession } from './computer-use-session.js';
import {
  serialize,
  createMessageParser,
  MAX_LINE_SIZE,
  type ClientMessage,
  type ServerMessage,
  normalizeThreadType,
} from './ipc-protocol.js';
import { validateClientMessage } from './ipc-validate.js';
import { handleMessage, type HandlerContext, type SessionCreateOptions } from './handlers.js';
import { RunOrchestrator } from '../runtime/run-orchestrator.js';
import { ensureBlobDir, sweepStaleBlobs } from './ipc-blob-store.js';
import { bootstrapHomeBaseAppLink } from '../home-base/bootstrap.js';
import { assistantEventHub } from '../runtime/assistant-event-hub.js';
import { buildAssistantEvent } from '../runtime/assistant-event.js';
import { SessionEvictor } from './session-evictor.js';
import { getSubagentManager } from '../subagent/index.js';
import { tryHandlePendingCallAnswer } from '../calls/call-bridge.js';

const log = getLogger('server');

function readPackageVersion(): string | undefined {
  try {
    const pkgPath = join(import.meta.dir, '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

const daemonVersion = readPackageVersion();

export class DaemonServer {
  private server: net.Server | null = null;
  private tcpServer: net.Server | null = null;
  private sessions = new Map<string, Session>();
  private socketToSession = new Map<net.Socket, string>();
  private cuSessions = new Map<string, ComputerUseSession>();
  private socketToCuSession = new Map<net.Socket, Set<string>>();
  private connectedSockets = new Set<net.Socket>();
  private socketSandboxOverride = new Map<net.Socket, boolean>();
  private cuObservationParseSequence = new Map<string, number>();
  // Persisted session options (e.g. systemPromptOverride, maxResponseTokens)
  // so that evicted sessions can be recreated with the same overrides.
  private sessionOptions = new Map<string, SessionCreateOptions>();
  // Guards against duplicate session creation when multiple clients connect
  // with the same conversation ID concurrently. The first caller creates the
  // session; subsequent callers await the same promise.
  private sessionCreating = new Map<string, Promise<Session>>();
  // Shared across all sessions so maxRequestsPerMinute is enforced globally.
  private sharedRequestTimestamps: number[] = [];
  private socketPath: string;
  private httpPort: number | undefined;
  private watchers: FSWatcher[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly MAX_DEBOUNCE_ENTRIES = 1000;
  private suppressConfigReload = false;
  private lastConfigFingerprint = '';
  private lastConfigRefreshTime = 0;
  private blobSweepTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly CONFIG_REFRESH_INTERVAL_MS = 30_000;
  private static readonly MAX_CONNECTIONS = 50;
  private static readonly AUTH_TIMEOUT_MS = 5_000;
  private sessionToken = '';
  private authenticatedSockets = new Set<net.Socket>();
  private authTimeouts = new Map<net.Socket, ReturnType<typeof setTimeout>>();
  private evictor: SessionEvictor;

  /**
   * Derive a SessionMemoryPolicy from the conversation's thread type and
   * memory scope. Private conversations get an isolated scope with strict
   * side-effect controls and default-fallback recall; standard conversations
   * use the shared default scope with no restrictions.
   */
  private deriveMemoryPolicy(conversationId: string): SessionMemoryPolicy {
    const threadType = conversationStore.getConversationThreadType(conversationId);
    if (threadType === 'private') {
      return {
        scopeId: conversationStore.getConversationMemoryScopeId(conversationId),
        includeDefaultFallback: true,
        strictSideEffects: true,
      };
    }
    return DEFAULT_MEMORY_POLICY;
  }

  private applyTransportMetadata(_session: Session, options: SessionCreateOptions | undefined): void {
    const transport = options?.transport;
    if (!transport) return;

    // Transport metadata is available for future use but onboarding context
    // is now handled via BOOTSTRAP.md in the system prompt.
    log.debug({ channelId: transport.channelId }, 'Transport metadata received');
  }

  /**
   * Logical assistant identifier used when publishing to the assistant-events hub.
   * Defaults to 'default' for the IPC daemon runtime; override in tests or
   * multi-tenant deployments where the daemon is scoped to a specific assistant.
   */
  assistantId: string = 'default';

  constructor() {
    this.socketPath = getSocketPath();
    this.evictor = new SessionEvictor(this.sessions);
    // Share the global rate-limit timestamps with the subagent manager.
    getSubagentManager().sharedRequestTimestamps = this.sharedRequestTimestamps;
    // Abort subagents when their parent session is evicted.
    this.evictor.onEvict = (sessionId: string) => {
      getSubagentManager().abortAllForParent(sessionId);
    };
    // Protect parent sessions that have active subagents from eviction.
    this.evictor.shouldProtect = (sessionId: string) => {
      const children = getSubagentManager().getChildrenOf(sessionId);
      return children.some((c) => c.status === 'running' || c.status === 'pending');
    };
    // When a subagent finishes, inject the result into the parent session
    // so the LLM automatically informs the user.
    getSubagentManager().onSubagentFinished = (parentSessionId, message, sendToClient) => {
      const parentSession = this.sessions.get(parentSessionId);
      if (!parentSession) {
        log.warn({ parentSessionId }, 'Subagent finished but parent session not found');
        return;
      }
      const requestId = `subagent-notify-${Date.now()}`;
      const enqueueResult = parentSession.enqueueMessage(message, [], sendToClient, requestId);
      if (enqueueResult.rejected) {
        log.warn({ parentSessionId }, 'Parent session queue full, dropping subagent notification');
        return;
      }
      if (!enqueueResult.queued) {
        // Parent is idle — send directly.
        const messageId = parentSession.persistUserMessage(message, []);
        parentSession.runAgentLoop(message, messageId, sendToClient).catch((err) => {
          log.error({ parentSessionId, err }, 'Failed to process subagent notification in parent');
        });
      }
      // If queued, it will be processed when the parent finishes its current turn.
    };
  }

  async start(): Promise<void> {
    // Clean up stale socket (only if it's actually a Unix socket)
    removeSocketFile(this.socketPath);

    // Initialize providers from config so they're available before any
    // session is created. Without this, getProvider() throws because the
    // registry is empty until a config file change triggers a reload.
    const config = getConfig();
    initializeProviders(config);
    this.lastConfigFingerprint = this.configFingerprint(config);

    try {
      bootstrapHomeBaseAppLink();
    } catch (err) {
      log.warn({ err }, 'Failed to bootstrap Home Base app link at daemon startup');
    }

    this.evictor.start();

    ensureBlobDir();
    this.blobSweepTimer = setInterval(() => {
      sweepStaleBlobs(30 * 60 * 1000).catch((err) => {
        log.warn({ err }, 'Blob sweep failed');
      });
    }, 5 * 60 * 1000);

    this.startFileWatchers();

    // Generate a session token and write it to disk so clients can
    // authenticate when connecting. Written before the socket starts
    // listening to ensure the token is available by the time a client
    // can connect.
    this.sessionToken = randomBytes(32).toString('hex');
    const tokenPath = getSessionTokenPath();
    writeFileSync(tokenPath, this.sessionToken, { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    log.info({ tokenPath }, 'Session token written');

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      const oldUmask = process.umask(0o177);

      this.server.once('error', (err) => {
        process.umask(oldUmask);
        log.error({ err, socketPath: this.socketPath }, 'Server failed to start (is another daemon already running?)');
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        process.umask(oldUmask);
        // Replace the one-shot startup handler with a permanent one
        this.server!.removeAllListeners('error');
        this.server!.on('error', (err) => {
          log.error({ err, socketPath: this.socketPath }, 'Server socket error while running');
        });
        chmodSync(this.socketPath, 0o600);
        log.info({ socketPath: this.socketPath }, 'Daemon server listening');

        // Start TCP listener for iOS clients (alongside the Unix socket)
        if (isTCPEnabled()) {
          const tcpPort = getTCPPort();
          this.tcpServer = net.createServer((socket) => {
            this.handleConnection(socket);
          });
          this.tcpServer.on('error', (err) => {
            log.error({ err, tcpPort }, 'TCP server error');
          });
          this.tcpServer.listen(tcpPort, getTCPHost(), () => {
            log.info({ tcpPort, tcpHost: getTCPHost() }, 'TCP listener started');
          });
        }

        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    getSubagentManager().disposeAll();
    this.evictor.stop();
    if (this.blobSweepTimer) {
      clearInterval(this.blobSweepTimer);
      this.blobSweepTimer = null;
    }
    this.stopFileWatchers();

    // Clean up session token
    try {
      unlinkSync(getSessionTokenPath());
    } catch { /* ignore if already gone */ }

    for (const timer of this.authTimeouts.values()) {
      clearTimeout(timer);
    }
    this.authTimeouts.clear();
    this.authenticatedSockets.clear();

    // 1. Stop accepting new connections first. server.close() prevents new
    //    connections from arriving, so the cleanup below won't race with
    //    handleConnection() adding sockets that never get destroyed.
    //    Its callback fires once all existing connections have ended.
    const serverClosed = new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => {
          try {
            removeSocketFile(this.socketPath);
          } catch (err) {
            log.warn({ err, socketPath: this.socketPath }, 'Failed to remove socket file during shutdown');
          }
          resolve();
        });
      } else {
        resolve();
      }
    });

    const tcpServerClosed = new Promise<void>((resolve) => {
      if (this.tcpServer) {
        this.tcpServer.close(() => resolve());
        this.tcpServer = null;
      } else {
        resolve();
      }
    });

    // 2. Now dispose sessions and destroy sockets. This lets server.close()
    //    finish promptly since all connections will be ended.
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();

    for (const cuSession of this.cuSessions.values()) {
      cuSession.abort();
    }
    this.cuSessions.clear();
    this.socketToCuSession.clear();

    for (const socket of this.connectedSockets) {
      socket.destroy();
    }
    this.connectedSockets.clear();
    this.socketToSession.clear();
    this.socketSandboxOverride.clear();
    this.cuObservationParseSequence.clear();

    await Promise.all([serverClosed, tcpServerClosed]);
    log.info('Daemon server stopped');
  }

  private startFileWatchers(): void {
    const rootDir = getRootDir();
    const workspaceDir = getWorkspaceDir();
    const protectedDir = join(rootDir, 'protected');

    // Watch workspace directory for config + prompt files
    const workspaceHandlers: Record<string, () => void> = {
      'config.json': () => {
        if (this.suppressConfigReload) return;
        try {
          this.refreshConfigFromSources();
        } catch (err) {
          log.error({ err, configPath: join(workspaceDir, 'config.json') }, 'Failed to reload config after file change. Previous config remains active.');
          return;
        }
      },
      'SOUL.md': () => this.evictSessionsForReload(),
      'IDENTITY.md': () => this.evictSessionsForReload(),
      'USER.md': () => this.evictSessionsForReload(),
      'LOOKS.md': () => this.evictSessionsForReload(),
    };

    // Watch protected/ for trust rules and secret allowlist
    const protectedHandlers: Record<string, () => void> = {
      'trust.json': () => {
        clearTrustCache();
      },
      'secret-allowlist.json': () => {
        resetAllowlist();
        try {
          const errors = validateAllowlistFile();
          if (errors && errors.length > 0) {
            for (const e of errors) {
              log.warn({ index: e.index, pattern: e.pattern }, `Invalid regex in secret-allowlist.json: ${e.message}`);
            }
          }
        } catch (err) {
          log.warn({ err }, 'Failed to validate secret-allowlist.json');
        }
      },
    };

    const watchDir = (dir: string, handlers: Record<string, () => void>, label: string): void => {
      try {
        const watcher = watch(dir, (_eventType, filename) => {
          if (!filename) return;
          const file = String(filename);
          if (!handlers[file]) return;
          const key = `file:${file}`;
          const existing = this.debounceTimers.get(key);
          if (existing) clearTimeout(existing);
          const timer = setTimeout(() => {
            this.debounceTimers.delete(key);
            log.info({ file }, 'File changed, reloading');
            handlers[file]();
          }, 200);
          this.debounceTimers.set(key, timer);
          this.enforceDebounceLimit();
        });
        this.watchers.push(watcher);
        log.info({ dir }, `Watching ${label}`);
      } catch (err) {
        log.warn({ err, dir }, `Failed to watch ${label}. Hot-reload will be unavailable.`);
      }
    };

    watchDir(workspaceDir, workspaceHandlers, 'workspace directory for config/prompt changes');
    if (existsSync(protectedDir)) {
      watchDir(protectedDir, protectedHandlers, 'protected directory for trust/allowlist changes');
    }

    this.startSkillsWatchers(() => this.evictSessionsForReload());
  }

  private configFingerprint(config: ReturnType<typeof getConfig>): string {
    return JSON.stringify(config);
  }

  /**
   * Record the runtime HTTP server port and broadcast it to all
   * connected clients so they can enable the share UI immediately.
   */
  setHttpPort(port: number): void {
    this.httpPort = port;
    // Clients that connected before the HTTP server started received
    // daemon_status with no httpPort. Broadcast the updated port so
    // they can enable the share UI without reconnecting.
    this.broadcast({
      type: 'daemon_status',
      httpPort: port,
      version: daemonVersion,
    });
  }

  /**
   * Dispose and remove all in-memory sessions unconditionally.
   * Called after `sessions clear` wipes the database so that stale
   * sessions don't reference deleted conversation rows.
   */
  clearAllSessions(): number {
    const count = this.sessions.size;
    const subagentManager = getSubagentManager();
    for (const id of this.sessions.keys()) {
      this.evictor.remove(id);
      subagentManager.abortAllForParent(id);
    }
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.sessionOptions.clear();
    return count;
  }

  private evictSessionsForReload(): void {
    const subagentManager = getSubagentManager();
    for (const [id, session] of this.sessions) {
      if (!session.isProcessing()) {
        subagentManager.abortAllForParent(id);
        session.dispose();
        this.sessions.delete(id);
        this.evictor.remove(id);
      } else {
        session.markStale();
      }
    }
  }

  /**
   * Reload config from disk + secure storage, and refresh providers only
   * when effective config values (including API keys) have changed.
   */
  private refreshConfigFromSources(): boolean {
    invalidateConfigCache();
    const config = getConfig();
    const fingerprint = this.configFingerprint(config);
    if (fingerprint === this.lastConfigFingerprint) {
      return false;
    }
    // Default trust rules depend on config (e.g. skills.load.extraDirs),
    // so clear the trust cache so rules are regenerated from fresh config.
    clearTrustCache();
    clearEmbeddingBackendCache();
    const isFirstInit = this.lastConfigFingerprint === '';
    initializeProviders(config);
    this.lastConfigFingerprint = fingerprint;
    if (!isFirstInit) {
      this.evictSessionsForReload();
    }
    return true;
  }

  private stopFileWatchers(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }

  /**
   * Evict the oldest file-watcher debounce entries when the map exceeds the safety cap.
   * Map iteration order follows insertion order, so the first keys are oldest.
   * Protects system timers (keys starting with '__') from eviction, so critical
   * timers like '__suppress_reset__' are never cleared during bursts of file events.
   */
  private enforceDebounceLimit(): void {
    if (this.debounceTimers.size <= DaemonServer.MAX_DEBOUNCE_ENTRIES) return;
    const excess = this.debounceTimers.size - DaemonServer.MAX_DEBOUNCE_ENTRIES;
    let removed = 0;
    for (const [key, timer] of this.debounceTimers) {
      if (removed >= excess) break;
      // Skip system timers (those with keys starting with '__')
      if (key.startsWith('__')) continue;
      clearTimeout(timer);
      this.debounceTimers.delete(key);
      removed++;
    }
  }

  private startSkillsWatchers(evictSessions: () => void): void {
    const skillsDir = getWorkspaceSkillsDir();
    if (!existsSync(skillsDir)) return;

    const scheduleSkillsReload = (file: string): void => {
      const key = `skills:${file}`;
      const existing = this.debounceTimers.get(key);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        this.debounceTimers.delete(key);
        log.info({ file }, 'Skill file changed, reloading');
        evictSessions();
      }, 200);
      this.debounceTimers.set(key, timer);
      this.enforceDebounceLimit();
    };

    try {
      const recursiveWatcher = watch(skillsDir, { recursive: true }, (_eventType, filename) => {
        scheduleSkillsReload(filename ? String(filename) : '(unknown)');
      });
      this.watchers.push(recursiveWatcher);
      log.info({ dir: skillsDir }, 'Watching skills directory recursively');
      return;
    } catch (err) {
      log.info({ err, dir: skillsDir }, 'Recursive skills watch unavailable; using per-directory watchers');
    }

    const childWatchers = new Map<string, FSWatcher>();

    const watchDir = (dirPath: string, onChange: (filename: string) => void): FSWatcher | null => {
      try {
        const watcher = watch(dirPath, (_eventType, filename) => {
          onChange(filename ? String(filename) : '(unknown)');
        });
        this.watchers.push(watcher);
        return watcher;
      } catch (err) {
        log.warn({ err, dirPath }, 'Failed to watch skills directory');
        return null;
      }
    };

    const removeWatcher = (watcher: FSWatcher): void => {
      const idx = this.watchers.indexOf(watcher);
      if (idx !== -1) {
        this.watchers.splice(idx, 1);
      }
    };

    const refreshChildWatchers = (): void => {
      const nextChildDirs = new Set<string>();

      try {
        const entries = readdirSync(skillsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const childDir = join(skillsDir, entry.name);
          nextChildDirs.add(childDir);

          if (childWatchers.has(childDir)) continue;

          const watcher = watchDir(childDir, (filename) => {
            const label = filename === '(unknown)' ? entry.name : `${entry.name}/${filename}`;
            scheduleSkillsReload(label);
          });
          if (watcher) {
            childWatchers.set(childDir, watcher);
          }
        }
      } catch (err) {
        log.warn({ err, skillsDir }, 'Failed to enumerate skill directories');
        return;
      }

      for (const [childDir, watcher] of childWatchers.entries()) {
        if (nextChildDirs.has(childDir)) continue;
        watcher.close();
        childWatchers.delete(childDir);
        removeWatcher(watcher);
      }
    };

    const rootWatcher = watchDir(skillsDir, (filename) => {
      scheduleSkillsReload(filename);
      refreshChildWatchers();
    });

    if (!rootWatcher) return;

    refreshChildWatchers();
    log.info({ dir: skillsDir }, 'Watching skills directory with non-recursive fallback');
  }

  private handleConnection(socket: net.Socket): void {
    if (this.connectedSockets.size >= DaemonServer.MAX_CONNECTIONS) {
      log.warn({ current: this.connectedSockets.size, max: DaemonServer.MAX_CONNECTIONS }, 'Connection limit reached, rejecting client');
      socket.once('error', (err) => {
        log.error({ err }, 'Socket error while rejecting connection');
      });
      socket.write(serialize({ type: 'error', message: `Connection limit reached (max ${DaemonServer.MAX_CONNECTIONS})` }));
      socket.destroy();
      return;
    }

    log.info('Client connected');
    this.connectedSockets.add(socket);
    const parser = createMessageParser({ maxLineSize: MAX_LINE_SIZE });

    // When the operator explicitly opts into unauthenticated connections
    // (VELLUM_DAEMON_NOAUTH=1), auto-authenticate so clients that can't
    // read the local session token file (e.g. SSH-forwarded sockets)
    // aren't disconnected by the auth timeout. This is intentionally
    // gated on a separate flag — a custom socket path alone (via
    // VELLUM_DAEMON_SOCKET) no longer bypasses token auth.
    if (hasNoAuthOverride()) {
      this.authenticatedSockets.add(socket);
      log.warn('Auto-authenticated client (VELLUM_DAEMON_NOAUTH is set — token auth bypassed)');
      this.send(socket, { type: 'auth_result', success: true });
      this.sendInitialSession(socket).catch((err) => {
        log.error({ err }, 'Failed to send initial session info after auto-auth');
      });
    }

    // Require authentication before sending session info or accepting
    // commands. Clients must send { type: 'auth', token } as their
    // first message within AUTH_TIMEOUT_MS.
    const authTimer = setTimeout(() => {
      if (!this.authenticatedSockets.has(socket)) {
        log.warn('Client failed to authenticate within timeout, disconnecting');
        this.send(socket, { type: 'error', message: 'Authentication timeout' });
        socket.destroy();
      }
    }, DaemonServer.AUTH_TIMEOUT_MS);
    this.authTimeouts.set(socket, authTimer);

    socket.on('data', (data) => {
      const chunkReceivedAtMs = Date.now();
      const parseStartNs = process.hrtime.bigint();
      let parsed;
      try {
        parsed = parser.feedRaw(data.toString());
      } catch (err) {
        log.error({ err }, 'IPC parse error (malformed JSON or message exceeded size limit), dropping client');
        socket.write(serialize({ type: 'error', message: `IPC parse error: ${(err as Error).message}` }));
        socket.destroy();
        return;
      }
      const parsedAtMs = Date.now();
      const parseDurationMs = Number(process.hrtime.bigint() - parseStartNs) / 1_000_000;
      for (const entry of parsed) {
        const msg = entry.msg;
        if (typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'cu_observation') {
          const maybeSessionId = (msg as { sessionId?: unknown }).sessionId;
          const sessionId = typeof maybeSessionId === 'string' ? maybeSessionId : 'unknown';
          const previousSequence = this.cuObservationParseSequence.get(sessionId) ?? 0;
          const sequence = previousSequence + 1;
          this.cuObservationParseSequence.set(sessionId, sequence);
          log.info({
            sessionId,
            sequence,
            chunkReceivedAtMs,
            parsedAtMs,
            parseDurationMs,
            messageBytes: entry.rawByteLength,
          }, 'IPC_METRIC cu_observation_parse');
        }
        const result = validateClientMessage(msg);
        if (!result.valid) {
          log.warn({ reason: result.reason }, 'Invalid IPC message, dropping client');
          socket.write(serialize({ type: 'error', message: `Invalid message: ${result.reason}` }));
          socket.destroy();
          return;
        }

        // Auth gate: first message must be 'auth' with a valid token.
        if (!this.authenticatedSockets.has(socket)) {
          const pendingTimer = this.authTimeouts.get(socket);
          if (pendingTimer) {
            clearTimeout(pendingTimer);
            this.authTimeouts.delete(socket);
          }

          if (result.message.type === 'auth') {
            const authMsg = result.message as { type: 'auth'; token: string };
            if (authMsg.token === this.sessionToken) {
              this.authenticatedSockets.add(socket);
              this.send(socket, { type: 'auth_result', success: true });
              this.sendInitialSession(socket).catch((err) => {
                log.error({ err }, 'Failed to send initial session info after auth');
              });
            } else {
              log.warn('Client provided invalid auth token');
              this.send(socket, { type: 'auth_result', success: false, message: 'Invalid token' });
              socket.destroy();
            }
            continue;
          }

          // Non-auth message from unauthenticated socket
          log.warn({ type: result.message.type }, 'Unauthenticated client sent non-auth message, disconnecting');
          this.send(socket, { type: 'error', message: 'Authentication required' });
          socket.destroy();
          return;
        }

        // If an already-authenticated socket sends an auth message (e.g.
        // auto-auth'd client that also has a local token), respond with
        // auth_result so the client doesn't hang waiting for the handshake.
        if (result.message.type === 'auth') {
          this.send(socket, { type: 'auth_result', success: true });
          continue;
        }

        this.dispatchMessage(result.message, socket);
      }
    });

    socket.on('close', () => {
      const pendingAuthTimer = this.authTimeouts.get(socket);
      if (pendingAuthTimer) {
        clearTimeout(pendingAuthTimer);
        this.authTimeouts.delete(socket);
      }
      this.authenticatedSockets.delete(socket);
      this.connectedSockets.delete(socket);
      this.socketSandboxOverride.delete(socket);
      const sessionId = this.socketToSession.get(socket);
      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
          session.abort();
        }
        getSubagentManager().abortAllForParent(sessionId);
      }
      this.socketToSession.delete(socket);
      const cuSessionIds = this.socketToCuSession.get(socket);
      if (cuSessionIds) {
        for (const cuSessionId of cuSessionIds) {
          this.cuObservationParseSequence.delete(cuSessionId);
          const cuSession = this.cuSessions.get(cuSessionId);
          if (cuSession) {
            cuSession.abort();
            this.cuSessions.delete(cuSessionId);
          }
        }
      }
      this.socketToCuSession.delete(socket);
      log.info('Client disconnected');
    });

    socket.on('error', (err) => {
      log.error({ err, remoteAddress: socket.remoteAddress }, 'Client socket error');
    });
  }

  /** Low-level wire write — does not publish to the assistant-events hub. */
  private writeToSocket(socket: net.Socket, msg: ServerMessage): void {
    if (!socket.destroyed && socket.writable) {
      socket.write(serialize(msg));
    }
  }

  private send(socket: net.Socket, msg: ServerMessage): void {
    this.writeToSocket(socket, msg);
    // Best-effort sessionId: prefer message field, fall back to socket binding.
    const msgRecord = msg as unknown as Record<string, unknown>;
    const sessionId =
      ('sessionId' in msg && typeof msgRecord.sessionId === 'string'
        ? msgRecord.sessionId as string
        : undefined) ?? this.socketToSession.get(socket);
    this.publishAssistantEvent(msg, sessionId, this.assistantId);
  }

  broadcast(msg: ServerMessage, excludeSocket?: net.Socket): void {
    for (const socket of this.authenticatedSockets) {
      if (socket === excludeSocket) continue;
      this.writeToSocket(socket, msg);  // bypass per-socket hub publish
    }
    // Publish once for the broadcast. Prefer message-level sessionId; fall back
    // to excludeSocket's session binding so session-scoped events (e.g.
    // assistant_text_delta emitted without a sessionId field) are correctly tagged.
    const msgRecord = msg as unknown as Record<string, unknown>;
    const sessionId =
      ('sessionId' in msg && typeof msgRecord.sessionId === 'string'
        ? msgRecord.sessionId as string
        : undefined) ?? (excludeSocket ? this.socketToSession.get(excludeSocket) : undefined);
    this.publishAssistantEvent(msg, sessionId, this.assistantId);
  }

  /**
   * Publish `msg` as an `AssistantEvent` to the process-level hub.
   * Publishes are serialized via a promise chain so that subscribers always
   * observe events in the order they were sent (e.g. text deltas before
   * message_complete), even when subscriber callbacks are async.
   */
  private _hubChain: Promise<void> = Promise.resolve();

  private publishAssistantEvent(msg: ServerMessage, sessionId?: string, assistantId?: string): void {
    const event = buildAssistantEvent(assistantId ?? this.assistantId, msg, sessionId);
    this._hubChain = this._hubChain
      .then(() => assistantEventHub.publish(event))
      .catch((err: unknown) => {
        log.warn({ err }, 'assistant-events hub subscriber threw during IPC send');
      });
  }

  private async sendInitialSession(socket: net.Socket): Promise<void> {
    // Only send session info for an existing conversation. Don't create one —
    // the client will create its own session via session_create when the user
    // sends a message. Creating one here would produce an orphaned session
    // that the macOS client rejects (correlation ID mismatch) but that still
    // appears in session_list on subsequent launches.
    const conversation = conversationStore.getLatestConversation();
    if (!conversation) {
      this.send(socket, {
        type: 'daemon_status',
        httpPort: this.httpPort,
        version: daemonVersion,
      });
      return;
    }

    // Warm session state for commands like undo/usage after reconnect without
    // rebinding the active IPC output client to this passive socket.
    await this.getOrCreateSession(conversation.id, undefined, false);

    this.send(socket, {
      type: 'session_info',
      sessionId: conversation.id,
      title: conversation.title ?? 'New Conversation',
      threadType: normalizeThreadType(conversation.threadType),
    });

    this.send(socket, {
      type: 'daemon_status',
      httpPort: this.httpPort,
      version: daemonVersion,
    });
  }

  private async getOrCreateSession(
    conversationId: string,
    socket?: net.Socket,
    rebindClient = true,
    options?: SessionCreateOptions,
  ): Promise<Session> {
    let session = this.sessions.get(conversationId);
    const sendToClient = socket
      ? (msg: ServerMessage) => this.send(socket, msg)
      : () => {};
    const maybeBindClient = (target: Session): void => {
      if (!rebindClient || !socket) return;
      target.updateClient(sendToClient);
      target.setSandboxOverride(this.socketSandboxOverride.get(socket));
      // Update the sender for any active child subagents so they route
      // through the new socket instead of the stale one from spawn time.
      getSubagentManager().updateParentSender(conversationId, sendToClient);
    };

    // Persist session options so they survive eviction/recreation.
    if (options && Object.values(options).some(v => v !== undefined)) {
      this.sessionOptions.set(conversationId, {
        ...this.sessionOptions.get(conversationId),
        ...options,
      });
    }

    if (!session || (session.isStale() && !session.isProcessing())) {
      // Dispose the outgoing stale session before replacing it.
      if (session) {
        getSubagentManager().abortAllForParent(conversationId);
        session.dispose();
      }

      // Check if another caller is already creating this session.
      // Without this guard, two concurrent getOrCreateSession calls for the
      // same conversationId would both pass the null/stale check, both create
      // a Session + loadFromDb(), and the second set() would orphan the first.
      const pending = this.sessionCreating.get(conversationId);
      if (pending) {
        session = await pending;
        maybeBindClient(session);
        return session;
      }

      // Recover stored options for this conversation (survives eviction).
      const storedOptions = this.sessionOptions.get(conversationId);

      const createPromise = (async () => {
        const config = getConfig();
        let provider = getFailoverProvider(config.provider, config.providerOrder);
        const { rateLimit } = config;
        if (rateLimit.maxRequestsPerMinute > 0 || rateLimit.maxTokensPerSession > 0) {
          provider = new RateLimitProvider(provider, rateLimit, this.sharedRequestTimestamps);
        }
        const workingDir = getSandboxWorkingDir();

        const systemPrompt = storedOptions?.systemPromptOverride ?? buildSystemPrompt();
        const maxTokens = storedOptions?.maxResponseTokens ?? config.maxTokens;

        const memoryPolicy = this.deriveMemoryPolicy(conversationId);
        const newSession = new Session(
          conversationId,
          provider,
          systemPrompt,
          maxTokens,
          rebindClient ? sendToClient : () => {},
          workingDir,
          (msg) => this.broadcast(msg, socket),
          memoryPolicy,
        );
        // When created without a socket (HTTP path), mark the session
        // so interactive prompts (e.g. host attachment reads) can fail
        // fast instead of waiting for a timeout with no client to respond.
        if (!socket) {
          newSession.updateClient(sendToClient, true);
        }
        await newSession.loadFromDb();
        this.applyTransportMetadata(newSession, storedOptions);
        if (rebindClient && socket) {
          newSession.setSandboxOverride(this.socketSandboxOverride.get(socket));
        }
        this.sessions.set(conversationId, newSession);
        return newSession;
      })();

      this.sessionCreating.set(conversationId, createPromise);
      try {
        session = await createPromise;
      } finally {
        this.sessionCreating.delete(conversationId);
      }
      this.evictor.touch(conversationId);
    } else {
      // Rebind to the new socket so IPC goes to the current client.
      maybeBindClient(session);
      this.applyTransportMetadata(session, options);
      this.evictor.touch(conversationId);
    }
    return session;
  }

  private handlerContext(): HandlerContext {
    return {
      sessions: this.sessions,
      socketToSession: this.socketToSession,
      cuSessions: this.cuSessions,
      socketToCuSession: this.socketToCuSession,
      cuObservationParseSequence: this.cuObservationParseSequence,
      socketSandboxOverride: this.socketSandboxOverride,
      sharedRequestTimestamps: this.sharedRequestTimestamps,
      debounceTimers: this.debounceTimers,
      suppressConfigReload: this.suppressConfigReload,
      setSuppressConfigReload: (value: boolean) => { this.suppressConfigReload = value; },
      updateConfigFingerprint: () => {
        this.lastConfigFingerprint = this.configFingerprint(getConfig());
        this.lastConfigRefreshTime = Date.now();
      },
      send: (socket, msg) => this.send(socket, msg),
      broadcast: (msg) => this.broadcast(msg),
      clearAllSessions: () => this.clearAllSessions(),
      getOrCreateSession: (id, socket?, rebind?, options?) =>
        this.getOrCreateSession(id, socket, rebind, options),
      touchSession: (id) => this.evictor.touch(id),
    };
  }

  private dispatchMessage(msg: ClientMessage, socket: net.Socket): void {
    if (msg.type !== 'ping') {
      const now = Date.now();
      if (now - this.lastConfigRefreshTime >= DaemonServer.CONFIG_REFRESH_INTERVAL_MS) {
        try {
          this.refreshConfigFromSources();
          this.lastConfigRefreshTime = now;
        } catch (err) {
          log.warn({ err }, 'Failed to refresh config from secure sources before handling IPC message');
        }
      }
    }
    handleMessage(msg, socket, this.handlerContext());
  }

  /**
   * Persist a user message and start the agent loop in the background.
   * Returns the messageId immediately without waiting for the agent loop
   * to complete. Used by the HTTP sendMessage endpoint so the response
   * is not blocked for the duration of the agent loop.
   */
  async persistAndProcessMessage(
    conversationId: string,
    content: string,
    attachmentIds?: string[],
    options?: SessionCreateOptions,
    sourceChannel?: string,
  ): Promise<{ messageId: string }> {
    // Block inbound content that contains secrets — mirrors the IPC check in sessions.ts
    const ingressCheck = checkIngressForSecrets(content);
    if (ingressCheck.blocked) {
      throw new IngressBlockedError(ingressCheck.userNotice!, ingressCheck.detectedTypes);
    }

    const session = await this.getOrCreateSession(conversationId, undefined, true, options);

    // Reject concurrent requests upfront. The HTTP path should never use
    // the message queue — it returns 409 to the caller instead.
    if (session.isProcessing()) {
      throw new Error('Session is already processing a message');
    }

    session.setChannelCapabilities(resolveChannelCapabilities(sourceChannel));

    // Resolve attachment IDs to full attachment data for the session
    const attachments = attachmentIds
      ? attachmentsStore.getAttachmentsByIds('self', attachmentIds).map((a) => ({
          id: a.id,
          filename: a.originalFilename,
          mimeType: a.mimeType,
          data: a.dataBase64,
        }))
      : [];

    // persistUserMessage throws if the session is busy or persistence fails
    const requestId = crypto.randomUUID();
    const messageId = session.persistUserMessage(content, attachments, requestId);

    // Attempt the call-answer bridge before launching the agent loop.
    // The bridge check is in its own try/catch so that a bridge failure
    // (non-fatal) falls through to the agent loop, but post-bridge cleanup
    // errors propagate to the caller.
    let bridgeHandled = false;
    try {
      const bridgeResult = await tryHandlePendingCallAnswer(conversationId, content, messageId);
      bridgeHandled = bridgeResult.handled;
    } catch (err) {
      log.warn({ err, conversationId }, 'Call-answer bridge check failed (non-fatal), proceeding with agent loop');
    }

    if (bridgeHandled) {
      // The message was consumed by the call system. Release the
      // processing lock so the session can accept subsequent messages.
      // runAgentLoop normally does this in its finally block, but we
      // skipped it entirely.
      resetSessionProcessingState(session);
      // Drain any queued messages that arrived while processing was true.
      // runAgentLoop normally drains in its finally block, but we skipped it.
      session.drainQueue('loop_complete');
      log.info({ conversationId, messageId }, 'User message consumed by call-answer bridge, skipping agent loop');
      return { messageId };
    }

    // Fire-and-forget the agent loop. Errors are logged but do not
    // affect the HTTP response (the client polls GET /messages).
    session.runAgentLoop(content, messageId, () => {}).catch((err) => {
      log.error({ err, conversationId }, 'Background agent loop failed');
    });

    return { messageId };
  }

  /**
   * Process a message from the HTTP runtime API (blocking).
   * Gets or creates a session and runs the full agent loop before returning.
   * Used by the channel inbound endpoint which needs the assistant reply.
   */
  async processMessage(
    conversationId: string,
    content: string,
    attachmentIds?: string[],
    options?: SessionCreateOptions,
    sourceChannel?: string,
  ): Promise<{ messageId: string }> {
    // Block inbound content that contains secrets — mirrors the IPC check in sessions.ts
    const ingressCheck = checkIngressForSecrets(content);
    if (ingressCheck.blocked) {
      throw new IngressBlockedError(ingressCheck.userNotice!, ingressCheck.detectedTypes);
    }

    const session = await this.getOrCreateSession(conversationId, undefined, true, options);

    if (session.isProcessing()) {
      throw new Error('Session is already processing a message');
    }

    session.setChannelCapabilities(resolveChannelCapabilities(sourceChannel));

    // Resolve attachment IDs to full attachment data for the session
    const attachments = attachmentIds
      ? attachmentsStore.getAttachmentsByIds('self', attachmentIds).map((a) => ({
          id: a.id,
          filename: a.originalFilename,
          mimeType: a.mimeType,
          data: a.dataBase64,
        }))
      : [];

    // Persist the user message first so that processing=true is set before
    // any async work.  This prevents two concurrent requests from both
    // passing the isProcessing() guard and racing through bridge handling.
    const requestId = crypto.randomUUID();
    const messageId = session.persistUserMessage(content, attachments, requestId);

    // Check the call-answer bridge before launching the agent loop.
    // The bridge check is in its own try/catch so that a bridge failure
    // (non-fatal) falls through to the agent loop, but post-bridge cleanup
    // errors propagate to the caller.
    let bridgeHandled = false;
    try {
      const bridgeResult = await tryHandlePendingCallAnswer(conversationId, content, messageId);
      bridgeHandled = bridgeResult.handled;
    } catch (err) {
      log.warn({ err, conversationId }, 'Call-answer bridge check failed (non-fatal), proceeding with agent loop');
    }

    if (bridgeHandled) {
      // The message was consumed by the call system. Release the
      // processing lock so the session can accept subsequent messages.
      resetSessionProcessingState(session);
      // Drain any queued messages that arrived while processing was true.
      session.drainQueue('loop_complete');
      log.info({ conversationId, messageId }, 'User message consumed by call-answer bridge, skipping agent loop');
      return { messageId };
    }

    // Run the agent loop directly — persistence already happened above.
    await session.runAgentLoop(content, messageId, () => {});

    return { messageId };
  }

  /**
   * Create a RunOrchestrator wired to this server's session management.
   */
  createRunOrchestrator(): RunOrchestrator {
    return new RunOrchestrator({
      getOrCreateSession: (conversationId) =>
        this.getOrCreateSession(conversationId),
      resolveAttachments: (attachmentIds) =>
        attachmentsStore.getAttachmentsByIds('self', attachmentIds).map((a) => ({
          id: a.id,
          filename: a.originalFilename,
          mimeType: a.mimeType,
          data: a.dataBase64,
        })),
    });
  }

}

/**
 * Reset the processing state set by `persistUserMessage` when the agent loop
 * is intentionally skipped (e.g. call-answer bridge consumed the message).
 */
function resetSessionProcessingState(session: Session): void {
  const s = session as unknown as {
    processing: boolean;
    abortController: AbortController | null;
    currentRequestId: string | undefined;
  };
  s.processing = false;
  s.abortController = null;
  s.currentRequestId = undefined;
}
