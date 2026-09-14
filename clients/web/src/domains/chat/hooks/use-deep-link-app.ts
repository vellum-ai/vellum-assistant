/**
 * Legacy `?app=<id>` links land on the app route.
 *
 * The app viewer lives at `/assistant/conversations/:conversationId/app/:appId`
 * (see `useAppRouteSync`), so the param is only a redirect now. The pending id
 * is held in a ref because an index landing (`/assistant?app=x`) is rewritten
 * to a conversation URL by the loader before the conversation id is known.
 */

import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";

import { useConversationStore } from "@/stores/conversation-store";
import { routes } from "@/utils/routes";

const LEGACY_APP_PARAM = "app";

export function useDeepLinkApp(
  urlConversationId: string | null,
  searchParams: URLSearchParams,
): void {
  const navigate = useNavigate();
  const activeConversationId = useConversationStore.use.activeConversationId();
  const pendingAppIdRef = useRef<string | null>(null);

  useEffect(() => {
    const appId = searchParams.get(LEGACY_APP_PARAM);
    if (appId) {
      pendingAppIdRef.current = appId;
    }
  }, [searchParams]);

  useEffect(() => {
    const conversationId = urlConversationId ?? activeConversationId;
    const appId = pendingAppIdRef.current;
    if (!appId || !conversationId) {
      return;
    }
    pendingAppIdRef.current = null;
    const params = new URLSearchParams(searchParams.toString());
    params.delete(LEGACY_APP_PARAM);
    const rest = params.toString();
    void navigate(
      {
        pathname: routes.conversation(conversationId, appId),
        search: rest ? `?${rest}` : "",
      },
      { replace: true },
    );
  }, [searchParams, urlConversationId, activeConversationId, navigate]);
}
