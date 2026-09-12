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
import { executeDesktopBrowserOperation } from "../../desktop/desktop-browser-operations.js";
import type { ContentBlock } from "../../providers/types.js";
import { LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import { resolveBrowserContext } from "./browser-context.js";
export { browserCliConversationKey } from "./browser-context.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Param validation ─────────────────────────────────────────────────

const BrowserExecuteParams = z.object({
  operation: z.enum(BROWSER_OPERATIONS as unknown as [string, ...string[]]),
  input: z.record(z.string(), z.unknown()).default({}),
  sessionId: z.string().min(1).default("default"),
  conversationId: z.string().min(1).optional(),
  desktop: z.boolean().optional(),
});

// ── Screenshot extraction ────────────────────────────────────────────

/**
 * Extract base64 screenshot payloads from tool execution content blocks.
 * Returns an array of `{ mediaType, data }` objects for each image found.
 */
function extractScreenshots(
  contentBlocks?: ContentBlock[],
): Array<{ mediaType: string; data: string }> {
  if (!contentBlocks) {
    return [];
  }
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

async function handleBrowserExecute({
  body = {},
  headers = {},
  abortSignal,
}: RouteHandlerArgs) {
  const { operation, input, sessionId, conversationId, desktop } =
    BrowserExecuteParams.parse(body);

  const context = await resolveBrowserContext(
    conversationId,
    sessionId,
    headers,
    abortSignal,
  );
  const execute = desktop
    ? executeDesktopBrowserOperation
    : executeBrowserOperation;
  const result = await execute(operation as BrowserOperation, input, context);

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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
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
