import * as net from 'node:net';
import { unlinkSync, existsSync, chmodSync, watch, type FSWatcher } from 'node:fs';
import { getSocketPath, getDataDir } from '../util/platform.js';
import { getLogger } from '../util/logger.js';
import { getProvider, initializeProviders } from '../providers/registry.js';
import { RateLimitProvider } from '../providers/ratelimit.js';
import { getConfig, loadRawConfig, saveRawConfig, invalidateConfigCache } from '../config/loader.js';
import { DEFAULT_SYSTEM_PROMPT } from '../config/defaults.js';
import { clearCache as clearTrustCache } from '../permissions/trust-store.js';
import { resetAllowlist } from '../security/secret-allowlist.js';
import * as conversationStore from '../memory/conversation-store.js';
import { Session } from './session.js';
import {
  serialize,
  createMessageParser,
  type ClientMessage,
  type ServerMessage,
} from './ipc-protocol.js';

const log = getLogger('server');

export class DaemonServer {
  private server: net.Server | null = null;
  private sessions = new Map<string, Session>();
  private socketToSession = new Map<net.Socket, string>();
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
        log.error({ err }, 'Server error');
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        process.umask(oldUmask);
        // Replace the one-shot startup handler with a permanent one
        this.server!.removeAllListeners('error');
        this.server!.on('error', (err) => {
          log.error({ err }, 'Server error');
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
          log.error({ err }, 'Failed to reload config');
          return;
        }
        // Evict idle sessions; mark busy ones as stale
        for (const [id, session] of this.sessions) {
          if (!session.isProcessing()) {
            this.sessions.delete(id);
          } else {
            session.markStale();
          }
        }
      },
      'trust.json': () => {
        clearTrustCache();
      },
      'secret-allowlist.json': () => {
        resetAllowlist();
      },
    };

    try {
      const watcher = watch(dataDir, (_eventType, filename) => {
        if (!filename || !handlers[filename]) return;
        // Debounce: editors often write files in multiple steps
        const existing = this.debounceTimers.get(filename);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          this.debounceTimers.delete(filename);
          log.info({ file: filename }, 'File changed, reloading');
          handlers[filename]();
        }, 200);
        this.debounceTimers.set(filename, timer);
      });
      this.watchers.push(watcher);
      log.info({ dir: dataDir }, 'Watching data directory for config/trust changes');
    } catch (err) {
      log.warn({ err }, 'Failed to watch data directory');
    }
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

  private handleConnection(socket: net.Socket): void {
    log.info('Client connected');
    this.connectedSockets.add(socket);
    const parser = createMessageParser();

    // Send initial session info
    this.sendInitialSession(socket).catch((err) => {
      log.error({ err }, 'Failed to send initial session');
    });

    socket.on('data', (data) => {
      const messages = parser.feed(data.toString());
      for (const msg of messages) {
        this.handleMessage(msg as ClientMessage, socket);
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
      log.info('Client disconnected');
    });

    socket.on('error', (err) => {
      log.error({ err }, 'Socket error');
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

    await this.getOrCreateSession(conversation.id, socket);
    this.socketToSession.set(socket, conversation.id);
    this.send(socket, {
      type: 'session_info',
      sessionId: conversation.id,
      title: conversation.title ?? 'New Conversation',
    });
  }

  private async getOrCreateSession(conversationId: string, socket: net.Socket): Promise<Session> {
    let session = this.sessions.get(conversationId);
    const sendToClient = (msg: ServerMessage) => this.send(socket, msg);

    if (!session || (session.isStale() && !session.isProcessing())) {
      // Check if another caller is already creating this session.
      // Without this guard, two concurrent getOrCreateSession calls for the
      // same conversationId would both pass the null/stale check, both create
      // a Session + loadFromDb(), and the second set() would orphan the first.
      const pending = this.sessionCreating.get(conversationId);
      if (pending) {
        session = await pending;
        session.updateClient(sendToClient);
        session.setSandboxOverride(this.socketSandboxOverride.get(socket));
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
          config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
          config.maxTokens,
          sendToClient,
          workingDir,
        );
        await newSession.loadFromDb();
        newSession.setSandboxOverride(this.socketSandboxOverride.get(socket));
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
      // Rebind to the new socket so IPC goes to the current client
      session.updateClient(sendToClient);
      session.setSandboxOverride(this.socketSandboxOverride.get(socket));
    }
    return session;
  }

  private handleMessage(msg: ClientMessage, socket: net.Socket): void {
    switch (msg.type) {
      case 'user_message':
        this.handleUserMessage(msg.sessionId, msg.content, socket);
        break;
      case 'confirmation_response': {
        const sessionId = this.socketToSession.get(socket);
        if (sessionId) {
          const session = this.sessions.get(sessionId);
          if (session) {
            session.handleConfirmationResponse(
              msg.requestId,
              msg.decision as 'allow' | 'always_allow' | 'deny',
              msg.selectedPattern,
              msg.selectedScope,
            );
          }
        }
        break;
      }
      case 'session_list':
        this.handleSessionList(socket);
        break;
      case 'session_create':
        this.handleSessionCreate(msg.title, socket);
        break;
      case 'session_switch':
        this.handleSessionSwitch(msg.sessionId, socket);
        break;
      case 'cancel': {
        const cancelSessionId = this.socketToSession.get(socket);
        if (cancelSessionId) {
          const session = this.sessions.get(cancelSessionId);
          if (session) {
            session.abort();
          }
        }
        break;
      }
      case 'model_get':
        this.handleModelGet(socket);
        break;
      case 'model_set':
        this.handleModelSet(msg.model, socket);
        break;
      case 'history_request':
        this.handleHistoryRequest(msg.sessionId, socket);
        break;
      case 'undo':
        this.handleUndo(msg.sessionId, socket);
        break;
      case 'usage_request':
        this.handleUsageRequest(msg.sessionId, socket);
        break;
      case 'sandbox_set':
        this.handleSandboxSet(msg.enabled, socket);
        break;
      case 'ping':
        this.send(socket, { type: 'pong' });
        break;
    }
  }

  private async handleUserMessage(
    sessionId: string,
    content: string,
    socket: net.Socket,
  ): Promise<void> {
    try {
      this.socketToSession.set(socket, sessionId);
      const session = await this.getOrCreateSession(sessionId, socket);
      await session.processMessage(content, (event) => {
        this.send(socket, event);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, sessionId }, 'Error processing user message');
      this.send(socket, { type: 'error', message });
    }
  }

  private handleSessionList(socket: net.Socket): void {
    const conversations = conversationStore.listConversations(50);
    this.send(socket, {
      type: 'session_list_response',
      sessions: conversations.map((c) => ({
        id: c.id,
        title: c.title ?? 'Untitled',
        updatedAt: c.updatedAt,
      })),
    });
  }

  private async handleSessionCreate(
    title: string | undefined,
    socket: net.Socket,
  ): Promise<void> {
    const conversation = conversationStore.createConversation(
      title ?? 'New Conversation',
    );
    await this.getOrCreateSession(conversation.id, socket);
    this.send(socket, {
      type: 'session_info',
      sessionId: conversation.id,
      title: conversation.title ?? 'New Conversation',
    });
  }

  private async handleSessionSwitch(
    sessionId: string,
    socket: net.Socket,
  ): Promise<void> {
    const conversation = conversationStore.getConversation(sessionId);
    if (!conversation) {
      this.send(socket, { type: 'error', message: `Session ${sessionId} not found` });
      return;
    }
    this.socketToSession.set(socket, sessionId);
    await this.getOrCreateSession(sessionId, socket);
    this.send(socket, {
      type: 'session_info',
      sessionId: conversation.id,
      title: conversation.title ?? 'Untitled',
    });
  }

  private handleModelGet(socket: net.Socket): void {
    const config = getConfig();
    this.send(socket, {
      type: 'model_info',
      model: config.model,
      provider: config.provider,
    });
  }

  private handleModelSet(model: string, socket: net.Socket): void {
    try {
      // Use raw config to avoid persisting env-var API keys to disk
      const raw = loadRawConfig();
      raw.model = model;

      // Suppress the file watcher callback — handleModelSet already does
      // the full reload sequence; a redundant watcher-triggered reload
      // would incorrectly evict sessions created after this method returns.
      this.suppressConfigReload = true;
      try {
        saveRawConfig(raw);
      } catch (err) {
        this.suppressConfigReload = false;
        throw err;
      }
      const existingSuppressTimer = this.debounceTimers.get('__suppress_reset__');
      if (existingSuppressTimer) clearTimeout(existingSuppressTimer);
      const resetTimer = setTimeout(() => { this.suppressConfigReload = false; }, 300);
      this.debounceTimers.set('__suppress_reset__', resetTimer);

      // Re-initialize provider with the new model so LLM calls use it
      const config = getConfig();
      initializeProviders(config);

      // Evict idle sessions immediately; mark busy ones as stale so they
      // get recreated with the new provider once they finish processing.
      for (const [id, session] of this.sessions) {
        if (!session.isProcessing()) {
          this.sessions.delete(id);
        } else {
          session.markStale();
        }
      }

      this.send(socket, {
        type: 'model_info',
        model: config.model,
        provider: config.provider,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send(socket, { type: 'error', message: `Failed to set model: ${message}` });
    }
  }

  private handleSandboxSet(enabled: boolean, socket: net.Socket): void {
    // Per-socket override: store the sandbox preference for this client only.
    // The override is applied to the session so it doesn't affect other clients.
    this.socketSandboxOverride.set(socket, enabled);
    const sessionId = this.socketToSession.get(socket);
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.setSandboxOverride(enabled);
      }
    }
    log.info({ enabled }, 'Sandbox override applied (per-session)');
  }

  private handleHistoryRequest(sessionId: string, socket: net.Socket): void {
    const dbMessages = conversationStore.getMessages(sessionId);
    const historyMessages = dbMessages.map((m) => {
      let text = '';
      try {
        const content = JSON.parse(m.content);
        if (Array.isArray(content)) {
          text = content
            .filter((b: { type: string }) => b.type === 'text')
            .map((b: { text: string }) => b.text)
            .join('');
        } else {
          text = String(content);
        }
      } catch (err) {
        log.debug({ err, messageId: m.id }, 'Failed to parse message content as JSON, using raw text');
        text = m.content;
      }
      return { role: m.role, text, timestamp: m.createdAt };
    });
    this.send(socket, { type: 'history_response', messages: historyMessages });
  }

  private handleUndo(sessionId: string, socket: net.Socket): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.send(socket, { type: 'error', message: 'No active session' });
      return;
    }
    const removedCount = session.undo();
    this.send(socket, { type: 'undo_complete', removedCount });
  }

  private handleUsageRequest(sessionId: string, socket: net.Socket): void {
    const conversation = conversationStore.getConversation(sessionId);
    if (!conversation) {
      this.send(socket, { type: 'error', message: 'No active session' });
      return;
    }
    const config = getConfig();
    this.send(socket, {
      type: 'usage_response',
      totalInputTokens: conversation.totalInputTokens,
      totalOutputTokens: conversation.totalOutputTokens,
      estimatedCost: conversation.totalEstimatedCost,
      model: config.model,
    });
  }

}
