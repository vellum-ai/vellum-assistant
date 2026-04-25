import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  disposeAcpSessionManager,
  getAcpSessionManager,
  setBroadcastToAllClients,
} from "../acp/index.js";
import { enrichMessageWithSourcePaths } from "../agent/attachments.js";
import type { AgentEvent } from "../agent/loop.js";
import {
  createAssistantMessage,
  createUserMessage,
} from "../agent/message-types.js";
import { compileApp } from "../bundler/app-compiler.js";
import {
  type ChannelId,
  type InterfaceId,
  parseChannelId,
  parseInterfaceId,
  supportsHostProxy,
} from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import { onContactChange } from "../contacts/contact-events.js";
import type { CesClient } from "../credential-execution/client.js";
import type { CesProcessManager } from "../credential-execution/process-manager.js";
import type { FilingService } from "../filing/filing-service.js";
import type { HeartbeatService } from "../heartbeat/heartbeat-service.js";
import { CliIpcServer } from "../ipc/cli-server.js";
import { registerBrowserIpcContextResolver } from "../ipc/routes/browser-context.js";
import { SkillIpcServer } from "../ipc/skill-server.js";
import { getApp, getAppDirPath, isMultifileApp } from "../memory/app-store.js";
import * as attachmentsStore from "../memory/attachments-store.js";
import {
  createCanonicalGuardianRequest,
  generateCanonicalRequestCode,
} from "../memory/canonical-guardian-store.js";
import {
  addMessage,
  getConversation,
  getConversationMemoryScopeId,
  getConversationType,
  provenanceFromTrustContext,
  setConversationOriginChannelIfUnset,
  setConversationOriginInterfaceIfUnset,
} from "../memory/conversation-crud.js";
import {
  syncMessageToDisk,
  updateMetaFile,
} from "../memory/conversation-disk-view.js";
import { getOrCreateConversation } from "../memory/conversation-key-store.js";
import { syncIdentityNameToPlatform } from "../platform/sync-identity.js";
import { buildSystemPrompt } from "../prompts/system-prompt.js";
import { CallSiteRoutingProvider } from "../providers/call-site-routing.js";
import { RateLimitProvider } from "../providers/ratelimit.js";
import { getProvider, initializeProviders } from "../providers/registry.js";
import {
  registerDefaultWakeResolver,
  type WakeTarget,
} from "../runtime/agent-wake.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { getSigningKeyFingerprint } from "../runtime/auth/token-service.js";
import { bridgeConfirmationRequestToGuardian } from "../runtime/confirmation-request-guardian-bridge.js";
import { registerInteractiveUiResolver } from "../runtime/interactive-ui.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { checkIngressForSecrets } from "../security/secret-ingress.js";
import { redactSecrets } from "../security/secret-scanner.js";
import { updatePublishedAppDeployment } from "../services/published-app-updater.js";
import { registerCancelCallback } from "../signals/cancel.js";
import { registerConversationUndoCallback } from "../signals/conversation-undo.js";
import { appendEventToStream } from "../signals/event-stream.js";
import { registerUserMessageCallback } from "../signals/user-message.js";
import { getSubagentManager } from "../subagent/index.js";
import { summarizeToolInput } from "../tools/tool-input-summary.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { getLogger } from "../util/logger.js";
import {
  getAvatarImagePath,
  getSandboxWorkingDir,
  getWorkspacePromptPath,
} from "../util/platform.js";
import { registerDaemonCallbacks } from "../work-items/work-item-runner.js";
import {
  AppSourceWatcher,
  setEnsureAppSourceWatcher,
} from "./app-source-watcher.js";
import { ConfigWatcher } from "./config-watcher.js";
import {
  Conversation,
  type ConversationMemoryPolicy,
  DEFAULT_MEMORY_POLICY,
} from "./conversation.js";
import { ConversationEvictor } from "./conversation-evictor.js";
import { registerLaunchConversationDeps } from "./conversation-launch.js";
import { buildSlackMetaForPersistence } from "./conversation-messaging.js";
import { formatCompactResult } from "./conversation-process.js";
import { resolveChannelCapabilities } from "./conversation-runtime-assembly.js";
import { resolveSlash, type SlashContext } from "./conversation-slash.js";
import {
  refreshSurfacesForApp,
  showStandaloneSurface,
} from "./conversation-surfaces.js";
import { undoLastMessage } from "./handlers/conversations.js";
import { parseIdentityFields } from "./handlers/identity.js";
import type {
  ConversationCreateOptions,
  HandlerContext,
} from "./handlers/shared.js";
import type { SkillOperationContext } from "./handlers/skills.js";
import { HostBashProxy } from "./host-bash-proxy.js";
import { HostBrowserProxy } from "./host-browser-proxy.js";
import { HostCuProxy } from "./host-cu-proxy.js";
import { HostFileProxy } from "./host-file-proxy.js";
import { HostTransferProxy } from "./host-transfer-proxy.js";
import { setGlobalSkillIpcSender } from "./meet-host-supervisor.js";
import type {
  ServerMessage,
  UserMessageAttachment,
} from "./message-protocol.js";
import { buildTransportHints } from "./transport-hints.js";

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
 * loop emits confirmation_request, secret_request, host_bash_request,
 * host_browser_request, host_file_request, or host_cu_request events. This
 * ensures that channel approval interception can look up the conversation by
 * requestId.
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
        const inputRecord = msg.input as Record<string, unknown>;
        const activityRaw =
          (typeof inputRecord.activity === "string"
            ? inputRecord.activity
            : undefined) ??
          (typeof inputRecord.reason === "string"
            ? inputRecord.reason
            : undefined);
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
          commandPreview:
            redactSecrets(summarizeToolInput(msg.toolName, inputRecord)) ||
            undefined,
          riskLevel: msg.riskLevel,
          activityText: activityRaw ? redactSecrets(activityRaw) : undefined,
          executionTarget: msg.executionTarget,
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
    } else if (msg.type === "host_browser_request") {
      pendingInteractions.register(msg.requestId, {
        conversation,
        conversationId,
        kind: "host_browser",
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
    } else if (msg.type === "host_transfer_request") {
      pendingInteractions.register(msg.requestId, {
        conversation,
        conversationId,
        kind: "host_transfer",
      });
    }
  };
}

