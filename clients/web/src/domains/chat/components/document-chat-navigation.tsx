import { Button } from "@vellumai/design-library";
import { FileText } from "lucide-react";

import { useTranslation } from "@/i18n";

interface DocumentChatNavigationProps {
  onReopenDocument: () => void;
}

/** Return from the conversation to its retained document editor. */
export function DocumentChatNavigation({
  onReopenDocument,
}: DocumentChatNavigationProps) {
  const { t } = useTranslation("chat");
  return (
    <div
      className="flex shrink-0 justify-end py-2"
      data-slot="document-chat-navigation"
    >
      <Button
        variant="ghost"
        size="compact"
        leftIcon={<FileText />}
        onClick={onReopenDocument}
      >
        {t("documentChat.reopenDocument")}
      </Button>
    </div>
  );
}
