/**
 * File-based event stream for cross-process assistant event delivery.
 *
 * Subscribers (e.g. the built-in CLI) create a file under
 * `signals/events/<conversationId>` via {@link watchEventStream}.
 * The daemon appends JSON-line events to every existing subscriber
 * file via {@link appendEventToStream}. When a subscriber disposes
 * its watcher the file is removed, so the daemon stops writing.
 *
 * Write side: {@link appendEventToStream} (called by DaemonServer.broadcast)
 * Read side: {@link watchEventStream} (called by the CLI)
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
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
 * Append a serialized event to every active subscriber file for the
 * given conversation. If no subscriber files exist the call is a no-op,
 * so the daemon never writes events that nobody is listening to.
 */
export function appendEventToStream(
  conversationId: string,
  event: AssistantEvent,
): void {
  const dir = eventsDir();
  if (!existsSync(dir)) return;

  const prefix = `${conversationId}.`;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith(prefix));
  } catch {
    return;
  }
  if (files.length === 0) return;

  const line = JSON.stringify(event) + "\n";
  for (const file of files) {
    try {
      appendFileSync(join(dir, file), line);
    } catch {
      // Best-effort per subscriber.
    }
  }
}

// ── Read side (CLI) ──────────────────────────────────────────────────

/** Handle returned by {@link watchEventStream}. Call `dispose()` to stop. */
export interface EventStreamWatcher {
  dispose(): void;
}

/**
 * Register as a subscriber for a conversation's event stream and
 * invoke `callback` for each new {@link AssistantEvent} appended.
 *
 * Creates a subscriber file under `signals/events/<conversationId>.<pid>`.
 * The daemon writes events to all such files. On {@link dispose} the
 * file is removed so the daemon stops writing.
 */
export function watchEventStream(
  conversationId: string,
  callback: (event: AssistantEvent) => void,
): EventStreamWatcher {
  const dir = eventsDir();
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${conversationId}.${process.pid}`);

  // Create the subscriber file (empty). The daemon will append to it.
  writeFileSync(filePath, "");
  let offset = 0;

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
        try {
          unlinkSync(filePath);
        } catch {
          // Already removed.
        }
      }
    },
  };
}
