// Re-export all contract types for backward compatibility
export * from './ipc-contract.js';

import type { ClientMessage, ServerMessage } from './ipc-contract.js';

// === Serialization ===

/**
 * Maximum size of a single line in the IPC buffer (96MB).
 *
 * Attachment payloads are sent inline as base64 in `user_message`, so the
 * parser must tolerate large partial frames before the terminating newline
 * arrives.
 */
export const MAX_LINE_SIZE = 96 * 1024 * 1024;

export function serialize(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg) + '\n';
}

export function createMessageParser(options?: { maxLineSize?: number }) {
  let buffer = '';
  const maxLineSize = options?.maxLineSize;

  return {
    feed(data: string): Array<ClientMessage | ServerMessage> {
      buffer += data;
      const messages: Array<ClientMessage | ServerMessage> = [];
      const lines = buffer.split('\n');
      // Keep the last partial line in the buffer
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          try {
            messages.push(JSON.parse(trimmed));
          } catch {
            // Skip malformed messages
          }
        }
      }
      if (maxLineSize != null && buffer.length > maxLineSize) {
        buffer = '';
        throw new Error(
          `IPC message exceeds maximum line size of ${maxLineSize} bytes. Message discarded.`,
        );
      }
      return messages;
    },
  };
}
