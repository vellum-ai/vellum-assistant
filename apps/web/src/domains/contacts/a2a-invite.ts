import { routes } from "@/utils/routes.js";

export interface A2AInviteParams {
  senderAssistantId: string;
  token: string;
  senderGatewayUrl: string;
}

/**
 * Build a shareable A2A invite link that routes to the connect page.
 * The link includes `senderGatewayUrl` so the recipient can reach the
 * sender's gateway directly, without a central broker.
 */
export function buildA2AInviteLink(params: A2AInviteParams): string {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "";
  const search = new URLSearchParams({
    senderAssistantId: params.senderAssistantId,
    token: params.token,
    senderGatewayUrl: params.senderGatewayUrl,
  });
  return `${origin}${routes.connect}?${search.toString()}`;
}

/**
 * Parse A2A invite parameters from a URL search string.
 * Returns `null` if any required parameter is missing.
 */
export function parseA2AInviteParams(
  search: URLSearchParams,
): A2AInviteParams | null {
  const senderAssistantId = search.get("senderAssistantId");
  const token = search.get("token");
  const senderGatewayUrl = search.get("senderGatewayUrl");
  if (!senderAssistantId || !token || !senderGatewayUrl) {
    return null;
  }
  return { senderAssistantId, token, senderGatewayUrl };
}
