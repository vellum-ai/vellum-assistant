/**
 * Queue types and data structure extracted from Session.
 *
 * Session uses MessageQueue to manage the message backlog while an
 * agent loop is in flight.
 */

import type {
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import { getLogger } from "../util/logger.js";
import type { ServerMessage, UserMessageAttachment } from "./message-protocol.js";

const log = getLogger("session-queue");

export interface QueuedMessage {
  content: string;
  attachments: UserMessageAttachment[];
  requestId: string;
  onEvent: (msg: ServerMessage) => void;
  activeSurfaceId?: string;
  currentPage?: string;
  metadata?: Record<string, unknown>;
  turnChannelContext?: TurnChannelContext;
  turnInterfaceContext?: TurnInterfaceContext;
  /** When false, the turn has no interactive user and should skip clarification prompts. */
  isInteractive?: boolean;
  /** Timestamp (ms) when the message was enqueued. */
  queuedAt: number;
  /** Original user message text to persist to DB when recording intent stripping produced a different `content`. */
  displayContent?: string;
}

/** Messages older than this (ms) are auto-expired from the queue. */
export const DEFAULT_MAX_WAIT_MS = 60_000;

/**
 * Describes why a queued message was promoted from the queue.
 * - `loop_complete`: the agent loop finished normally and the next message was drained.
 * - `checkpoint_handoff`: a turn-boundary checkpoint decided to yield to the queued message.
 */
export type QueueDrainReason = "loop_complete" | "checkpoint_handoff";

/**
 * Configuration for how/when checkpoint handoff is allowed.
 * When `checkpointHandoffEnabled` is true, the agent loop may yield at
 * a turn boundary if there are queued messages waiting.
 */
export interface QueuePolicy {
  checkpointHandoffEnabled: boolean;
}

export interface QueueMetrics {
  currentDepth: number;
  totalExpired: number;
  /** Average wait time (ms) of dequeued messages. 0 when no messages have been dequeued. */
  averageWaitMs: number;
}

/**
 * Typed wrapper around the queued-message array.
 *
 * Session owns one instance; the wrapper handles expiry, metrics,
 * and iteration so the rest of Session doesn't touch the raw array.
 */
export class MessageQueue {
  private items: QueuedMessage[] = [];
  private maxWaitMs: number;
  private expiredCount = 0;
  private totalWaitMs = 0;
  private dequeuedCount = 0;

  constructor(maxWaitMs: number = DEFAULT_MAX_WAIT_MS) {
    this.maxWaitMs = maxWaitMs;
  }

  push(item: QueuedMessage): void {
    this.expireStale();
    item.queuedAt = Date.now();
    this.items.push(item);
  }

  shift(): QueuedMessage | undefined {
    this.expireStale();
    const item = this.items.shift();
    if (item) {
      this.dequeuedCount++;
      this.totalWaitMs += Date.now() - item.queuedAt;
    }
    return item;
  }

  clear(): void {
    this.items = [];
  }

  get length(): number {
    return this.items.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  /**
   * Remove a queued message by its requestId.
   * Returns the removed message, or undefined if not found.
   */
  removeByRequestId(requestId: string): QueuedMessage | undefined {
    const idx = this.items.findIndex((m) => m.requestId === requestId);
    if (idx === -1) return undefined;
    return this.items.splice(idx, 1)[0];
  }

  getMetrics(): QueueMetrics {
    return {
      currentDepth: this.items.length,
      totalExpired: this.expiredCount,
      averageWaitMs:
        this.dequeuedCount > 0 ? this.totalWaitMs / this.dequeuedCount : 0,
    };
  }

  /** Remove messages that have been waiting longer than maxWaitMs. */
  private expireStale(): void {
    const now = Date.now();
    const cutoff = now - this.maxWaitMs;
    const expired: QueuedMessage[] = [];
    this.items = this.items.filter((item) => {
      if (item.queuedAt < cutoff) {
        this.expiredCount++;
        expired.push(item);
        return false;
      }
      return true;
    });
    for (const item of expired) {
      log.warn(
        { requestId: item.requestId, waitMs: now - item.queuedAt },
        "Expiring stale queued message",
      );
      try {
        item.onEvent({
          type: "error",
          message:
            "Your queued message was dropped because it waited too long in the queue.",
          category: "queue_expired",
        });
      } catch (e) {
        log.debug(
          { err: e, requestId: item.requestId },
          "Failed to notify client of expired message",
        );
      }
    }
  }

  [Symbol.iterator](): Iterator<QueuedMessage> {
    return this.items[Symbol.iterator]();
  }
}
