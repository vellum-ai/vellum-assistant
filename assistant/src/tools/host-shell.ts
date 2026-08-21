import type { ToolContext } from "./types.js";

export type HostShell = "bash" | "powershell";

export function getHostShell(
  context: Pick<ToolContext, "clientOs" | "transportInterface">,
): HostShell | undefined {
  return context.clientOs === "windows" ||
    context.transportInterface === "windows"
    ? "powershell"
    : undefined;
}
