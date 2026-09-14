/**
 * One top-level file row of the Chat Info panel. Documents and images and
 * camera frames are the same row: a title, the category's exact total, See
 * All, and a fitted line of file tiles. Only the copy and the category the
 * drill-in carries differ.
 *
 * Presentational: the panel owns the category's items and what opening a tile
 * does.
 */

import {
  CHAT_INFO_FILE_TILE_WIDTH_PX,
  ChatInfoFileTile,
} from "@/domains/chat/components/chat-info-file-tile";
import { ChatInfoSection } from "@/domains/chat/components/chat-info-section";
import type { ConversationFileAsset } from "@/domains/chat/hooks/use-conversation-assets";

export type ChatInfoFileCategory = "files" | "frames";

interface ChatInfoFileRowProps {
  category: ChatInfoFileCategory;
  title: string;
  /** The category's exact total, which may exceed `items.length` when paged. */
  count: number;
  items: ConversationFileAsset[];
  seeAllAriaLabel: string;
  onSeeAll: (category: ChatInfoFileCategory) => void;
  /** Opens a document, or previews an attachment or camera frame. */
  onOpen: (file: ConversationFileAsset) => void;
  assistantId: string;
}

export function ChatInfoFileRow({
  category,
  title,
  count,
  items,
  seeAllAriaLabel,
  onSeeAll,
  onOpen,
  assistantId,
}: ChatInfoFileRowProps) {
  return (
    <ChatInfoSection
      title={title}
      count={count}
      items={items}
      tileWidth={CHAT_INFO_FILE_TILE_WIDTH_PX}
      seeAllAriaLabel={seeAllAriaLabel}
      onSeeAll={() => onSeeAll(category)}
      renderTile={(file) => (
        <ChatInfoFileTile
          key={file.id}
          file={file}
          assistantId={assistantId}
          onOpen={onOpen}
        />
      )}
    />
  );
}
