import type { ToolContext, ToolExecutionResult } from "../tools/types.js";
import { desktopAutomationLease } from "./desktop-automation-lease.js";
import { isVirtualDesktopEnabled } from "./virtual-desktop-feature.js";

export async function prepareDesktopHelp(
  context: ToolContext,
): Promise<ToolExecutionResult | ((resume: boolean) => Promise<void>)> {
  if (!isVirtualDesktopEnabled()) {
    return {
      content: "Virtual desktop help is unavailable on this assistant.",
      isError: true,
    };
  }
  return desktopAutomationLease.reserveForHuman(context);
}
