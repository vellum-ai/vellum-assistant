import { extractErrorEnvelope } from "@/utils/api-errors";

export function mcpSetupErrorKey(error: unknown) {
  switch (extractErrorEnvelope(error).code) {
    case "PUBLIC_INGRESS_NOT_CONFIGURED":
      return "mcpConnect.callbackNotConfigured" as const;
    case "PUBLIC_INGRESS_DISABLED":
      return "mcpConnect.callbackDisabled" as const;
    default:
      return undefined;
  }
}
