/**
 * The "Listening language" row shown in the voice-room settings popover: the
 * current language with a chevron, leading to the
 * {@link ListeningLanguagePickerModal} the parent hosts. Renders nothing when
 * the daemon doesn't offer manual language selection for the configured STT
 * provider (auto-detecting providers, old daemons), so the popover never shows
 * a control the daemon would ignore.
 *
 * The picker is a modal rather than an inline dropdown on purpose: the radix
 * popover positions its content through a transformed wrapper, which becomes
 * the containing block for fixed-position descendants, so the Dropdown menu's
 * viewport coordinates land relative to the already-offset popover and the
 * options render far from the trigger. Like the Voice row, this row only
 * reports the click via `onOpen`; the parent closes the popover and opens the
 * modal it owns outside it.
 */

import { ChevronRight } from "lucide-react";

import { cn } from "@vellumai/design-library";

import { useSttLanguageSelection } from "@/components/speech/use-stt-language-selection";
import {
  sttLanguageLabel,
  sttLanguageOptionsFor,
} from "@/lib/stt/language-catalog";

export interface ListeningLanguageRowProps {
  assistantId: string | null;
  /** Open the language picker modal (owned by the parent). */
  onOpen: () => void;
  className?: string;
}

export function ListeningLanguageRow({
  assistantId,
  onOpen,
  className,
}: ListeningLanguageRowProps) {
  const { available, currentCode, configuredProviderId } =
    useSttLanguageSelection(assistantId);

  if (!available) {
    return null;
  }

  const current = sttLanguageOptionsFor(currentCode, configuredProviderId).find(
    (option) => option.code === currentCode,
  );

  return (
    <div className={cn("flex flex-col", className)}>
      {/* Same straight full-width divider the Voice row draws (a border on a
          rounded child would render with rounded ends). */}
      <div className="border-t border-[var(--border-subtle)]" />
      <button
        type="button"
        onClick={onOpen}
        className="mt-1 flex w-full items-baseline gap-2 rounded-md px-1 py-2 text-left transition-colors hover:bg-[var(--surface-hover)]"
      >
        <span className="shrink-0 text-body-medium-default text-[var(--content-default)]">
          Listening language
        </span>
        <span className="min-w-0 flex-1 truncate text-right text-label-small-default text-[var(--content-tertiary)]">
          {current ? sttLanguageLabel(current) : currentCode}
        </span>
        <ChevronRight className="size-4 shrink-0 self-center text-[var(--content-tertiary)]" />
      </button>
    </div>
  );
}
