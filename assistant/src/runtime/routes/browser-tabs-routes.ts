/**
 * Routes for browser tab management commands.
 *
 * Exposes `browser_tabs` so CLI commands can list, create, select, and
 * close browser tabs via the Chrome extension backend.
 */

import { z } from "zod";

import { findConversation } from "../../daemon/conversation-store.js";
import { getCdpClient } from "../../tools/browser/cdp-client/factory.js";
import {
  clearPinnedTab,
  setPinnedTab,
} from "../../tools/browser/pinned-tabs.js";
import type { ToolContext } from "../../tools/types.js";
import { BadRequestError, ServiceUnavailableError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";
import { browserCliConversationKey } from "./browser-routes.js";

const BrowserTabsParams = z.object({
  command: z.enum(["list", "select", "new", "close"]),
  sessionId: z.string().min(1).default("default"),
  conversationId: z.string().min(1).optional(),
  tabId: z.number().optional(),
  url: z.string().optional(),
});

async function handleBrowserTabs({ body = {} }: RouteHandlerArgs) {
  const { command, sessionId, conversationId, tabId, url } =
    BrowserTabsParams.parse(body);

  const conversation = conversationId
    ? findConversation(conversationId)
    : undefined;
  const resolvedConversationId = conversation
    ? conversationId!
    : browserCliConversationKey(sessionId);

  const context = {
    workingDir: process.cwd(),
    conversationId: resolvedConversationId,
    trustClass: conversation?.trustContext?.trustClass ?? "unknown",
    transportInterface: conversation?.transportInterface,
  } as unknown as ToolContext;

  if (command === "list") {
    const cdp = getCdpClient(context, { mode: "extension" });
    try {
      const tabs = await cdp.listTabs();
      return { ok: true, tabs };
    } finally {
      cdp.dispose();
    }
  }

  if (command === "select") {
    if (tabId === undefined) {
      throw new BadRequestError("tabId is required for the select command");
    }
    const cdp = getCdpClient(context, { mode: "extension" });
    try {
      const result = await cdp.selectTab(tabId);
      const clientId =
        typeof result?.clientId === "string" && result.clientId.length > 0
          ? result.clientId
          : undefined;
      if (result?.tabId !== undefined) {
        setPinnedTab(
          resolvedConversationId,
          String(result.tabId),
          clientId,
        );
      }
      return { ok: true, tab: result };
    } finally {
      cdp.dispose();
    }
  }

  if (command === "new") {
    const cdp = getCdpClient(context, { mode: "extension" });
    try {
      const result = await cdp.send<{ tabId?: number | string; clientId?: string }>(
        "Vellum.createTab",
        {},
      );
      const newTabId =
        typeof result?.tabId === "number"
          ? String(result.tabId)
          : typeof result?.tabId === "string"
            ? result.tabId
            : undefined;
      const clientId =
        typeof result?.clientId === "string" && result.clientId.length > 0
          ? result.clientId
          : undefined;
      if (newTabId) {
        cdp.setCdpSessionId?.(newTabId);
        setPinnedTab(resolvedConversationId, newTabId, clientId);
        if (url) {
          await cdp.send("Page.navigate", { url });
        }
      } else {
        clearPinnedTab(resolvedConversationId);
      }
      return { ok: true, tabId: newTabId, clientId };
    } finally {
      cdp.dispose();
    }
  }

  if (command === "close") {
    if (tabId === undefined) {
      throw new BadRequestError("tabId is required for the close command");
    }
    const cdp = getCdpClient(context, { mode: "extension" });
    try {
      const result = await cdp.closeTab(tabId);
      return { ok: true, ...result };
    } finally {
      cdp.dispose();
    }
  }

  throw new BadRequestError(`Unknown tabs command: ${command}`);
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "browser_tabs",
    endpoint: "browser/tabs",
    method: "POST",
    handler: handleBrowserTabs,
    summary: "Manage browser tabs",
    description:
      "List, create, select, or close browser tabs via the Chrome extension backend.",
    tags: ["browser"],
    requestBody: BrowserTabsParams,
    responseBody: z.object({
      ok: z.boolean(),
      tabs: z
        .array(
          z.object({
            tabId: z.number().optional(),
            windowId: z.number().optional(),
            url: z.string().optional(),
            title: z.string().optional(),
            active: z.boolean(),
            pinned: z.boolean(),
          }),
        )
        .optional(),
      tab: z.unknown().optional(),
      tabId: z.string().optional(),
      clientId: z.string().optional(),
      closed: z.boolean().optional(),
    }),
  },
];
