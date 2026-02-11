import * as net from 'node:net';
import { unlinkSync, existsSync, chmodSync, readdirSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { getSocketPath, getDataDir } from '../util/platform.js';
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
import { handleMessage, type HandlerContext } from './handlers.js';

const log = getLogger('server');

export class DaemonServer {
  private server: net.Server | null = null;
  private sessions = new Map<string, Session>();
  private socketToSession = new Map<net.Socket, string>();
  private cuSessions = new Map<string, ComputerUseSession>();
  private socketToCuSession = new Map<net.Socket, Set<string>>();
  private connectedSockets = new Set<net.Socket>();
  private socketSandboxOverride = new Map<net.Socket, boolean>();
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

  constructor() {
    this.socketPath = getSocketPath();
  }

  async start(): Promise<void> {
    // Clean up stale socket
    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }

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
          if (existsSync(this.socketPath)) {
            unlinkSync(this.socketPath);
          }
          resolve();
        });
      } else {
        resolve();
      }
    });

    // 2. Now abort sessions and destroy sockets. This lets server.close()
    //    finish promptly since all connections will be ended.
    for (const session of this.sessions.values()) {
      session.abort();
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

    await serverClosed;
    log.info('Daemon server stopped');
  }

  private startFileWatchers(): void {
    const dataDir = getDataDir();

    // Prompt/config changes should invalidate existing session prompts.
    const evictSessions = () => {
      for (const [id, session] of this.sessions) {
        if (!session.isProcessing()) {
          this.sessions.delete(id);
        } else {
          session.markStale();
        }
      }
    };

    // Watch the data directory instead of individual files so we detect:
    // - Files that don't exist yet at startup (new config/trust creation)
    // - Atomic rename writes (trust-store uses renameSync)
    const handlers: Record<string, () => void> = {
      'config.json': () => {
        if (this.suppressConfigReload) return;
        invalidateConfigCache();
        try {
          const config = getConfig();
          initializeProviders(config);
        } catch (err) {
          log.error({ err, configPath: join(getDataDir(), 'config.json') }, 'Failed to reload config after file change. Previous config remains active.');
          return;
        }
        evictSessions();
      },
      'trust.json': () => {
        clearTrustCache();
      },
      'secret-allowlist.json': () => {
        resetAllowlist();
      },
    };

    // Prompt files (SOUL.md, IDENTITY.md) affect the system prompt.
    // When they change, evict idle sessions so they pick up the new prompt.
    handlers['SOUL.md'] = evictSessions;
    handlers['IDENTITY.md'] = evictSessions;

    try {
      const watcher = watch(dataDir, (_eventType, filename) => {
        if (!filename) return;
        const file = String(filename);
        if (!handlers[file]) return;
        // Debounce: editors often write files in multiple steps
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
      log.info({ dir: dataDir }, 'Watching data directory for config/trust/prompt changes');
    } catch (err) {
      log.warn({ err, dir: dataDir }, 'Failed to watch data directory for config changes. Config/trust/prompt hot-reload will be unavailable.');
    }

    this.startSkillsWatchers(evictSessions);
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
    const skillsDir = join(getDataDir(), 'skills');
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
      let messages;
      try {
        messages = parser.feed(data.toString());
      } catch (err) {
        log.error({ err }, 'IPC parse error (malformed JSON or message exceeded size limit), dropping client');
        socket.write(serialize({ type: 'error', message: `IPC parse error: ${(err as Error).message}` }));
        socket.destroy();
        return;
      }
      for (const msg of messages) {
        this.dispatchMessage(msg as ClientMessage, socket);
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

    if (!session || (session.isStale() && !session.isProcessing())) {
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

      const createPromise = (async () => {
        const config = getConfig();
        let provider = getProvider(config.provider);
        const { rateLimit } = config;
        if (rateLimit.maxRequestsPerMinute > 0 || rateLimit.maxTokensPerSession > 0) {
          provider = new RateLimitProvider(provider, rateLimit, this.sharedRequestTimestamps);
        }
        const workingDir = process.cwd();

        const newSession = new Session(
          conversationId,
          provider,
          buildSystemPrompt(config.systemPrompt),
          config.maxTokens,
          rebindClient ? sendToClient : () => {},
          workingDir,
        );
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
      send: (socket, msg) => this.send(socket, msg),
      getOrCreateSession: (id, socket?, rebind?) =>
        this.getOrCreateSession(id, socket, rebind),
    };
  }

  private dispatchMessage(msg: ClientMessage, socket: net.Socket): void {
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
    options?: { userMessageAlreadyPersisted?: boolean },
  ): Promise<{ messageId: string }> {
    const session = await this.getOrCreateSession(conversationId);

    if (session.isProcessing()) {
      throw new Error('Session is already processing a message');
    }

    // Resolve attachment IDs to full attachment data for the session
    const attachments = attachmentIds
      ? attachmentsStore.getAttachmentsByIds(assistantId, attachmentIds).map((a) => ({
          id: a.id,
          filename: a.originalFilename,
          mimeType: a.mimeType,
          data: a.dataBase64,
        }))
      : [];

    const messageId = await session.processMessage(content, attachments, () => {}, crypto.randomUUID(), options);

    if (!messageId) {
      throw new Error('Failed to persist user message');
    }

    return { messageId };
  }

}
