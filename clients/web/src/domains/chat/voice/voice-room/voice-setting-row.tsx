/**
 * The "Voice" row shown in the voice-room settings popover and the first-run
 * card: the assistant's current voice with a chevron, leading to the full
 * catalog with previews (which doesn't fit inline).
 *
 * The parent owns where that leads — this row only reports the click via
 * `onOpen`. The settings popover opens {@link VoicePickerModal} (so closing the
 * popover, which unmounts this row, can't unmount the picker with it); the
 * first-run card swaps to its own voice view instead.
 *
 * Renders nothing unless managed voice selection is available (managed assistant
 * + a daemon that offers it); BYO providers choose their voice in Settings.
 */

import { ChevronRight } from "lucide-react";

import { cn } from "@vellumai/design-library";

import { useManagedVoiceSelection } from "@/domains/chat/voice/voice-room/use-managed-voice-selection";
import { VoiceLabel } from "@/domains/chat/voice/voice-room/voice-list";

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
  const { available, voices, currentModel } =
    useManagedVoiceSelection(assistantId);
  const current = voices.find((v) => v.model === currentModel) ?? voices[0];

  if (!available || !current) return null;

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
