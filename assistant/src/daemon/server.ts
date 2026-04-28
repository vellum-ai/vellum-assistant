import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  disposeAcpSessionManager,
  getAcpSessionManager,
  setBroadcastToAllClients,
} from "../acp/index.js";
import { compileApp } from "../bundler/app-compiler.js";
import { getConfig } from "../config/loader.js";
import { onContactChange } from "../contacts/contact-events.js";
import type { CesClient } from "../credential-execution/client.js";
import type { CesProcessManager } from "../credential-execution/process-manager.js";
import { AssistantIpcServer } from "../ipc/assistant-server.js";
import { SkillIpcServer } from "../ipc/skill-server.js";
import { getApp, getAppDirPath, isMultifileApp } from "../memory/app-store.js";
import {
  uploadFileBackedAttachment,
  validateAttachmentUpload,
} from "../memory/attachments-store.js";
import { getOrCreateConversation } from "../memory/conversation-key-store.js";
import { syncIdentityNameToPlatform } from "../platform/sync-identity.js";
import { initializeProviders } from "../providers/registry.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { getSigningKeyFingerprint } from "../runtime/auth/token-service.js";
import { checkIngressForSecrets } from "../security/secret-ingress.js";
import { updatePublishedAppDeployment } from "../services/published-app-updater.js";
import { registerCancelCallback } from "../signals/cancel.js";
import { registerConversationUndoCallback } from "../signals/conversation-undo.js";
import { appendEventToStream } from "../signals/event-stream.js";
import { registerUserMessageCallback } from "../signals/user-message.js";
import { getSubagentManager } from "../subagent/index.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { getLogger } from "../util/logger.js";
import {
  getAvatarImagePath,
  getWorkspacePromptPath,
} from "../util/platform.js";
import { registerDaemonCallbacks } from "../work-items/work-item-runner.js";
import {
  AppSourceWatcher,
  setEnsureAppSourceWatcher,
} from "./app-source-watcher.js";
import { getConfigWatcher } from "./config-watcher.js";
import { Conversation } from "./conversation.js";
import { ConversationEvictor } from "./conversation-evictor.js";
import { registerLaunchConversationDeps } from "./conversation-launch.js";
import {
  allConversations,
  clearConversations,
  conversationEntries,
  deleteConversation,
  findConversation,
  getConversationMap,
  getOrCreateConversation as getOrCreateActiveConversation,
  initConversationLifecycle,
  setCesClientPromise,
} from "./conversation-store.js";
import { refreshSurfacesForApp } from "./conversation-surfaces.js";
import { undoLastMessage } from "./handlers/conversations.js";
import { parseIdentityFields } from "./handlers/identity.js";
import type { ConversationCreateOptions } from "./handlers/shared.js";
import { setGlobalSkillIpcSender } from "./meet-host-supervisor.js";
import type {
  ServerMessage,
  UserMessageAttachment,
} from "./message-protocol.js";
import {
  makePendingInteractionRegistrar,
  prepareConversationForMessage,
  resolveTurnChannel,
  resolveTurnInterface,
} from "./process-message.js";

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

export class DaemonServer {
  private sharedRequestTimestamps: number[] = [];
  private unsubscribeContactChange: (() => void) | null = null;
  private evictor: ConversationEvictor;
  private _hubChain: Promise<void> = Promise.resolve();

  // Composed subsystems
  private configWatcher = getConfigWatcher();
  private appSourceWatcher = new AppSourceWatcher();
  private cliIpc = new AssistantIpcServer();
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
      setCesClientPromise(this.cesClientPromise);
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

  constructor() {
    this.evictor = new ConversationEvictor(getConversationMap());
    getSubagentManager().sharedRequestTimestamps = this.sharedRequestTimestamps;
    getSubagentManager().broadcastToAllClients = (msg) => this.broadcast(msg);
    initConversationLifecycle({
      evictor: this.evictor,
      sharedRequestTimestamps: this.sharedRequestTimestamps,
    });
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
      const parentConversation = findConversation(parentConversationId);
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
      const parentConversation = findConversation(parentConversationId);
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
    const event = buildAssistantEvent(msg, conversationId);
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
      for (const conversation of allConversations()) {
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
        getOrCreateActiveConversation(conversationId),
      broadcast: (msg) => this.broadcast(msg),
    });

    registerCancelCallback((conversationId) => {
      const conversation = findConversation(conversationId);
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
      undoLastMessage(conversationId),
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
      const conversation = await getOrCreateActiveConversation(conversationId);

      // Register file-backed attachments so they flow through the send
      // pipeline as images the LLM can see directly.
      const attachmentIds: string[] = [];
      const resolvedAttachments: UserMessageAttachment[] = [];
      if (params.attachments && params.attachments.length > 0) {
        for (const a of params.attachments) {
          try {
            const validation = validateAttachmentUpload(a.filename, a.mimeType);
            if (!validation.ok) {
              log.warn(
                { error: validation.error, path: a.path },
                "Signal attachment rejected by validation",
              );
              continue;
            }
            const size = statSync(a.path).size;
            const stored = uploadFileBackedAttachment(
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
        getOrCreateActiveConversation(id, options),
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
    });

    this.configWatcher.start(
      () => this.evictConversationsForReload(),
      () => this.broadcastIdentityChanged(),
      () => this.broadcastSoundsConfigUpdated(),
      () => this.broadcastAvatarUpdated(),
      () => this.broadcastConfigChanged(),
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

    for (const conversation of allConversations()) {
      conversation.dispose();
    }
    clearConversations();

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
      setCesClientPromise(undefined);
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

  private evictConversationsForReload(): void {
    const subagentManager = getSubagentManager();
    for (const [id, conversation] of conversationEntries()) {
      if (!conversation.isProcessing()) {
        subagentManager.abortAllForParent(id);
        conversation.dispose();
        deleteConversation(id);
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

  // ── HTTP message processing ─────────────────────────────────────────

  async persistAndProcessMessage(
    conversationId: string,
    content: string,
    attachmentIds?: string[],
    options?: ConversationCreateOptions,
    sourceChannel?: string,
    sourceInterface?: string,
  ): Promise<{ messageId: string }> {
    const { conversation, attachments } = await prepareConversationForMessage(
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

  /**
   * Expose conversation lookup for the POST /v1/messages handler.
   * The handler manages busy-state checking and queueing itself.
   */
  async getConversationForMessages(
    conversationId: string,
    options?: ConversationCreateOptions,
  ): Promise<Conversation> {
    return getOrCreateActiveConversation(conversationId, options);
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
