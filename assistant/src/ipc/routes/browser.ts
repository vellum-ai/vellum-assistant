/**
 * IPC route for browser operations.
 *
 * Exposes `browser_execute` so CLI commands and external processes can
 * invoke browser operations without going through skill tool wrappers.
 *
 * The `sessionId` parameter (default `"default"`) is mapped to a
 * deterministic conversation key `browser-cli:<sessionId>` so that
 * sequential IPC calls with the same session reuse browser state.
 */

import { z } from "zod";

import { executeBrowserOperation } from "../../browser/operations.js";
import {
  BROWSER_OPERATIONS,
  type BrowserOperation,
} from "../../browser/types.js";
import type { ContentBlock } from "../../providers/types.js";
import type { IpcRoute } from "../cli-server.js";
import { resolveBrowserIpcContext } from "./browser-context.js";

// ── Param validation ─────────────────────────────────────────────────

const BrowserExecuteParams = z.object({
  operation: z.enum(BROWSER_OPERATIONS as unknown as [string, ...string[]]),
  input: z.record(z.string(), z.unknown()).default({}),
  sessionId: z.string().min(1).default("default"),
  conversationId: z.string().min(1).optional(),
});

// ── Conversation key ─────────────────────────────────────────────────

/**
 * Build a deterministic conversation key from a session ID.
 * All CLI browser calls with the same session share browser state.
 */
export function browserCliConversationKey(sessionId: string): string {
  return `browser-cli:${sessionId}`;
}

// ── Screenshot extraction ────────────────────────────────────────────

/**
 * Extract base64 screenshot payloads from tool execution content blocks.
 * Returns an array of `{ mediaType, data }` objects for each image found.
 */
function extractScreenshots(
  contentBlocks?: ContentBlock[],
): Array<{ mediaType: string; data: string }> {
  if (!contentBlocks) return [];
  const screenshots: Array<{ mediaType: string; data: string }> = [];
  for (const block of contentBlocks) {
    if (block.type === "image" && block.source.type === "base64") {
      screenshots.push({
        mediaType: block.source.media_type,
        data: block.source.data,
      });
    }
  }
  return screenshots;
}

// ── Route definition ─────────────────────────────────────────────────

export const browserExecuteRoute: IpcRoute = {
  method: "browser_execute",
  handler: async (params) => {
    const { operation, input, sessionId, conversationId } =
      BrowserExecuteParams.parse(params);
    const resolvedContext = resolveBrowserIpcContext({
      requestedConversationId: conversationId,
      fallbackConversationId: browserCliConversationKey(sessionId),
    });

    const result = await executeBrowserOperation(
      operation as BrowserOperation,
      input,
      {
        workingDir: process.cwd(),
        conversationId: resolvedContext.conversationId,
        trustClass: resolvedContext.trustClass,
        hostBrowserProxy: resolvedContext.hostBrowserProxy,
        transportInterface: resolvedContext.transportInterface,
      },
    );

    const screenshots = extractScreenshots(result.contentBlocks);

    return {
      content: result.content,
      isError: result.isError,
      ...(screenshots.length > 0 ? { screenshots } : {}),
    };
  },
};
