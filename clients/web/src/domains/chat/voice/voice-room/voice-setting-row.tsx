/**
 * The "Voice" row shown in the voice-room settings popover and the first-run
 * card: the assistant's current voice with a chevron, leading to the full
 * catalog with previews (which doesn't fit inline).
 *
 * The parent owns where that leads — this row only reports the click via
 * `onOpen`. The settings popover opens {@link VoicePickerModal}, so closing the
 * popover (which unmounts this row) can't unmount the picker with it; the
 * first-run card swaps to its own voice view.
 *
 * An assistant on a bring-your-own speech provider has no catalog to open, so
 * the row goes disabled and points at Settings → Models & Services, where that
 * provider's voice id lives with the rest of its config — a stopgap until BYO
 * voices get a picker of their own. Following that link mid-call is safe: it
 * leaves the chat route, which hides the room and hands the live session to the
 * title-bar pill. Everything else that leaves voice selection unavailable
 * (config still loading, an older daemon) renders nothing, so the popover never
 * shows a dead row it can't explain.
 */

import { ChevronRight } from "lucide-react";
import { Link } from "react-router";

import { cn } from "@vellumai/design-library";

import { useManagedVoiceSelection } from "@/components/speech/use-managed-voice-selection";
import { VoiceLabel } from "@/components/speech/voice-list";
import { routes } from "@/utils/routes";

export interface VoiceSettingRowProps {
  assistantId: string | null;
  /** Open the voice picker modal (owned by the parent). */
  onOpen: () => void;
  className?: string;
}

export function VoiceSettingRow({
  assistantId,
  onOpen,
  className,
}: VoiceSettingRowProps) {
  const { available, isByok, voices, currentModel } =
    useManagedVoiceSelection(assistantId);
  const current = voices.find((v) => v.model === currentModel) ?? voices[0];

  if (!available || !current) {
    return isByok ? <ByokVoiceRow className={className} /> : null;
  }

  return (
    // The divider is its own straight, full-width line — a top border on the
    // rounded button below would render with rounded ends.
    <div className={cn("flex flex-col", className)}>
      <div className="border-t border-[var(--border-subtle)]" />
      <button
        type="button"
        onClick={onOpen}
        className="mt-1 flex w-full items-baseline gap-2 rounded-md px-1 py-2 text-left transition-colors hover:bg-[var(--surface-hover)]"
      >
        <span className="shrink-0 text-body-medium-default text-[var(--content-default)]">
          Voice
        </span>
        <VoiceLabel
          description={current.description}
          className="min-w-0 flex-1 text-label-small-default text-[var(--content-tertiary)]"
        />
        <ChevronRight className="size-4 shrink-0 self-center text-[var(--content-tertiary)]" />
      </button>
    </div>
  );
}

/**
 * The bring-your-own-provider state: the same row, disabled — it keeps the
 * shape so the popover doesn't reflow between assistants — with the one thing
 * the user can act on underneath it.
 */
function ByokVoiceRow({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="border-t border-[var(--border-subtle)]" />
      <button
        type="button"
        disabled
        className="mt-1 flex w-full cursor-not-allowed items-baseline gap-2 rounded-md px-1 py-2 text-left opacity-50"
      >
        <span className="shrink-0 text-body-medium-default text-[var(--content-default)]">
          Voice
        </span>
        <span className="min-w-0 flex-1 truncate text-right text-label-small-default text-[var(--content-tertiary)]">
          Your API key
        </span>
      </button>
      <Link
        to={`${routes.settings.ai}#text-to-speech`}
        className="px-1 pb-1 text-label-small-default text-[var(--content-tertiary)] underline decoration-[var(--border-element)] underline-offset-2 transition-colors hover:text-[var(--content-default)]"
      >
        Change voice in Settings
      </Link>
    </div>
  );
}
