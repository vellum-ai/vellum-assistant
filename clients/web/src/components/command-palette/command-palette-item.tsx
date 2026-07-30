import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { PanelItem } from "@vellumai/design-library";

export interface CommandPaletteItemProps {
  icon?: LucideIcon;
  title: string;
  subtitle?: string;
  /** Longer match excerpt rendered as a second line under the title. */
  snippet?: string;
  /** Search term used to highlight the match inside the snippet. */
  highlightQuery?: string;
  shortcutHint?: ReactNode;
  isSelected: boolean;
  onClick: () => void;
  surface?: "overlay" | "window";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Emphasize the first case-insensitive occurrence of the query. Matching
 * runs on the original snippet so offsets stay aligned even when
 * lowercasing would change string length (e.g. Turkish dotted I).
 */
function highlightMatch(
  snippet: string,
  highlightQuery: string | undefined,
): ReactNode {
  const q = highlightQuery?.trim();
  if (!q) {
    return snippet;
  }
  const match = new RegExp(escapeRegExp(q), "i").exec(snippet);
  if (!match) {
    return snippet;
  }
  const start = match.index;
  const end = start + match[0].length;
  return (
    <>
      {snippet.slice(0, start)}
      <span className="font-medium text-[var(--content-default)]">
        {snippet.slice(start, end)}
      </span>
      {snippet.slice(end)}
    </>
  );
}

/**
 * A single result row inside the CommandPalette.
 */
export function CommandPaletteItem({
  icon,
  title,
  subtitle,
  snippet,
  highlightQuery,
  shortcutHint,
  isSelected,
  onClick,
  surface = "overlay",
}: CommandPaletteItemProps) {
  const Icon = icon;

  if (surface === "window") {
    return (
      <button
        type="button"
        role="option"
        aria-current={isSelected ? "page" : undefined}
        aria-selected={isSelected}
        onClick={onClick}
        className={[
          "flex w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium outline-none transition-colors",
          snippet ? "py-1.5" : "h-10",
          isSelected
            ? "bg-[var(--surface-active)] text-[var(--content-default)]"
            : "text-[var(--content-secondary)] hover:bg-[var(--surface-overlay)] hover:text-[var(--content-default)]",
        ].join(" ")}
      >
        {Icon ? (
          <Icon
            size={16}
            aria-hidden
            className={
              isSelected
                ? "shrink-0 text-[var(--content-default)]"
                : "shrink-0 text-[var(--content-tertiary)]"
            }
          />
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{title}</span>
            {subtitle ? (
              <span className="min-w-0 truncate text-xs text-[var(--content-tertiary)]">
                {subtitle}
              </span>
            ) : null}
            {shortcutHint ? (
              <span className="ml-auto shrink-0 text-xs text-[var(--content-tertiary)]">
                {shortcutHint}
              </span>
            ) : null}
          </span>
          {snippet ? (
            <span className="truncate text-xs font-normal text-[var(--content-tertiary)]">
              {highlightMatch(snippet, highlightQuery)}
            </span>
          ) : null}
        </span>
      </button>
    );
  }

  return (
    <PanelItem
      icon={icon}
      label={
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{title}</span>
            {subtitle ? (
              <span className="min-w-0 truncate text-[var(--content-tertiary)] text-body-small-default">
                {subtitle}
              </span>
            ) : null}
            {shortcutHint ? (
              <span className="ml-auto shrink-0 text-[var(--content-tertiary)] text-body-small-default">
                {shortcutHint}
              </span>
            ) : null}
          </span>
          {snippet ? (
            <span className="truncate text-[var(--content-tertiary)] text-body-small-default">
              {highlightMatch(snippet, highlightQuery)}
            </span>
          ) : null}
        </span>
      }
      active={isSelected}
      onSelect={onClick}
      className={snippet ? "h-auto px-3 py-2" : "px-3 py-2"}
    />
  );
}
