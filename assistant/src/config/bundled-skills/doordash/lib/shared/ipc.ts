/**
 * Minimal IPC serialization/parsing for daemon communication.
 * Inlined from assistant/src/daemon/ipc-protocol.ts (stripped of type dependencies).
 */

export function serialize(msg: Record<string, unknown>): string {
  return JSON.stringify(msg) + "\n";
}

export function createMessageParser() {
  let buffer = "";

  return {
    feed(data: string): Array<Record<string, unknown>> {
      buffer += data;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      const results: Array<Record<string, unknown>> = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          try {
            results.push(JSON.parse(trimmed) as Record<string, unknown>);
          } catch {
            // Skip malformed messages
          }
        }
      }
      return results;
    },
  };
}
