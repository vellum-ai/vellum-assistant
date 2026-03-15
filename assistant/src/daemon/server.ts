import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  disposeAcpSessionManager,
  setBroadcastToAllClients,
} from "../acp/index.js";
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
import type { CesClient } from "../credential-execution/client.js";
import { createCesClient } from "../credential-execution/client.js";
import { isCesToolsEnabled } from "../credential-execution/feature-gates.js";
import {
  type CesProcessManager,
  CesUnavailableError,
  createCesProcessManager,
} from "../credential-execution/process-manager.js";
import type { HeartbeatService } from "../heartbeat/heartbeat-service.js";
import * as attachmentsStore from "../memory/attachments-store.js";
import {
  createCanonicalGuardianRequest,
  generateCanonicalRequestCode,
} from "../memory/canonical-guardian-store.js";
import {
  addMessage,
  getConversationMemoryScopeId,
  getConversationType,
  provenanceFromTrustContext,
  setConversationOriginChannelIfUnset,
  setConversationOriginInterfaceIfUnset,
} from "../memory/conversation-crud.js";
import { getOrCreateConversation } from "../memory/conversation-key-store.js";
import { buildSystemPrompt } from "../prompts/system-prompt.js";
import { resolveManagedProxyContext } from "../providers/managed-proxy/context.js";
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
import { registerCancelCallback } from "../signals/cancel.js";
import { registerConversationUndoCallback } from "../signals/conversation-undo.js";
import { appendEventToStream } from "../signals/event-stream.js";
import { registerUserMessageCallback } from "../signals/user-message.js";
import { getSubagentManager } from "../subagent/index.js";
import { IngressBlockedError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import {
  getSandboxWorkingDir,
  getWorkspacePromptPath,
} from "../util/platform.js";
import { registerDaemonCallbacks } from "../work-items/work-item-runner.js";
import { ConfigWatcher } from "./config-watcher.js";
import {
  Conversation,
  type ConversationMemoryPolicy,
  DEFAULT_MEMORY_POLICY,
} from "./conversation.js";
import { ConversationEvictor } from "./conversation-evictor.js";
import { resolveChannelCapabilities } from "./conversation-runtime-assembly.js";
import { resolveSlash } from "./conversation-slash.js";
import { undoLastMessage } from "./handlers/conversations.js";
import { parseIdentityFields } from "./handlers/identity.js";
import type {
  ConversationCreateOptions,
  HandlerContext,
} from "./handlers/shared.js";
import type { SkillOperationContext } from "./handlers/skills.js";
import { HostBashProxy } from "./host-bash-proxy.js";
import { HostCuProxy } from "./host-cu-proxy.js";
import { HostFileProxy } from "./host-file-proxy.js";
import type { ServerMessage } from "./message-protocol.js";

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
 * loop emits confirmation_request, secret_request, host_bash_request, or
 * host_file_request events. This ensures that channel approval interception
 * can look up the conversation by requestId.
 */
function makePendingInteractionRegistrar(
  conversation: Conversation,
  conversationId: string,
): (msg: ServerMessage) => void {
  return (msg: ServerMessage) => {
    if (msg.type === "confirmation_request") {
      pendingInteractions.register(msg.requestId, {
        conversation,
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
        const trustContext = conversation.trustContext;
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
          expiresAt: Date.now() + 5 * 60 * 1000,
        });

        // For trusted-contact sessions, bridge to guardian.question so the
        // guardian gets notified and can approve via callback/request-code.
        if (trustContext) {
          bridgeConfirmationRequestToGuardian({
            canonicalRequest,
            trustContext,
            conversationId,
            toolName: msg.toolName,
            assistantId:
              conversation.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
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
        conversation,
        conversationId,
        kind: "secret",
      });
    } else if (msg.type === "host_bash_request") {
      pendingInteractions.register(msg.requestId, {
        conversation,
        conversationId,
        kind: "host_bash",
      });
    } else if (msg.type === "host_file_request") {
      pendingInteractions.register(msg.requestId, {
        conversation,
        conversationId,
        kind: "host_file",
      });
    } else if (msg.type === "host_cu_request") {
      pendingInteractions.register(msg.requestId, {
        conversation,
        conversationId,
        kind: "host_cu",
      });
    }
  };
}

export class DaemonServer {
  private conversations = new Map<string, Conversation>();
  private conversationOptions = new Map<string, ConversationCreateOptions>();
  private conversationCreating = new Map<string, Promise<Conversation>>();
  private sharedRequestTimestamps: number[] = [];
  private httpPort: number | undefined;
  private unsubscribeContactChange: (() => void) | null = null;
  private evictor: ConversationEvictor;
  private _hubChain: Promise<void> = Promise.resolve();

  // Composed subsystems
  private configWatcher = new ConfigWatcher();

  // CES (Credential Execution Service) — process-level singleton.
  // The CES sidecar accepts exactly one bootstrap connection, so we must
  // hold that connection at the server level rather than per-conversation.
  private cesProcessManager?: CesProcessManager;
  private cesClientPromise?: Promise<CesClient | undefined>;
  private cesInitAbortController?: AbortController;
  private cesClientRef?: CesClient;

  /**
   * Logical assistant identifier used when publishing to the assistant-events hub.
   */
  assistantId: string = DAEMON_INTERNAL_ASSISTANT_ID;

  /**
   * Return the CES client reference (if available).
   * Used by routes that need to push updates to CES (e.g. secret-routes).
   */
  getCesClient(): CesClient | undefined {
    return this.cesClientRef;
  }

  /** Optional heartbeat service reference for "Run Now" from the UI. */
  private _heartbeatService?: HeartbeatService;

  setHeartbeatService(service: HeartbeatService): void {
    this._heartbeatService = service;
  }

  private deriveMemoryPolicy(conversationId: string): ConversationMemoryPolicy {
    const conversationType = getConversationType(conversationId);
    if (conversationType === "private") {
      return {
        scopeId: getConversationMemoryScopeId(conversationId),
        includeDefaultFallback: true,
        strictSideEffects: true,
      };
    }
    return DEFAULT_MEMORY_POLICY;
  }

  private applyTransportMetadata(
    _conversation: Conversation,
    options: ConversationCreateOptions | undefined,
  ): void {
    const transport = options?.transport;
    if (!transport) return;
    log.debug(
      { channelId: transport.channelId },
      "Transport metadata received",
    );
  }

  constructor() {
    this.evictor = new ConversationEvictor(this.conversations);
    getSubagentManager().sharedRequestTimestamps = this.sharedRequestTimestamps;
    getSubagentManager().broadcastToAllClients = (msg) => this.broadcast(msg);
    setBroadcastToAllClients((msg) => this.broadcast(msg));
    this.evictor.onEvict = (conversationId: string) => {
      getSubagentManager().abortAllForParent(conversationId);
    };
    this.evictor.shouldProtect = (conversationId: string) => {
      const children = getSubagentManager().getChildrenOf(conversationId);
      return children.some(
        (c) => c.status === "running" || c.status === "pending",
      );
    };
    getSubagentManager().onSubagentFinished = async (
      parentConversationId,
      message,
      sendToClient,
      notification,
    ) => {
      const parentConversation = this.conversations.get(parentConversationId);
      if (!parentConversation) {
        log.warn(
          { parentConversationId },
          "Subagent finished but parent conversation not found",
        );
        return;
      }
      const requestId = `subagent-notify-${Date.now()}`;
      const metadata = { subagentNotification: notification };
      const enqueueResult = parentConversation.enqueueMessage(
        message,
        [],
        sendToClient,
        requestId,
        undefined,
        undefined,
        metadata,
      );
      if (!enqueueResult.queued && !enqueueResult.rejected) {
        const messageId = await parentConversation.persistUserMessage(
          message,
          [],
          undefined,
          metadata,
        );
        parentConversation
          .runAgentLoop(message, messageId, sendToClient)
          .catch((err) => {
            log.error(
              { parentConversationId, err },
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
  private publishAssistantEvent(
    msg: ServerMessage,
    conversationId?: string,
  ): void {
    const id = this.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID;
    const event = buildAssistantEvent(id, msg, conversationId);
    this._hubChain = this._hubChain
      .then(() => assistantEventHub.publish(event))
      .catch((err: unknown) => {
        log.warn(
          { err },
          "assistant-events hub subscriber threw during broadcast",
        );
      });

    // Dual-write to file-based stream for cross-process consumers.
    // No-op when no subscriber files exist for this conversation.
    if (conversationId) {
      try {
        appendEventToStream(conversationId, event);
      } catch {
        // Best-effort; file I/O failures must not block the hub chain.
      }
    }
  }

  broadcast(msg: ServerMessage): void {
    const conversationId = extractConversationId(msg);
    this.publishAssistantEvent(msg, conversationId);
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
    await initializeProviders(config);
    this.configWatcher.initFingerprint(config);

    this.evictor.start();

    registerDaemonCallbacks({
      getOrCreateConversation: (conversationId) =>
        this.getOrCreateConversation(conversationId),
      broadcast: (msg) => this.broadcast(msg),
    });

    registerCancelCallback((conversationId) => {
      const conversation = this.conversations.get(conversationId);
      if (!conversation) return false;
      this.evictor.touch(conversationId);
      conversation.abort();
      getSubagentManager().abortAllForParent(conversationId);
      return true;
    });

    registerConversationUndoCallback((conversationId) =>
      undoLastMessage(conversationId, this.handlerContext()),
    );

    registerUserMessageCallback(async (params) => {
      const { conversationId } = getOrCreateConversation(
        params.conversationKey,
      );
      const conversation = await this.getOrCreateConversation(conversationId);
      if (conversation.isProcessing()) {
        const requestId = crypto.randomUUID();
        const resolvedChannel = resolveTurnChannel(params.sourceChannel);
        const resolvedInterface = resolveTurnInterface(params.sourceInterface);
        const result = conversation.enqueueMessage(
          params.content,
          [],
          () => {},
          requestId,
          undefined,
          undefined,
          {
            userMessageChannel: resolvedChannel,
            assistantMessageChannel: resolvedChannel,
            userMessageInterface: resolvedInterface,
            assistantMessageInterface: resolvedInterface,
          },
        );
        return { accepted: !result.rejected };
      }
      await this.persistAndProcessMessage(
        conversationId,
        params.content,
        undefined,
        undefined,
        params.sourceChannel,
        params.sourceInterface,
      );
      return { accepted: true };
    });

    this.configWatcher.start(
      () => this.evictConversationsForReload(),
      () => this.broadcastIdentityChanged(),
    );

    // Broadcast contacts_changed to all clients when any contact mutation occurs.
    this.unsubscribeContactChange = onContactChange(() => {
      this.broadcast({ type: "contacts_changed" });
    });

    // CES lifecycle — start the CES process and perform the RPC handshake
    // once at server level. The managed sidecar accepts exactly one bootstrap
    // connection, so this must be a process-level singleton.
    if (isCesToolsEnabled(config)) {
      const pm = createCesProcessManager({ assistantConfig: config });
      this.cesProcessManager = pm;
      const abortController = new AbortController();
      this.cesInitAbortController = abortController;
      this.cesClientPromise = (async () => {
        try {
          const transport = await pm.start();
          if (abortController.signal.aborted) {
            throw new Error("CES initialization aborted during shutdown");
          }
          const client = createCesClient(transport);
          this.cesClientRef = client;
          // Resolve the assistant API key so CES can use it for platform
          // credential materialisation. In managed mode the key is provisioned
          // after hatch and stored in the credential store — CES can't read
          // the env var, so we pass it via the handshake.
          const proxyCtx = await resolveManagedProxyContext();
          const { accepted, reason } = await client.handshake(
            proxyCtx.assistantApiKey
              ? { assistantApiKey: proxyCtx.assistantApiKey }
              : undefined,
          );
          if (abortController.signal.aborted) {
            client.close();
            throw new Error("CES initialization aborted during shutdown");
          }
          if (accepted) {
            log.info(
              "CES client initialized and handshake accepted (server-level)",
            );
            return client;
          }
          log.warn(
            { reason },
            "CES handshake rejected — CES tools will be unavailable",
          );
          client.close();
          this.cesClientRef = undefined;
          await pm.stop();
          // Reset so next session can retry initialization
          this.cesClientPromise = undefined;
          return undefined;
        } catch (err) {
          if (err instanceof CesUnavailableError) {
            log.info(
              { reason: err.message },
              "CES is not available — CES tools will be unavailable",
            );
          } else {
            log.warn(
              { error: err instanceof Error ? err.message : String(err) },
              "Failed to initialize CES client — CES tools will be unavailable",
            );
          }
          await pm.stop().catch(() => {});
          // Reset so next session can retry initialization
          this.cesClientRef = undefined;
          this.cesClientPromise = undefined;
          return undefined;
        }
      })();
    }

    log.info("DaemonServer started (HTTP-only mode)");
  }

  async stop(): Promise<void> {
    getSubagentManager().disposeAll();
    disposeAcpSessionManager();
    this.evictor.stop();
    this.configWatcher.stop();
    if (this.unsubscribeContactChange) {
      this.unsubscribeContactChange();
      this.unsubscribeContactChange = null;
    }

    for (const conversation of this.conversations.values()) {
      conversation.dispose();
    }
    this.conversations.clear();

    // Abort any in-flight CES initialization so it fails fast instead of
    // blocking shutdown for up to ~15s (socket connect + handshake timeouts).
    if (this.cesInitAbortController) {
      this.cesInitAbortController.abort();
      this.cesInitAbortController = undefined;
    }
    // Force-stop the CES process immediately — forceStop() works even if
    // start() hasn't finished (unlike stop() which is a no-op when !running).
    if (this.cesProcessManager) {
      await this.cesProcessManager.forceStop().catch(() => {});
    }
    // Cancel in-flight handshake/RPC timers by closing the client directly.
    // Without this, the handshake setTimeout (~10s) keeps the init promise
    // pending even after the transport is killed.
    if (this.cesClientRef) {
      this.cesClientRef.close();
      this.cesClientRef = undefined;
    }
    // Now await the init promise (which should settle immediately since we
    // killed the transport and cancelled pending timers above).
    if (this.cesClientPromise) {
      await this.cesClientPromise.catch(() => undefined);
      this.cesClientPromise = undefined;
    }
    if (this.cesProcessManager) {
      this.cesProcessManager = undefined;
    }

    log.info("Daemon server stopped");
  }

  // ── Conversation management ──────────────────────────────────────────────

  setHttpPort(port: number): void {
    this.httpPort = port;
    this.broadcast({
      type: "daemon_status",
      httpPort: port,
      version: daemonVersion,
      keyFingerprint: getSigningKeyFingerprint(),
    });
  }

  clearAllConversations(): number {
    const count = this.conversations.size;
    const subagentManager = getSubagentManager();
    for (const id of this.conversations.keys()) {
      this.evictor.remove(id);
      subagentManager.abortAllForParent(id);
    }
    for (const conversation of this.conversations.values()) {
      conversation.dispose();
    }
    this.conversations.clear();
    this.conversationOptions.clear();
    return count;
  }

  /**
   * Abort and dispose a single in-memory conversation, removing it from the
   * conversation map. No-op if no conversation exists for the given ID.
   */
  destroyConversation(conversationId: string): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    this.evictor.remove(conversationId);
    getSubagentManager().abortAllForParent(conversationId);
    conversation.dispose();
    this.conversations.delete(conversationId);
    this.conversationOptions.delete(conversationId);
  }

  private evictConversationsForReload(): void {
    const subagentManager = getSubagentManager();
    for (const [id, conversation] of this.conversations) {
      if (!conversation.isProcessing()) {
        subagentManager.abortAllForParent(id);
        conversation.dispose();
        this.conversations.delete(id);
        this.evictor.remove(id);
      } else {
        conversation.markStale();
      }
    }
  }

  get lastConfigFingerprint(): string {
    return this.configWatcher.lastFingerprint;
  }

  set lastConfigFingerprint(value: string) {
    this.configWatcher.lastFingerprint = value;
  }

  async refreshConfigFromSources(): Promise<boolean> {
    const changed = await this.configWatcher.refreshConfigFromSources();
    if (changed) this.evictConversationsForReload();
    return changed;
  }

  private async getOrCreateConversation(
    conversationId: string,
    options?: ConversationCreateOptions,
  ): Promise<Conversation> {
    let conversation = this.conversations.get(conversationId);
    const sendToClient = () => {};

    if (options && Object.values(options).some((v) => v !== undefined)) {
      this.conversationOptions.set(conversationId, {
        ...this.conversationOptions.get(conversationId),
        ...options,
      });
    }

    if (
      !conversation ||
      (conversation.isStale() && !conversation.isProcessing())
    ) {
      if (conversation) {
        getSubagentManager().abortAllForParent(conversationId);
        conversation.dispose();
      }

      const pending = this.conversationCreating.get(conversationId);
      if (pending) {
        conversation = await pending;
        return conversation;
      }

      const storedOptions = this.conversationOptions.get(conversationId);

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
        // Resolve the shared CES client (may still be initializing).
        const sharedCesClient = this.cesClientPromise
          ? await this.cesClientPromise
          : undefined;
        const newConversation = new Conversation(
          conversationId,
          provider,
          systemPrompt,
          maxTokens,
          sendToClient,
          workingDir,
          (msg) => this.broadcast(msg),
          memoryPolicy,
          sharedCesClient,
        );
        newConversation.updateClient(sendToClient, true);
        await newConversation.loadFromDb();
        // Restore trust/auth context and assistant ID from stored options so
        // that evicted sessions rehydrated by undo/regenerate don't run with
        // unscoped history.  Without this, an untrusted actor could operate
        // on the full conversation after eviction.
        if (storedOptions?.assistantId) {
          newConversation.setAssistantId(storedOptions.assistantId);
        }
        if (storedOptions?.trustContext) {
          newConversation.setTrustContext(storedOptions.trustContext);
        }
        if (storedOptions?.authContext) {
          newConversation.setAuthContext(storedOptions.authContext);
        }
        if (storedOptions?.trustContext || storedOptions?.authContext) {
          await newConversation.ensureActorScopedHistory();
        }
        this.applyTransportMetadata(newConversation, storedOptions);
        this.conversations.set(conversationId, newConversation);
        return newConversation;
      })();

      this.conversationCreating.set(conversationId, createPromise);
      try {
        conversation = await createPromise;
      } finally {
        this.conversationCreating.delete(conversationId);
      }
      this.evictor.touch(conversationId);
    } else {
      this.applyTransportMetadata(conversation, options);
      this.evictor.touch(conversationId);
    }
    return conversation;
  }

  // ── Handler context ────────────────────────────────────────────────

  private handlerContext(): HandlerContext {
    return {
      conversations: this.conversations,
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
      clearAllConversations: () => this.clearAllConversations(),
      getOrCreateConversation: (id, options?) =>
        this.getOrCreateConversation(id, options),
      touchConversation: (id) => this.evictor.touch(id),
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

  private async prepareConversationForMessage(
    conversationId: string,
    content: string,
    attachmentIds: string[] | undefined,
    options: ConversationCreateOptions | undefined,
    sourceChannel: string | undefined,
    sourceInterface: string | undefined,
  ): Promise<{
    conversation: Conversation;
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

    const conversation = await this.getOrCreateConversation(
      conversationId,
      options,
    );

    if (conversation.isProcessing()) {
      throw new Error("Conversation is already processing a message");
    }

    const resolvedChannel = resolveTurnChannel(
      sourceChannel,
      options?.transport?.channelId,
    );
    const resolvedInterface = resolveTurnInterface(sourceInterface);
    conversation.setAssistantId(
      options?.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
    );
    conversation.setTrustContext(options?.trustContext ?? null);
    conversation.setAuthContext(options?.authContext ?? null);
    await conversation.ensureActorScopedHistory();
    conversation.setChannelCapabilities(
      resolveChannelCapabilities(
        sourceChannel,
        sourceInterface,
        null,
        options?.transport?.chatType,
      ),
    );
    // Only create the host bash proxy for desktop client interfaces that can
    // execute commands on the user's machine. Non-desktop conversations (CLI,
    // channels, headless) fall back to local execution.
    // Guard: don't replace an active proxy during concurrent turn races —
    // another request may have started processing between the isProcessing()
    // check above and the await on ensureActorScopedHistory().
    if (resolvedInterface === "macos" || resolvedInterface === "ios") {
      if (!conversation.isProcessing() || !conversation.hostBashProxy) {
        conversation.setHostBashProxy(
          new HostBashProxy(conversation.getCurrentSender(), (requestId) => {
            pendingInteractions.resolve(requestId);
          }),
        );
      }
      if (!conversation.isProcessing() || !conversation.hostFileProxy) {
        conversation.setHostFileProxy(
          new HostFileProxy(conversation.getCurrentSender(), (requestId) => {
            pendingInteractions.resolve(requestId);
          }),
        );
      }
      if (!conversation.isProcessing() || !conversation.hostCuProxy) {
        conversation.setHostCuProxy(
          new HostCuProxy(conversation.getCurrentSender(), (requestId) => {
            pendingInteractions.resolve(requestId);
          }),
        );
      }
      conversation.addPreactivatedSkillId("computer-use");
    } else if (!conversation.isProcessing()) {
      conversation.setHostBashProxy(undefined);
      conversation.setHostFileProxy(undefined);
      conversation.setHostCuProxy(undefined);
    }
    conversation.setCommandIntent(options?.commandIntent ?? null);
    conversation.setTurnChannelContext({
      userMessageChannel: resolvedChannel,
      assistantMessageChannel: resolvedChannel,
    });
    conversation.setTurnInterfaceContext({
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

    return { conversation, attachments };
  }

  async persistAndProcessMessage(
    conversationId: string,
    content: string,
    attachmentIds?: string[],
    options?: ConversationCreateOptions,
    sourceChannel?: string,
    sourceInterface?: string,
  ): Promise<{ messageId: string }> {
    const { conversation, attachments } =
      await this.prepareConversationForMessage(
        conversationId,
        content,
        attachmentIds,
        options,
        sourceChannel,
        sourceInterface,
      );

    const requestId = crypto.randomUUID();
    const messageId = await conversation.persistUserMessage(
      content,
      attachments,
      requestId,
    );

    // Register pending interactions so channel approval interception can
    // find the conversation by requestId when confirmation/secret events fire.
    const registrar = makePendingInteractionRegistrar(
      conversation,
      conversationId,
    );
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
      conversation.updateClient(onEvent, false);
    }

    conversation
      .runAgentLoop(content, messageId, onEvent, {
        isInteractive: options?.isInteractive ?? false,
        isUserMessage: true,
      })
      .finally(() => {
        if (
          options?.isInteractive === true &&
          conversation.getCurrentSender() === onEvent
        ) {
          conversation.updateClient(() => {}, true);
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
    options?: ConversationCreateOptions,
    sourceChannel?: string,
    sourceInterface?: string,
  ): Promise<{ messageId: string }> {
    const { conversation, attachments } =
      await this.prepareConversationForMessage(
        conversationId,
        content,
        attachmentIds,
        options,
        sourceChannel,
        sourceInterface,
      );

    const slashResult = await resolveSlash(content);

    if (slashResult.kind === "unknown") {
      const serverTurnCtx = conversation.getTurnChannelContext();
      const serverInterfaceCtx = conversation.getTurnInterfaceContext();
      const serverProvenance = provenanceFromTrustContext(
        conversation.trustContext,
      );
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
      conversation.getMessages().push(userMsg);

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
      conversation.getMessages().push(assistantMsg);
      return { messageId: persisted.id };
    }

    const resolvedContent = slashResult.content;

    const requestId = crypto.randomUUID();
    const messageId = await conversation.persistUserMessage(
      resolvedContent,
      attachments,
      requestId,
    );

    // Register pending interactions so channel approval interception can
    // find the conversation by requestId when confirmation/secret events fire.
    const registrar = makePendingInteractionRegistrar(
      conversation,
      conversationId,
    );
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
      conversation.updateClient(onEvent, false);
    }

    try {
      await conversation.runAgentLoop(resolvedContent, messageId, onEvent, {
        isInteractive: options?.isInteractive ?? false,
        isUserMessage: true,
      });
    } finally {
      if (
        options?.isInteractive === true &&
        conversation.getCurrentSender() === onEvent
      ) {
        conversation.updateClient(() => {}, true);
      }
    }

    return { messageId };
  }

  /**
   * Expose conversation lookup for the POST /v1/messages handler.
   * The handler manages busy-state checking and queueing itself.
   */
  async getConversationForMessages(
    conversationId: string,
  ): Promise<Conversation> {
    return this.getOrCreateConversation(conversationId);
  }

  /**
   * Look up an active conversation by ID without creating one.
   */
  findConversation(conversationId: string): Conversation | undefined {
    return this.conversations.get(conversationId);
  }

  /**
   * Look up an active conversation that owns a given surfaceId.
   */
  findConversationBySurfaceId(surfaceId: string): Conversation | undefined {
    for (const c of this.conversations.values()) {
      if (c.surfaceState.has(surfaceId)) return c;
    }
    return undefined;
  }

  /**
   * Expose the handler context for use by conversation management HTTP routes.
   * The context is built on-the-fly so it always reflects the current server state.
   */
  getHandlerContext(): HandlerContext {
    return this.handlerContext();
  }
}

/** Extract conversationId from a ServerMessage if present. */
function extractConversationId(msg: ServerMessage): string | undefined {
  const record = msg as unknown as Record<string, unknown>;
  if ("conversationId" in msg && typeof record.conversationId === "string") {
    return record.conversationId as string;
  }
  return undefined;
}
