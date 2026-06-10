import { SingleActivity } from "@/domains/chat/components/single-activity/single-activity";
import type { WebSearchResultItem } from "@/assistant/web-activity-types";
import type { ToolCallCardStep } from "@/domains/chat/utils/tool-call-card-utils";

/**
 * Lone-web adapter. A purely-web group of exactly ONE web tool call renders
 * here; the dispatcher (`MultiActivityGroup`) routes grouped (2+) and mixed
 * groups through the unified bare activity card instead.
 *
 * This is a thin wrapper around `SingleActivity variant="web"` — the inline,
 * expand-in-place "Web Search | <WebsiteCarousel>" link. It owns no chrome of
 * its own: collapsed it's the inline link with a rotating website carousel,
 * and expanding it reveals the favicon result row (or the error row for a
 * `web_search_error` step) in place. State / expansion are fully controlled by
 * the caller.
 */
export interface WebSearchProgressCardProps {
  /** Fallback static title (latest searched website) when the carousel isn't shown. */
  info: string;
  /** Websites to feed the rotating WebsiteCarousel in the header info slot. */
  carouselItems: WebSearchResultItem[];
  /**
   * Card-level state:
   * - `"loading"` while the search is still running (animated dots + rotating
   *   carousel in the collapsed link).
   * - `"complete"` once the search finalised successfully (static globe glyph).
   * - `"error"` when the search failed or its confirmation was denied (negative
   *   tone + error row when expanded).
   */
  state: "loading" | "complete" | "error";
  /** The single web step to render when expanded (favicon chips / error row). */
  step: Extract<ToolCallCardStep, { kind: "web_search" | "web_search_error" }>;
  /** Controlled expand state. */
  expanded: boolean;
  /** Notified when the user toggles the inline expand chevron. */
  onExpandChange: (next: boolean) => void;
}

export function WebSearchProgressCard({
  info,
  carouselItems,
  state,
  step,
  expanded,
  onExpandChange,
}: WebSearchProgressCardProps) {
  return (
    <SingleActivity
      variant="web"
      info={info}
      carouselItems={carouselItems}
      state={state}
      step={step}
      expanded={expanded}
      onExpandChange={onExpandChange}
    />
  );
}
