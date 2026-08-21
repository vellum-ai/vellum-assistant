import type { ClassifyRiskIpcParams } from "@vellumai/gateway-client";

import type { ToolContext } from "./types.js";

export function getHostShell(
  context: Pick<ToolContext, "clientOs" | "transportInterface">,
): ClassifyRiskIpcParams["shell"] {
  return context.clientOs === "windows" ||
    context.transportInterface === "windows"
    ? "powershell"
    : undefined;
}
