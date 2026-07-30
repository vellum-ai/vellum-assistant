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
 * Emphasize query-token matches. Lexical search matches tokens
 * independently, so each token is highlighted wherever it occurs, not
 * only when the full query appears contiguously. Matching runs on the
 * original snippet so offsets stay aligned even when lowercasing would
 * change string length (e.g. Turkish dotted I).
 */
function highlightMatch(
  snippet: string,
  highlightQuery: string | undefined,
): ReactNode {
  const tokens = [
    ...new Set(highlightQuery?.trim().toLowerCase().split(/\s+/) ?? []),
  ]
    .filter((token) => token.length > 0)
    .sort((a, b) => b.length - a.length);
  if (tokens.length === 0) {
    return snippet;
  }
  const matcher = new RegExp(tokens.map(escapeRegExp).join("|"), "gi");
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of snippet.matchAll(matcher)) {
    parts.push(snippet.slice(cursor, match.index));
    parts.push(
      <span
        key={match.index}
        className="font-medium text-[var(--content-default)]"
      >
        {match[0]}
      </span>,
    );
    cursor = match.index + match[0].length;
  }
  if (parts.length === 0) {
    return snippet;
  }
  parts.push(snippet.slice(cursor));
  return <>{parts}</>;
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
