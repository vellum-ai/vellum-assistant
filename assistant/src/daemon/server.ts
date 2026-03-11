import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
import { buildSystemPrompt } from "../prompts/system-prompt.js";
import { RateLimitProvider } from "../providers/ratelimit.js";
import {
  getFailoverProvider,
  initializeProviders,
} from "../providers/registry.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { getSigningKeyFingerprint } from "../runtime/auth/token-service.js";
import { bridgeConfirmationRequestToGuardian } from "../runtime/confirmation-request-guardian-bridge.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { checkIngressForSecrets } from "../security/secret-ingress.js";
import { getSubagentManager } from "../subagent/index.js";
import { IngressBlockedError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import {
  getSandboxWorkingDir,
  getWorkspacePromptPath,
} from "../util/platform.js";
import { registerDaemonCallbacks } from "../work-items/work-item-runner.js";
import { ComputerUseSession } from "./computer-use-session.js";
import { ConfigWatcher } from "./config-watcher.js";
import { parseIdentityFields } from "./handlers/identity.js";
import type {
  HandlerContext,
  SessionCreateOptions,
} from "./handlers/shared.js";
import type { SkillOperationContext } from "./handlers/skills.js";
import { HostBashProxy } from "./host-bash-proxy.js";
import type { ServerMessage } from "./message-protocol.js";
import {
  DEFAULT_MEMORY_POLICY,
  Session,
  type SessionMemoryPolicy,
} from "./session.js";
import { SessionEvictor } from "./session-evictor.js";
import { resolveChannelCapabilities } from "./session-runtime-assembly.js";
import { resolveSlash } from "./session-slash.js";

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

      // Create a canonical guardian request so HTTP handlers can find it
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
    } else if (msg.type === "host_bash_request") {
      pendingInteractions.register(msg.requestId, {
        session,
        conversationId,
        kind: "host_bash",
      });
    }
  };
}

export class DaemonServer {
  private sessions = new Map<string, Session>();
  private cuSessions = new Map<string, ComputerUseSession>();
  private cuObservationParseSequence = new Map<string, number>();
  private sessionOptions = new Map<string, SessionCreateOptions>();
  private sessionCreating = new Map<string, Promise<Session>>();
  private sharedRequestTimestamps: number[] = [];
  private httpPort: number | undefined;
  private unsubscribeContactChange: (() => void) | null = null;
  private evictor: SessionEvictor;
  private _hubChain: Promise<void> = Promise.resolve();

