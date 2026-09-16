import { getConfig } from "../config/loader.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";
import { desktopAutomationLease } from "./desktop-automation-lease.js";
import { isVirtualDesktopEnabled } from "./virtual-desktop-feature.js";

export async function prepareDesktopHelp(
  context: ToolContext,
): Promise<ToolExecutionResult | undefined> {
  if (!isVirtualDesktopEnabled(getConfig())) {
    return {
      content: "Virtual desktop help is unavailable on this assistant.",
      isError: true,
    };
  }
  await desktopAutomationLease.runBrowser(
    context,
    async () => ({ content: "", isError: false }),
    true,
  );
}
