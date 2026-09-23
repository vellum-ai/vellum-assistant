import { checkIngressForSecrets } from "../../security/secret-ingress.js";
import { RouteResponse } from "./types.js";

/**
 * The 422 a send route answers when the message carries a known-format
 * secret, or null when it may be sent. Checked before anything is persisted.
 */
export function secretBlockedResponse(content: string): RouteResponse | null {
  const ingressResult = checkIngressForSecrets(content);
  if (!ingressResult.blocked) {
    return null;
  }
  return new RouteResponse(
    JSON.stringify({
      accepted: false,
      error: "secret_blocked",
      message: ingressResult.userNotice,
      detectedTypes: ingressResult.detectedTypes,
    }),
    { "content-type": "application/json" },
    422,
  );
}
