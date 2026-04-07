/**
 * Home Feed Writer — reads and writes the home-feed.json file.
 *
 * The feed file lives at `{workspaceDir}/data/home-feed.json` and is
 * written atomically (temp file + rename) to prevent partial reads.
 * After each write, an `home_feed_updated` SSE event is emitted so
 * connected clients can refresh.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("feed-writer");

// ── Types ────────────────────────────────────────────────────────────────────

export interface FeedAction {
  id: string;
  label: string;
}

export interface FeedItem {
  id: string;
  type: "nudge" | "digest" | "action" | "thread";
  priority: number;
  title: string;
  summary: string;
  source?: string;
  timestamp: string;
  status: "new" | "seen" | "acted_on";
  ttl?: string;
  minTimeAway?: number;
  actions?: FeedAction[];
}

export interface HomeFeedFile {
  version: 1;
  lastUpdated: string;
  items: FeedItem[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function feedFilePath(workspaceDir: string): string {
  return join(workspaceDir, "data", "home-feed.json");
}

function emptyFeed(): HomeFeedFile {
  return { version: 1, lastUpdated: "", items: [] };
}

function atomicWriteFile(filePath: string, content: string): void {
  const dir = dirname(filePath);
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Read and parse the home feed file.
 * Returns an empty feed structure if the file doesn't exist.
 */
export async function readFeedItems(
  workspaceDir: string,
): Promise<HomeFeedFile> {
  const filePath = feedFilePath(workspaceDir);
  if (!existsSync(filePath)) {
    return emptyFeed();
  }
  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as HomeFeedFile;
    return data;
  } catch (err) {
    log.warn({ err }, "Failed to read home feed file, returning empty feed");
    return emptyFeed();
  }
}

/**
 * Write feed items atomically and emit an SSE event.
 *
 * Creates the `data/` directory if it doesn't exist. Writes to a temp
 * file first, then renames for atomicity.
 */
export async function writeFeedItems(
  workspaceDir: string,
  items: FeedItem[],
): Promise<void> {
  const filePath = feedFilePath(workspaceDir);
  const dir = dirname(filePath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const feed: HomeFeedFile = {
    version: 1,
    lastUpdated: new Date().toISOString(),
    items,
  };

  atomicWriteFile(filePath, JSON.stringify(feed, null, 2));

  // Emit SSE event to notify connected clients
  assistantEventHub
    .publish(
      buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, {
        type: "home_feed_updated",
      }),
    )
    .catch((err: unknown) => {
      log.warn({ err }, "Failed to publish home_feed_updated event");
    });
}
