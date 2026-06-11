/**
 * Routes for browser tab management commands.
 *
 * Exposes `browser_tabs` so CLI commands can list, create, select, and
 * close browser tabs via the Chrome extension backend.
 */

import { z } from "zod";

import { findConversation } from "../../daemon/conversation-registry.js";
import { getCdpClient } from "../../tools/browser/cdp-client/factory.js";
import {
  clearPinnedTab,
  clearPinnedTabByTabId,
  setPinnedTab,
} from "../../tools/browser/pinned-tabs.js";
import type { ToolContext } from "../../tools/types.js";
import { LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import { browserCliConversationKey } from "./browser-routes.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const BrowserTabsParams = z.object({
  command: z.enum(["list", "select", "new", "close"]),
  sessionId: z.string().min(1).default("default"),
  conversationId: z.string().min(1).optional(),
  tabId: z.number().optional(),
  url: z.string().optional(),
  // Route tab operations to a specific extension client in multi-client
  // setups. Mirrors browser/execute's `target_client_id` semantics.
  targetClientId: z.string().min(1).optional(),
});

async function handleBrowserTabs({ body = {} }: RouteHandlerArgs) {
  const { command, sessionId, conversationId, tabId, url, targetClientId } =
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

  const cdpOptions = { mode: "extension" as const, targetClientId };

  if (command === "list") {
    const cdp = getCdpClient(context, cdpOptions);
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
    const cdp = getCdpClient(context, cdpOptions);
    try {
      const result = await cdp.selectTab(tabId);
      const clientId =
        typeof result?.clientId === "string" && result.clientId.length > 0
          ? result.clientId
          : undefined;
      if (result?.tabId !== undefined) {
        setPinnedTab(resolvedConversationId, String(result.tabId), clientId);
      }
      return { ok: true, tab: result };
    } finally {
      cdp.dispose();
    }
  }

  if (command === "new") {
    const cdp = getCdpClient(context, cdpOptions);
    try {
      const result = await cdp.send<{
        tabId?: number | string;
        clientId?: string;
      }>("Vellum.createTab", {});
      // Normalise to string for internal use (setCdpSessionId / setPinnedTab)
      // and keep the numeric form for the API response.
      const newTabIdStr: string | undefined =
        typeof result?.tabId === "number"
          ? String(result.tabId)
          : typeof result?.tabId === "string"
            ? result.tabId
            : undefined;
      const newTabIdNum: number | undefined =
        typeof result?.tabId === "number"
          ? result.tabId
          : typeof result?.tabId === "string"
            ? parseInt(result.tabId, 10)
            : undefined;
      const clientId =
        typeof result?.clientId === "string" && result.clientId.length > 0
          ? result.clientId
          : undefined;
      if (newTabIdStr) {
        cdp.setCdpSessionId?.(newTabIdStr);
        setPinnedTab(resolvedConversationId, newTabIdStr, clientId);
        if (url) {
          await cdp.send("Page.navigate", { url });
        }
      } else if (targetClientId) {
        // Only scope-clear the targeted client's pin. With the per-(conversationId,
        // clientId) pin store, passing no clientId to clearPinnedTab
        // would wipe pins for *every* connected client on this conversation
        // and break their routing — so we skip the clear entirely when the
        // caller didn't explicitly target a client. The stale pin (if any)
        // is overwritten on the next successful tab operation.
        clearPinnedTab(resolvedConversationId, targetClientId);
      }
      return { ok: true, tabId: newTabIdNum, clientId };
    } finally {
      cdp.dispose();
    }
  }

  if (command === "close") {
    if (tabId === undefined) {
      throw new BadRequestError("tabId is required for the close command");
    }
    const cdp = getCdpClient(context, cdpOptions);
    try {
      const result = await cdp.closeTab(tabId);
      // Clear any pinned-tab slot still pointing at the closed tabId so
      // subsequent browser tool calls don't route to a dead cdpSessionId
      // and fail with session-not-found. Tabs that never debugger-attached
      // (e.g. `tabs new` without `--url`) won't emit a detach invalidation
      // event, so the pin would otherwise leak.
      //
      // Scope the clear to the actual responding client. Prefer the
      // clientId from the closeTab response (resolved by the extension
      // dispatcher), fall back to the caller-supplied targetClientId.
      // Without a resolved clientId we skip the clear entirely — calling
      // clearPinnedTabByTabId without a clientId would wipe matching pins
      // across every client (Chrome tab IDs are per-instance, not
      // globally unique), breaking the per-(conversationId, clientId)
      // pin isolation added in #31361. The stale pin in the unscoped
      // case will self-heal via the session-not-found cleanup on the
      // next browser op against that pin.
      const resolvedClientId = result.clientId ?? targetClientId;
      if (resolvedClientId) {
        clearPinnedTabByTabId(String(tabId), resolvedClientId);
      }
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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
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
      tabId: z.number().optional(),
      clientId: z.string().optional(),
      closed: z.boolean().optional(),
    }),
  },
];
