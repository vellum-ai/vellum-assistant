import {
    AlarmClock,
    Bell,
    BookOpen,
    Briefcase,
    Calendar,
    CheckSquare,
    Code,
    Compass,
    Cpu,
    FileText,
    Flag,
    Folder,
    Gamepad,
    Gift,
    Globe,
    GraduationCap,
    Heart,
    Lightbulb,
    Link,
    ListTodo,
    Mail,
    Map,
    MessageCircle,
    MessageSquare,
    Music,
    Package,
    Pencil,
    Phone,
    Pin,
    Plane,
    Plug,
    Puzzle,
    Search,
    Send,
    Settings,
    Share,
    ShoppingCart,
    Sparkles,
    Star,
    Sun,
    Tag,
    Target,
    TrendingUp,
    Users,
    Wand2,
    Wrench,
    X,
    Zap,
    type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import type { SuggestedPrompt } from "@vellumai/assistant-api";
import { Typography } from "@vellumai/design-library";

// Curated set of Lucide icons that suggestion prompts may reference by name.
// The daemon sends bare camelCase identifiers (e.g. "mail", "fileText"); a
// star import from `lucide-react` would pull every icon (~1700) into the
// bundle, so we maintain an explicit list and fall back to `Sparkles` for
// anything unmapped.
const SUGGESTION_ICON_BY_NAME: Record<string, LucideIcon> = {
  AlarmClock,
  Bell,
  BookOpen,
  Briefcase,
  Calendar,
  CheckSquare,
  Code,
  Compass,
  Cpu,
  FileText,
  Flag,
  Folder,
  Gamepad,
  Gift,
  Globe,
  GraduationCap,
  Heart,
  Lightbulb,
  Link,
  ListTodo,
  Mail,
  Map,
  MessageCircle,
  MessageSquare,
  Music,
  Package,
  Pencil,
  Phone,
  Pin,
  Plane,
  Plug,
  Puzzle,
  Search,
  Send,
  Settings,
  Share,
  ShoppingCart,
  Sparkles,
  Star,
  Sun,
  Target,
  Tag,
  TrendingUp,
  Users,
  Wand2,
  Wrench,
  Zap,
};

function toPascalCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Resolves a daemon icon key (bare Lucide camelCase like "mail", "fileText")
 * to a lucide-react component. Matches the macOS resolveIcon(_:) algorithm:
 * try direct PascalCase lookup, then strip "lucide-" prefix and retry. Names
 * outside the curated `SUGGESTION_ICON_BY_NAME` set fall back to `Sparkles`.
 */
function resolveIcon(iconName: string | undefined): LucideIcon {
  if (!iconName) return Sparkles;

  const pascal = toPascalCase(iconName);
  if (SUGGESTION_ICON_BY_NAME[pascal]) {
    return SUGGESTION_ICON_BY_NAME[pascal];
  }

  const stripped = iconName.replace(/^lucide-/, "");
  if (stripped !== iconName) {
    const strippedPascal = toPascalCase(stripped);
    if (SUGGESTION_ICON_BY_NAME[strippedPascal]) {
      return SUGGESTION_ICON_BY_NAME[strippedPascal];
    }
  }

  return Sparkles;
}

interface HomeSuggestionPillBarProps {
  suggestions: SuggestedPrompt[];
  maxVisible?: number;
  onSelect: (prompt: SuggestedPrompt) => void;
}

export function HomeSuggestionPillBar({
  suggestions,
  maxVisible = 3,
  onSelect,
}: HomeSuggestionPillBarProps) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || suggestions.length === 0) return null;

  const visible = suggestions.slice(0, maxVisible);

  return (
    <div className="flex flex-col gap-[var(--app-spacing-sm)] rounded-2xl border border-[var(--border-disabled)] px-[var(--app-spacing-lg)] py-[var(--app-spacing-lg)]">
      <div className="flex items-center justify-between">
        <Typography
          variant="body-medium-default"
          className="text-[var(--content-tertiary)]"
        >
          By the way, have you tried one of these:
        </Typography>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss suggestions"
          className="shrink-0 cursor-pointer text-[var(--content-disabled)] transition-colors hover:text-[var(--content-tertiary)]"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-[var(--app-spacing-sm)]">
        {visible.map((suggestion) => {
          const Icon = resolveIcon(suggestion.icon);
          return (
            <button
              key={suggestion.id}
              type="button"
              onClick={() => onSelect(suggestion)}
              className="flex cursor-pointer items-center gap-[var(--app-spacing-xs)] rounded-full bg-[var(--surface-active)] py-1 pl-1 pr-3 text-[var(--content-default)] transition-colors hover:text-[var(--content-secondary)]"
            >
              <span
                className="flex shrink-0 items-center justify-center rounded-full bg-[var(--surface-active)]"
                style={{ width: 26, height: 26 }}
                aria-hidden="true"
              >
                <Icon className="size-[18px]" />
              </span>
              <span className="text-body-small-default">
                {suggestion.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
