import { executeBrowserOperation } from "../browser/operations.js";
import type { BrowserOperation } from "../browser/types.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";
import { desktopControl } from "./desktop-control.js";
import { getDesktopSessionManager } from "./desktop-session-manager.js";

export function executeDesktopBrowserOperation(
  operation: BrowserOperation,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  if (
    input.target_client_id ||
    (input.browser_mode &&
      input.browser_mode !== "auto" &&
      input.browser_mode !== "cdp-inspect")
  ) {
    throw new Error(
      "--desktop targets the streamed Chrome directly. Omit other browser targets and modes.",
    );
  }
  if (input.use_active_tab) {
    throw new Error(
      "Use assistant browser --desktop tabs list and tabs select to choose a streamed browser tab.",
    );
  }
  if (operation === "wait_for_download") {
    throw new Error(
      "Download waiting is unavailable for the streamed desktop browser",
    );
  }
  return desktopControl.runBrowser(
    context,
    async (signal) => {
      const cdpClient = await getDesktopSessionManager().browser.client(
        context.conversationId,
        signal,
      );
      if (operation === "status") {
        await cdpClient.listTabs();
        return {
          isError: false,
          content: JSON.stringify({
            requestedMode: "desktop",
            recommendedMode: "desktop",
            modes: [
              {
                mode: "desktop",
                available: true,
                summary:
                  "Streamed desktop Chrome is ready. Use assistant browser --desktop commands.",
                userActions: [],
              },
            ],
          }),
        };
      }
      const browser = getDesktopSessionManager().browser;
      const generation = browser.generation;
      const result = await executeBrowserOperation(operation, input, {
        ...context,
        signal,
        cdpClient,
      });
      if (operation === "snapshot" && generation !== browser.generation) {
        browser.invalidateSnapshot();
        return {
          isError: true,
          content:
            "The page changed during the snapshot. Take a fresh snapshot before acting.",
        };
      }
      return result;
    },
    operation === "detach" || operation === "close",
  );
}

export function executeDesktopBrowserTabs(
  params: {
    command: "list" | "select" | "new" | "close";
    tabId?: number;
    url?: string;
  },
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return desktopControl.runBrowser(context, async (signal) => {
    const cdpClient = await getDesktopSessionManager().browser.client(
      context.conversationId,
      signal,
    );
    let result: unknown;
    if (params.command === "list") {
      const tabs = await cdpClient.listTabs();
      result = {
        ok: true,
        tabs: [
          ...tabs.filter((tab) => tab.active),
          ...tabs.filter((tab) => !tab.active),
        ].slice(0, 100),
      };
    } else if (params.command === "new") {
      const created = await cdpClient.send<{ tabId: number }>(
        "Vellum.createTab",
        {},
        signal,
      );
      if (params.url) {
        const navigated = await executeBrowserOperation(
          "navigate",
          { url: params.url },
          { ...context, signal, cdpClient },
        );
        if (navigated.isError) {
          return navigated;
        }
      }
      result = { ok: true, ...created };
    } else {
      if (params.tabId === undefined) {
        throw new Error("A tab ID is required");
      }
      result =
        params.command === "select"
          ? { ok: true, tab: await cdpClient.selectTab(params.tabId) }
          : { ok: true, ...(await cdpClient.closeTab(params.tabId)) };
    }
    return { isError: false, content: JSON.stringify(result) };
  });
}
