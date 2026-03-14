/**
 * File-based event stream for cross-process assistant event delivery.
 *
 * The daemon appends JSON-line events to per-conversation files under
 * `signals/events/<conversationId>`. The CLI watches these files and
 * reads new lines as they arrive.
 *
 * Write side: {@link appendEventToStream} (called by DaemonServer.broadcast)
 * Read side: {@link watchEventStream} (called by the CLI)
 */

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { AssistantEvent } from "../runtime/assistant-event.js";
import { getSignalsDir } from "../util/platform.js";

// ── Write side (daemon) ──────────────────────────────────────────────

function eventsDir(): string {
  return join(getSignalsDir(), "events");
}

/**
 * Append a serialized event to the conversation's event stream file.
 * Called by the daemon's broadcast path to dual-write events for
 * cross-process consumers (e.g. the built-in CLI).
 */
export function appendEventToStream(
  conversationId: string,
  event: AssistantEvent,
): void {
  const dir = eventsDir();
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, conversationId), JSON.stringify(event) + "\n");
}

// ── Read side (CLI) ──────────────────────────────────────────────────

/** Handle returned by {@link watchEventStream}. Call `dispose()` to stop. */
export interface EventStreamWatcher {
  dispose(): void;
}

/**
 * Watch a conversation's event stream file and invoke `callback` for
 * each new {@link AssistantEvent} line appended after the call.
 *
 * Existing file content is skipped — only events written after the
 * watcher is created are delivered.
 */
export function watchEventStream(
  conversationId: string,
  callback: (event: AssistantEvent) => void,
): EventStreamWatcher {
  const dir = eventsDir();
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, conversationId);

  // Ensure the file exists so fs.watch doesn't fail.
  let offset: number;
  try {
    offset = statSync(filePath).size;
  } catch {
    writeFileSync(filePath, "");
    offset = 0;
  }

  let disposed = false;

  const readNewLines = (): void => {
    if (disposed) return;
    let fd: number | undefined;
    try {
      fd = openSync(filePath, "r");
      const size = statSync(filePath).size;
      if (size <= offset) return;
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      offset = size;

      const lines = buf.toString("utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as AssistantEvent;
          callback(event);
        } catch {
          // Skip malformed lines.
        }
      }
    } catch {
      // File may have been removed or is not yet readable.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };

  const watcher = watch(filePath, () => {
    readNewLines();
  });

  return {
    dispose() {
      if (!disposed) {
        disposed = true;
        watcher.close();
      }
    },
  };
}
