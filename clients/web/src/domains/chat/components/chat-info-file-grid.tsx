/**
 * The Chat Info panel's second level for its two file categories, documents
 * and images and camera frames: the whole category as a wrapping grid of
 * tiles, with the control that fetches the next page under it. The apps
 * drill-in keeps its own auto-fill grid in the panel, since an app tile is
 * sized and laid out differently.
 *
 * Presentational: the panel owns the category, its items, and what opening a
 * tile does. A category that is ready and empty never reaches here: the panel
 * sends it back to the top level.
 */

import { Button } from "@vellumai/design-library";

import { ChatInfoFileTile } from "@/domains/chat/components/chat-info-file-tile";
import type { ConversationFileAsset } from "@/domains/chat/hooks/use-conversation-assets";
import { useTranslation } from "@/i18n";

interface ChatInfoFileGridProps {
  items: ConversationFileAsset[];
  assistantId: string;
  /** Whether the category holds more than the loaded page. */
  hasMore: boolean;
  onLoadMore: () => void;
  /** Opens a document, or previews an attachment or camera frame. */
  onOpen: (file: ConversationFileAsset) => void;
}

export function ChatInfoFileGrid({
  items,
  assistantId,
  hasMore,
  onLoadMore,
  onOpen,
}: ChatInfoFileGridProps) {
  const { t } = useTranslation("chat");

  return (
    <div className="flex flex-col gap-4">
      {items.length > 0 && (
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
      )}
      {hasMore && (
        <Button variant="outlined" onClick={onLoadMore} className="self-start">
          {t("chatInfoPanel.loadMore")}
        </Button>
      )}
    </div>
  );
}