  // Composed subsystems
  private configWatcher = new ConfigWatcher();

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
      if (!enqueueResult.queued && !enqueueResult.rejected) {
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

  // ── Broadcast / Event publishing ──────────────────────────────────

  /**
   * Publish `msg` as an `AssistantEvent` to the process-level hub.
   * Publications are serialized via a promise chain so subscribers
   * always observe events in send order.
   */
  private publishAssistantEvent(msg: ServerMessage, sessionId?: string): void {
    const id = this.assistantId ?? "default";
    const event = buildAssistantEvent(id, msg, sessionId);
    this._hubChain = this._hubChain
      .then(() => assistantEventHub.publish(event))
      .catch((err: unknown) => {
        log.warn(
          { err },
          "assistant-events hub subscriber threw during broadcast",
        );
      });
  }

  broadcast(msg: ServerMessage): void {
    const sessionId = extractSessionId(msg);
    this.publishAssistantEvent(msg, sessionId);
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
    const config = getConfig();
    initializeProviders(config);
    this.configWatcher.initFingerprint(config);

    this.evictor.start();

    registerDaemonCallbacks({
      getOrCreateSession: (conversationId) =>
        this.getOrCreateSession(conversationId),
      broadcast: (msg) => this.broadcast(msg),
    });

    this.configWatcher.start(
      () => this.evictSessionsForReload(),
      () => this.broadcastIdentityChanged(),
    );

    // Broadcast contacts_changed to all clients when any contact mutation occurs.
    this.unsubscribeContactChange = onContactChange(() => {
      this.broadcast({ type: "contacts_changed" });
    });

    log.info("DaemonServer started (HTTP-only mode)");
  }

  async stop(): Promise<void> {
    getSubagentManager().disposeAll();
    this.evictor.stop();
    this.configWatcher.stop();
    if (this.unsubscribeContactChange) {
      this.unsubscribeContactChange();
      this.unsubscribeContactChange = null;
    }

    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();

    for (const cuSession of this.cuSessions.values()) {
      cuSession.abort();
    }
    this.cuSessions.clear();

    log.info("Daemon server stopped");
  }

  // ── Session management ──────────────────────────────────────────────

  setHttpPort(port: number): void {
    this.httpPort = port;
    this.broadcast({
      type: "daemon_status",
      httpPort: port,
      version: daemonVersion,
      keyFingerprint: getSigningKeyFingerprint(),
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

  private async getOrCreateSession(
    conversationId: string,
    options?: SessionCreateOptions,
  ): Promise<Session> {
    let session = this.sessions.get(conversationId);
    const sendToClient = () => {};

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
          sendToClient,
          workingDir,
          (msg) => this.broadcast(msg),
          memoryPolicy,
        );
        newSession.updateClient(sendToClient, true);
        await newSession.loadFromDb();
        this.applyTransportMetadata(newSession, storedOptions);
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
      this.applyTransportMetadata(session, options);
      this.evictor.touch(conversationId);
    }
    return session;
  }

  // ── Handler context ────────────────────────────────────────────────

  private handlerContext(): HandlerContext {
    return {
      sessions: this.sessions,
      cuSessions: this.cuSessions,
      cuObservationParseSequence: this.cuObservationParseSequence,
      sharedRequestTimestamps: this.sharedRequestTimestamps,
      debounceTimers: this.configWatcher.timers,
      suppressConfigReload: this.configWatcher.suppressConfigReload,
      setSuppressConfigReload: (value: boolean) => {
        this.configWatcher.suppressConfigReload = value;
      },
      updateConfigFingerprint: () => {
        this.configWatcher.updateFingerprint();
      },
      send: (msg) => this.broadcast(msg),
      broadcast: (msg) => this.broadcast(msg),
      clearAllSessions: () => this.clearAllSessions(),
      getOrCreateSession: (id, options?) =>
        this.getOrCreateSession(id, options),
      touchSession: (id) => this.evictor.touch(id),
      heartbeatService: this._heartbeatService,
    };
  }

  /** Public subset of handler context for skill management HTTP routes. */
  getSkillContext(): SkillOperationContext {
    return {
      debounceTimers: this.configWatcher.timers,
      setSuppressConfigReload: (value: boolean) => {
        this.configWatcher.suppressConfigReload = value;
      },
      updateConfigFingerprint: () => {
        this.configWatcher.updateFingerprint();
      },
      broadcast: (msg) => this.broadcast(msg),
    };
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

    const session = await this.getOrCreateSession(conversationId, options);

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
    // Only create the host bash proxy for desktop client interfaces that can
    // execute commands on the user's machine. Non-desktop sessions (CLI,
    // channels, headless) fall back to local execution.
    if (resolvedInterface === "macos" || resolvedInterface === "ios") {
      session.setHostBashProxy(
        new HostBashProxy(session.getCurrentSender(), (requestId) => {
          pendingInteractions.resolve(requestId);
        }),
      );
    } else {
      session.setHostBashProxy(undefined);
    }
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
          try {
            options.onEvent!(msg);
          } catch (err) {
            log.error(
              { err, conversationId },
              "onEvent callback failed; continuing agent loop",
            );
          }
        }
      : registrar;
    if (options?.isInteractive === true) {
      session.updateClient(onEvent, false);
    }

    session
      .runAgentLoop(content, messageId, onEvent, {
        isInteractive: options?.isInteractive ?? false,
        isUserMessage: true,
      })
      .finally(() => {
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
          try {
            options.onEvent!(msg);
          } catch (err) {
            log.error(
              { err, conversationId },
              "onEvent callback failed; continuing agent loop",
            );
          }
        }
      : registrar;
    if (options?.isInteractive === true) {
      session.updateClient(onEvent, false);
    }

    try {
      await session.runAgentLoop(resolvedContent, messageId, onEvent, {
        isInteractive: options?.isInteractive ?? false,
        isUserMessage: true,
      });
    } finally {
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
    return this.getOrCreateSession(conversationId);
  }

  /**
   * Look up an active session by ID without creating one.
   * Checks both normal sessions and computer-use sessions so the HTTP
   * surface-action path is consistent with dispatch.
   */
  findSession(sessionId: string): Session | ComputerUseSession | undefined {
    return this.cuSessions.get(sessionId) ?? this.sessions.get(sessionId);
  }

  /**
   * Look up an active session that owns a given surfaceId.
   * Falls back across both normal and computer-use sessions.
   */
  findSessionBySurfaceId(
    surfaceId: string,
  ): Session | ComputerUseSession | undefined {
    for (const s of this.cuSessions.values()) {
      if (s.surfaceState.has(surfaceId)) return s;
    }
    for (const s of this.sessions.values()) {
      if (s.surfaceState.has(surfaceId)) return s;
    }
    return undefined;
  }

  /**
   * Expose the handler context for use by session management HTTP routes.
   * The context is built on-the-fly so it always reflects the current server state.
   */
  getHandlerContext(): HandlerContext {
    return this.handlerContext();
  }
}

/** Extract sessionId from a ServerMessage if present. */
function extractSessionId(msg: ServerMessage): string | undefined {
  const record = msg as unknown as Record<string, unknown>;
  if ("sessionId" in msg && typeof record.sessionId === "string") {
    return record.sessionId as string;
  }
  return undefined;
}
