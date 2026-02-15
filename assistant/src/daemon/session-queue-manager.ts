/**
 * Queue types and data structure extracted from Session.
 *
 * Session uses MessageQueue to manage the message backlog while an
 * agent loop is in flight.
 */

import type { ServerMessage, UserMessageAttachment } from './ipc-protocol.js';

export interface QueuedMessage {
  content: string;
  attachments: UserMessageAttachment[];
  requestId: string;
  onEvent: (msg: ServerMessage) => void;
  activeSurfaceId?: string;
}

export const MAX_QUEUE_DEPTH = 10;

/**
 * Describes why a queued message was promoted from the queue.
 * - `loop_complete`: the agent loop finished normally and the next message was drained.
 * - `checkpoint_handoff`: a turn-boundary checkpoint decided to yield to the queued message.
 */
export type QueueDrainReason = 'loop_complete' | 'checkpoint_handoff';

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
 * Session owns one instance; the wrapper handles capacity checks and
 * iteration so the rest of Session doesn't touch the raw array.
 */
export class MessageQueue {
  private items: QueuedMessage[] = [];

  push(item: QueuedMessage): boolean {
    if (this.items.length >= MAX_QUEUE_DEPTH) return false;
    this.items.push(item);
    return true;
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

  [Symbol.iterator](): Iterator<QueuedMessage> {
    return this.items[Symbol.iterator]();
  }
}
