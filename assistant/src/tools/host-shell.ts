import { resolveInvocationHostClientOs } from "./client-os.js";
import type { ToolContext } from "./types.js";

export type HostShell = "bash" | "powershell";

export function getHostShell(
  context: Pick<
    ToolContext,
    "clientOs" | "transportInterface" | "sourceActorPrincipalId"
  >,
  input: Record<string, unknown>,
): HostShell | undefined {
  const targetClientOs = resolveInvocationHostClientOs(
    "host_bash",
    input,
    context,
  );
  return targetClientOs === "windows" ||
    (targetClientOs === undefined &&
      (context.clientOs === "windows" ||
        context.transportInterface === "windows"))
    ? "powershell"
    : undefined;
}
