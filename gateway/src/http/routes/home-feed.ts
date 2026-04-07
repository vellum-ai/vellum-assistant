/**
 * Gateway route handlers for the Home Feed API.
 *
 * - GET  /v1/home/feed                              — read feed items, filter expired TTLs
 * - PATCH /v1/home/feed/:itemId                     — update item status (seen / acted_on)
 * - POST  /v1/home/feed/:itemId/actions/:actionId   — proxy action execution to runtime
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { getWorkspaceDir } from "../../credential-reader.js";
import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";

const log = getLogger("home-feed");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FeedItem {
  id: string;
  ttl?: string;
  status?: string;
  [key: string]: unknown;
}

interface FeedFile {
  version: 1;
  lastUpdated: string;
  items: FeedItem[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFeedPath(): string {
  return join(getWorkspaceDir(), "data", "home-feed.json");
}

function readFeedFile(): FeedFile | null {
  const feedPath = getFeedPath();
  if (!existsSync(feedPath)) return null;
  try {
    const raw = readFileSync(feedPath, "utf-8").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as FeedFile;
  } catch {
    return null;
  }
}

function writeFeedFileAtomic(data: FeedFile): void {
  const feedPath = getFeedPath();
  const dir = dirname(feedPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = join(dir, `.home-feed.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, feedPath);
}

/**
 * Serializes feed writes so concurrent PATCH requests don't race on
 * read-modify-write.
 */
let feedWriteChain: Promise<void> = Promise.resolve();

function enqueueFeedWrite(fn: () => void): void {
  feedWriteChain = feedWriteChain.then(fn);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET /v1/home/feed
 *
 * Reads the workspace feed JSON, filters out expired TTL items, and returns
 * the remaining items. Does NOT filter by minTimeAway — the client does that.
 */
export function createHomeFeedGetHandler() {
  return async (_req: Request): Promise<Response> => {
    try {
      const feed = readFeedFile();
      if (!feed) {
        return Response.json({ items: [], lastUpdated: null });
      }

      const now = new Date();
      const items = feed.items.filter((item) => {
        if (!item.ttl) return true;
        try {
          return new Date(item.ttl) > now;
        } catch {
          // If ttl is not a valid date, keep the item
          return true;
        }
      });

      return Response.json({
        items,
        lastUpdated: feed.lastUpdated ?? null,
      });
    } catch (err) {
      log.error({ err }, "Failed to read home feed");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

/**
 * PATCH /v1/home/feed/:itemId
 *
 * Updates the status of a feed item (seen / acted_on) via atomic
 * read-modify-write.
 */
export function createHomeFeedPatchHandler() {
  return async (req: Request, itemId: string): Promise<Response> => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(
        { error: "Request body must be valid JSON" },
        { status: 400 },
      );
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json(
        { error: "Request body must be a JSON object" },
        { status: 400 },
      );
    }

    const { status } = body as { status?: unknown };
    if (status !== "seen" && status !== "acted_on") {
      return Response.json(
        { error: '"status" must be "seen" or "acted_on"' },
        { status: 400 },
      );
    }

    const writeResult = new Promise<Response>((resolve) => {
      enqueueFeedWrite(() => {
        try {
          const feed = readFeedFile();
          if (!feed) {
            resolve(
              Response.json({ error: "Item not found" }, { status: 404 }),
            );
            return;
          }

          const itemIndex = feed.items.findIndex((item) => item.id === itemId);
          if (itemIndex === -1) {
            resolve(
              Response.json({ error: "Item not found" }, { status: 404 }),
            );
            return;
          }

          feed.items[itemIndex].status = status;
          writeFeedFileAtomic(feed);

          log.info({ itemId, status }, "Home feed item status updated");
          resolve(Response.json(feed.items[itemIndex]));
        } catch (err) {
          log.error({ err, itemId }, "Failed to update home feed item");
          resolve(
            Response.json({ error: "Internal server error" }, { status: 500 }),
          );
        }
      });
    });

    return writeResult;
  };
}

/**
 * POST /v1/home/feed/:itemId/actions/:actionId
 *
 * Proxies the action to the runtime's internal endpoint.
 */
export function createHomeFeedActionHandler(config: GatewayConfig) {
  return async (
    _req: Request,
    itemId: string,
    actionId: string,
  ): Promise<Response> => {
    const upstream = `${config.assistantRuntimeBaseUrl}/v1/internal/home/feed/${encodeURIComponent(itemId)}/actions/${encodeURIComponent(actionId)}`;

    try {
      const response = await fetchImpl(upstream, {
        method: "POST",
        headers: {
          authorization: `Bearer ${mintServiceToken()}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(config.runtimeTimeoutMs),
      });

      if (!response.ok) {
        const body = await response.text();
        log.warn(
          { itemId, actionId, status: response.status },
          "Runtime returned error for home feed action",
        );
        return new Response(body, {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      }

      return Response.json({ ok: true });
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        log.error(
          { itemId, actionId },
          "Home feed action proxy upstream timed out",
        );
        return Response.json({ error: "Gateway Timeout" }, { status: 504 });
      }
      log.error(
        { err, itemId, actionId },
        "Home feed action proxy connection failed",
      );
      return Response.json({ error: "Bad Gateway" }, { status: 502 });
    }
  };
}
