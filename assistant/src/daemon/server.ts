import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { disposeAcpSessionManager } from "../acp/index.js";
import { getConfig } from "../config/loader.js";
import { syncIdentityNameToPlatform } from "../platform/sync-identity.js";
import { initializeProviders } from "../providers/registry.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { getSigningKeyFingerprint } from "../runtime/auth/token-service.js";
import { getSubagentManager } from "../subagent/index.js";
import { getLogger } from "../util/logger.js";
import { getWorkspacePromptPath } from "../util/platform.js";
import { Conversation } from "./conversation.js";
import { ConversationEvictor } from "./conversation-evictor.js";
import { getConversationMap } from "./conversation-registry.js";
import {
  getOrCreateConversation as getOrCreateActiveConversation,
  initConversationLifecycle,
} from "./conversation-store.js";
import { parseIdentityFields } from "./handlers/identity.js";
import type { ConversationCreateOptions } from "./handlers/shared.js";

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
  private evictor: ConversationEvictor;

  constructor() {
    this.evictor = new ConversationEvictor(getConversationMap());
    getSubagentManager().sharedRequestTimestamps = this.sharedRequestTimestamps;

    initConversationLifecycle({
      evictor: this.evictor,
      sharedRequestTimestamps: this.sharedRequestTimestamps,
    });

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

  // ── Server lifecycle ────────────────────────────────────────────────

  async start(): Promise<void> {
    const config = getConfig();
    await initializeProviders(config);

    this.evictor.start();

    this.syncIdentityToPlatform();

    log.info("DaemonServer started (HTTP-only mode)");
  }

  async stop(): Promise<void> {
    getSubagentManager().disposeAll();
    disposeAcpSessionManager();
    this.evictor.stop();

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
