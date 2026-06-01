import { HomeMarkdownContent } from "./home-markdown-content";
import type { FeedItem } from "@vellumai/assistant-api";

export interface HomeGenericDetailProps {
  item: FeedItem;
}

/**
 * Fallback renderer for feed items that don't have a specialized
 * detail panel. Renders the item summary as markdown.
 */
export function HomeGenericDetail({ item }: HomeGenericDetailProps) {
  return <HomeMarkdownContent content={item.summary} />;
}
