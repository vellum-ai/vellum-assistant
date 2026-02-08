import * as net from 'node:net';
import { unlinkSync, existsSync } from 'node:fs';
import { getSocketPath } from '../util/platform.js';
import { getLogger } from '../util/logger.js';
import { getProvider } from '../providers/registry.js';
import { getConfig } from '../config/loader.js';
import { DEFAULT_SYSTEM_PROMPT } from '../config/defaults.js';
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
  private socketPath: string;

  constructor() {
    this.socketPath = getSocketPath();
  }

  async start(): Promise<void> {
    // Clean up stale socket
    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (err) => {
        log.error({ err }, 'Server error');
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        log.info({ socketPath: this.socketPath }, 'Daemon server listening');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          if (existsSync(this.socketPath)) {
            unlinkSync(this.socketPath);
          }
          log.info('Daemon server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private handleConnection(socket: net.Socket): void {
    log.info('Client connected');
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
    if (!session) {
      const config = getConfig();
      const provider = getProvider(config.provider);
      const workingDir = process.cwd();

      session = new Session(
        conversationId,
        provider,
        config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        config.maxTokens,
        (msg: ServerMessage) => this.send(socket, msg),
        workingDir,
      );
      await session.loadFromDb();
      this.sessions.set(conversationId, session);
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
}
