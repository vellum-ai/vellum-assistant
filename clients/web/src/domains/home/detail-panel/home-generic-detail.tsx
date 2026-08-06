import { HomeMarkdownContent } from "./home-markdown-content";
import type { FeedItem } from "@vellumai/assistant-api";

export interface HomeGenericDetailProps {
  item: FeedItem;
  /** Extra classes for the markdown body, e.g. a looser line height. */
  className?: string;
}

/**
 * Fallback renderer for feed items that don't have a specialized
 * detail panel. Renders the item summary as markdown.
 */
export function HomeGenericDetail({ item, className }: HomeGenericDetailProps) {
  return <HomeMarkdownContent content={item.summary} className={className} />;
}
