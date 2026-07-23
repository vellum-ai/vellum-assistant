/**
 * A collapsed, select-style voice control: a trigger showing the current voice
 * that opens the shared {@link VoiceList} (grouped, with per-row preview and a
 * provider badge) in a popover. Used where a form wants a compact field rather
 * than an always-open list — the Models & Services Text-to-Speech card.
 *
 * Controlled: the parent owns the value (so it can stay a draft until Save).
 * The list closes the popover on select. Renders nothing when the assistant
 * offers no managed voice catalog, so the surrounding label collapses with it.
 */

import { useState } from "react";

import { ChevronDown } from "lucide-react";

import { cn } from "@vellumai/design-library";
import { Popover } from "@vellumai/design-library/components/popover";

import { useManagedVoiceSelection } from "@/components/speech/use-managed-voice-selection";
import { VoiceList } from "@/components/speech/voice-list";
import { voiceTraitsLabel } from "@/lib/tts/managed-voice-catalog";

export interface VoicePickerFieldProps {
  assistantId: string | null;
  /** Currently-selected model (draft). */
  value: string;
  onChange: (model: string) => void;
  className?: string;
}

export function VoicePickerField({
  assistantId,
  value,
  onChange,
  className,
}: VoicePickerFieldProps) {
  const [open, setOpen] = useState(false);
  const { available, voices } = useManagedVoiceSelection(assistantId);

  if (!available) return null;

  const current = voices.find((v) => v.model === value) ?? voices[0];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        {/* Mirrors the design-library Dropdown trigger exactly so the Voice
            field reads as a sibling of the Provider dropdown above it. */}
        <button
          type="button"
          aria-label="Voice"
          className={cn(
            "flex h-9 w-full items-center gap-2 rounded-md border border-[var(--field-border)] bg-[var(--field-bg)] px-3 text-left text-body-medium-lighter text-[var(--content-default)] transition-colors focus:outline-none data-[state=open]:border-[var(--border-active)]",
            className,
          )}
        >
          <span className="min-w-0 flex-1 truncate">
            {current ? voiceTraitsLabel(current.description) : "Select a voice"}
          </span>
          <ChevronDown
            className="h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]"
            aria-hidden
          />
        </button>
      </Popover.Trigger>
      <Popover.Content
        side="bottom"
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-1"
      >
        <VoiceList
          assistantId={assistantId}
          value={value}
          onChange={onChange}
          onSelect={() => setOpen(false)}
          showSource
        />
      </Popover.Content>
    </Popover.Root>
  );
}
