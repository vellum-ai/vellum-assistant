
import { Brain } from "lucide-react";
import type { ReactNode } from "react";

import { Typography, cn } from "@vellum/design-library";

/**
 * Outlined pill used to surface a single sub-step "thinking" / reasoning
 * line inside the expanded `WebSearchProgressCard`. Stateless and
 * content-agnostic — the caller passes any `children` (typically a short
 * sentence) and optionally overrides the leading icon.
 *
 * Matches Figma node 4922:104017. The default leading icon is lucide's
 * `Brain` glyph. Figma calls out the Font Awesome 6 Pro `brain` icon, but
 * paying for a full icon font for a single glyph is not justified — design
 * is aware and may revisit.
 *
 * Chat-scoped — intentionally not exported from a shared package. Import
 * directly via `@/domains/chat/components/web-search/thinking-chip`.
 */
export function ThinkingChip({
  children,
  icon,
  className,
}: {
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1 rounded-[var(--radius-pill)] border border-[var(--border-base)] bg-[var(--surface-overlay)] px-[10px] py-[6px]",
        className,
      )}
    >
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
        {icon ?? (
          <Brain className="h-[14px] w-[14px] text-[var(--content-tertiary)]" />
        )}
      </span>
      <Typography
        variant="body-small-default"
        className="text-[var(--content-default)]"
      >
        {children}
      </Typography>
    </div>
  );
}
