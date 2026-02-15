import * as net from 'node:net';
import { existsSync, chmodSync, readdirSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { getSocketPath, getRootDir, getSandboxWorkingDir, removeSocketFile } from '../util/platform.js';
import { getLogger } from '../util/logger.js';
import { getProvider, initializeProviders } from '../providers/registry.js';
import { RateLimitProvider } from '../providers/ratelimit.js';
import { getConfig, invalidateConfigCache } from '../config/loader.js';
import { buildSystemPrompt } from '../config/system-prompt.js';
import { clearCache as clearTrustCache } from '../permissions/trust-store.js';
import { resetAllowlist } from '../security/secret-allowlist.js';
import * as conversationStore from '../memory/conversation-store.js';
import * as attachmentsStore from '../memory/attachments-store.js';
import { Session } from './session.js';
import { ComputerUseSession } from './computer-use-session.js';
import {
  serialize,
  createMessageParser,
  MAX_LINE_SIZE,
  type ClientMessage,
  type ServerMessage,
} from './ipc-protocol.js';
import { validateClientMessage } from './ipc-validate.js';
import { handleMessage, type HandlerContext, type SessionCreateOptions } from './handlers.js';
import { RunOrchestrator } from '../runtime/run-orchestrator.js';

const log = getLogger('server');

export class DaemonServer {
  private server: net.Server | null = null;
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
  private watchers: FSWatcher[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private suppressConfigReload = false;
  private lastConfigFingerprint = '';
  private lastConfigRefreshTime = 0;
  private static readonly CONFIG_REFRESH_INTERVAL_MS = 30_000;

  constructor() {
    this.socketPath = getSocketPath();
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

    this.startFileWatchers();

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
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.stopFileWatchers();

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

    await serverClosed;
    log.info('Daemon server stopped');
  }

  private startFileWatchers(): void {
    const rootDir = getRootDir();
    const protectedDir = join(rootDir, 'protected');

    // Watch root directory for config + prompt files
    const rootHandlers: Record<string, () => void> = {
      'config.json': () => {
        if (this.suppressConfigReload) return;
        try {
          this.refreshConfigFromSources();
        } catch (err) {
          log.error({ err, configPath: join(rootDir, 'config.json') }, 'Failed to reload config after file change. Previous config remains active.');
          return;
        }
      },
      'SOUL.md': () => this.evictSessionsForReload(),
      'IDENTITY.md': () => this.evictSessionsForReload(),
      'USER.md': () => this.evictSessionsForReload(),
    };

    // Watch protected/ for trust rules and secret allowlist
    const protectedHandlers: Record<string, () => void> = {
      'trust.json': () => {
        clearTrustCache();
      },
      'secret-allowlist.json': () => {
        resetAllowlist();
      },
    };

    const watchDir = (dir: string, handlers: Record<string, () => void>, label: string): void => {
      try {
        const watcher = watch(dir, (_eventType, filename) => {
          if (!filename) return;
          const file = String(filename);
          if (!handlers[file]) return;
          const existing = this.debounceTimers.get(file);
          if (existing) clearTimeout(existing);
          const timer = setTimeout(() => {
            this.debounceTimers.delete(file);
            log.info({ file }, 'File changed, reloading');
            handlers[file]();
          }, 200);
          this.debounceTimers.set(file, timer);
        });
        this.watchers.push(watcher);
        log.info({ dir }, `Watching ${label}`);
      } catch (err) {
        log.warn({ err, dir }, `Failed to watch ${label}. Hot-reload will be unavailable.`);
      }
    };

    watchDir(rootDir, rootHandlers, 'root directory for config/prompt changes');
    if (existsSync(protectedDir)) {
      watchDir(protectedDir, protectedHandlers, 'protected directory for trust/allowlist changes');
    }

    this.startSkillsWatchers(() => this.evictSessionsForReload());
  }

  private configFingerprint(config: ReturnType<typeof getConfig>): string {
    return JSON.stringify({
      provider: config.provider,
      model: config.model,
      maxTokens: config.maxTokens,
      rateLimit: config.rateLimit,
      thinking: config.thinking,
      contextWindow: config.contextWindow,
      apiKeys: config.apiKeys,
    });
  }

  /**
   * Dispose and remove all in-memory sessions unconditionally.
   * Called after `sessions clear` wipes the database so that stale
   * sessions don't reference deleted conversation rows.
   */
  clearAllSessions(): number {
    const count = this.sessions.size;
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.sessionOptions.clear();
    return count;
  }

  private evictSessionsForReload(): void {
    for (const [id, session] of this.sessions) {
      if (!session.isProcessing()) {
        session.dispose();
        this.sessions.delete(id);
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

  private startSkillsWatchers(evictSessions: () => void): void {
    const skillsDir = join(getRootDir(), 'skills');
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
    log.info('Client connected');
    this.connectedSockets.add(socket);
    const parser = createMessageParser({ maxLineSize: MAX_LINE_SIZE });

    // Send initial session info
    this.sendInitialSession(socket).catch((err) => {
      log.error({ err }, 'Failed to send initial session info to client on connect');
    });

    socket.on('data', (data) => {
      const chunkReceivedAtMs = Date.now();
      const parseStartNs = process.hrtime.bigint();
      let messages;
      try {
        messages = parser.feed(data.toString());
      } catch (err) {
        log.error({ err }, 'IPC parse error (malformed JSON or message exceeded size limit), dropping client');
        socket.write(serialize({ type: 'error', message: `IPC parse error: ${(err as Error).message}` }));
        socket.destroy();
        return;
      }
      const parsedAtMs = Date.now();
      const parseDurationMs = Number(process.hrtime.bigint() - parseStartNs) / 1_000_000;
      for (const msg of messages) {
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
            payloadJsonBytes: Buffer.byteLength(JSON.stringify(msg), 'utf8'),
          }, 'IPC_METRIC cu_observation_parse');
        }
        const result = validateClientMessage(msg);
        if (!result.valid) {
          log.warn({ reason: result.reason }, 'Invalid IPC message, dropping client');
          socket.write(serialize({ type: 'error', message: `Invalid message: ${result.reason}` }));
          socket.destroy();
          return;
        }
        this.dispatchMessage(result.message, socket);
      }
    });

    socket.on('close', () => {
      this.connectedSockets.delete(socket);
      this.socketSandboxOverride.delete(socket);
      const sessionId = this.socketToSession.get(socket);
      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
          session.abort();
        }
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

  private send(socket: net.Socket, msg: ServerMessage): void {
    if (!socket.destroyed) {
      socket.write(serialize(msg));
    }
  }

  private broadcast(msg: ServerMessage): void {
    for (const socket of this.connectedSockets) {
      this.send(socket, msg);
    }
  }

  private async sendInitialSession(socket: net.Socket): Promise<void> {
    // Get or create a session
    let conversation = conversationStore.getLatestConversation();
    if (!conversation) {
      conversation = conversationStore.createConversation('New Conversation');
    }

    // Warm session state for commands like undo/usage after reconnect without
    // rebinding the active IPC output client to this passive socket.
    await this.getOrCreateSession(conversation.id, undefined, false);

    this.send(socket, {
      type: 'session_info',
      sessionId: conversation.id,
      title: conversation.title ?? 'New Conversation',
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
    };

    // Persist session options so they survive eviction/recreation.
    if (options && (options.systemPromptOverride || options.maxResponseTokens)) {
      this.sessionOptions.set(conversationId, {
        ...this.sessionOptions.get(conversationId),
        ...options,
      });
    }

    if (!session || (session.isStale() && !session.isProcessing())) {
      // Dispose the outgoing stale session before replacing it.
      if (session) {
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
        let provider = getProvider(config.provider);
        const { rateLimit } = config;
        if (rateLimit.maxRequestsPerMinute > 0 || rateLimit.maxTokensPerSession > 0) {
          provider = new RateLimitProvider(provider, rateLimit, this.sharedRequestTimestamps);
        }
        const workingDir = getSandboxWorkingDir();

        const systemPrompt = storedOptions?.systemPromptOverride ?? buildSystemPrompt();
        const maxTokens = storedOptions?.maxResponseTokens ?? config.maxTokens;

        const newSession = new Session(
          conversationId,
          provider,
          systemPrompt,
          maxTokens,
          rebindClient ? sendToClient : () => {},
          workingDir,
        );
        // When created without a socket (HTTP path), mark the session
        // so interactive prompts (e.g. host attachment reads) can fail
        // fast instead of waiting for a timeout with no client to respond.
        if (!socket) {
          newSession.updateClient(sendToClient, true);
        }
        await newSession.loadFromDb();
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
    } else {
      // Rebind to the new socket so IPC goes to the current client.
      maybeBindClient(session);
    }
    return session;
  }

  private handlerContext(): HandlerContext {
    return {
      sessions: this.sessions,
      socketToSession: this.socketToSession,
      cuSessions: this.cuSessions,
      socketToCuSession: this.socketToCuSession,
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
    assistantId: string,
    conversationId: string,
    content: string,
    attachmentIds?: string[],
  ): Promise<{ messageId: string }> {
    const session = await this.getOrCreateSession(conversationId);

    // Reject concurrent requests upfront. The HTTP path should never use
    // the message queue — it returns 409 to the caller instead.
    if (session.isProcessing()) {
      throw new Error('Session is already processing a message');
    }

    // Set assistantId AFTER the isProcessing check so a rejected request
    // doesn't mutate the session state visible to an in-flight request.
    session.setAssistantId(assistantId);

    // Resolve attachment IDs to full attachment data for the session
    const attachments = attachmentIds
      ? attachmentsStore.getAttachmentsByIds(assistantId, attachmentIds).map((a) => ({
          id: a.id,
          filename: a.originalFilename,
          mimeType: a.mimeType,
          data: a.dataBase64,
        }))
      : [];

    // persistUserMessage throws if the session is busy or persistence fails
    const requestId = crypto.randomUUID();
    const messageId = session.persistUserMessage(content, attachments, requestId);

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
    assistantId: string,
    conversationId: string,
    content: string,
    attachmentIds?: string[],
  ): Promise<{ messageId: string }> {
    const session = await this.getOrCreateSession(conversationId);

    if (session.isProcessing()) {
      throw new Error('Session is already processing a message');
    }

    // Set assistantId AFTER the isProcessing check so a rejected request
    // doesn't mutate the session state visible to an in-flight request.
    session.setAssistantId(assistantId);

    // Resolve attachment IDs to full attachment data for the session
    const attachments = attachmentIds
      ? attachmentsStore.getAttachmentsByIds(assistantId, attachmentIds).map((a) => ({
          id: a.id,
          filename: a.originalFilename,
          mimeType: a.mimeType,
          data: a.dataBase64,
        }))
      : [];

    const messageId = await session.processMessage(content, attachments, () => {}, crypto.randomUUID());

    if (!messageId) {
      throw new Error('Failed to persist user message');
    }

    return { messageId };
  }

  /**
   * Create a RunOrchestrator wired to this server's session management.
   */
  createRunOrchestrator(): RunOrchestrator {
    return new RunOrchestrator({
      getOrCreateSession: (conversationId) =>
        this.getOrCreateSession(conversationId),
      resolveAttachments: (assistantId, attachmentIds) =>
        attachmentsStore.getAttachmentsByIds(assistantId, attachmentIds).map((a) => ({
          id: a.id,
          filename: a.originalFilename,
          mimeType: a.mimeType,
          data: a.dataBase64,
        })),
    });
  }

}
