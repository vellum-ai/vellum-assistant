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
import { HostBrowserProxy } from "../../daemon/host-browser-proxy.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import type { ContentBlock } from "../../providers/types.js";
import { getChromeExtensionRegistry } from "../chrome-extension-registry.js";
import { getClientRegistry } from "../client-registry.js";
import * as pendingInteractions from "../pending-interactions.js";
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
  // conversation's browser proxy wiring so operations like `status`
  // see extension connectivity from the parent turn.
  const conversation = conversationId
    ? findConversation(conversationId)
    : undefined;

  const resolvedConversationId = conversation
    ? conversationId!
    : browserCliConversationKey(sessionId);

  // Check the client registry for connected host_browser clients so the
  // status command can report accurate extension availability.
  const clientRegistry = getClientRegistry();
  const browserClients = clientRegistry.listByCapability("host_browser");

  // Resolve the host browser proxy. Prefer the conversation's proxy when
  // available; otherwise create an on-the-fly proxy wired to the
  // ChromeExtensionRegistry so CLI `assistant browser` commands can drive
  // the extension without a conversation context.
  let hostBrowserProxy = conversation?.hostBrowserProxy;
  let cliProxy: HostBrowserProxy | undefined;

  if (!hostBrowserProxy) {
    const extConn = getChromeExtensionRegistry().getAny();
    if (extConn) {
      const guardianId = extConn.guardianId;
      const sender = (msg: ServerMessage): void => {
        // Register the pending interaction so host_browser_result can
        // resolve it. Pass the proxy itself as the direct resolver since
        // there's no conversation object.
        if (
          msg.type === "host_browser_request" &&
          "requestId" in msg &&
          typeof msg.requestId === "string"
        ) {
          pendingInteractions.register(msg.requestId, {
            conversation: null,
            conversationId: resolvedConversationId,
            kind: "host_browser",
            hostBrowserProxy: cliProxy,
          });
        }
        const ok = getChromeExtensionRegistry().send(guardianId, msg);
        if (!ok) {
          throw new Error(
            `host_browser send failed: no active extension connection for guardian ${guardianId}`,
          );
        }
      };
      cliProxy = new HostBrowserProxy(sender);
      cliProxy.updateSender(sender, true);
      hostBrowserProxy = cliProxy;
    }
  }

  try {
    const result = await executeBrowserOperation(
      operation as BrowserOperation,
      input,
      {
        workingDir: process.cwd(),
        conversationId: resolvedConversationId,
        trustClass: conversation?.trustContext?.trustClass ?? "unknown",
        hostBrowserProxy,
        transportInterface:
          conversation?.transportInterface ?? "chrome-extension",
        hostBrowserRegistryRouted:
          !!conversation?.hostBrowserSenderOverride || !!cliProxy,
        connectedBrowserClients: browserClients.map((c) => ({
          clientId: c.clientId,
          interfaceId: c.interfaceId,
        })),
      },
    );

    const screenshots = extractScreenshots(result.contentBlocks);

    return {
      content: result.content,
      isError: result.isError,
      ...(screenshots.length > 0 ? { screenshots } : {}),
    };
  } finally {
    // Dispose the CLI proxy to clean up any pending timers if the
    // operation was aborted or timed out.
    cliProxy?.dispose();
  }
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
