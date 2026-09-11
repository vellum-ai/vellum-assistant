import { Button, Typography } from "@vellumai/design-library";
import { FileText, MessageSquareText } from "lucide-react";

import { useTranslation } from "@/i18n";

interface DocumentChatNavigationProps {
  presentation: "document" | "conversation";
  status: "idle" | "working" | "needs-input" | "preparing";
  onViewConversation: () => void;
  onReopenDocument: () => void;
}

/** Navigation between two presentations of the same conversation. */
export function DocumentChatNavigation({
  presentation,
  status,
  onViewConversation,
  onReopenDocument,
}: DocumentChatNavigationProps) {
  const { t } = useTranslation("chat");
  return (
    <div
      className="flex shrink-0 items-center justify-between gap-2 py-2"
      data-slot="document-chat-navigation"
    >
      <Typography
        variant="body-small-default"
        className="text-[var(--content-secondary)]"
        role="status"
      >
        {status === "preparing"
          ? t("documentChat.saving")
          : status === "needs-input"
            ? t("documentChat.needsInput")
            : status === "working"
              ? t("documentChat.working")
              : t("documentChat.repliesInConversation")}
      </Typography>
      <Button
        variant="ghost"
        size="compact"
        leftIcon={
          presentation === "document" ? <MessageSquareText /> : <FileText />
        }
        onClick={
          presentation === "document" ? onViewConversation : onReopenDocument
        }
      >
        {presentation === "document"
          ? t("documentChat.viewConversation")
          : t("documentChat.reopenDocument")}
      </Button>
    </div>
  );
}
