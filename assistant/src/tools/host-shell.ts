import type { ClassifyRiskIpcParams } from "@vellumai/gateway-client";

import { resolveInvocationHostClientOs } from "./client-os.js";
import type { ToolContext } from "./types.js";

export function getHostShell(
  context: Pick<
    ToolContext,
    "clientOs" | "transportInterface" | "sourceActorPrincipalId"
  >,
  input: Record<string, unknown>,
): ClassifyRiskIpcParams["shell"] {
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