export class DaemonServer {
  private conversations = new Map<string, Conversation>();
  private conversationOptions = new Map<string, ConversationCreateOptions>();
  private conversationCreating = new Map<string, Promise<Conversation>>();
  private sharedRequestTimestamps: number[] = [];
  private unsubscribeContactChange: (() => void) | null = null;
  private evictor: ConversationEvictor;
  private _hubChain: Promise<void> = Promise.resolve();

  // Composed subsystems
  private configWatcher = new ConfigWatcher();
  private appSourceWatcher = new AppSourceWatcher();
  private cliIpc = new CliIpcServer();
  private skillIpc = new SkillIpcServer();

  // CES (Credential Execution Service) — process-level singleton.
  // Lifecycle is managed by startCesProcess() in lifecycle.ts; the server
  // receives the result via setCes().
  private cesProcessManager?: CesProcessManager;
  private cesClientPromise?: Promise<CesClient | undefined>;
  private cesInitAbortController?: AbortController;
  private cesClientRef?: CesClient;
  /** Monotonically increasing counter to detect stale client updates. */
  private cesClientGeneration = 0;

  /**
   * Logical assistant identifier used when publishing to the assistant-events hub.
   */
  assistantId: string = DAEMON_INTERNAL_ASSISTANT_ID;

  /**
   * Inject the CES client and process manager from the caller (lifecycle.ts).
   * Must be called before start().
   */
  setCes(result: {
    client: CesClient | undefined;
    processManager: CesProcessManager | undefined;
    clientPromise: Promise<CesClient | undefined> | undefined;
    abortController: AbortController | undefined;
  }): void {
    this.cesClientRef = result.client;
    this.cesProcessManager = result.processManager;
    this.cesInitAbortController = result.abortController;

    // Wrap the external promise so that cesClientRef stays in sync once the
    // handshake completes — the async work runs in lifecycle.ts but the
    // server needs the resolved client reference for getCesClient().
    // Use a generation snapshot so a late-resolving promise doesn't overwrite
    // a newer client set by updateCesClient().
    if (result.clientPromise) {
      const gen = this.cesClientGeneration;
      this.cesClientPromise = result.clientPromise.then((client) => {
        if (this.cesClientGeneration === gen) {
          this.cesClientRef = client;
        }
        return client;
      });
    }
  }

  /**
   * Return the CES client reference (if available).
   * Used by routes that need to push updates to CES (e.g. secret-routes).
   */
  getCesClient(): CesClient | undefined {
    return this.cesClientRef;
  }

  /**
   * Update the CES client reference after a successful reconnection.
   * Called via the `onCesClientChanged` listener registered in lifecycle.ts.
   * Bumps the generation counter so any pending setCes().then() callback
   * won't overwrite this newer client.
   */
  updateCesClient(client: CesClient | undefined): void {
    this.cesClientGeneration++;
    this.cesClientRef = client;
  }

  /** Optional heartbeat service reference for "Run Now" from the UI. */
  private _heartbeatService?: HeartbeatService;

  setHeartbeatService(service: HeartbeatService): void {
    this._heartbeatService = service;
  }

  getHeartbeatService(): HeartbeatService | undefined {
    return this._heartbeatService;
  }

  /** Optional filing service reference for "Run Now" from the UI. */
  private _filingService?: FilingService;

  setFilingService(service: FilingService): void {
    this._filingService = service;
  }

  getFilingService(): FilingService | undefined {
    return this._filingService;
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
    conversation: Conversation,
    options: ConversationCreateOptions | undefined,
  ): void {
    const transport = options?.transport;
    if (!transport) return;
    log.debug(
      { channelId: transport.channelId },
      "Transport metadata received",
    );
    conversation.setTransportHints(buildTransportHints(transport));
    // Route client-reported host env through the capability-gated setter on
    // Conversation so both the create/reuse path here and the queue-drain
    // path in conversation-process share one implementation. The method
    // gates on `supportsHostProxy` (not a specific interface name), so any
    // new host-capable client added to `HostProxyInterfaceId` will flow its
    // host env through automatically.
    conversation.applyHostEnvFromTransport(transport);
  }

