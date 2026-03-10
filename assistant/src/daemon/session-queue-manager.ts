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
import type { ServerMessage, UserMessageAttachment } from "./message-protocol.js";

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
 * Session owns one instance; the wrapper handles iteration
 * so the rest of Session doesn't touch the raw array.
 */
export class MessageQueue {
  private items: QueuedMessage[] = [];

  push(item: QueuedMessage): void {
    item.queuedAt = Date.now();
    this.items.push(item);
  }

  shift(): QueuedMessage | undefined {
    return this.items.shift();
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

  [Symbol.iterator](): Iterator<QueuedMessage> {
    return this.items[Symbol.iterator]();
  }
}
