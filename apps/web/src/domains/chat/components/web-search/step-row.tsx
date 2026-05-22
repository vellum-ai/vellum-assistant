
import { AlertCircle, CheckCircle2 } from "lucide-react";
import type { ReactNode } from "react";

import { Typography } from "@vellum/design-library";

/**
 * A single sub-step row inside the expanded `WebSearchProgressCard`. Renders a
 * left-aligned status icon + step title, an optional right-aligned metadata
 * cluster (link count · duration), and a free-form children slot for the
 * step's content chips.
 *
 * Matches Figma node 4922:104010 (header) + 4922:104016 (content). The 24px
 * left padding on the content slot is intentional — it aligns chips below the
 * step title text, accounting for the 14px icon + 4px gap + 2px hairline.
 *
 * Pass `tone="error"` to swap the green CheckCircle2 for a red AlertCircle —
 * the visual treatment for `web_search_error` step descriptors.
 *
 * Internal helper for `WebSearchProgressCard` — not exported beyond this
 * folder.
 */
export function StepRow({
  title,
  durationLabel,
  linkCount,
  tone = "default",
  children,
}: {
  title: string;
  /** Human-readable duration, e.g. "2s". Optional. */
  durationLabel?: string;
  /** When provided, renders `{n} links · {durationLabel}` in the right cluster. */
  linkCount?: number;
  /**
   * Visual tone of the leading status icon. `"default"` renders the green
   * CheckCircle2; `"error"` swaps in a red AlertCircle so error-state rows
   * read as distinct from completed-OK rows.
   */
  tone?: "default" | "error";
  children: ReactNode;
}) {
  const hasMeta = linkCount != null || durationLabel != null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between py-[2px]">
        <div className="flex items-center gap-1">
          {tone === "error" ? (
            <AlertCircle
              aria-hidden="true"
              data-testid="step-row-status-icon"
              data-tone="error"
              className="h-[14px] w-[14px] text-[var(--system-negative-strong)]"
            />
          ) : (
            <CheckCircle2
              aria-hidden="true"
              data-testid="step-row-status-icon"
              data-tone="default"
              className="h-[14px] w-[14px] text-[var(--system-positive-strong)]"
            />
          )}
          <Typography
            variant="body-medium-default"
            className="text-[var(--content-default)]"
          >
            {title}
          </Typography>
        </div>
        {hasMeta ? (
          <Typography
            variant="label-medium-default"
            className="flex items-center gap-1 text-[var(--content-tertiary)]"
          >
            {linkCount != null ? (
              <span>
                {linkCount} link{linkCount === 1 ? "" : "s"}
              </span>
            ) : null}
            {linkCount != null && durationLabel ? (
              <span
                aria-hidden="true"
                className="h-[3px] w-[3px] rounded-full bg-[var(--content-tertiary)]"
              />
            ) : null}
            {durationLabel ? <span>{durationLabel}</span> : null}
          </Typography>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1 pl-[24px]">{children}</div>
    </div>
  );
}
