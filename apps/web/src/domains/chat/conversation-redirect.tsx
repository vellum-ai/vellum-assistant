/**
 * Handles the `/assistant` index route. If a legacy `?conversationId=` or
 * `?conversationKey=` search param is present, redirects to the canonical
 * path-based conversation URL. `conversationId` wins when both are present.
 *
 * Sanctioned exclusion from the `conversationKey` → `conversationId`
 * cutover: the redirect itself stays bilingual so that ancient saved/shared
 * URLs (which only knew the `conversationKey` query-param shape) continue
 * to land on the right conversation rather than the new-chat page.
 *
 * Otherwise renders `ChatPage` (new/default conversation).
 */
import { Navigate, useSearchParams } from "react-router";

import { ChatPage } from "@/domains/chat/chat-page.js";
import { routes } from "@/utils/routes.js";

export function ConversationRedirect() {
  const [searchParams] = useSearchParams();
  const target =
    searchParams.get("conversationId") ?? searchParams.get("conversationKey");
  if (target) {
    const remaining = new URLSearchParams(searchParams);
    remaining.delete("conversationId");
    remaining.delete("conversationKey");
    const qs = remaining.toString();
    return (
      <Navigate
        to={`${routes.conversation(target)}${qs ? `?${qs}` : ""}`}
        replace
      />
    );
  }
  return <ChatPage />;
}
