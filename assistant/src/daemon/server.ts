import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { disposeAcpSessionManager } from "../acp/index.js";
import { compileApp } from "../bundler/app-compiler.js";
import { getConfig } from "../config/loader.js";
import { onContactChange } from "../contacts/contact-events.js";
import type { CesClient } from "../credential-execution/client.js";
import type { CesProcessManager } from "../credential-execution/process-manager.js";
import { AssistantIpcServer } from "../ipc/assistant-server.js";
import { SkillIpcServer } from "../ipc/skill-server.js";
import { getApp, getAppDirPath, isMultifileApp } from "../memory/app-store.js";
import { syncIdentityNameToPlatform } from "../platform/sync-identity.js";
import { initializeProviders } from "../providers/registry.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { getSigningKeyFingerprint } from "../runtime/auth/token-service.js";
import { updatePublishedAppDeployment } from "../services/published-app-updater.js";
import { getSubagentManager } from "../subagent/index.js";
import { getLogger } from "../util/logger.js";
import {
  getAvatarImagePath,
  getWorkspacePromptPath,
} from "../util/platform.js";
import {
  AppSourceWatcher,
  setEnsureAppSourceWatcher,
} from "./app-source-watcher.js";
import { getConfigWatcher } from "./config-watcher.js";
import { Conversation } from "./conversation.js";
import { ConversationEvictor } from "./conversation-evictor.js";
import {
  allConversations,
  clearConversations,
  conversationEntries,
  deleteConversation,
  getConversationMap,
  getOrCreateConversation as getOrCreateActiveConversation,
  initConversationLifecycle,
  setCesClientPromise,
} from "./conversation-store.js";
import { refreshSurfacesForApp } from "./conversation-surfaces.js";
import { parseIdentityFields } from "./handlers/identity.js";
import type { ConversationCreateOptions } from "./handlers/shared.js";
import { setGlobalSkillIpcSender } from "./meet-host-supervisor.js";

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

    initConversationLifecycle({
      evictor: this.evictor,
      sharedRequestTimestamps: this.sharedRequestTimestamps,
    });

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
  }

  private broadcastIdentityChanged(): void {
    try {
      const identityPath = getWorkspacePromptPath("IDENTITY.md");
      const content = existsSync(identityPath)
        ? readFileSync(identityPath, "utf-8")
        : "";
      const fields = parseIdentityFields(content);
      broadcastMessage({
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
    broadcastMessage({ type: "config_changed" });
  }

  private broadcastSoundsConfigUpdated(): void {
    broadcastMessage({ type: "sounds_config_updated" });
  }

  private broadcastAvatarUpdated(): void {
    broadcastMessage({
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
      broadcastMessage({ type: "app_files_changed", appId });
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

    try {
      await this.cliIpc.start();
    } catch (err) {
      log.warn(
        { err },
        "CLI IPC server failed to start — continuing startup with degraded CLI connectivity",
      );
    }

    // Start the skill IPC server. First-party skill processes connect to this
    // socket to access host capabilities (host.log, host.config.*,
    // host.events.*, host.registries.*). Route registry is populated by
    // subsequent PRs in the skill-isolation plan.
    try {
      await this.skillIpc.start();
    } catch (err) {
      log.warn(
        { err },
        "Skill IPC server failed to start — continuing startup with degraded skill host connectivity",
      );
    }

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
      broadcastMessage({ type: "contacts_changed" });
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
    broadcastMessage({
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
