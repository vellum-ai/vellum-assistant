/**
 * Transport-agnostic route for browser operations.
 *
 * Exposes `browser_execute` so CLI commands and external processes can
 * invoke browser operations without going through skill tool wrappers.
 *
 * The `sessionId` parameter (default `"default"`) is mapped to a
 * deterministic conversation key `browser-cli:<sessionId>` so that
 * sequential calls with the same session reuse browser state.
 */

import { z } from "zod";

import { executeBrowserOperation } from "../../browser/operations.js";
import {
  BROWSER_OPERATIONS,
  type BrowserOperation,
} from "../../browser/types.js";
import { findConversation } from "../../daemon/conversation-store.js";
import type { ContentBlock } from "../../providers/types.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

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

// ── Handler ──────────────────────────────────────────────────────────

async function handleBrowserExecute({ body = {} }: RouteHandlerArgs) {
  const { operation, input, sessionId, conversationId } =
    BrowserExecuteParams.parse(body);

  // When the caller passes a live conversation ID (e.g. from
  // __CONVERSATION_ID in a nested bash invocation), reuse that
  // conversation's trust context and transport interface.
  const conversation = conversationId
    ? findConversation(conversationId)
    : undefined;

  const resolvedConversationId = conversation
    ? conversationId!
    : browserCliConversationKey(sessionId);

  const result = await executeBrowserOperation(
    operation as BrowserOperation,
    input,
    {
      workingDir: process.cwd(),
      conversationId: resolvedConversationId,
      trustClass: conversation?.trustContext?.trustClass ?? "unknown",
      transportInterface: conversation?.transportInterface,
    },
  );

  const screenshots = extractScreenshots(result.contentBlocks);

  return {
    content: result.content,
    isError: result.isError,
    ...(screenshots.length > 0 ? { screenshots } : {}),
  };
}

// ── Routes ───────────────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "browser_execute",
    endpoint: "browser/execute",
    method: "POST",
    handler: handleBrowserExecute,
    summary: "Execute a browser operation",
    description:
      "Invoke a browser operation (navigate, click, type, screenshot, etc.) via the headless browser subsystem.",
    tags: ["browser"],
    requestBody: BrowserExecuteParams,
    responseBody: z.object({
      content: z.string(),
      isError: z.boolean(),
      screenshots: z
        .array(
          z.object({
            mediaType: z.string(),
            data: z.string(),
          }),
        )
        .optional(),
    }),
  },
];
