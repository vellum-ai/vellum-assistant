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
import type { ServerMessage, UserMessageAttachment } from "./ipc-protocol.js";

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

export const MAX_QUEUE_DEPTH = 10;
const CAPACITY_WARNING_THRESHOLD = 0.8;

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
  totalDropped: number;
  /** Average wait time (ms) of dequeued messages. 0 when no messages have been dequeued. */
  averageWaitMs: number;
}

/**
 * Typed wrapper around the queued-message array.
 *
 * Session owns one instance; the wrapper handles capacity checks,
 * metrics, and iteration so the rest of Session doesn't
 * touch the raw array.
 */
export class MessageQueue {
  private items: QueuedMessage[] = [];
  private droppedCount = 0;
  private totalWaitMs = 0;
  private dequeuedCount = 0;
  private capacityWarned = false;

  push(item: QueuedMessage): boolean {
    if (this.items.length >= MAX_QUEUE_DEPTH) {
      this.droppedCount++;
      return false;
    }

    item.queuedAt = Date.now();
    this.items.push(item);

    const ratio = this.items.length / MAX_QUEUE_DEPTH;
    if (ratio >= CAPACITY_WARNING_THRESHOLD && !this.capacityWarned) {
      this.capacityWarned = true;
      log.warn(
        { depth: this.items.length, max: MAX_QUEUE_DEPTH },
        "Queue nearing capacity",
      );
    } else if (ratio < CAPACITY_WARNING_THRESHOLD) {
      this.capacityWarned = false;
    }

    return true;
  }

  shift(): QueuedMessage | undefined {
    const item = this.items.shift();
    if (item) {
      this.dequeuedCount++;
      this.totalWaitMs += Date.now() - item.queuedAt;
    }
    if (this.items.length / MAX_QUEUE_DEPTH < CAPACITY_WARNING_THRESHOLD) {
      this.capacityWarned = false;
    }
    return item;
  }

  clear(): void {
    this.items = [];
    this.capacityWarned = false;
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
      totalDropped: this.droppedCount,
      averageWaitMs:
        this.dequeuedCount > 0 ? this.totalWaitMs / this.dequeuedCount : 0,
    };
  }

  /**
   * Rearrange the queue to match the given order of requestIds.
   * Items whose requestIds are in the array are placed first (in the given order);
   * items not mentioned keep their relative order at the end.
   */
  reorder(requestIds: string[]): string[] {
    const idSet = new Set(requestIds);
    const ordered: QueuedMessage[] = [];
    const remaining: QueuedMessage[] = [];

    const byId = new Map<string, QueuedMessage>();
    for (const item of this.items) {
      byId.set(item.requestId, item);
    }

    for (const id of requestIds) {
      const item = byId.get(id);
      if (item) ordered.push(item);
    }

    for (const item of this.items) {
      if (!idSet.has(item.requestId)) remaining.push(item);
    }

    this.items = [...ordered, ...remaining];
    return this.items.map((item) => item.requestId);
  }

  /**
   * Drain the entire queue, returning all items at once.
   * Updates dequeue metrics for each item.
   */
  shiftAll(): QueuedMessage[] {
    const all = this.items;
    this.items = [];
    const now = Date.now();
    for (const item of all) {
      this.dequeuedCount++;
      this.totalWaitMs += now - item.queuedAt;
    }
    this.capacityWarned = false;
    return all;
  }

  [Symbol.iterator](): Iterator<QueuedMessage> {
    return this.items[Symbol.iterator]();
  }
}
