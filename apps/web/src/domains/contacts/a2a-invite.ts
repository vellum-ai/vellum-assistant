import { routes } from "@/utils/routes.js";

/**
 * Build a shareable A2A invite link that routes to the connect page.
 *
 * Unlike the platform version, the OSS invite link includes
 * `senderGatewayUrl` — there is no central Django broker to derive it.
 */
export function buildA2AInviteLink(params: {
  senderAssistantId: string;
  token: string;
  senderGatewayUrl: string;
}): string {
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
 * Extract and validate A2A invite parameters from a URL's search params.
 *
 * Returns `null` if any required parameter is missing or empty.
 */
export function parseA2AInviteParams(
  searchParams: URLSearchParams,
): { senderAssistantId: string; token: string; senderGatewayUrl: string } | null {
  const senderAssistantId = searchParams.get("senderAssistantId")?.trim();
  const token = searchParams.get("token")?.trim();
  const senderGatewayUrl = searchParams.get("senderGatewayUrl")?.trim();

  if (!senderAssistantId || !token || !senderGatewayUrl) {
    return null;
  }

  return { senderAssistantId, token, senderGatewayUrl };
}
