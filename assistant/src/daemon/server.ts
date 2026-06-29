import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { disposeAcpSessionManager } from "../acp/index.js";
import { compileApp } from "../bundler/app-compiler.js";
import { getConfig } from "../config/loader.js";
import { onContactChange } from "../contacts/contact-events.js";
import { AssistantIpcServer } from "../ipc/assistant-server.js";
import { SkillIpcServer } from "../ipc/skill-server.js";
import { getApp, getAppDirPath, isMultifileApp } from "../memory/app-store.js";
import { syncIdentityNameToPlatform } from "../platform/sync-identity.js";
import { initializeProviders } from "../providers/registry.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { getSigningKeyFingerprint } from "../runtime/auth/token-service.js";
import {
  publishAppsChanged,
  publishAvatarChanged,
  publishConfigChanged,
  publishIdentityChanged,
  publishSoundsConfigUpdated,
} from "../runtime/sync/resource-sync-events.js";
import { updatePublishedAppDeployment } from "../services/published-app-updater.js";
import { getSubagentManager } from "../subagent/index.js";
import { getLogger } from "../util/logger.js";
import { getWorkspacePromptPath } from "../util/platform.js";
import {
  AppSourceWatcher,
  setEnsureAppSourceWatcher,
} from "./app-source-watcher.js";
import { getConfigWatcher } from "./config-watcher.js";
import { Conversation } from "./conversation.js";
import { ConversationEvictor } from "./conversation-evictor.js";
import {
  allConversations,
  conversationEntries,
  deleteConversation,
  getConversationMap,
} from "./conversation-registry.js";
import {
  getOrCreateConversation as getOrCreateActiveConversation,
  initConversationLifecycle,
} from "./conversation-store.js";
import { refreshSurfacesForApp } from "./conversation-surfaces.js";
import { parseIdentityFields } from "./handlers/identity.js";
import type { ConversationCreateOptions } from "./handlers/shared.js";
import { setGlobalSkillIpcSender } from "./meet-host-supervisor.js";
import { refreshSkillCapabilityMemories } from "./skill-memory-refresh.js";

const log = getLogger("server");

function isEaddrInUse(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "EADDRINUSE"
  );
}

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
      publishIdentityChanged(fields);

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
    publishConfigChanged();
  }

  private broadcastSoundsConfigUpdated(): void {
    publishSoundsConfigUpdated();
  }

  private broadcastAvatarUpdated(): void {
    publishAvatarChanged();
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
      publishAppsChanged();
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
      if (isEaddrInUse(err)) {
        log.error(
          { err },
          "CLI IPC socket already in use by another daemon — aborting startup to prevent duplicate processing",
        );
        throw err;
      }
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
      () => refreshSkillCapabilityMemories(getConfig()),
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
