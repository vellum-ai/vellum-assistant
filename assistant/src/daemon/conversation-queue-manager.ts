/**
 * Queue types and data structure extracted from Conversation.
 *
 * Conversation uses MessageQueue to manage the message backlog while an
 * agent loop is in flight.
 */

import type {
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import { getLogger } from "../util/logger.js";
import type {
  ServerMessage,
  UserMessageAttachment,
} from "./message-protocol.js";
import type { ConversationTransportMetadata } from "./message-types/conversations.js";

const log = getLogger("conversation-queue");

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
  /** Transport metadata snapshot captured at enqueue time, applied when this message becomes active. */
  transport?: ConversationTransportMetadata;
  /** Original user message text to persist to DB when recording intent stripping produced a different `content`. */
  displayContent?: string;
  /** Wall-clock time (ms since epoch) when the message was enqueued, used as the display timestamp. */
  sentAt: number;
  /** Client-generated UUID nonce for echo dedup on the originating client. */
  clientMessageId?: string;
}

/**
 * Maximum total estimated bytes across all queued messages per conversation.
 * Limits memory consumption when a sender floods messages while the
 * conversation is busy.  50 MB is well above any legitimate usage.
 */
export const DEFAULT_MAX_QUEUE_BYTES = 50 * 1024 * 1024; // 50 MB

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

/**
 * Typed wrapper around the queued-message array.
 *
 * Conversation owns one instance; the wrapper handles iteration
 * so the rest of Conversation doesn't touch the raw array.
 *
 * A byte budget caps total memory held by queued messages so a
 * high-rate sender cannot exhaust the process.
 */
export class MessageQueue {
  private items: QueuedMessage[] = [];
  private currentBytes = 0;
  private maxBytes: number;

  constructor(maxBytes: number = DEFAULT_MAX_QUEUE_BYTES) {
    this.maxBytes = maxBytes;
  }

  /**
   * Attempt to enqueue a message.
   * Returns `true` if accepted, `false` if rejected (over budget).
   */
  push(item: QueuedMessage): boolean {
    const itemBytes = estimateItemBytes(item);
    if (
      this.currentBytes + itemBytes > this.maxBytes &&
      this.items.length > 0
    ) {
      log.warn(
        {
          requestId: item.requestId,
          queueDepth: this.items.length,
          currentBytes: this.currentBytes,
          itemBytes,
          maxBytes: this.maxBytes,
        },
        "Rejecting queued message: queue byte budget exceeded",
      );
      return false;
    }
    this.items.push(item);
    this.currentBytes += itemBytes;
    return true;
  }

  shift(): QueuedMessage | undefined {
    const item = this.items.shift();
    if (item) {
      this.currentBytes -= estimateItemBytes(item);
    }
    return item;
  }

  /**
   * Read-only access to a queued message by index without mutating the queue.
   * Returns `undefined` when the index is out of range.
   */
  peek(index: number = 0): QueuedMessage | undefined {
    return this.items[index];
  }

  /**
   * Pop up to `count` messages FIFO and return them in order.
   * Decrements the byte budget for each popped item using the same
   * accounting as `shift` / `removeByRequestId`, keeping the bookkeeping
   * centralized here rather than at call sites.
   */
  shiftN(count: number): QueuedMessage[] {
    const n = Math.min(Math.max(0, count), this.items.length);
    if (n === 0) return [];
    const removed = this.items.splice(0, n);
    for (const item of removed) {
      this.currentBytes -= estimateItemBytes(item);
    }
    return removed;
  }

  clear(): void {
    this.items = [];
    this.currentBytes = 0;
  }

  get length(): number {
    return this.items.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  get totalBytes(): number {
    return this.currentBytes;
  }

  /**
   * Remove a queued message by its requestId.
   * Returns the removed message, or undefined if not found.
   */
  removeByRequestId(requestId: string): QueuedMessage | undefined {
    const idx = this.items.findIndex((m) => m.requestId === requestId);
    if (idx === -1) return undefined;
    const [removed] = this.items.splice(idx, 1);
    this.currentBytes -= estimateItemBytes(removed);
    return removed;
  }

  [Symbol.iterator](): Iterator<QueuedMessage> {
    return this.items[Symbol.iterator]();
  }
}

/**
 * Estimate the in-memory byte cost of a queued message.
 * Dominated by content text and attachment `data` (base64 strings).
 */
function estimateItemBytes(item: QueuedMessage): number {
  let bytes = item.content.length * 2; // JS strings are UTF-16
  for (const a of item.attachments) {
    bytes += a.data.length * 2;
    if (a.extractedText) bytes += a.extractedText.length * 2;
  }
  // Include transport metadata in the estimate so large transport
  // payloads (e.g. hostHomeDir, hostUsername) count against the budget.
  if (item.transport) {
    bytes += JSON.stringify(item.transport).length * 2;
  }
  // Small fixed overhead for metadata, pointers, etc. (not worth
  // measuring precisely — the content/attachment data dominates).
  bytes += 512;
  return bytes;
}
