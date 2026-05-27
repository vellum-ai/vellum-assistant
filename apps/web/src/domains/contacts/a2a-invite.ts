import { routes } from "@/utils/routes";

export interface A2AInviteParams {
  senderAssistantId: string;
  token: string;
}

/**
 * Build a shareable A2A invite link that routes to the connect page.
 * The link includes `senderAssistantId` and `token` so the recipient
 * can redeem the invite via the platform broker.
 */
export function buildA2AInviteLink(params: A2AInviteParams): string {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "";
  const search = new URLSearchParams({
    senderAssistantId: params.senderAssistantId,
    token: params.token,
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
  const senderAssistantId = search.get("senderAssistantId")?.trim();
  const token = search.get("token")?.trim();
  if (!senderAssistantId || !token) {
    return null;
  }
  return { senderAssistantId, token };
}
