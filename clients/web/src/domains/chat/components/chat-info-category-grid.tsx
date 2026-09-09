/**
 * The Chat Info panel's second level: one category's whole set as a wrapping
 * grid of tiles, with the control that fetches the next page under it.
 *
 * Presentational: the panel owns the category, its items, and what opening a
 * tile does.
 */

import { Button } from "@vellumai/design-library";

import { ChatInfoFileTile } from "@/domains/chat/components/chat-info-file-tile";
import type { ConversationFileAsset } from "@/domains/chat/hooks/use-conversation-assets";
import { useTranslation } from "@/i18n";

export interface ChatInfoCategoryGridProps {
  items: ConversationFileAsset[];
  assistantId: string;
  /** Whether the category holds more than the loaded page. */
  hasMore: boolean;
  onLoadMore: () => void;
  /** Opens a document, or previews an attachment or camera frame. */
  onOpen: (file: ConversationFileAsset) => void;
}

export function ChatInfoCategoryGrid({
  items,
  assistantId,
  hasMore,
  onLoadMore,
  onOpen,
}: ChatInfoCategoryGridProps) {
  const { t } = useTranslation("chat");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {items.map((file) => (
          <ChatInfoFileTile
            key={file.id}
            file={file}
            assistantId={assistantId}
            onOpen={onOpen}
          />
        ))}
      </div>
      {hasMore && (
        <Button variant="outlined" onClick={onLoadMore} className="self-start">
          {t("chatInfoPanel.loadMore")}
        </Button>
      )}
    </div>
  );
}
