import { useLocation } from "react-router";

import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { isConversationPath } from "@/utils/routes";

import { getDocumentConversationRoute } from "../document-conversation-navigation";

export function useDocumentHeaderVisible(): boolean {
  const isMobile = useIsMobile();
  const { pathname, search } = useLocation();
  const documentHeader = useChatLayoutSlotsStore.use.documentHeader();
  const route = getDocumentConversationRoute(search);
  return (
    isMobile &&
    isConversationPath(pathname) &&
    route.showingDocument &&
    documentHeader?.surfaceId === route.surfaceId
  );
}
