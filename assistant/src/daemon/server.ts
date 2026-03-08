import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import * as tls from "node:tls";

import {
  createAssistantMessage,
  createUserMessage,
} from "../agent/message-types.js";
import {
  type ChannelId,
  type InterfaceId,
  parseChannelId,
  parseInterfaceId,
} from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import { onContactChange } from "../contacts/contact-events.js";
import type { HeartbeatService } from "../heartbeat/heartbeat-service.js";
import { bootstrapHomeBaseAppLink } from "../home-base/bootstrap.js";
import * as attachmentsStore from "../memory/attachments-store.js";
import {
  createCanonicalGuardianRequest,
  generateCanonicalRequestCode,
} from "../memory/canonical-guardian-store.js";
import {
  addMessage,
  getConversationMemoryScopeId,
  getConversationThreadType,
  provenanceFromTrustContext,
  setConversationOriginChannelIfUnset,
  setConversationOriginInterfaceIfUnset,
} from "../memory/conversation-crud.js";
import { getLatestConversation } from "../memory/conversation-queries.js";
import { buildSystemPrompt } from "../prompts/system-prompt.js";
import { RateLimitProvider } from "../providers/ratelimit.js";
import {
  getFailoverProvider,
  initializeProviders,
} from "../providers/registry.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { bridgeConfirmationRequestToGuardian } from "../runtime/confirmation-request-guardian-bridge.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { checkIngressForSecrets } from "../security/secret-ingress.js";
import { getSubagentManager } from "../subagent/index.js";
import { IngressBlockedError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import { getLocalIPv4 } from "../util/network-info.js";
import {
  getSandboxWorkingDir,
  getSocketPath,
  getTCPHost,
  getTCPPort,
  getWorkspacePromptPath,
  isIOSPairingEnabled,
  isTCPEnabled,
  removeSocketFile,
} from "../util/platform.js";
import { registerDaemonCallbacks } from "../work-items/work-item-runner.js";
import { AuthManager } from "./auth-manager.js";
import { ComputerUseSession } from "./computer-use-session.js";
import { ConfigWatcher } from "./config-watcher.js";
import { parseIdentityFields } from "./handlers/identity.js";
import { handleMessage } from "./handlers/index.js";
import { cleanupRecordingsOnDisconnect } from "./handlers/recording.js";
import type {
  HandlerContext,
  SessionCreateOptions,
} from "./handlers/shared.js";
import { ensureBlobDir, sweepStaleBlobs } from "./ipc-blob-store.js";
import { IpcSender } from "./ipc-handler.js";
import {
  createMessageParser,
  MAX_LINE_SIZE,
  normalizeThreadType,
  serialize,
  type ServerMessage,
} from "./ipc-protocol.js";
import { validateClientMessage } from "./ipc-validate.js";
import {
  DEFAULT_MEMORY_POLICY,
  Session,
  type SessionMemoryPolicy,
} from "./session.js";
import { SessionEvictor } from "./session-evictor.js";
import { resolveChannelCapabilities } from "./session-runtime-assembly.js";
import { resolveSlash } from "./session-slash.js";
import { ensureTlsCert } from "./tls-certs.js";

const log = getLogger("server");

function readPackageVersion(): string | undefined {
  try {
    const pkgPath = join(import.meta.dir, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      version?: string;
    };
    return pkg.version;
  } catch {
    return undefined;
  }
}

const daemonVersion = readPackageVersion();

function resolveTurnChannel(
  sourceChannel?: string,
  transportChannelId?: string,
): ChannelId {
  if (sourceChannel != null) {
    const parsed = parseChannelId(sourceChannel);
    if (!parsed) {
      throw new Error(`Invalid sourceChannel: ${sourceChannel}`);
    }
    return parsed;
  }
  if (transportChannelId != null) {
    const parsed = parseChannelId(transportChannelId);
    if (!parsed) {
      throw new Error(`Invalid transport.channelId: ${transportChannelId}`);
    }
    return parsed;
  }
  return "vellum";
}

function resolveTurnInterface(sourceInterface?: string): InterfaceId {
  if (sourceInterface != null) {
    const parsed = parseInterfaceId(sourceInterface);
    if (!parsed) {
      throw new Error(`Invalid sourceInterface: ${sourceInterface}`);
    }
    return parsed;
  }
  // Interface and channel are orthogonal dimensions; default explicitly
  // instead of deriving interface from channel.
  return "vellum";
}

function resolveCanonicalRequestSourceType(
  sourceChannel: string | undefined,
): "desktop" | "channel" | "voice" {
  if (sourceChannel === "phone") {
    return "voice";
  }
  if (sourceChannel === "vellum") {
    return "desktop";
  }
  return "channel";
}

/**
 * Build an onEvent callback that registers pending interactions when the agent
 * loop emits confirmation_request or secret_request events. This ensures that
 * channel approval interception can look up the session by requestId.
 */
function makePendingInteractionRegistrar(
  session: Session,
  conversationId: string,
): (msg: ServerMessage) => void {
  return (msg: ServerMessage) => {
    if (msg.type === "confirmation_request") {
      pendingInteractions.register(msg.requestId, {
        session,
        conversationId,
        kind: "confirmation",
        confirmationDetails: {
          toolName: msg.toolName,
          input: msg.input,
          riskLevel: msg.riskLevel,
          executionTarget: msg.executionTarget,
          allowlistOptions: msg.allowlistOptions,
          scopeOptions: msg.scopeOptions,
          persistentDecisionsAllowed: msg.persistentDecisionsAllowed,
          temporaryOptionsAvailable: msg.temporaryOptionsAvailable,
        },
      });

      // Create a canonical guardian request so IPC/HTTP handlers can find it
      // via applyCanonicalGuardianDecision.
      try {
        const trustContext = session.trustContext;
        const sourceChannel = trustContext?.sourceChannel ?? "vellum";
        const canonicalRequest = createCanonicalGuardianRequest({
          id: msg.requestId,
          kind: "tool_approval",
          sourceType: resolveCanonicalRequestSourceType(sourceChannel),
          sourceChannel,
          conversationId,
          requesterExternalUserId: trustContext?.requesterExternalUserId,
          requesterChatId: trustContext?.requesterChatId,
          guardianExternalUserId: trustContext?.guardianExternalUserId,
          guardianPrincipalId: trustContext?.guardianPrincipalId ?? undefined,
          toolName: msg.toolName,
          status: "pending",
          requestCode: generateCanonicalRequestCode(),
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });

        // For trusted-contact sessions, bridge to guardian.question so the
        // guardian gets notified and can approve via callback/request-code.
        if (trustContext) {
          bridgeConfirmationRequestToGuardian({
            canonicalRequest,
            trustContext,
            conversationId,
            toolName: msg.toolName,
            assistantId: session.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
          });
        }
      } catch (err) {
        log.debug(
          { err, requestId: msg.requestId, conversationId },
          "Failed to create canonical request from pending interaction registrar",
        );
      }
    } else if (msg.type === "secret_request") {
      pendingInteractions.register(msg.requestId, {
        session,
        conversationId,
        kind: "secret",
      });
    }
  };
}

export class DaemonServer {
  private server: net.Server | null = null;
  private tcpServer: tls.Server | null = null;
  private sessions = new Map<string, Session>();
  private socketToSession = new Map<net.Socket, string>();
  private cuSessions = new Map<string, ComputerUseSession>();
  private socketToCuSession = new Map<net.Socket, Set<string>>();
  private connectedSockets = new Set<net.Socket>();
  private socketSandboxOverride = new Map<net.Socket, boolean>();
  private cuObservationParseSequence = new Map<string, number>();
  private sessionOptions = new Map<string, SessionCreateOptions>();
  private sessionCreating = new Map<string, Promise<Session>>();
  private sharedRequestTimestamps: number[] = [];
  private socketPath: string;
  private httpPort: number | undefined;
  private blobSweepTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeContactChange: (() => void) | null = null;
  private static readonly MAX_CONNECTIONS = 50;
  private evictor: SessionEvictor;

  // Composed subsystems
  private auth = new AuthManager();
  private configWatcher = new ConfigWatcher();
  private ipc = new IpcSender();

  /**
   * Logical assistant identifier used when publishing to the assistant-events hub.
   */
  assistantId: string = "default";

  /** Optional heartbeat service reference for "Run Now" from the UI. */
  private _heartbeatService?: HeartbeatService;

  setHeartbeatService(service: HeartbeatService): void {
    this._heartbeatService = service;
  }

  private deriveMemoryPolicy(conversationId: string): SessionMemoryPolicy {
    const threadType = getConversationThreadType(conversationId);
    if (threadType === "private") {
      return {
        scopeId: getConversationMemoryScopeId(conversationId),
        includeDefaultFallback: true,
        strictSideEffects: true,
      };
    }
    return DEFAULT_MEMORY_POLICY;
  }

  private applyTransportMetadata(
    _session: Session,
    options: SessionCreateOptions | undefined,
  ): void {
    const transport = options?.transport;
    if (!transport) return;
    log.debug(
      { channelId: transport.channelId },
      "Transport metadata received",
    );
  }

  constructor() {
    this.socketPath = getSocketPath();
    this.evictor = new SessionEvictor(this.sessions);
    getSubagentManager().sharedRequestTimestamps = this.sharedRequestTimestamps;
    this.evictor.onEvict = (sessionId: string) => {
      getSubagentManager().abortAllForParent(sessionId);
    };
    this.evictor.shouldProtect = (sessionId: string) => {
      const children = getSubagentManager().getChildrenOf(sessionId);
      return children.some(
        (c) => c.status === "running" || c.status === "pending",
      );
    };
    getSubagentManager().onSubagentFinished = async (
      parentSessionId,
      message,
      sendToClient,
      notification,
    ) => {
      const parentSession = this.sessions.get(parentSessionId);
      if (!parentSession) {
        log.warn(
          { parentSessionId },
          "Subagent finished but parent session not found",
        );
        return;
      }
      const requestId = `subagent-notify-${Date.now()}`;
      const metadata = { subagentNotification: notification };
      const enqueueResult = parentSession.enqueueMessage(
        message,
        [],
        sendToClient,
        requestId,
        undefined,
        undefined,
        metadata,
      );
      if (enqueueResult.rejected) {
        log.warn(
          { parentSessionId },
          "Parent session queue full, dropping subagent notification",
        );
        return;
      }
      if (!enqueueResult.queued) {
        const messageId = await parentSession.persistUserMessage(
          message,
          [],
          undefined,
          metadata,
        );
        parentSession
          .runAgentLoop(message, messageId, sendToClient)
          .catch((err) => {
            log.error(
              { parentSessionId, err },
              "Failed to process subagent notification in parent",
            );
          });
      }
    };
  }

  // ── Send / Broadcast wrappers ───────────────────────────────────────

  private send(socket: net.Socket, msg: ServerMessage): void {
    this.ipc.send(socket, msg, this.socketToSession, this.assistantId);
  }

  broadcast(msg: ServerMessage, excludeSocket?: net.Socket): void {
    this.ipc.broadcast(
      this.auth.getAuthenticatedSockets(),
      msg,
      this.socketToSession,
      this.assistantId,
      excludeSocket,
    );
  }

  private broadcastIdentityChanged(): void {
    try {
      const identityPath = getWorkspacePromptPath("IDENTITY.md");
      const content = existsSync(identityPath)
        ? readFileSync(identityPath, "utf-8")
        : "";
      const fields = parseIdentityFields(content);
      this.broadcast({
        type: "identity_changed",
        name: fields.name,
        role: fields.role,
        personality: fields.personality,
        emoji: fields.emoji,
        home: fields.home,
      });
    } catch (err) {
      log.error({ err }, "Failed to broadcast identity change");
    }
  }

  // ── Server lifecycle ────────────────────────────────────────────────

  async start(): Promise<void> {
    removeSocketFile(this.socketPath);

    const config = getConfig();
    initializeProviders(config);
    this.configWatcher.initFingerprint(config);

    try {
      bootstrapHomeBaseAppLink();
    } catch (err) {
      log.warn(
        { err },
        "Failed to bootstrap Home Base app link at daemon startup",
      );
    }

    this.evictor.start();

    registerDaemonCallbacks({
      getOrCreateSession: (conversationId) =>
        this.getOrCreateSession(conversationId),
      broadcast: (msg) => this.broadcast(msg),
    });

    ensureBlobDir();
    this.blobSweepTimer = setInterval(
      () => {
        sweepStaleBlobs(30 * 60 * 1000).catch((err) => {
          log.warn({ err }, "Blob sweep failed");
        });
      },
      5 * 60 * 1000,
    );

    this.configWatcher.start(
      () => this.evictSessionsForReload(),
      () => this.broadcastIdentityChanged(),
    );

    // Broadcast contacts_changed to all clients when any contact mutation occurs.
    this.unsubscribeContactChange = onContactChange(() => {
      this.broadcast({ type: "contacts_changed" });
    });

    this.auth.initToken();

    let tlsCreds: { cert: string; key: string; fingerprint: string } | null =
      null;
    if (isTCPEnabled()) {
      try {
        tlsCreds = await ensureTlsCert();
      } catch (err) {
        log.error(
          { err },
          "Failed to generate TLS certificate — TCP listener will not start",
        );
      }
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      const oldUmask = process.umask(0o177);

      this.server.once("error", (err) => {
        process.umask(oldUmask);
        log.error(
          { err, socketPath: this.socketPath },
          "Server failed to start (is another daemon already running?)",
        );
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        process.umask(oldUmask);
        this.server!.removeAllListeners("error");
        this.server!.on("error", (err) => {
          log.error(
            { err, socketPath: this.socketPath },
            "Server socket error while running",
          );
        });
        chmodSync(this.socketPath, 0o600);
        // Validate the chmod actually took effect — some filesystems
        // (e.g. FAT32 mounts, container overlays) silently ignore chmod.
        const socketStat = statSync(this.socketPath);
        if ((socketStat.mode & 0o077) !== 0) {
          const actual = "0o" + (socketStat.mode & 0o777).toString(8);
          log.error(
            { socketPath: this.socketPath, mode: actual },
            "IPC socket is accessible by other users (expected 0600) — filesystem may not support Unix permissions",
          );
        }
        log.info({ socketPath: this.socketPath }, "Daemon server listening");

        if (tlsCreds) {
          const tcpPort = getTCPPort();
          const tcpHost = getTCPHost();
          this.tcpServer = tls.createServer(
            { cert: tlsCreds.cert, key: tlsCreds.key },
            (socket) => {
              this.handleConnection(socket);
            },
          );
          this.tcpServer.on("error", (err) => {
            log.error({ err, tcpPort }, "TLS TCP server error");
          });
          const fingerprint = tlsCreds.fingerprint;
          this.tcpServer.listen(tcpPort, tcpHost, () => {
            const localIP = getLocalIPv4();
            log.info(
              {
                tcpPort,
                tcpHost,
                fingerprint,
                localIP,
                iosPairing: isIOSPairingEnabled(),
              },
              "TLS TCP listener started",
            );
            if (isIOSPairingEnabled() && localIP) {
              log.warn(
                { localIP, tcpPort },
                "iOS pairing enabled — daemon is reachable on the local network at %s:%d",
                localIP,
                tcpPort,
              );
            }
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
    this.configWatcher.stop();
    if (this.unsubscribeContactChange) {
      this.unsubscribeContactChange();
      this.unsubscribeContactChange = null;
    }
    this.auth.cleanupAll();

    const serverClosed = new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => {
          try {
            removeSocketFile(this.socketPath);
          } catch (err) {
            log.warn(
              { err, socketPath: this.socketPath },
              "Failed to remove socket file during shutdown",
            );
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
    log.info("Daemon server stopped");
  }

  // ── Connection handling ─────────────────────────────────────────────

  private handleConnection(socket: net.Socket): void {
    if (this.connectedSockets.size >= DaemonServer.MAX_CONNECTIONS) {
      log.warn(
        {
          current: this.connectedSockets.size,
          max: DaemonServer.MAX_CONNECTIONS,
        },
        "Connection limit reached, rejecting client",
      );
      socket.once("error", (err) => {
        log.error({ err }, "Socket error while rejecting connection");
      });
      socket.write(
        serialize({
          type: "error",
          message: `Connection limit reached (max ${DaemonServer.MAX_CONNECTIONS})`,
        }),
      );
      socket.destroy();
      return;
    }

    log.info("Client connected");
    this.connectedSockets.add(socket);
    const parser = createMessageParser({ maxLineSize: MAX_LINE_SIZE });

    if (this.auth.shouldAutoAuth()) {
      this.auth.markAuthenticated(socket);
      log.warn(
        "Auto-authenticated client (VELLUM_DAEMON_NOAUTH is set — token auth bypassed)",
      );
      this.send(socket, { type: "auth_result", success: true });
      this.sendInitialSession(socket).catch((err) => {
        log.error(
          { err },
          "Failed to send initial session info after auto-auth",
        );
      });
    }

    this.auth.startTimeout(socket, () => {
      this.send(socket, { type: "error", message: "Authentication timeout" });
      socket.destroy();
    });

    socket.on("data", (data) => {
      const chunkReceivedAtMs = Date.now();
      const parseStartNs = process.hrtime.bigint();
      let parsed;
      try {
        parsed = parser.feedRaw(data.toString());
      } catch (err) {
        log.error(
          { err },
          "IPC parse error (malformed JSON or message exceeded size limit), dropping client",
        );
        socket.write(
          serialize({
            type: "error",
            message: `IPC parse error: ${(err as Error).message}`,
          }),
        );
        socket.destroy();
        return;
      }
      const parsedAtMs = Date.now();
      const parseDurationMs =
        Number(process.hrtime.bigint() - parseStartNs) / 1_000_000;
      for (const entry of parsed) {
        const msg = entry.msg;
        if (
          typeof msg === "object" &&
          msg != null &&
          (msg as { type?: unknown }).type === "cu_observation"
        ) {
          const maybeSessionId = (msg as { sessionId?: unknown }).sessionId;
          const sessionId =
            typeof maybeSessionId === "string" ? maybeSessionId : "unknown";
          const previousSequence =
            this.cuObservationParseSequence.get(sessionId) ?? 0;
          const sequence = previousSequence + 1;
          this.cuObservationParseSequence.set(sessionId, sequence);
          log.info(
            {
              sessionId,
              sequence,
              chunkReceivedAtMs,
              parsedAtMs,
              parseDurationMs,
              messageBytes: entry.rawByteLength,
            },
            "IPC_METRIC cu_observation_parse",
          );
        }
        const result = validateClientMessage(msg);
        if (!result.valid) {
          log.warn(
            { reason: result.reason },
            "Invalid IPC message, dropping client",
          );
          socket.write(
            serialize({
              type: "error",
              message: `Invalid message: ${result.reason}`,
            }),
          );
          socket.destroy();
          return;
        }

        // Auth gate
        if (!this.auth.isAuthenticated(socket)) {
          this.auth.clearTimeout(socket);

          if (result.message.type === "auth") {
            const authMsg = result.message as { type: "auth"; token: string };
            if (this.auth.authenticate(socket, authMsg.token)) {
              this.send(socket, { type: "auth_result", success: true });
              this.sendInitialSession(socket).catch((err) => {
                log.error(
                  { err },
                  "Failed to send initial session info after auth",
                );
              });
            } else {
              this.send(socket, {
                type: "auth_result",
                success: false,
                message: "Invalid token",
              });
              socket.destroy();
            }
            continue;
          }

          log.warn(
            { type: result.message.type },
            "Unauthenticated client sent non-auth message, disconnecting",
          );
          this.send(socket, {
            type: "error",
            message: "Authentication required",
          });
          socket.destroy();
          return;
        }

        // Already-authenticated socket sending auth (e.g. auto-auth'd + local token)
        if (result.message.type === "auth") {
          this.send(socket, { type: "auth_result", success: true });
          continue;
        }

        this.dispatchMessage(result.message, socket);
      }
    });

    socket.on("close", () => {
      this.auth.cleanupSocket(socket);
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
      // Clean up recording state for recordings whose owning conversation is
      // bound to the disconnecting socket. Runs outside the sessionId check
      // because recordings may be keyed to a different conversation than the
      // socket's current session.
      cleanupRecordingsOnDisconnect(socket, (convId) => {
        for (const [s, sid] of this.socketToSession.entries()) {
          if (sid === convId) return s;
        }
        return undefined;
      });
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
      log.info("Client disconnected");
    });

    socket.on("error", (err) => {
      log.error(
        { err, remoteAddress: socket.remoteAddress },
        "Client socket error",
      );
    });
  }

  // ── Session management ──────────────────────────────────────────────

  setHttpPort(port: number): void {
    this.httpPort = port;
    this.broadcast({
      type: "daemon_status",
      httpPort: port,
      version: daemonVersion,
    });
  }

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

  get lastConfigFingerprint(): string {
    return this.configWatcher.lastFingerprint;
  }

  set lastConfigFingerprint(value: string) {
    this.configWatcher.lastFingerprint = value;
  }

  refreshConfigFromSources(): boolean {
    const changed = this.configWatcher.refreshConfigFromSources();
    if (changed) this.evictSessionsForReload();
    return changed;
  }

  private async sendInitialSession(socket: net.Socket): Promise<void> {
    const conversation = getLatestConversation();
    if (!conversation) {
      this.send(socket, {
        type: "daemon_status",
        httpPort: this.httpPort,
        version: daemonVersion,
      });
      return;
    }

    await this.getOrCreateSession(conversation.id, undefined, false);

    this.send(socket, {
      type: "session_info",
      sessionId: conversation.id,
      title: conversation.title ?? "New Conversation",
      threadType: normalizeThreadType(conversation.threadType),
    });

    this.send(socket, {
      type: "daemon_status",
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
      getSubagentManager().updateParentSender(conversationId, sendToClient);
    };

    if (options && Object.values(options).some((v) => v !== undefined)) {
      this.sessionOptions.set(conversationId, {
        ...this.sessionOptions.get(conversationId),
        ...options,
      });
    }

    if (!session || (session.isStale() && !session.isProcessing())) {
      if (session) {
        getSubagentManager().abortAllForParent(conversationId);
        session.dispose();
      }

      const pending = this.sessionCreating.get(conversationId);
      if (pending) {
        session = await pending;
        maybeBindClient(session);
        return session;
      }

      const storedOptions = this.sessionOptions.get(conversationId);

      const createPromise = (async () => {
        const config = getConfig();
        let provider = getFailoverProvider(
          config.provider,
          config.providerOrder,
        );
        const { rateLimit } = config;
        if (
          rateLimit.maxRequestsPerMinute > 0 ||
          rateLimit.maxTokensPerSession > 0
        ) {
          provider = new RateLimitProvider(
            provider,
            rateLimit,
            this.sharedRequestTimestamps,
          );
        }
        const workingDir = getSandboxWorkingDir();

        const systemPrompt =
          storedOptions?.systemPromptOverride ?? buildSystemPrompt();
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
      maybeBindClient(session);
      this.applyTransportMetadata(session, options);
      this.evictor.touch(conversationId);
    }
    return session;
  }

  // ── Message dispatch ────────────────────────────────────────────────

  private handlerContext(): HandlerContext {
    return {
      sessions: this.sessions,
      socketToSession: this.socketToSession,
      cuSessions: this.cuSessions,
      socketToCuSession: this.socketToCuSession,
      cuObservationParseSequence: this.cuObservationParseSequence,
      socketSandboxOverride: this.socketSandboxOverride,
      sharedRequestTimestamps: this.sharedRequestTimestamps,
      debounceTimers: this.configWatcher.timers,
      suppressConfigReload: this.configWatcher.suppressConfigReload,
      setSuppressConfigReload: (value: boolean) => {
        this.configWatcher.suppressConfigReload = value;
      },
      updateConfigFingerprint: () => {
        this.configWatcher.updateFingerprint();
      },
      send: (socket, msg) => this.send(socket, msg),
      broadcast: (msg) => this.broadcast(msg),
      clearAllSessions: () => this.clearAllSessions(),
      getOrCreateSession: (id, socket?, rebind?, options?) =>
        this.getOrCreateSession(id, socket, rebind, options),
      touchSession: (id) => this.evictor.touch(id),
      heartbeatService: this._heartbeatService,
    };
  }

  private dispatchMessage(
    msg: Parameters<typeof handleMessage>[0],
    socket: net.Socket,
  ): void {
    if (msg.type !== "ping") {
      const now = Date.now();
      if (
        now - this.configWatcher.lastConfigRefreshTime >=
        ConfigWatcher.REFRESH_INTERVAL_MS
      ) {
        try {
          const changed = this.configWatcher.refreshConfigFromSources();
          if (changed) this.evictSessionsForReload();
          this.configWatcher.lastConfigRefreshTime = now;
        } catch (err) {
          log.warn(
            { err },
            "Failed to refresh config from secure sources before handling IPC message",
          );
        }
      }
    }
    handleMessage(msg, socket, this.handlerContext());
  }

  // ── HTTP message processing ─────────────────────────────────────────

  private async prepareSessionForMessage(
    conversationId: string,
    content: string,
    attachmentIds: string[] | undefined,
    options: SessionCreateOptions | undefined,
    sourceChannel: string | undefined,
    sourceInterface: string | undefined,
  ): Promise<{
    session: Session;
    attachments: {
      id: string;
      filename: string;
      mimeType: string;
      data: string;
    }[];
  }> {
    const ingressCheck = checkIngressForSecrets(content);
    if (ingressCheck.blocked) {
      throw new IngressBlockedError(
        ingressCheck.userNotice!,
        ingressCheck.detectedTypes,
      );
    }

    const session = await this.getOrCreateSession(
      conversationId,
      undefined,
      true,
      options,
    );

    if (session.isProcessing()) {
      throw new Error("Session is already processing a message");
    }

    const resolvedChannel = resolveTurnChannel(
      sourceChannel,
      options?.transport?.channelId,
    );
    const resolvedInterface = resolveTurnInterface(sourceInterface);
    session.setAssistantId(
      options?.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
    );
    session.setTrustContext(options?.trustContext ?? null);
    session.setAuthContext(options?.authContext ?? null);
    await session.ensureActorScopedHistory();
    session.setChannelCapabilities(
      resolveChannelCapabilities(sourceChannel, sourceInterface),
    );
    session.setCommandIntent(options?.commandIntent ?? null);
    session.setTurnChannelContext({
      userMessageChannel: resolvedChannel,
      assistantMessageChannel: resolvedChannel,
    });
    session.setTurnInterfaceContext({
      userMessageInterface: resolvedInterface,
      assistantMessageInterface: resolvedInterface,
    });

    const attachments = attachmentIds
      ? attachmentsStore.getAttachmentsByIds(attachmentIds).map((a) => ({
          id: a.id,
          filename: a.originalFilename,
          mimeType: a.mimeType,
          data: a.dataBase64,
        }))
      : [];

    return { session, attachments };
  }

  async persistAndProcessMessage(
    conversationId: string,
    content: string,
    attachmentIds?: string[],
    options?: SessionCreateOptions,
    sourceChannel?: string,
    sourceInterface?: string,
  ): Promise<{ messageId: string }> {
    const { session, attachments } = await this.prepareSessionForMessage(
      conversationId,
      content,
      attachmentIds,
      options,
      sourceChannel,
      sourceInterface,
    );

    const requestId = crypto.randomUUID();
    const messageId = await session.persistUserMessage(
      content,
      attachments,
      requestId,
    );

    // Register pending interactions so channel approval interception can
    // find the session by requestId when confirmation/secret events fire.
    const registrar = makePendingInteractionRegistrar(session, conversationId);
    const onEvent = options?.onEvent
      ? (msg: ServerMessage) => {
          registrar(msg);
          options.onEvent!(msg);
        }
      : registrar;
    if (options?.isInteractive === true) {
      // Interactive HTTP paths (e.g. channel ingress) still run without an IPC
      // socket. Route prompter events through the registrar callback so
      // confirmation_request/secret_request events are tracked, and mark the
      // session interactive so prompt decisions are not auto-denied.
      session.updateClient(onEvent, false);
    }

    session
      .runAgentLoop(content, messageId, onEvent, {
        isInteractive: options?.isInteractive ?? false,
        isUserMessage: true,
      })
      .finally(() => {
        // Only reset if no other caller (e.g. a real IPC client) has rebound
        // the session's sender while the agent loop was running.
        if (
          options?.isInteractive === true &&
          session.getCurrentSender() === onEvent
        ) {
          session.updateClient(() => {}, true);
        }
      })
      .catch((err) => {
        log.error({ err, conversationId }, "Background agent loop failed");
      });

    return { messageId };
  }

  async processMessage(
    conversationId: string,
    content: string,
    attachmentIds?: string[],
    options?: SessionCreateOptions,
    sourceChannel?: string,
    sourceInterface?: string,
  ): Promise<{ messageId: string }> {
    const { session, attachments } = await this.prepareSessionForMessage(
      conversationId,
      content,
      attachmentIds,
      options,
      sourceChannel,
      sourceInterface,
    );

    const slashResult = resolveSlash(content);

    if (slashResult.kind === "unknown") {
      const serverTurnCtx = session.getTurnChannelContext();
      const serverInterfaceCtx = session.getTurnInterfaceContext();
      const serverProvenance = provenanceFromTrustContext(session.trustContext);
      const serverChannelMeta = {
        ...serverProvenance,
        ...(serverTurnCtx
          ? {
              userMessageChannel: serverTurnCtx.userMessageChannel,
              assistantMessageChannel: serverTurnCtx.assistantMessageChannel,
            }
          : {}),
        ...(serverInterfaceCtx
          ? {
              userMessageInterface: serverInterfaceCtx.userMessageInterface,
              assistantMessageInterface:
                serverInterfaceCtx.assistantMessageInterface,
            }
          : {}),
      };
      const userMsg = createUserMessage(content, attachments);
      const persisted = await addMessage(
        conversationId,
        "user",
        JSON.stringify(userMsg.content),
        serverChannelMeta,
      );
      session.getMessages().push(userMsg);

      if (serverTurnCtx) {
        try {
          setConversationOriginChannelIfUnset(
            conversationId,
            serverTurnCtx.userMessageChannel,
          );
        } catch (err) {
          log.warn(
            { err, conversationId },
            "Failed to set origin channel (best-effort)",
          );
        }
      }
      if (serverInterfaceCtx) {
        try {
          setConversationOriginInterfaceIfUnset(
            conversationId,
            serverInterfaceCtx.userMessageInterface,
          );
        } catch (err) {
          log.warn(
            { err, conversationId },
            "Failed to set origin interface (best-effort)",
          );
        }
      }

      const assistantMsg = createAssistantMessage(slashResult.message);
      await addMessage(
        conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        serverChannelMeta,
      );
      session.getMessages().push(assistantMsg);
      return { messageId: persisted.id };
    }

    const resolvedContent = slashResult.content;

    if (slashResult.kind === "rewritten") {
      session.setPreactivatedSkillIds([slashResult.skillId]);
    }

    const requestId = crypto.randomUUID();
    let messageId: string;
    try {
      messageId = await session.persistUserMessage(
        resolvedContent,
        attachments,
        requestId,
      );
    } catch (err) {
      session.setPreactivatedSkillIds(undefined);
      throw err;
    }

    // Register pending interactions so channel approval interception can
    // find the session by requestId when confirmation/secret events fire.
    const registrar = makePendingInteractionRegistrar(session, conversationId);
    const onEvent = options?.onEvent
      ? (msg: ServerMessage) => {
          registrar(msg);
          options.onEvent!(msg);
        }
      : registrar;
    if (options?.isInteractive === true) {
      // Interactive HTTP paths (e.g. channel ingress) still run without an IPC
      // socket. Route prompter events through the registrar callback so
      // confirmation_request/secret_request events are tracked, and mark the
      // session interactive so prompt decisions are not auto-denied.
      session.updateClient(onEvent, false);
    }

    try {
      await session.runAgentLoop(resolvedContent, messageId, onEvent, {
        isInteractive: options?.isInteractive ?? false,
        isUserMessage: true,
      });
    } finally {
      // Only reset if no other caller (e.g. a real IPC client) has rebound
      // the session's sender while the agent loop was running.
      if (
        options?.isInteractive === true &&
        session.getCurrentSender() === onEvent
      ) {
        session.updateClient(() => {}, true);
      }
    }

    return { messageId };
  }

  /**
   * Expose session lookup for the POST /v1/messages handler.
   * The handler manages busy-state checking and queueing itself.
   */
  async getSessionForMessages(conversationId: string): Promise<Session> {
    return this.getOrCreateSession(conversationId, undefined, true);
  }

  /**
   * Look up an active session by ID without creating one.
   * Checks both normal sessions and computer-use sessions so the HTTP
   * surface-action path is consistent with IPC dispatch.
   */
  findSession(sessionId: string): Session | ComputerUseSession | undefined {
    return this.cuSessions.get(sessionId) ?? this.sessions.get(sessionId);
  }
}