  constructor() {
    this.evictor = new ConversationEvictor(this.conversations);
    getSubagentManager().sharedRequestTimestamps = this.sharedRequestTimestamps;
    getSubagentManager().broadcastToAllClients = (msg) => this.broadcast(msg);
    getSubagentManager().resolveParentConversation = (id) =>
      this.conversations.get(id);
    setBroadcastToAllClients((msg) => this.broadcast(msg));
    setEnsureAppSourceWatcher(() => this.appSourceWatcher.ensureStarted());
    // Wire the skill IPC server into the meet-host supervisor's lazy
    // dispatch path. The supervisor is constructed in
    // `initializeProvidersAndTools()` (via `startMeetHost`), which can run
    // before or after this DaemonServer instance, so the sender flows
    // through a module-level global rather than constructor injection.
    setGlobalSkillIpcSender(this.skillIpc);
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
    getAcpSessionManager().onAcpSessionFinished = async (
      parentConversationId,
      message,
      sendToClient,
    ) => {
      const parentConversation = this.conversations.get(parentConversationId);
      if (!parentConversation) {
        log.warn(
          { parentConversationId },
          "ACP agent finished but parent conversation not found",
        );
        return;
      }
      const requestId = `acp-notify-${Date.now()}`;
      const enqueueResult = parentConversation.enqueueMessage(
        message,
        [],
        sendToClient,
        requestId,
      );
      if (!enqueueResult.queued && !enqueueResult.rejected) {
        const messageId = await parentConversation.persistUserMessage(
          message,
          [],
        );
        parentConversation
          .runAgentLoop(message, messageId, sendToClient)
          .catch((err: unknown) => {
            log.error(
              { parentConversationId, err },
              "Failed to process ACP notification in parent",
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

      // Best-effort sync of the assistant name to the platform record.
      if (fields.name) {
        syncIdentityNameToPlatform(fields.name);
      }
    } catch (err) {
      log.error({ err }, "Failed to broadcast identity change");
    }
  }

  /** Best-effort sync of the IDENTITY.md name to the platform record. */
  private syncIdentityToPlatform(): void {
    try {
      const identityPath = getWorkspacePromptPath("IDENTITY.md");
      const content = existsSync(identityPath)
        ? readFileSync(identityPath, "utf-8")
        : "";
      const fields = parseIdentityFields(content);
      if (fields.name) {
        syncIdentityNameToPlatform(fields.name);
      }
    } catch (err) {
      log.error({ err }, "Failed to sync identity to platform at startup");
    }
  }

  private broadcastConfigChanged(): void {
    this.broadcast({ type: "config_changed" });
  }

  private broadcastSoundsConfigUpdated(): void {
    this.broadcast({ type: "sounds_config_updated" });
  }

  private broadcastFeatureFlagsChanged(): void {
    this.broadcast({ type: "feature_flags_changed" });
  }

  private broadcastAvatarUpdated(): void {
    this.broadcast({
      type: "avatar_updated",
      avatarPath: getAvatarImagePath(),
    });
  }

  /**
   * Handle a detected app source file change from the filesystem watcher.
   * Recompiles multifile apps and refreshes surfaces across ALL conversations.
   */
  private handleAppSourceChange(appId: string): void {
    const app = getApp(appId);
    if (!app) return;

    const doRefresh = () => {
      for (const conversation of this.conversations.values()) {
        refreshSurfacesForApp(conversation, appId, { fileChange: true });
      }
      this.broadcast({ type: "app_files_changed", appId });
      void updatePublishedAppDeployment(appId);
    };

    if (isMultifileApp(app)) {
      const appDir = getAppDirPath(appId);
      void compileApp(appDir)
        .then((result) => {
          if (!result.ok) {
            log.warn(
              { appId, errors: result.errors },
              "Recompile failed on app source change",
            );
          }
          doRefresh();
        })
        .catch((err) => {
          log.warn({ appId, err }, "Recompile threw on app source change");
          doRefresh();
        });
      return;
    }

    doRefresh();
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
      conversation.abort(
        createAbortReason(
          "signal_cancel",
          "registerCancelCallback",
          conversationId,
        ),
      );
      getSubagentManager().abortAllForParent(conversationId);
      return true;
    });

    registerConversationUndoCallback((conversationId) =>
      undoLastMessage(conversationId, this.handlerContext()),
    );

    registerUserMessageCallback(async (params) => {
      // Block messages containing known-format secrets before persistence
      if (!params.bypassSecretCheck) {
        const ingressResult = checkIngressForSecrets(params.content);
        if (ingressResult.blocked) {
          return {
            accepted: false,
            error: "secret_blocked" as const,
            message: ingressResult.userNotice,
          };
        }
      }

      const { conversationId } = getOrCreateConversation(
        params.conversationKey,
      );
      const conversation = await this.getOrCreateConversation(conversationId);

      // Register file-backed attachments so they flow through the send
      // pipeline as images the LLM can see directly.
      const attachmentIds: string[] = [];
      const resolvedAttachments: UserMessageAttachment[] = [];
      if (params.attachments && params.attachments.length > 0) {
        for (const a of params.attachments) {
          try {
            const validation = attachmentsStore.validateAttachmentUpload(
              a.filename,
              a.mimeType,
            );
            if (!validation.ok) {
              log.warn(
                { error: validation.error, path: a.path },
                "Signal attachment rejected by validation",
              );
              continue;
            }
            const size = statSync(a.path).size;
            const stored = attachmentsStore.uploadFileBackedAttachment(
              a.filename,
              a.mimeType,
              a.path,
              size,
            );
            attachmentIds.push(stored.id);
            resolvedAttachments.push({
              id: stored.id,
              filename: a.filename,
              mimeType: a.mimeType,
              data: "",
              filePath: a.path,
            });
          } catch (err) {
            log.warn(
              { err, path: a.path },
              "Failed to register signal attachment",
            );
          }
        }
      }

      // Build a hub-publishing sender so events reach SSE clients.
      const hubSender = (msg: ServerMessage) => {
        const msgConversationId =
          "conversationId" in msg &&
          typeof (msg as { conversationId?: unknown }).conversationId ===
            "string"
            ? (msg as { conversationId: string }).conversationId
            : undefined;
        this.publishAssistantEvent(msg, msgConversationId ?? conversationId);
      };

      if (conversation.isProcessing()) {
        // Hydrate file data now — the queue path won't re-read from
        // the attachment store, so base64 content must be inline.
        for (let i = resolvedAttachments.length - 1; i >= 0; i--) {
          const att = resolvedAttachments[i];
          if (att.filePath && !att.data) {
            try {
              att.data = readFileSync(att.filePath).toString("base64");
            } catch (err) {
              log.warn(
                { err, path: att.filePath },
                "Failed to read queued signal attachment, skipping",
              );
              resolvedAttachments.splice(i, 1);
            }
          }
        }
        const requestId = crypto.randomUUID();
        const resolvedChannel = resolveTurnChannel(params.sourceChannel);
        const resolvedInterface = resolveTurnInterface(params.sourceInterface);
        const result = conversation.enqueueMessage(
          params.content,
          resolvedAttachments,
          hubSender,
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
        attachmentIds.length > 0 ? attachmentIds : undefined,
        { onEvent: hubSender },
        params.sourceChannel,
        params.sourceInterface,
      );
      return { accepted: true };
    });

    // Install the default resolver for `wakeAgentForOpportunity()` so
    // internal subsystems (e.g. the Meet chat-opportunity detector wired
    // up in `MeetSessionManager`) can invoke it without having to build
    // a `WakeTarget` adapter themselves. The adapter wraps a live
    // `Conversation` fetched from the in-memory map / hydrated from the
    // DB, exposing only the narrow surface the wake helper needs.
    registerDefaultWakeResolver(async (conversationId) => {
      try {
        // Only resolve existing conversations — don't create ghost
        // conversations for stale targets (e.g. meetings that ended
        // but a delayed opportunity callback still fires).
        const existing = getConversation(conversationId);
        if (!existing) return null;
        const conversation = await this.getOrCreateConversation(conversationId);
        return conversationToWakeTarget(conversation);
      } catch (err) {
        log.warn(
          { err, conversationId },
          "agent-wake default resolver: failed to hydrate conversation",
        );
        return null;
      }
    });

    // Install the interactive UI resolver so skills and IPC handlers can
    // present ad-hoc UI surfaces (confirmations, forms) to the user via
    // `requestInteractiveUi()`. Interactive UI requires a client to be
    // actively connected to the conversation (via SSE), which means the
    // conversation must be in the in-memory map. If the conversation was
    // evicted from memory the client is definitely disconnected, so
    // hydration from persistent storage is pointless — the hydrated
    // conversation would have hasNoClient=true, causing
    // canShowInteractiveUi() to return false and the surface to be
    // cancelled with no_interactive_surface. We skip that wasted work
    // and return conversation_not_found directly.
    registerInteractiveUiResolver(async (request) => {
      const conversation = this.conversations.get(request.conversationId);

      if (!conversation) {
        log.warn(
          {
            conversationId: request.conversationId,
            surfaceType: request.surfaceType,
          },
          "interactive-ui resolver: conversation not in memory (client not connected); failing closed",
        );
        return {
          status: "cancelled" as const,
          surfaceId: `ui-resolver-${Date.now()}`,
          cancellationReason: "conversation_not_found" as const,
        };
      }

      // Generate a unique surface ID and delegate to the conversation's
      // standalone surface lifecycle. The returned Promise blocks until
      // the user submits, cancels, or the timeout elapses.
      const surfaceId = `ui-standalone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return showStandaloneSurface(conversation, request, surfaceId);
    });

    // Allow `browser_execute` IPC calls to reuse live conversation browser
    // proxy wiring (when a caller passes a conversationId from
    // __CONVERSATION_ID / __SKILL_CONTEXT_JSON). This keeps nested
    // `assistant browser status` checks consistent with the parent turn's
    // extension connectivity instead of always falling back to a synthetic
    // browser-cli session that has no hostBrowserProxy.
    registerBrowserIpcContextResolver((conversationId) => {
      const conversation = this.conversations.get(conversationId);
      if (!conversation) return null;
      return {
        conversationId,
        trustClass: conversation.trustContext?.trustClass ?? "unknown",
        hostBrowserProxy: conversation.hostBrowserProxy,
        transportInterface: conversation.transportInterface,
        hostBrowserRegistryRouted: !!conversation.hostBrowserSenderOverride,
      };
    });

    // Start the CLI IPC server. Built-in methods (wake_conversation) are
    // registered by the constructor; CLI commands connect to this socket to
    // invoke daemon-side operations that require in-process state.
    await this.cliIpc.start();

    // Start the skill IPC server. First-party skill processes connect to this
    // socket to access host capabilities (host.log, host.config.*,
    // host.events.*, host.registries.*). Route registry is populated by
    // subsequent PRs in the skill-isolation plan.
    await this.skillIpc.start();

    // Wire the launchConversation helper to daemon-side state so
    // handleSurfaceAction can spawn conversations through it.
    registerLaunchConversationDeps({
      getOrCreateConversation: (id, options) =>
        this.getOrCreateConversation(id, options),
      persistAndProcessMessage: (
        conversationId,
        content,
        attachmentIds,
        options,
        sourceChannel,
        sourceInterface,
      ) =>
        this.persistAndProcessMessage(
          conversationId,
          content,
          attachmentIds,
          options,
          sourceChannel,
          sourceInterface,
        ),
      publishAssistantEvent: (msg, conversationId) =>
        this.publishAssistantEvent(msg, conversationId),
      getAssistantId: () => this.assistantId,
    });

    this.configWatcher.start(
      () => this.evictConversationsForReload(),
      () => this.broadcastIdentityChanged(),
      () => this.broadcastSoundsConfigUpdated(),
      () => this.broadcastAvatarUpdated(),
      () => this.broadcastConfigChanged(),
      () => this.broadcastFeatureFlagsChanged(),
    );

    this.syncIdentityToPlatform();

    this.appSourceWatcher.start((appId) => this.handleAppSourceChange(appId));

    // Broadcast contacts_changed to all clients when any contact mutation occurs.
    this.unsubscribeContactChange = onContactChange(() => {
      this.broadcast({ type: "contacts_changed" });
    });

    log.info("DaemonServer started (HTTP-only mode)");
  }

  async stop(): Promise<void> {
    getSubagentManager().disposeAll();
    disposeAcpSessionManager();
    this.evictor.stop();
    this.configWatcher.stop();
    this.appSourceWatcher.stop();
    this.cliIpc.stop();
    this.skillIpc.stop();
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

  broadcastStatus(): void {
    this.broadcast({
      type: "assistant_status",
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

  /**
   * Provider instances are captured when conversations are created, so a key
   * change must evict or mark them stale before the next turn.
   */
  refreshConversationsForProviderChange(): void {
    this.evictConversationsForReload();
  }

  private async getOrCreateConversation(
    conversationId: string,
    options?: ConversationCreateOptions,
  ): Promise<Conversation> {
    let conversation = this.conversations.get(conversationId);
    const sendToClient = () => {};

    const { taskRunId: _taskRunId, ...persistentOptions } = options ?? {};
    if (Object.values(persistentOptions).some((v) => v !== undefined)) {
      this.conversationOptions.set(conversationId, {
        ...this.conversationOptions.get(conversationId),
        ...persistentOptions,
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
        let provider = getProvider(config.llm.default.provider);
        // Per-call `options.config.callSite` can resolve to a provider name
        // that differs from `llm.default.provider`. Wrap the default
        // provider so the actual transport routes correctly per call,
        // rather than only forwarding metadata to the default's HTTP
        // client. See `providers/call-site-routing.ts`.
        provider = new CallSiteRoutingProvider(provider, (name) => {
          try {
            return getProvider(name);
          } catch {
            return undefined;
          }
        });
        const { rateLimit } = config;
        if (rateLimit.maxRequestsPerMinute > 0) {
          provider = new RateLimitProvider(
            provider,
            rateLimit,
            this.sharedRequestTimestamps,
          );
        }
        const workingDir = getSandboxWorkingDir();

        const systemPrompt =
          storedOptions?.systemPromptOverride ?? buildSystemPrompt();
        const maxTokens =
          storedOptions?.maxResponseTokens ?? config.llm.default.maxTokens;

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
          storedOptions?.speed,
          undefined,
          storedOptions?.modelOverride,
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
      // Only apply transport metadata when the conversation is idle.
      // When processing, the hints are stored on the queued message and
      // will be applied at dequeue time — applying them here would
      // overwrite the in-flight conversation's transportHints.
      if (!conversation.isProcessing()) {
        this.applyTransportMetadata(conversation, options);
        // trustContext is reapplied here only when the conversation is idle,
        // so concurrent requests cannot overwrite an in-flight turn's guardian
        // scope. Direct callers (e.g. schedule-routes run-now) that invoke
        // processMessage without going through prepareConversationForMessage
        // rely on this to pick up the trustContext passed in options.
        // prepareConversationForMessage also reapplies after its own idle check.
        if (options?.trustContext !== undefined) {
          conversation.setTrustContext(options.trustContext);
        }
      }
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
      filePath?: string;
    }[];
  }> {
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
    conversation.taskRunId = options?.taskRunId;
    // Only overwrite trust/auth context when explicitly provided. Callers that
    // don't supply a trust context (e.g. signal-injected messages) should
    // inherit whatever the conversation already has from a prior session.
    if (options?.trustContext !== undefined) {
      conversation.setTrustContext(options.trustContext);
    }
    if (options?.authContext !== undefined) {
      conversation.setAuthContext(options.authContext);
    }
    await conversation.ensureActorScopedHistory();

    // Persist the conversation's current trust/auth context so it survives
    // eviction and recreation. The restore path in getOrCreateConversation
    // reads from storedOptions.trustContext / storedOptions.authContext.
    // Always write — including null — so explicit clearing isn't lost.
    this.conversationOptions.set(conversationId, {
      ...this.conversationOptions.get(conversationId),
      trustContext: conversation.trustContext,
      authContext: conversation.authContext,
    });
    conversation.setChannelCapabilities(
      resolveChannelCapabilities(
        sourceChannel,
        sourceInterface,
        options?.transport?.chatType,
      ),
    );
    // Chrome-extension host_browser wiring is intentionally not supported
    // through this entry point. `prepareConversationForMessage` constructs
    // host_browser proxies that capture `conversation.getCurrentSender()`
    // directly, which routes browser frames through the daemon SSE channel.
    // This is correct for macOS (SSE-based host proxy), but chrome-extension
    // requires the `ChromeExtensionRegistry` WebSocket transport instead.
    // Chrome-extension flows reach host_browser exclusively through the
    // `/v1/messages` flow in `conversation-routes.ts`, which wires a
    // registry-aware sender and sets `hostBrowserSenderOverride`.
    //
    // Fail loudly rather than silently returning a mis-wired proxy so that
    // any future caller that tries to route chrome-extension through this
    // path discovers the gap immediately. When the time comes, factor the
    // wiring in conversation-routes.ts (registry lookup + override) into a
    // shared helper and call it from both sites.
    if (resolvedInterface === "chrome-extension") {
      throw new Error(
        "prepareConversationForMessage does not yet support chrome-extension transport — " +
          "use the conversation-routes.ts /v1/messages flow which routes host_browser through " +
          "the ChromeExtensionRegistry. If you need chrome-extension here, factor out the " +
          "wiring in conversation-routes.ts into a shared helper.",
      );
    }
    // Only create each host proxy for interfaces that support the matching
    // capability. macOS supports all four; the chrome-extension interface only
    // supports host_browser. Non-desktop conversations (CLI, channels, headless)
    // fall back to local execution.
    // Guard: don't replace an active proxy during concurrent turn races —
    // another request may have started processing between the isProcessing()
    // check above and the await on ensureActorScopedHistory().
    if (supportsHostProxy(resolvedInterface, "host_bash")) {
      if (!conversation.isProcessing() || !conversation.hostBashProxy) {
        conversation.setHostBashProxy(
          new HostBashProxy(conversation.getCurrentSender(), (requestId) => {
            pendingInteractions.resolve(requestId);
          }),
        );
      }
    } else if (!conversation.isProcessing()) {
      conversation.setHostBashProxy(undefined);
    }
    if (supportsHostProxy(resolvedInterface, "host_browser")) {
      if (!conversation.isProcessing() || !conversation.hostBrowserProxy) {
        conversation.setHostBrowserProxy(
          new HostBrowserProxy(conversation.getCurrentSender(), (requestId) => {
            pendingInteractions.resolve(requestId);
          }),
        );
      }
    } else if (!conversation.isProcessing()) {
      conversation.setHostBrowserProxy(undefined);
    }
    if (supportsHostProxy(resolvedInterface, "host_file")) {
      if (!conversation.isProcessing() || !conversation.hostFileProxy) {
        conversation.setHostFileProxy(
          new HostFileProxy(conversation.getCurrentSender(), (requestId) => {
            pendingInteractions.resolve(requestId);
          }),
        );
      }
      if (
        !conversation.isProcessing() ||
        !conversation.getHostTransferProxy()
      ) {
        conversation.setHostTransferProxy(
          new HostTransferProxy(
            conversation.getCurrentSender(),
            (requestId) => {
              pendingInteractions.resolve(requestId);
            },
          ),
        );
      }
    } else if (!conversation.isProcessing()) {
      conversation.setHostFileProxy(undefined);
      conversation.setHostTransferProxy(undefined);
    }
    if (supportsHostProxy(resolvedInterface, "host_cu")) {
      if (!conversation.isProcessing() || !conversation.hostCuProxy) {
        conversation.setHostCuProxy(
          new HostCuProxy(conversation.getCurrentSender(), (requestId) => {
            pendingInteractions.resolve(requestId);
          }),
        );
      }
      conversation.addPreactivatedSkillId("computer-use");
    } else if (!conversation.isProcessing()) {
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
      ? (() => {
          const resolved = attachmentsStore.getAttachmentsByIds(attachmentIds, {
            hydrateFileData: true,
          });
          const sourcePaths =
            attachmentsStore.getSourcePathsForAttachments(attachmentIds);
          return resolved.map((a) => ({
            id: a.id,
            filename: a.originalFilename,
            mimeType: a.mimeType,
            data: a.dataBase64,
            ...(sourcePaths.has(a.id)
              ? { filePath: sourcePaths.get(a.id) }
              : {}),
          }));
        })()
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
    // Non-interactive interfaces that still have a connected client capable
    // of handling host_browser_request events (e.g. chrome-extension) need
    // their hostBrowserProxy explicitly marked connected. The proxy
    // constructor defaults clientConnected = false, so without an explicit
    // sender update the chrome-extension proxy would be created and
    // immediately unavailable. We do NOT call updateClient(onEvent, false)
    // for that case, because flipping hasNoClient false would also enable
    // host_bash/host_file/host_cu tool gating for an interface that can't
    // service them. Instead, provision just the browser proxy's sender.
    const persistInterfaceCtx = conversation.getTurnInterfaceContext();
    const persistInterface = persistInterfaceCtx?.userMessageInterface;
    if (options?.isInteractive === true) {
      conversation.updateClient(onEvent, false);
    } else if (
      persistInterface &&
      !supportsHostProxy(persistInterface) &&
      supportsHostProxy(persistInterface, "host_browser")
    ) {
      conversation.hostBrowserProxy?.updateSender(onEvent, true);
    }

    conversation
      .runAgentLoop(content, messageId, onEvent, {
        isInteractive: options?.isInteractive ?? false,
        isUserMessage: true,
        ...(options?.callSite ? { callSite: options.callSite } : {}),
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

    const config = getConfig();
    const serverInterfaceCtx = conversation.getTurnInterfaceContext();
    const slashContext: SlashContext = {
      messageCount: conversation.getMessages().length,
      inputTokens: conversation.usageStats.inputTokens,
      outputTokens: conversation.usageStats.outputTokens,
      maxInputTokens: config.llm.default.contextWindow.maxInputTokens,
      model: config.llm.default.model,
      provider: config.llm.default.provider,
      estimatedCost: conversation.usageStats.estimatedCost,
      userMessageInterface: serverInterfaceCtx?.userMessageInterface,
    };
    const slashResult = await resolveSlash(content, slashContext);

    // Slack inbound metadata is materialized once here for the slash-command
    // bypass paths (unknown-slash and /compact), which persist the user row
    // directly via `addMessage` and would otherwise drop the envelope. The
    // agent-loop path does not consume this variable — it forwards
    // `options.slackInbound` through `persistMetadata` and the envelope is
    // built internally by `buildSlackMetaForPersistence` inside
    // `persistQueuedMessageBody`.
    const slackMeta = buildSlackMetaForPersistence({
      slackInbound: options?.slackInbound,
      turnChannel: conversation.getTurnChannelContext()?.userMessageChannel,
    });

    if (slashResult.kind === "unknown") {
      const serverTurnCtx = conversation.getTurnChannelContext();
      const serverProvenance = provenanceFromTrustContext(
        conversation.trustContext,
      );
      const imageSourcePaths: Record<string, string> = {};
      for (let i = 0; i < attachments.length; i++) {
        const a = attachments[i];
        if (a.filePath && a.mimeType.toLowerCase().startsWith("image/")) {
          imageSourcePaths[`${i}:${a.filename}`] = a.filePath;
        }
      }
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
        ...(Object.keys(imageSourcePaths).length > 0
          ? { imageSourcePaths }
          : {}),
      };
      // slackMeta encodes the inbound user message's ts/thread — it attaches
      // to the user row only. The assistant's slash-command response does not
      // originate from Slack and must not inherit the user's channelTs, which
      // would break ordering in the chronological renderer.
      const userMetaWithSlack = slackMeta
        ? { ...serverChannelMeta, slackMeta }
        : serverChannelMeta;
      const cleanMsg = createUserMessage(content, attachments);
      const llmMsg = enrichMessageWithSourcePaths(cleanMsg, attachments);
      const persisted = await addMessage(
        conversationId,
        "user",
        JSON.stringify(cleanMsg.content),
        userMetaWithSlack,
      );
      conversation.getMessages().push(llmMsg);

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

      // Rewrite meta.json so the on-disk metadata reflects the origin channel
      if (serverTurnCtx || serverInterfaceCtx) {
        try {
          const convForMeta = getConversation(conversationId);
          if (convForMeta) {
            updateMetaFile(convForMeta);
          }
        } catch (err) {
          log.warn(
            { err, conversationId },
            "Failed to update disk meta (best-effort)",
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

    if (slashResult.kind === "compact") {
      const serverTurnCtx = conversation.getTurnChannelContext();
      const serverProvenance = provenanceFromTrustContext(
        conversation.trustContext,
      );
      const compactChannelMeta = {
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
      const compactUserMeta = slackMeta
        ? { ...compactChannelMeta, slackMeta }
        : compactChannelMeta;
      const cleanMsg = createUserMessage(content, attachments);
      const persisted = await addMessage(
        conversationId,
        "user",
        JSON.stringify(cleanMsg.content),
        compactUserMeta,
      );
      conversation.getMessages().push(cleanMsg);

      conversation.emitActivityState(
        "thinking",
        "context_compacting",
        "assistant_turn",
      );
      const result = await conversation.forceCompact();
      const responseText = formatCompactResult(result);
      const assistantMsg = createAssistantMessage(responseText);
      await addMessage(
        conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        compactChannelMeta,
      );
      conversation.getMessages().push(assistantMsg);
      return { messageId: persisted.id };
    }

    const resolvedContent = slashResult.content;

    const requestId = crypto.randomUUID();
    // Slack inbound metadata captured at the channel ingress boundary is
    // forwarded into the persistence call so `persistQueuedMessageBody` can
    // emit a `slackMeta` envelope on the row's metadata column.
    const persistMetadata = options?.slackInbound
      ? { slackInbound: options.slackInbound }
      : undefined;
    const messageId = await conversation.persistUserMessage(
      resolvedContent,
      attachments,
      requestId,
      persistMetadata,
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
        ...(options?.callSite ? { callSite: options.callSite } : {}),
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
    options?: ConversationCreateOptions,
  ): Promise<Conversation> {
    return this.getOrCreateConversation(conversationId, options);
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
    // Fast path: exact surfaceId match in surfaceState
    for (const c of this.conversations.values()) {
      if (c.surfaceState.has(surfaceId)) return c;
    }

    // Fallback: standalone app surfaces use "app-open-{appId}" IDs that
    // were never part of any conversation.  Extract the appId and find
    // a conversation whose surfaceState has a surface for that app.
    const appOpenPrefix = "app-open-";
    if (surfaceId.startsWith(appOpenPrefix)) {
      const appId = surfaceId.slice(appOpenPrefix.length);
      for (const c of this.conversations.values()) {
        for (const [, state] of c.surfaceState.entries()) {
          const data = state.data as unknown as Record<string, unknown>;
          if (data?.appId === appId) {
            // Register this surfaceId so subsequent lookups are O(1)
            c.surfaceState.set(surfaceId, state);
            return c;
          }
        }
      }
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

/**
 * Translate a raw {@link AgentEvent} from the agent loop into the
 * corresponding {@link ServerMessage} wire frame. The normal user-turn
 * path does this via the full state-aware handler in
 * `conversation-agent-loop-handlers.ts`; the wake path has no tool
 * accounting, title generation, or activity-state tracking to worry
 * about, so we only need the subset that produces client-visible
 * frames. Events that have no client-visible wire shape (usage, error,
 * preview/input-json deltas, etc.) are dropped — they produce no UI.
 *
 * Keeping this translator co-located with the wake adapter preserves
 * the runtime/daemon layering: `runtime/agent-wake.ts` never imports
 * `message-protocol.ts` or wire shapes, and the daemon owns all
 * translation from agent-loop semantics to client frames.
 */
function translateAgentEventToServerMessage(
  event: AgentEvent,
  conversationId: string,
): ServerMessage | null {
  switch (event.type) {
    case "text_delta":
      return {
        type: "assistant_text_delta",
        text: event.text,
        conversationId,
      };
    case "thinking_delta":
      return {
        type: "assistant_thinking_delta",
        thinking: event.thinking,
        conversationId,
      };
    case "tool_use":
      return {
        type: "tool_use_start",
        toolName: event.name,
        input: event.input,
        conversationId,
        toolUseId: event.id,
      };
    case "tool_use_preview_start":
      return {
        type: "tool_use_preview_start",
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        conversationId,
      };
    case "tool_output_chunk":
      return {
        type: "tool_output_chunk",
        chunk: event.chunk,
        conversationId,
        toolUseId: event.toolUseId,
      };
    case "tool_result": {
      const imageBlocks = event.contentBlocks?.filter(
        (b): b is Extract<typeof b, { type: "image" }> => b.type === "image",
      );
      const imageDataList = imageBlocks?.length
        ? imageBlocks.map((b) => b.source.data)
        : undefined;
      return {
        type: "tool_result",
        toolName: "",
        result: event.content,
        isError: event.isError,
        diff: event.diff,
        status: event.status,
        conversationId,
        imageData: imageDataList?.[0],
        imageDataList,
        toolUseId: event.toolUseId,
      };
    }
    case "server_tool_start":
      return {
        type: "tool_use_start",
        toolName: event.name,
        input: event.input,
        conversationId,
        toolUseId: event.toolUseId,
      };
    case "server_tool_complete": {
      let resultText = "";
      if (Array.isArray(event.content) && event.content.length > 0) {
        resultText = (event.content as unknown[])
          .filter(
            (r): r is { type: string; title: string; url: string } =>
              typeof r === "object" &&
              r != null &&
              (r as { type?: string }).type === "web_search_result",
          )
          .map((r) => `${r.title}\n${r.url}`)
          .join("\n\n");
      }
      return {
        type: "tool_result",
        toolName: "web_search",
        result: resultText,
        isError: event.isError,
        conversationId,
        toolUseId: event.toolUseId,
      };
    }
    case "message_complete":
      return {
        type: "message_complete",
        conversationId,
      };
    // No wire frame for these — usage/error/input_json_delta are either
    // server-internal (accounting/classification) or app-only debug
    // streams the client doesn't surface for wake-originated turns.
    case "input_json_delta":
    case "usage":
    case "error":
      return null;
  }
}

/**
 * Adapt a live {@link Conversation} to the narrow {@link WakeTarget}
 * surface expected by `wakeAgentForOpportunity()`. Kept here so the
 * runtime-level wake helper stays decoupled from the heavyweight
 * conversation class (see `registerDefaultWakeResolver` above).
 *
 * Routing notes:
 *   - `emitAgentEvent` dispatches via `broadcastToAllClients` rather
 *     than `sendToClient`. Several signal-injected paths reset
 *     `sendToClient` to a no-op in their `finally` blocks (see the
 *     `updateClient(() => {}, true)` calls in `persistAndProcessMessage`
 *     / `processMessage`), so a wake fired on such a conversation would
 *     find a silent sink. `broadcastToAllClients` is wired to
 *     `this.broadcast(msg)` at construction time and always reaches the
 *     hub, regardless of which sender the most-recent user turn left
 *     behind.
 *   - `persistTailMessage` mirrors the canonical user-turn handlers
 *     (`handleMessageComplete` / the tool-result block in
 *     `conversation-agent-loop-handlers.ts`): builds channel/interface
 *     metadata via `provenanceFromTrustContext` plus the live turn
 *     channel/interface contexts, persists with metadata, and syncs the
 *     resulting row to the disk view so wake-produced messages appear
 *     in the on-disk transcript and carry provenance tags.
 *   - `drainQueue` delegates to the conversation so any user messages
 *     queued while the wake was running are processed. The wake helper
 *     calls this in its finally AFTER `markProcessing(false)`; the
 *     order matters because `enqueueMessage` only queues when
 *     `processing === true`.
 */
function conversationToWakeTarget(conversation: Conversation): WakeTarget {
  return {
    conversationId: conversation.conversationId,
    agentLoop: conversation.agentLoop,
    getMessages: () => conversation.getMessages(),
    pushMessage: (msg) => {
      conversation.messages.push(msg);
    },
    emitAgentEvent: (event) => {
      const frame = translateAgentEventToServerMessage(
        event,
        conversation.conversationId,
      );
      if (!frame) return;
      // Prefer `broadcastToAllClients` (wired to the hub at construction
      // time and always live) over `sendToClient` (which several
      // signal-injected paths reset to `() => {}` in their finally
      // blocks). Fall back to `sendToClient` when the broadcaster is
      // missing (e.g. in tests that construct a Conversation directly).
      if (conversation.broadcastToAllClients) {
        conversation.broadcastToAllClients(frame);
      } else {
        conversation.sendToClient(frame);
      }
    },
    isProcessing: () => conversation.isProcessing(),
    markProcessing: (on) => {
      conversation.processing = on;
    },
    persistTailMessage: async (message) => {
      // Build metadata that mirrors the canonical handlers in
      // `conversation-agent-loop-handlers.ts`. If the live turn channel
      // / interface contexts are missing (a wake can fire on a
      // conversation that has never run a user turn), fall back to the
      // conversation's origin channel/interface defaults (`"vellum"`)
      // so persisted rows still carry valid channel/interface ids.
      const turnChannelCtx = conversation.getTurnChannelContext();
      const turnInterfaceCtx = conversation.getTurnInterfaceContext();
      const metadata: Record<string, unknown> = {
        ...provenanceFromTrustContext(conversation.trustContext),
        userMessageChannel: turnChannelCtx?.userMessageChannel ?? "vellum",
        assistantMessageChannel:
          turnChannelCtx?.assistantMessageChannel ?? "vellum",
        userMessageInterface:
          turnInterfaceCtx?.userMessageInterface ?? "vellum",
        assistantMessageInterface:
          turnInterfaceCtx?.assistantMessageInterface ?? "vellum",
      };
      const persisted = await addMessage(
        conversation.conversationId,
        message.role,
        JSON.stringify(message.content),
        metadata,
      );
      // Sync the persisted row to the disk view so wake-produced
      // messages appear in the on-disk transcript and tools that read
      // from disk (e.g. `messages.jsonl`-based diagnostics) see them.
      // Mirrors the `syncMessageToDisk(...)` calls in the canonical
      // handlers — best-effort because a sync failure must not strand
      // the in-memory tail.
      try {
        const convRow = getConversation(conversation.conversationId);
        if (convRow) {
          syncMessageToDisk(
            conversation.conversationId,
            persisted.id,
            convRow.createdAt,
          );
        }
      } catch (err) {
        log.warn(
          { err, conversationId: conversation.conversationId },
          "wake adapter: syncMessageToDisk failed (non-fatal)",
        );
      }
    },
    drainQueue: () => conversation.drainQueue(),
  };
}
