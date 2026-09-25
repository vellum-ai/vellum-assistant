import { listGuardianRequests } from "../channels/gateway-guardian-requests.js";
import { getConfig } from "../config/loader.js";
import { isSidebarDoneEnabled } from "../config/sidebar-done-gate.js";
import {
  getDbMigrationReadiness,
  isStartupComplete,
} from "../daemon/daemon-readiness.js";
import { SYNC_TAGS } from "../daemon/message-types/sync.js";
import {
  archiveInactiveConversation,
  type AutoArchiveCandidate,
  listAutoArchiveCandidates,
} from "../persistence/conversation-auto-archive.js";
import {
  assistantEventHub,
  type AssistantEventSubscription,
} from "../runtime/assistant-event-hub.js";
import { publishConversationListAndMetadataChanged } from "../runtime/sync/resource-sync-events.js";
import { getLogger } from "../util/logger.js";
import { withSqliteRetry } from "../util/sqlite-retry.js";
import { hasAutoArchiveBlockingWork } from "./auto-archive-activity.js";

const log = getLogger("conversation:auto-archive");
const DAY_MS = 24 * 60 * 60 * 1_000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
const PAGE_SIZE = 100;

export class ConversationAutoArchiveWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private subscription: AssistantEventSubscription | undefined;
  private controller: AbortController | undefined;
  private recoveryComplete = false;
  private running: Promise<void> | undefined;
  private rerunRequested = false;

  start(startupRecovery: Promise<void> = Promise.resolve()): void {
    if (this.controller) {
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.recoveryComplete = false;
    this.subscription = assistantEventHub.subscribe({
      type: "process",
      callback: ({ message }) => {
        if (
          message.type === "sync_changed" &&
          message.tags.includes(SYNC_TAGS.assistantConfig)
        ) {
          void this.requestSweep();
        }
      },
    });
    this.timer = setInterval(() => void this.requestSweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
    void startupRecovery
      .then(() => {
        if (this.controller !== controller || controller.signal.aborted) {
          return;
        }
        this.recoveryComplete = true;
        void this.requestSweep();
      })
      .catch((err: unknown) => {
        log.warn(
          { err },
          "Startup recovery did not settle safely; automatic Done is paused until restart",
        );
      });
  }

  stop(): void {
    this.controller?.abort();
    this.controller = undefined;
    clearInterval(this.timer);
    this.timer = undefined;
    this.subscription?.dispose();
    this.subscription = undefined;
    this.recoveryComplete = false;
    this.rerunRequested = false;
  }

  requestSweep(): Promise<void> {
    if (!this.controller || !this.recoveryComplete) {
      return Promise.resolve();
    }
    if (this.running) {
      this.rerunRequested = true;
      return this.running;
    }
    const controller = this.controller;
    this.running = this.sweep(controller.signal)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          log.warn(
            { err },
            "Automatic Done sweep failed; eligible chats remain available",
          );
        }
      })
      .finally(() => {
        this.running = undefined;
        if (this.rerunRequested) {
          this.rerunRequested = false;
          void this.requestSweep();
        }
      });
    return this.running;
  }

  private enabledAfterDays(): number | undefined {
    if (!getDbMigrationReadiness().ready || !isStartupComplete()) {
      return undefined;
    }
    const config = getConfig();
    return isSidebarDoneEnabled(config) &&
      config.conversations.autoArchive.enabled
      ? config.conversations.autoArchive.afterDays
      : undefined;
  }

  private async sweep(signal: AbortSignal): Promise<void> {
    const afterDays = this.enabledAfterDays();
    if (afterDays === undefined || signal.aborted) {
      return;
    }
    const cutoff = Date.now() - afterDays * DAY_MS;
    let after: AutoArchiveCandidate | undefined;
    let total = 0;
    const stillCurrent = () =>
      !signal.aborted && this.enabledAfterDays() === afterDays;

    while (stillCurrent()) {
      const candidates = listAutoArchiveCandidates({
        cutoff,
        limit: PAGE_SIZE,
        after,
      });
      if (candidates.length === 0) {
        break;
      }
      // The gateway list is exhaustive. Failure leaves this page untouched.
      const requests = await listGuardianRequests({ status: "pending" });
      const awaitingInput = new Set(
        requests.map((request) => request.sourceConversationId),
      );
      const changed: string[] = [];
      try {
        for (const candidate of candidates) {
          if (!stillCurrent()) {
            break;
          }
          if (awaitingInput.has(candidate.id)) {
            continue;
          }
          const archived = await withSqliteRetry(
            () => {
              if (!stillCurrent() || hasAutoArchiveBlockingWork(candidate.id)) {
                return false;
              }
              return archiveInactiveConversation(candidate, cutoff, Date.now());
            },
            {
              op: "conversation:autoArchive",
              context: { conversationId: candidate.id },
              signal,
            },
          );
          if (archived) {
            changed.push(candidate.id);
          }
        }
      } finally {
        if (changed.length > 0) {
          publishConversationListAndMetadataChanged("reordered", changed);
          total += changed.length;
        }
      }
      after = candidates[candidates.length - 1];
      if (candidates.length < PAGE_SIZE) {
        break;
      }
    }
    if (total > 0) {
      log.info({ count: total, afterDays }, "Marked inactive chats Done");
    }
  }
}

const worker = new ConversationAutoArchiveWorker();

export function startConversationAutoArchive(
  startupRecovery: Promise<void>,
): void {
  worker.start(startupRecovery);
}

export function stopConversationAutoArchive(): void {
  worker.stop();
}
