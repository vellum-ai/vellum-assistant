/**
 * File-based event stream for cross-process assistant event delivery.
 *
 * Subscribers (e.g. the built-in CLI) create a directory under
 * `signals/events/<conversationId>.<pid>/` via {@link watchEventStream}.
 * The daemon writes each event as an individual file named by timestamp
 * inside every matching subscriber directory via {@link appendEventToStream}.
 * When a subscriber disposes its watcher the directory is removed, so the
 * daemon stops writing.
 *
 * Write side: {@link appendEventToStream} (called by DaemonServer.broadcast)
 * Read side: {@link watchEventStream} (called by the CLI)
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getIsContainerized } from "../config/env-registry.js";
import type { AssistantEvent } from "../runtime/assistant-event.js";
import { getSignalsDir } from "../util/platform.js";

// ── Write side (daemon) ──────────────────────────────────────────────

function eventsDir(): string {
  return join(getSignalsDir(), "events");
}

/** Cached subscriber directories per conversation, with TTL. */
const subscriberCache = new Map<string, { dirs: string[]; expiry: number }>();

const CACHE_TTL_MS = 10_000;

function getSubscriberDirs(conversationId: string): string[] {
  const now = Date.now();
  const cached = subscriberCache.get(conversationId);
  if (cached && now < cached.expiry) return cached.dirs;

  const dir = eventsDir();
  if (!existsSync(dir)) {
    subscriberCache.set(conversationId, {
      dirs: [],
      expiry: now + CACHE_TTL_MS,
    });
    return [];
  }

  const prefix = `${conversationId}.`;
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
      .map((d) => d.name);
  } catch {
    subscriberCache.set(conversationId, {
      dirs: [],
      expiry: now + CACHE_TTL_MS,
    });
    return [];
  }

  const dirs = entries.map((e) => join(dir, e));
  subscriberCache.set(conversationId, {
    dirs,
    expiry: now + CACHE_TTL_MS,
  });
  return dirs;
}

/** Monotonic counter to guarantee unique filenames within a process. */
let sequence = 0;

/**
 * Write an event file into every active subscriber directory for the
 * given conversation. If no subscriber directories exist the call is a
 * no-op, so the daemon never writes events that nobody is listening to.
 */
export function appendEventToStream(
  conversationId: string,
  event: AssistantEvent,
): void {
  if (getIsContainerized()) return;

  const dirs = getSubscriberDirs(conversationId);
  if (dirs.length === 0) return;

  const timestamp = `${Date.now()}-${String(sequence++).padStart(6, "0")}`;
  const payload = JSON.stringify(event);
  for (const subDir of dirs) {
    try {
      writeFileSync(join(subDir, timestamp), payload);
    } catch {
      // Best-effort per subscriber.
    }
  }
}

/**
 * Invalidate the subscriber cache for a conversation so that the next
 * call to {@link appendEventToStream} re-scans the directory.
 */
export function invalidateSubscriberCache(conversationId: string): void {
  subscriberCache.delete(conversationId);
}

// ── Read side (CLI) ──────────────────────────────────────────────────

/** Handle returned by {@link watchEventStream}. Call `dispose()` to stop. */
export interface EventStreamWatcher {
  dispose(): void;
}

/**
 * Register as a subscriber for a conversation's event stream and
 * invoke `callback` for each new {@link AssistantEvent} written.
 *
 * Creates a subscriber directory at
 * `signals/events/<conversationId>.<pid>/`. The daemon writes each
 * event as an individual file named by timestamp. The subscriber
 * watches the directory via `fs.watch` and reads new files in sorted
 * order. On {@link dispose} the directory is removed so the daemon
 * stops writing.
 */
export function watchEventStream(
  conversationId: string,
  callback: (event: AssistantEvent) => void,
): EventStreamWatcher {
  if (getIsContainerized()) {
    return { dispose() {} };
  }

  const parentDir = eventsDir();
  mkdirSync(parentDir, { recursive: true });
  const subDir = join(parentDir, `${conversationId}.${process.pid}`);
  mkdirSync(subDir, { recursive: true });

  invalidateSubscriberCache(conversationId);

  const processedFiles = new Set<string>();
  let disposed = false;

  const readNewEvents = (): void => {
    if (disposed) return;
    let files: string[];
    try {
      files = readdirSync(subDir).sort();
    } catch {
      return;
    }
    for (const file of files) {
      if (processedFiles.has(file)) continue;
      processedFiles.add(file);
      try {
        const data = readFileSync(join(subDir, file), "utf-8");
        const event = JSON.parse(data) as AssistantEvent;
        callback(event);
      } catch {
        // Skip unreadable or malformed event files.
      }
      try {
        unlinkSync(join(subDir, file));
      } catch {
        // Best-effort cleanup.
      }
    }
  };

  const watcher = watch(subDir, () => {
    readNewEvents();
  });

  return {
    dispose() {
      if (!disposed) {
        disposed = true;
        watcher.close();
        try {
          rmSync(subDir, { recursive: true, force: true });
        } catch {
          // Already removed.
        }
        invalidateSubscriberCache(conversationId);
      }
    },
  };
}
